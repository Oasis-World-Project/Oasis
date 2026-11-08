// 回归测试用的假 OpenRouter（docs/engineering/回归测试.md）：按场景脚本回复，记下每次调用供断言。
// 覆盖 model-gateway 用到的全部上游接口：价格表、chat completions（流式/非流式）、Jev 决策、生图、
// 生视频长任务、按生成 ID 查实际花费。规划员和节点里的 dsh 由脚本驱动，含持续目标（get_goal → update_goal）。
// 不联网、不花钱；行为照真实供应商：输出上限超过型号能力时拒单（2026-11-06 的 93 万 token 事故）。
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import {
  GOAL_TOOLS,
  MODEL_MAX_TOKENS,
  parseJson,
  planContext,
  segmentsOf,
  textOf,
  writeFiles,
} from './fake-dsh.mjs';
import { JPEG_IMAGE_MODEL, pickAnswer, VIDEO_MODELS } from './fake-media.mjs';

export { writeFiles } from './fake-dsh.mjs';

/**
 * 场景标记：用户原话里写 [[e2e:场景@本轮编号]]，假规划员把 [[e2e:场景@本轮编号/节点]] 写进每个节点的目标。
 * 本轮编号区分每次回归：上一轮没收尾的任务被重试时，不会混进这一轮的场景里。
 */
let RUN = 'local';
export const setRun = (id) => {
  RUN = id;
};
export const marker = (scenario, node) => `[[e2e:${scenario}@${RUN}${node ? `/${node}` : ''}]]`;
const TASK_MARK = /\[\[e2e:([\w-]+)@(\w+)\]\]/;
const NODE_MARK = /\[\[e2e:([\w-]+)@(\w+)\/([\w-]+)\]\]/;

/**
 * @param {{
 *   scenarios: Record<string, object>,
 *   models: string[],
 *   fixtures: { png: Buffer, jpg: Buffer, mp4: Buffer },
 *   videoSeconds?: number,
 * }} options
 */
export function createFakeProvider(options) {
  const { scenarios, fixtures } = options;
  /** 每次请求的记录：场景断言用 */
  const calls = [];
  /** 不像真实供应商的地方（输出上限超标、看不懂的请求）：回归失败 */
  const violations = [];
  const generations = new Map();
  const videos = new Map();
  /** 故障和挂起只发生一次（按 场景/节点/段/步 记） */
  const fired = new Set();
  /** 挂起中的请求：重启 model-gateway 的场景要等它出现 */
  const hanging = new Set();

  const record = (entry) => {
    const call = { at: Date.now(), ...entry };
    calls.push(call);
    options.onRecord?.(call);
  };

  const usageOf = (body, cost) => {
    const prompt = Math.ceil(JSON.stringify(body.messages ?? body.state ?? '').length / 4);
    return { prompt_tokens: prompt, completion_tokens: 32, total_tokens: prompt + 32, cost };
  };

  function sendJson(res, status, value) {
    const text = JSON.stringify(value);
    res.writeHead(status, {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(text),
    });
    res.end(text);
  }

  /** 一次模型回答：文字或一次工具调用；流式按 OpenAI 的 SSE 帧，结束帧带用量和花费 */
  function answer(res, body, reply) {
    const id = `gen-${randomUUID()}`;
    const usage = usageOf(body, reply.cost ?? 0.0002);
    generations.set(id, usage.cost);
    const finish = reply.call ? 'tool_calls' : (reply.finish ?? 'stop');
    const message = reply.call
      ? {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              index: 0,
              id: `call-${randomUUID().slice(0, 8)}`,
              type: 'function',
              function: { name: reply.call.name, arguments: JSON.stringify(reply.call.args) },
            },
          ],
        }
      : { role: 'assistant', content: reply.text ?? '' };
    if (!body.stream) {
      sendJson(res, 200, {
        id,
        object: 'chat.completion',
        model: body.model,
        choices: [{ index: 0, message, finish_reason: finish }],
        usage,
      });
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (choices, extra = {}) =>
      `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created: 1, model: body.model, choices, ...extra })}\n\n`;
    if (reply.fault === 'disconnect') {
      // 回答到一半连接断了：没有结束帧、没有 [DONE]
      res.write(
        frame([
          { index: 0, delta: { role: 'assistant', content: '写到一半' }, finish_reason: null },
        ]),
      );
      setTimeout(() => res.socket?.destroy(), 30);
      return;
    }
    res.end(
      frame([{ index: 0, delta: message, finish_reason: null }]) +
        frame([{ index: 0, delta: {}, finish_reason: finish }], { usage }) +
        'data: [DONE]\n\n',
    );
  }

  /** 故障或挂起只触发一次；返回 true 表示这次已经按故障处理了 */
  function inject(res, body, step, key, entry) {
    if (!step.fault && !step.hang) return false;
    if (fired.has(key)) return false;
    fired.add(key);
    if (step.hang) {
      record({ ...entry, action: 'hang' });
      const pending = { key, at: Date.now() };
      hanging.add(pending);
      res.once('close', () => hanging.delete(pending));
      return true; // 不回答：等调用方（model-gateway）断开
    }
    record({ ...entry, action: `fault:${step.fault}` });
    if (step.fault === 'error500')
      sendJson(res, 500, { error: { message: '上游临时错误（回归测试注入）' } });
    else if (step.fault === 'length') answer(res, body, { text: '输出被截断', finish: 'length' });
    else answer(res, body, { fault: 'disconnect' });
    return true;
  }

  /** 上一轮回归留下的任务：直接拒单，让它尽快失败，不混进这一轮的记录 */
  function stale(res, kind) {
    record({ kind: 'stale', of: kind });
    return sendJson(res, 400, { error: { message: '上一轮回归留下的任务（假供应商拒绝）' } });
  }

  /** 节点里的 dsh：按段执行场景脚本，脚本做完再走持续目标的完成流程 */
  function nodeTurn(res, body, segments) {
    const head = segments.find((s) => s.kind === 'work') ?? segments[0];
    const found = head.text.match(NODE_MARK);
    if (!found) {
      if (/\[\[e2e:/.test(head.text)) return stale(res, 'node');
      violations.push(`节点提示里没有 [[e2e:场景@轮/节点]] 标记：${head.text.slice(0, 80)}`);
      return answer(res, body, { text: '没有场景脚本。' });
    }
    const [, scenarioName, run, nodeKey] = found;
    if (run !== RUN) return stale(res, 'node');
    const script = scenarios[scenarioName]?.nodes?.[nodeKey];
    const seg = segments.at(-1);
    // 上一步工具的输出也记下：排查时能看到命令实际跑出了什么
    const previous = seg.calls.at(-1);
    const entry = {
      kind: 'node',
      scenario: scenarioName,
      node: nodeKey,
      segment: seg.kind,
      model: body.model,
      segments: segments.length,
      ...(previous
        ? { previous: `${previous.name}: ${(previous.result ?? '（没有结果）').slice(0, 600)}` }
        : {}),
      // 这一段里平台/dsh 插进来的其他消息（持续目标续跑、截断后的提醒……）开头
      ...(seg.notices.length ? { notices: seg.notices.map((n) => n.slice(0, 160)) } : {}),
    };
    if (!script) {
      violations.push(`场景 ${scenarioName} 没有节点 ${nodeKey} 的脚本`);
      return answer(res, body, { text: '没有脚本。' });
    }
    const steps = script[seg.kind] ?? (seg.kind === 'recover' ? script.resume : undefined) ?? [];
    const done = seg.calls.filter((c) => !GOAL_TOOLS.has(c.name));
    // 做成功了才算这一步过去：被打断（harness 接管后 dsh 报 unknown job）的那一步像真模型一样重做，最多三次
    let index = 0;
    let tries = 0;
    for (const call of done) {
      const failed = call.result === undefined || /^Error:/.test(call.result.trimStart());
      if (!failed || ++tries >= 3) {
        index++;
        tries = 0;
      }
    }
    if (index < steps.length) {
      const raw = steps[index];
      const step =
        typeof raw === 'function' ? raw({ seg, segments, done, last: done.at(-1)?.result }) : raw;
      const key = `${scenarioName}/${nodeKey}/${seg.kind}/${segments.length}/${index}`;
      if (inject(res, body, step, key, entry)) return;
      if (step.text !== undefined) {
        record({ ...entry, action: `text:${index}` });
        return answer(res, body, { text: step.text });
      }
      const call = step.bash
        ? {
            name: 'bash',
            args: { description: step.description ?? `第 ${index + 1} 步`, command: step.bash },
          }
        : { name: step.tool, args: step.args ?? {} };
      record({ ...entry, action: `${call.name}:${index}`, command: call.args.command });
      return answer(res, body, { call });
    }
    // 修复（关卡没过）是单轮的，不用持续目标；其余运行都要 update_goal complete 才算完
    if (seg.kind === 'rework') {
      record({ ...entry, action: 'done' });
      return answer(res, body, { text: script.summary ?? '已修好。' });
    }
    const goals = seg.calls.filter((c) => c.name === 'get_goal' || c.name === 'update_goal');
    const last = goals.at(-1);
    if (last?.name === 'update_goal' && parseJson(last.result)?.goal?.phase === 'complete') {
      record({ ...entry, action: 'done' });
      return answer(res, body, { text: script.summary ?? '已交付。' });
    }
    if (last?.name === 'get_goal') {
      const goal = parseJson(last.result)?.goal;
      if (goal && goal.phase !== 'complete') {
        record({ ...entry, action: 'update_goal' });
        return answer(res, body, {
          call: {
            name: 'update_goal',
            args: { goal_id: goal.id, revision: goal.revision, action: 'complete' },
          },
        });
      }
      if (!goal) violations.push(`${scenarioName}/${nodeKey}：持续目标运行里 get_goal 没有目标`);
      record({ ...entry, action: 'done' });
      return answer(res, body, { text: script.summary ?? '已交付。' });
    }
    if (goals.filter((c) => c.name === 'update_goal').length >= 3) {
      violations.push(
        `${scenarioName}/${nodeKey}：update_goal 连续失败：${last?.result?.slice(0, 200)}`,
      );
      return answer(res, body, { text: '目标没能标成完成。' });
    }
    record({ ...entry, action: 'get_goal' });
    return answer(res, body, { call: { name: 'get_goal', args: {} } });
  }

  /** 规划员（第一次规划、规划门退回后修改、修改成果时的规划）：写 out/plan.json，再说一句话 */
  function plannerTurn(res, body, segments) {
    const first = segments[0];
    const seg = segments.at(-1);
    const [, scenarioName, run] = first.text.match(TASK_MARK) ?? [];
    if ((run && run !== RUN) || (!run && first.text.includes('[[e2e:')))
      return stale(res, 'planner');
    const scenario = scenarios[scenarioName];
    const entry = {
      kind: first.kind === 'replan' ? 'replanner' : 'planner',
      scenario: scenarioName,
      segment: seg.kind,
      model: body.model,
    };
    if (!scenario) {
      violations.push(`规划员提示里没有场景标记：${first.text.slice(0, 80)}`);
      return answer(res, body, { text: '没有场景。' });
    }
    if (seg.calls.length) {
      record({ ...entry, action: 'done' });
      return answer(res, body, { text: '方案写好了。' });
    }
    const ctx = planContext(first.text);
    const pick = (preferred) =>
      ctx.models.includes(preferred) ? preferred : (ctx.models[0] ?? preferred);
    const plan =
      first.kind === 'replan'
        ? scenario.revisionPlan({
            ...ctx,
            pick,
            fix: seg.kind === 'planfix' ? seg.text : undefined,
          })
        : scenario.plan({ ...ctx, pick, fix: seg.kind === 'planfix' ? seg.text : undefined });
    record({ ...entry, action: 'write-plan', plan });
    answer(res, body, {
      call: {
        name: 'bash',
        args: {
          description: '写方案',
          command: writeFiles({ 'out/plan.json': JSON.stringify(plan, null, 2) }),
        },
      },
    });
  }

  /** 私聊里的 AI 接需求：直接按场景给出任务单 */
  function intakeTurn(res, body) {
    const content = textOf(body.messages.find((m) => m.role === 'user')?.content);
    const request =
      content
        .split('【用户的需求】\n')[1]
        ?.split(/\n\n【/)[0]
        ?.trim() ?? '';
    const [, name, run] = request.match(TASK_MARK) ?? [];
    if ((run && run !== RUN) || (!run && request.includes('[[e2e:'))) return stale(res, 'intake');
    const scenario = scenarios[name];
    record({ kind: 'intake', scenario: name, model: body.model });
    if (!scenario) violations.push(`接需求的原话里没有场景标记：${request.slice(0, 80)}`);
    const sheet = {
      title: scenario?.title ?? '回归测试任务',
      deliverables: scenario?.deliverables ?? [{ name: '成果', form: 'Markdown' }],
      criteria: scenario?.criteria ?? ['按要求交付'],
      style: [],
      budgetMicro: null,
      assumptions: [],
      requirements: [
        {
          id: 'r1',
          text: request.slice(0, 1000) || '按原话做',
          sources: [{ kind: 'request', quote: request.slice(0, 40) || '按原话做' }],
        },
      ],
    };
    answer(res, body, {
      text: JSON.stringify({
        type: 'sheet',
        intro: '好的，任务单如下。',
        questions: null,
        sheet,
        materialIds: null,
      }),
      cost: 0.0001,
    });
  }

  async function chat(res, body) {
    const max = body.max_completion_tokens ?? body.max_tokens;
    if (typeof max === 'number' && max > MODEL_MAX_TOKENS) {
      violations.push(`${body.model} 的输出上限 ${max} 超过型号能力 ${MODEL_MAX_TOKENS}`);
      return sendJson(res, 400, { error: { message: `max_tokens ${max} exceeds model limit` } });
    }
    const messages = body.messages ?? [];
    if (body.response_format?.json_schema?.name === 'oasis_intake') return intakeTurn(res, body);
    const firstUser = textOf(messages.find((m) => m.role === 'user')?.content);
    if (firstUser.startsWith('你在为一项交给 AI 团队的任务估工具用量')) {
      const [, name, run] = firstUser.match(TASK_MARK) ?? [];
      if (run && run !== RUN) return stale(res, 'quote');
      record({ kind: 'quote', scenario: name, model: body.model });
      return answer(res, body, {
        text: JSON.stringify({ tools: scenarios[name]?.quoteTools ?? [] }),
        cost: 0.0001,
      });
    }
    if (body.response_format?.json_schema?.name === 'evidence_decisions') {
      const keys = Object.keys(
        body.response_format.json_schema.schema?.properties?.answers?.properties ?? {},
      );
      record({ kind: 'decision-fallback', model: body.model });
      return answer(res, body, {
        text: JSON.stringify({
          answers: Object.fromEntries(keys.map((k) => [k, { type: 'noul', noul: 0.9 }])),
        }),
      });
    }
    if (textOf(messages.at(-1)?.content).includes('Output only the checkpoint text')) {
      record({ kind: 'checkpoint', model: body.model });
      return answer(res, body, { text: 'CHECKPOINT：接着做完当前目标。' });
    }
    const picked = pickAnswer(messages, firstUser);
    if (picked) {
      const { choice, reason, images } = picked;
      record({ kind: 'inspect', model: body.model, choice, images });
      return answer(res, body, { text: JSON.stringify({ choice, reason }), cost: 0.002 });
    }
    if (body.tools?.length) {
      const segments = segmentsOf(messages);
      if (!segments.length) {
        violations.push(`dsh 请求里认不出平台提示：${firstUser.slice(0, 120)}`);
        return answer(res, body, { text: '看不懂。' });
      }
      if (['plan', 'replan'].includes(segments[0].kind)) return plannerTurn(res, body, segments);
      return nodeTurn(res, body, segments);
    }
    record({ kind: 'chat', model: body.model });
    return answer(res, body, { text: '好的。', cost: 0.0001 });
  }

  function decisions(res, body) {
    record({ kind: 'decision', model: body.model, questions: Object.keys(body.questions ?? {}) });
    const answers = Object.fromEntries(
      Object.entries(body.questions ?? {}).map(([key, q]) => [
        key,
        q.type === 'noul' ? { type: 'noul', noul: 0.9 } : { type: q.type, choice: q.options?.[0] },
      ]),
    );
    sendJson(res, 200, { answers, usage: { input_tokens: 100, output_tokens: 0, cost: 0.00001 } });
  }

  function modelList() {
    return {
      data: options.models.map((id) => ({
        id,
        name: id,
        context_length: 200_000,
        top_provider: { max_completion_tokens: MODEL_MAX_TOKENS },
        architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
        supported_parameters: ['tools', 'reasoning', 'response_format', 'max_tokens'],
        pricing: { prompt: '0.000001', completion: '0.000002' },
      })),
    };
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://fake');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString();
    const body = raw ? (parseJson(raw) ?? {}) : {};
    const route = `${req.method} ${url.pathname}`;
    if (route === 'GET /api/v1/models') return sendJson(res, 200, modelList());
    if (route === 'POST /api/v1/chat/completions') return chat(res, body);
    if (route === 'POST /api/alpha/decisions') return decisions(res, body);
    if (route === 'GET /api/v1/generation') {
      const cost = generations.get(url.searchParams.get('id'));
      return cost === undefined
        ? sendJson(res, 404, { error: { message: 'not found' } })
        : sendJson(res, 200, { data: { total_cost: cost } });
    }
    if (route === 'POST /api/v1/images') {
      record({ kind: 'image', model: body.model, prompt: body.prompt });
      // 像 Seedream 一样：要 PNG、声明 PNG，实际回 JPEG（2026-11-08 真实小样踩到）
      const image = body.model === JPEG_IMAGE_MODEL ? fixtures.jpg : fixtures.png;
      return sendJson(res, 200, {
        data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }],
        usage: { cost: 0.04 },
      });
    }
    if (url.pathname.startsWith('/api/v1/images/models/'))
      return sendJson(res, 200, {
        endpoints: [{ supported_parameters: { input_references: { type: 'range', max: 4 } } }],
      });
    if (route === 'GET /api/v1/videos/models') return sendJson(res, 200, VIDEO_MODELS);
    if (route === 'POST /api/v1/videos') {
      const id = randomUUID();
      videos.set(id, { at: Date.now() });
      record({ kind: 'video.submit', model: body.model, id, prompt: body.prompt });
      return sendJson(res, 200, { id, status: 'pending' });
    }
    const video = url.pathname.match(/^\/api\/v1\/videos\/([\w-]+)(\/content)?$/);
    if (req.method === 'GET' && video) {
      const job = videos.get(video[1]);
      if (!job) return sendJson(res, 404, { error: { message: 'no such video' } });
      if (video[2]) {
        record({ kind: 'video.content', id: video[1] });
        res.writeHead(200, { 'content-type': 'video/mp4', 'content-length': fixtures.mp4.length });
        return res.end(fixtures.mp4);
      }
      const ready = Date.now() - job.at >= (options.videoSeconds ?? 12) * 1000;
      record({ kind: 'video.status', id: video[1], ready });
      return sendJson(
        res,
        200,
        ready ? { status: 'completed', usage: { cost: 0.25 } } : { status: 'pending' },
      );
    }
    violations.push(`没实现的上游接口：${route}`);
    return sendJson(res, 501, { error: { message: `fake provider does not implement ${route}` } });
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      violations.push(`假供应商出错：${err.stack ?? err}`);
      if (!res.headersSent) sendJson(res, 500, { error: { message: String(err) } });
      else res.destroy();
    });
  });

  return {
    calls,
    violations,
    hanging,
    async listen() {
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
      return `http://127.0.0.1:${server.address().port}`;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
    /** 等到某次调用出现（返回那条记录） */
    async waitFor(predicate, label, timeoutMs = 300_000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const hit = calls.find(predicate);
        if (hit) return hit;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`等不到：${label}`);
    },
    /** 某个场景的调用（可再按节点筛） */
    of: (scenario, node) =>
      calls.filter((c) => c.scenario === scenario && (node === undefined || c.node === node)),
  };
}
