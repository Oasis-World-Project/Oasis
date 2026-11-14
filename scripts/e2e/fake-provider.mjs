// 回归测试用的假 OpenRouter（docs/engineering/回归测试.md）：按场景脚本回复，记下每次调用供断言。
// 覆盖 model-gateway 用到的全部上游接口：价格表、chat completions（流式/非流式）、Jev 决策、生图、
// 生视频长任务、按生成 ID 查实际花费。私聊里干活的 AI（沙箱里的 dsh）按用户每句话的脚本做。
// 不联网、不花钱；行为照真实供应商：输出上限超过型号能力时拒单（2026-11-06 的 93 万 token 事故）。
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { MODEL_MAX_TOKENS, parseJson, segmentsOf, textOf } from './fake-dsh.mjs';
import { JPEG_IMAGE_MODEL, pickAnswer, VIDEO_MODELS } from './fake-media.mjs';

export { writeFiles } from './fake-dsh.mjs';

/**
 * 场景标记：用户每句话里写 [[e2e:场景@本轮编号/第几句]]，假模型按这句话的脚本做。
 * 本轮编号区分每次回归：上一轮没收尾的对话被接着做时，不会混进这一轮的场景里。
 */
let RUN = 'local';
export const setRun = (id) => {
  RUN = id;
};
export const marker = (scenario, say) => `[[e2e:${scenario}@${RUN}/${say}]]`;

/** 一张图要做多久（毫秒） */
export const IMAGE_MS = 1_500;

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
  /** 故障和挂起只发生一次（按 场景/句/段/步 记） */
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

  /** 上一轮回归留下的对话：直接拒单，让它尽快失败，不混进这一轮的记录 */
  function stale(res, kind) {
    record({ kind: 'stale', of: kind });
    return sendJson(res, 400, { error: { message: '上一轮回归留下的对话（假供应商拒绝）' } });
  }

  /**
   * 私聊里干活的 AI（沙箱里的 dsh）：按最近一句带标记的用户的话的脚本一步步做，做完说一句话。
   * 接管后的恢复提示接着那句话的脚本做，做过的步骤照算；被打断的那一步像真模型一样重做，最多三次。
   */
  function agentTurn(res, body, segments) {
    const at = segments.findLastIndex((s) => s.kind === 'say');
    if (at < 0) {
      const first = textOf(body.messages.find((m) => m.role === 'user')?.content);
      if (/\[\[e2e:/.test(first)) return stale(res, 'agent');
      violations.push(`dsh 请求里没有带 [[e2e:场景@轮/句]] 标记的用户的话：${first.slice(0, 120)}`);
      return answer(res, body, { text: '没有场景脚本。' });
    }
    const [, scenarioName, run, say] = segments[at].mark;
    if (run !== RUN) return stale(res, 'agent');
    const script = scenarios[scenarioName]?.says?.[say];
    const seg = segments.at(-1);
    // 上一步工具的输出也记下：排查时能看到命令实际跑出了什么
    const previous = seg.calls.at(-1);
    const entry = {
      kind: 'agent',
      scenario: scenarioName,
      say,
      segment: seg.kind,
      model: body.model,
      // 会话里攒着几句用户的话：大于 1 说明是接着原会话做的
      says: segments.filter((s) => s.kind === 'say').length,
      ...(previous
        ? { previous: `${previous.name}: ${(previous.result ?? '（没有结果）').slice(0, 600)}` }
        : {}),
      // 这一段里平台/dsh 插进来的其他消息（截断后的提醒……）开头
      ...(seg.notices.length ? { notices: seg.notices.map((n) => n.slice(0, 160)) } : {}),
    };
    if (!script) {
      violations.push(`场景 ${scenarioName} 没有第 ${say} 句话的脚本`);
      return answer(res, body, { text: '没有脚本。' });
    }
    const steps = script.steps ?? [];
    const done = segments.slice(at).flatMap((s) => s.calls);
    // 做成功了才算这一步过去：被打断（harness 接管后 dsh 报 unknown job）的那一步重做，最多三次
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
      const key = `${scenarioName}/${say}/${segments.length}/${seg.kind}/${index}`;
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
    record({ ...entry, action: 'done' });
    return answer(res, body, { text: script.reply ?? '做好了。' });
  }

  async function chat(res, body) {
    const max = body.max_completion_tokens ?? body.max_tokens;
    if (typeof max === 'number' && max > MODEL_MAX_TOKENS) {
      violations.push(`${body.model} 的输出上限 ${max} 超过型号能力 ${MODEL_MAX_TOKENS}`);
      return sendJson(res, 400, { error: { message: `max_tokens ${max} exceeds model limit` } });
    }
    const messages = body.messages ?? [];
    const firstUser = textOf(messages.find((m) => m.role === 'user')?.content);
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
    if (body.tools?.length) return agentTurn(res, body, segmentsOf(messages));
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
      // 像真的供应商一样要做一会儿：几张一起交时看得出是不是同时做的
      return setTimeout(
        () =>
          sendJson(res, 200, {
            data: [{ b64_json: image.toString('base64'), media_type: 'image/png' }],
            usage: { cost: 0.04 },
          }),
        IMAGE_MS,
      );
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
    /** 某个场景的调用（可再按第几句话筛） */
    of: (scenario, say) =>
      calls.filter((c) => c.scenario === scenario && (say === undefined || c.say === String(say))),
  };
}
