// Oasis 的授权与原生 goal 生命周期衔接；不实现 Agent Loop/调度器。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const { appendPluginRecord } = await import(
  createRequire('/usr/local/lib/node_modules/@deepseek-ai/dsh/package.json').resolve(
    '@deepseek-ai/dsh-session',
  )
);
export const name = 'oasis-node-goal';
export const inject = [
  'agents',
  'goals',
  'agentPresets',
  'sessionProjections',
  'llm',
  'subagentModelSelection',
];
export function apply(ctx) {
  const request = JSON.parse(readFileSync('/workspace/in/.oasis-execution.json', 'utf8'));
  const window = request.goalRoundWindow;
  let prepared = false;
  const truncated = new WeakSet();
  const defer = (agent, action) =>
    globalThis.queueMicrotask(() => {
      if (ctx.agents.get(agent.id) !== agent) return;
      try {
        action();
      } catch (error) {
        ctx.emit('agent/error', { agent, error });
      }
    });
  // SDK 的普通 idle 不包含持久目标的激活状态，沿用会话事件通路投影该状态。
  ctx.on('goal/activation-changed', ({ sessionId }) => {
    const agent = ctx.agents.get(sessionId);
    if (agent)
      defer(agent, () => {
        const goal = ctx.goals.get(agent);
        appendPluginRecord(agent.session, 'plugin:oasis/goal-status', {
          phase: goal?.phase ?? null,
          activation: goal?.activation ?? null,
        });
      });
  });
  // 原生委派工具会在 agent/created 时捕获授权，须在更早的会话发布边界衔接。
  ctx.on('session/created', (session) => {
    if (
      String(session.id) === request.sessionId &&
      session.firstLiveSeq > 0 &&
      !ctx.sessionProjections.stateOf(session, 'agentPreset') &&
      session.requestHeader()?.config.provider === 'oasis' &&
      ctx.sessionProjections.stateOf(session, 'subagentModelSelectionPolicy') === null
    ) {
      const selection = ctx.subagentModelSelection.current();
      if (selection.enabled && selection.allowedModels.length)
        session.append('subagent/model-selection-policy', {
          allowedModels: selection.allowedModels,
        });
    }
  });
  ctx.on('agent/created', async ({ agent }) => {
    if (
      String(agent.session.id) !== request.sessionId ||
      ctx.agentPresets.composedPreset(agent.ctx)
    )
      return;
    const saved = ctx.sessionProjections.stateOf(agent.session, 'agentPreset');
    if (saved || agent.session.firstLiveSeq > 0) {
      await ctx.agentPresets.mount(agent.ctx, saved ?? 'oasis');
      // SDK 的创建通知已取过监听器快照；晚绑定后通知原生工具重算作用域。
      ctx.emit('tools/change');
    } else await ctx.agentPresets.select(agent, 'oasis');
  });
  function extend(agent) {
    const goal = ctx.goals.get(agent);
    if (goal?.phase === 'active' && goal.maxGoalRounds - goal.roundsStarted <= window / 2) {
      ctx.goals.edit(agent, goal, { maxGoalRounds: goal.roundsStarted + window });
    }
  }
  // 使用该型号原生声明的最高档位；调用方/子代理明确选择的档位保持原样。
  ctx.on('agent/request', async ({ signal }, next) => {
    const config = await next();
    if (config.reasoningEffort !== undefined) return config;
    const info = await ctx.llm.resolveModelInfo(config.provider, config.model, signal);
    const effort = info.reasoning?.efforts.at(-1)?.id;
    return effort ? { ...config, reasoningEffort: effort } : config;
  });
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (request.goal && !prepared && String(agent.session.id) === request.sessionId) {
      prepared = true;
      const goal = ctx.goals.get(agent);
      if (!goal || goal.phase === 'complete')
        ctx.goals.create(agent, { objective: request.objective, maxGoalRounds: window });
      else if (goal.activation === 'disarmed' && goal.phase === 'active')
        ctx.goals.resume(agent, goal);
    }
    return next();
  });
  ctx.on('session/event', (session, event) => {
    const agent = ctx.agents.get(session.id);
    if (!agent || agent.session !== session) return;
    // 只能在轮次结束后续期：中途修改 revision 会使本轮的原生目标授权失效。
    if (event.type === 'turn/end') defer(agent, () => extend(agent));
    // 物理输出边界结束的是当前调用；已授权的未完成目标仍在同一会话续跑。
    if (event.type === 'turn/end' && event.data.reason.kind === 'max-tokens') truncated.add(agent);
  });
  ctx.on('agent/status', ({ agent, status }) => {
    if (status !== 'idle' || !truncated.delete(agent)) return;
    // 让原生驱动先完成此次终态的 disarm，避免依赖插件挂载顺序。
    defer(agent, () => {
      const goal = ctx.goals.get(agent);
      if (goal?.phase !== 'active' || goal.activation !== 'disarmed') return;
      extend(agent);
      ctx.goals.resume(agent, ctx.goals.get(agent));
    });
  });
}
