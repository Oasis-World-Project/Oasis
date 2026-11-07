// dsh 的适配层：全仓只有这里认识 DeepSeek Harness（AGENTS.md B.3）。
// 对外只暴露 Oasis 自己的概念：沙箱里的目录约定、环境变量、一次 agent 会话、翻译后的运行事件。
// dsh 升级（SDK 协议、事件格式变化）只改这个目录和 profile/ 下的组合。
import type { Readable, Writable } from 'node:stream';
import type { RunEventKind } from '@oasis/contracts/harness';
import type { ModelCapabilities } from '@oasis/contracts/model-gateway';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import { ApplicationSpec } from '@oasis/contracts/canvas';
import { BrowserTestPlan } from '@oasis/contracts/ui-test';
import { MODEL_PREVIEW_LIMITS, ModelPreviewSpec } from '@oasis/contracts/model-preview';
import { createJsonRpcClient } from './jsonrpc.ts';

/** 沙箱镜像里的目录约定（与 infra/images/harness-sandbox-base/Dockerfile 一致） */
export const SANDBOX_PATHS = {
  workdir: '/workspace',
  inputs: '/workspace/in',
  outputs: '/workspace/out',
  /** dsh 的数据目录，会话存储在它下面的 sessions/ */
  dshHome: '/home/node/.dsh',
  /** dsh 的会话存储（关卡退回修改、停止后继续、讨论的下一轮时接着原会话） */
  sessions: '/home/node/.dsh/sessions',
} as const;

/** dsh 里指向 model-gateway 的模型路由名（profile/cordis.patch.yml 里定义） */
const PROVIDER = 'openrouter';

/** 会话存档里不能带的文件：锁文件会让恢复以为会话还被占着 */
export const isSessionLock = (path: string) => path.endsWith('.lock');
/** 原生持久文件只在适配层识别；缺失与损坏必须区分。 */
export const isSessionArchive = (path: string, sessionId?: string) => {
  const parts = path.split('/');
  return (
    parts[0] === '--workspace--' &&
    (sessionId === undefined || parts[1] === sessionId) &&
    /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(parts[2] ?? '')
  );
};

/** 沙箱的环境变量。runKey 是密钥，调用方不得记进日志。 */
/** 沙箱装软件包的通路：出口代理和仓库地址（ADR 0006 §7） */
export interface SandboxPackages {
  /** 出口代理；没有时沙箱完全不能出站 */
  egressProxy: string | undefined;
  npmRegistry: string;
  pipIndexUrl: string;
}

export function sandboxEnv(input: {
  modelBaseUrl: string;
  runKey: string;
  model: string;
  packages: SandboxPackages;
}): Record<string, string> {
  const { egressProxy, npmRegistry, pipIndexUrl } = input.packages;
  // 调模型、工具的入口代理不走出口代理
  const noProxy = [new URL(input.modelBaseUrl).hostname, 'localhost', '127.0.0.1'].join(',');
  return {
    OASIS_MODEL_BASE_URL: input.modelBaseUrl,
    OASIS_RUN_KEY: input.runKey,
    // dsh 运行命令时会去掉名字像密钥的环境变量（含 KEY、TOKEN……），oasis-tool 拿不到 OASIS_RUN_KEY；
    // 这把临时 Key 本来就是给这次运行里的 AI 用工具的，所以用一个不会被去掉的名字再给一份
    OASIS_TOOL_AUTH: input.runKey,
    OASIS_MODEL: input.model,
    DSH_MAX_TOKENS_AS_SUCCESS: 'false',
    ...(egressProxy
      ? {
          HTTP_PROXY: egressProxy,
          HTTPS_PROXY: egressProxy,
          http_proxy: egressProxy,
          https_proxy: egressProxy,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
          npm_config_registry: npmRegistry,
          PIP_INDEX_URL: pipIndexUrl,
          UV_DEFAULT_INDEX: pipIndexUrl,
        }
      : {}),
  };
}

/** 元数据用文件传入，避免 Linux 单个环境变量的长度边界。 */
export function runtimeFiles(input: {
  models: ModelCapabilities[];
  sessionId: string;
  objective: string;
  goal: boolean;
  /** 规划员用最强思考档（用户 2026-11-07 要求）；不给时最高到 high */
  reasoningEffort?: 'max';
  goalRoundWindow: number;
  recovering?: boolean;
  environment?: ExecutionEnvironment;
}) {
  return [
    {
      path: 'in/.oasis-formats.json',
      content: Buffer.from(
        JSON.stringify({
          application: {
            schema: ApplicationSpec.toJSONSchema(),
            example: ApplicationSpec.parse({
              version: 1,
              kind: 'static',
              root: 'site',
              entry: 'index.html',
            }),
            location: 'out/<root>/oasis-app.json',
            paths: 'root 相对 out/；entry 相对 root，清单必须位于该 root 目录内。',
          },
          browserTest: {
            schema: BrowserTestPlan.toJSONSchema(),
            location: '与 oasis-app.json 同目录的 oasis-test.json',
          },
          // 3D 预览的事实（原来写在节点提示里，2026-11-07 挪到这里：用到再读）
          model3d: {
            interactive:
              '画布直接交互预览自包含的 GLB：不引用外部文件、不用扩展，骨骼/形变/压缩暂不支持。',
            limits: MODEL_PREVIEW_LIMITS,
            otherFormats:
              'blend/obj/fbx/stl/usdz/ply/gltf 不能直接预览；要预览就在同目录放 oasis-model-preview.json，指向同时交付的 GLB、封面图或转台视频。',
            tools:
              '3D 沙箱里：oasis-3d snapshot <模型> --out <目录> 自动取景出视角图；oasis-3d check <模型> 查尺寸、拓扑和能否预览；Blender 脚本里 import oasis_blender（导出可预览 GLB、基础材质）。',
            sidecar: {
              schema: ModelPreviewSpec.toJSONSchema(),
              location: '与原件同目录的 oasis-model-preview.json；路径相对该文件，sha256 填实际值',
            },
          },
        }),
      ),
    },
    ...(input.environment
      ? [
          {
            path: 'in/.oasis-environment.json',
            content: Buffer.from(JSON.stringify(input.environment)),
          },
        ]
      : []),
    {
      path: 'in/.oasis-models.json',
      content: Buffer.from(
        JSON.stringify(
          // node 是 Oasis 估价用的典型用量，不属于 dsh 的模型配置
          input.models.map(({ reasoning, node: _node, ...model }) => ({
            ...model,
            // node-goal 插件默认取最后一档：只有要最强思考的运行才声明 max
            reasoningEfforts: reasoning
              ? {
                  off: null,
                  high: 'high',
                  ...(input.reasoningEffort === 'max' ? { max: 'max' } : {}),
                }
              : false,
            compat: {
              thinkingFormat: 'openrouter',
              supportsReasoningEffort: reasoning,
              maxTokensField: 'max_tokens',
            },
          })),
        ),
      ),
    },
    {
      path: 'in/.oasis-execution.json',
      content: Buffer.from(
        JSON.stringify({
          sessionId: input.sessionId,
          objective: input.objective,
          goal: input.goal,
          goalRoundWindow: input.goalRoundWindow,
          recovering: input.recovering ?? false,
        }),
      ),
    },
  ];
}
export interface AgentEvent {
  kind: RunEventKind;
  data: Record<string, unknown>;
}

/** 工具参数和结果在事件里最多保留这么多字符（完整内容在 dsh 会话存档里） */
const MAX_EVENT_TEXT = 4000;
const clip = (text: string) =>
  text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…（已截断）` : text;

interface Block {
  type?: string;
  text?: string;
}
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Block[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    : typeof content === 'string'
      ? content
      : '';

/** 把 dsh 的一条通知翻译成 Oasis 的运行事件；不关心的返回 undefined。 */
export function translateNotification(method: string, params: unknown): AgentEvent | undefined {
  const p = (params ?? {}) as { status?: string; event?: { type?: string; data?: unknown } };
  if (method === 'session.status' && typeof p.status === 'string') {
    return { kind: 'status', data: { status: p.status } };
  }
  if (method !== 'session.event' || !p.event?.type) return undefined;
  const data = (p.event.data ?? {}) as Record<string, unknown>;
  switch (p.event.type) {
    case 'user/message': {
      // dsh 每一步还会插一条「运行时上下文」用户消息，只保留真正来自用户的
      const source = data.source as { kind?: string } | undefined;
      if (source?.kind !== 'user') return undefined;
      return { kind: 'user_message', data: { text: clip(textOf(data.content)) } };
    }
    case 'assistant/message': {
      const message = data.message as { content?: unknown } | undefined;
      const text = textOf(message?.content);
      // 模型调工具前常吐一段空白，不算它说了话
      return text.trim() ? { kind: 'assistant_text', data: { text: clip(text) } } : undefined;
    }
    case 'tool/call':
      return {
        kind: 'tool_call',
        data: {
          callId: data.callId,
          name: data.name,
          arguments: clip(String(data.arguments ?? '')),
        },
      };
    case 'tool/result': {
      const message = data.message as
        { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
      const error = data.error as { reason?: string } | undefined;
      return {
        kind: 'tool_result',
        data: {
          callId: message?.toolCallId,
          ok: !message?.isError,
          text: clip(textOf(message?.content)),
          ...(error?.reason ? { error: clip(error.reason) } : {}),
        },
      };
    }
    case 'turn/end': {
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === 'error') {
        return { kind: 'error', data: { message: clip(reason.error?.message ?? '模型调用失败') } };
      }
      if (reason?.kind === 'completed') return { kind: 'turn_end', data: { reason: 'completed' } };
      const kind = reason?.kind ?? 'unknown';
      return {
        kind: 'error',
        data: {
          reason: kind,
          message:
            kind === 'max-tokens'
              ? '输出达到 token 上限，运行未完成'
              : `运行未正常结束：${clip(kind)}`,
        },
      };
    }
    default:
      return undefined;
  }
}

/** 一个根会话及其原生托管代理树。子会话的终态不参与根会话完成判定。 */
export function connectAgent(io: {
  stdin: Writable;
  stdout: Readable;
  sessionId: string;
  goal?: boolean;
  onEvent: (event: AgentEvent) => void;
}) {
  let lastError: string | undefined = '运行未收到正常结束通知';
  let pendingTurns = 0;
  /** 有用户消息进了会话、还没等到它所在那一轮的结束通知 */
  let awaitingEnd = false;
  let goalPhase: string | undefined;
  let persistent = io.goal ?? false;
  let goalActivation: unknown;
  let goalBlocker: string | undefined;
  let failureReason: unknown;
  let revision = 0;
  const listeners = new Set<() => void>();
  const parents = new Map<string, string>();
  const belongs = (id: string): boolean =>
    id === io.sessionId || (parents.has(id) && belongs(parents.get(id)!));
  const changed = () => {
    revision++;
    for (const listener of listeners) listener();
    listeners.clear();
  };
  const rpc = createJsonRpcClient({
    input: io.stdout,
    output: io.stdin,
    onClose: (error) => {
      lastError = error.message;
      changed();
    },
    onNotification: (method, params) => {
      const p = (params ?? {}) as {
        sessionId?: string;
        parentSessionId?: string;
        childSessionId?: string;
        status?: string;
        event?: { type?: string; data?: Record<string, unknown> };
      };
      if (
        method === 'subagent.started' &&
        p.parentSessionId &&
        p.childSessionId &&
        belongs(p.parentSessionId)
      ) {
        parents.set(p.childSessionId, p.parentSessionId);
        io.onEvent({
          kind: 'status',
          data: {
            status: 'subagent_started',
            sessionId: p.childSessionId,
            parentSessionId: p.parentSessionId,
          },
        });
        return;
      }
      if ((method === 'session.event' || method === 'session.status') && !p.sessionId) {
        rpc.abort(new Error('会话通知缺少 sessionId，不能判断根会话是否完成'));
        return;
      }
      if (p.sessionId && !belongs(p.sessionId)) return;
      const root = !p.sessionId || p.sessionId === io.sessionId;
      if (p.event?.type === 'plugin:oasis/goal-status') {
        if (root) {
          goalPhase = p.event.data?.phase as string | undefined;
          goalActivation = p.event.data?.activation;
          changed();
        }
        io.onEvent({
          kind: 'status',
          data: {
            status: 'goal_status',
            sessionId: p.sessionId,
            goalPhase: p.event.data?.phase,
            goalActivation: p.event.data?.activation,
          },
        });
        return;
      }
      if (p.event?.type === 'goal/change') {
        const goal = p.event.data?.goal as
          { phase?: string; blockedReason?: { message?: string } } | undefined;
        if (root) {
          if (goal?.phase) persistent = true;
          goalPhase = goal?.phase;
          goalBlocker = goal?.blockedReason?.message;
          changed();
        }
        io.onEvent({
          kind: 'status',
          data: {
            status: 'goal_changed',
            sessionId: p.sessionId,
            goalPhase: goal?.phase,
            ...(goal?.blockedReason ? { blocker: goal.blockedReason.message } : {}),
          },
        });
        return;
      }
      const event = translateNotification(method, params);
      if (!event) return;
      if (root) {
        // 发出的每条消息进了会话历史就算处理了：运行中的追问可能被插进当前这一轮（node-goal 插件），
        // 不再单独开一轮，所以不能按轮次结束来数
        if (event.kind === 'user_message') {
          pendingTurns = Math.max(0, pendingTurns - 1);
          awaitingEnd = true;
        }
        if (event.kind === 'error' || event.kind === 'turn_end') {
          awaitingEnd = false;
          lastError = event.kind === 'error' ? String(event.data.message) : undefined;
          failureReason = event.data.reason;
        }
        changed();
      }
      io.onEvent({
        ...event,
        data: {
          ...event.data,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
          ...(!root && p.sessionId ? { parentSessionId: parents.get(p.sessionId) } : {}),
        },
      });
    },
  });
  const session = { sessionId: io.sessionId };
  return {
    initialize: (model: string, cwd: string, reasoningEffort?: string) =>
      rpc.request(
        'initialize',
        { cwd, provider: PROVIDER, model, ...(reasoningEffort ? { reasoningEffort } : {}) },
        60_000,
      ),
    resume: async () => {
      const result = await rpc.request('session/resume', session, 60_000);
      lastError = undefined;
      return { result, needsPrompt: persistent && !goalPhase };
    },
    prompt: (text: string) => {
      pendingTurns++;
      lastError = '运行未收到正常结束通知';
      return rpc.request(
        'session/prompt',
        { ...session, contentBlocks: [{ type: 'text', text }] },
        30_000,
      );
    },
    async waitIdle(): Promise<string | undefined> {
      try {
        for (;;) {
          const seen = revision;
          await rpc.request('session/wait', session);
          if (lastError && !persistent) return lastError;
          if (pendingTurns > 0 || awaitingEnd) return lastError ?? '运行未收到正常结束通知';
          if (!persistent || goalPhase === 'complete') return lastError;
          if (goalPhase !== 'active')
            return goalBlocker ?? '持续目标未完成：' + (goalPhase ?? '没有目标状态');
          if (goalActivation === 'disarmed' && failureReason !== 'max-tokens')
            return lastError ?? '持续目标停止了自动执行，尚未完成';
          // 原生驱动可能正在 flush/checkpoint；中间 idle 不等于目标结束。
          if (seen === revision) await new Promise<void>((resolve) => listeners.add(resolve));
        }
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    shutdown: () => rpc.request('shutdown', undefined, 10_000),
    abort: (error: Error) => {
      lastError = error.message;
      rpc.abort(error);
      changed();
    },
  };
}
export type AgentConnection = ReturnType<typeof connectAgent>;
