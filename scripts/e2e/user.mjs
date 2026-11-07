// 回归测试里的「用户」：和桌面端一样只经 gateway 的 /api/* 说话（Cookie 登录、Origin 校验都照真的来）。
// 登录用本地邮件服务（mailpit）收验证码；发任务走私聊接需求 → 确认任务单 → 等任务结束。
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const FINAL = ['succeeded', 'failed', 'cancelled'];

class ApiError extends Error {
  constructor(status, body, route) {
    super(
      `${route} → ${status} ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`,
    );
    this.status = status;
    this.body = body;
  }
}

/** 任务现在的样子，失败时附在报错里 */
function describeTask(task) {
  const nodes = task.nodes
    .map(
      (n) =>
        `  - ${n.key} ${n.status} attempts=${n.attempts} reworks=${n.reworks}${n.warning ? ` warning=${n.warning}` : ''}`,
    )
    .join('\n');
  return `任务 ${task.id} ${task.status}${task.attention ? ` attention=${JSON.stringify(task.attention)}` : ''}\n${nodes}`;
}

/**
 * @param {{ gateway: string, mailpit: string, origin: string, email?: string }} options
 */
export async function signIn(options) {
  const email = options.email ?? `e2e-${randomUUID().slice(0, 8)}@example.test`;
  let cookie = '';

  async function request(method, route, body, { raw = false, timeoutMs = 60_000 } = {}) {
    const response = await fetch(`${options.gateway}/api${route}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(method === 'GET' ? {} : { origin: options.origin }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const set = response.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
    if (raw) {
      if (!response.ok) throw new ApiError(response.status, await response.text(), route);
      return response;
    }
    const text = await response.text();
    const value = text ? JSON.parse(text) : undefined;
    if (!response.ok) throw new ApiError(response.status, value ?? text, route);
    return value;
  }

  const api = {
    get: (route, opts) => request('GET', route, undefined, opts),
    post: (route, body = {}, opts) => request('POST', route, body, opts),
    del: (route) => request('DELETE', route),
  };

  // ---- 登录：要验证码 → 本地邮件服务里取 → 换会话 Cookie ----
  await api.post('/identity/v1/auth/email-code', { email });
  let code;
  for (let i = 0; i < 40 && !code; i++) {
    const found = await (
      await fetch(`${options.mailpit}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)
    ).json();
    const message = found.messages?.find((m) => m.To?.some((to) => to.Address === email));
    if (message) {
      const mail = await (await fetch(`${options.mailpit}/api/v1/message/${message.ID}`)).json();
      code = mail.Text.match(/\b\d{6}\b/)?.[0];
    }
    if (!code) await sleep(500);
  }
  if (!code) throw new Error(`验证码邮件没收到：${email}`);
  const signed = await api.post('/identity/v1/auth/verify', { email, code });
  for (let i = 0; i < 40; i++) {
    try {
      await api.get('/billing/v1/wallet');
      break;
    } catch (err) {
      if (i === 39) throw err;
      await sleep(500);
    }
  }

  /** 私聊发消息：SSE 流，收集每条 done 消息 */
  async function send(conversationId, content) {
    const response = await request(
      'POST',
      `/conversation/v1/conversations/${conversationId}/messages`,
      { content, asTask: true },
      { raw: true, timeoutMs: 300_000 },
    );
    const text = await response.text();
    const events = text
      .split(/\r?\n\r?\n/)
      .map((block) =>
        block
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n'),
      )
      .filter(Boolean)
      .map((data) => JSON.parse(data));
    const error = events.find((e) => e.type === 'error');
    if (error) throw new Error(`发消息出错：${error.code} ${error.message}`);
    return events.filter((e) => e.type === 'done').map((e) => e.message);
  }

  return {
    email,
    userId: signed.user.id,
    cookie: () => cookie,
    api,

    /** 和桌面端一样发一个任务：新开私聊 → 「发任务」→ 任务单 → 按标准档确认。返回 taskId */
    async createTask(content) {
      const { models } = await api.get('/agent/v1/models');
      // 和用户平时一样用 DeepSeek 私聊：开发机所在地区有些模型用不了（真模型回归时会报地区不可用）
      const model =
        models.find((m) => m.available && /deepseek/i.test(m.key)) ??
        models.find((m) => m.available);
      if (!model) throw new Error('没有可用的私聊模型');
      const dm = await api.post('/conversation/v1/dms', { modelKey: model.key });
      let messages = await send(dm.id, content);
      for (let round = 0; round < 3 && !messages.some((m) => m.kind === 'sheet'); round++) {
        const questions = messages.find((m) => m.kind === 'questions');
        if (!questions) break;
        ({ messages } = await api.post(
          `/conversation/v1/conversations/${dm.id}/intake/answers`,
          { messageId: questions.id, answers: {}, skip: true },
          { timeoutMs: 300_000 },
        ));
      }
      const sheet = messages.find((m) => m.kind === 'sheet');
      if (!sheet) throw new Error(`没收到任务单：${JSON.stringify(messages).slice(0, 500)}`);
      const confirmed = await api.post(
        `/conversation/v1/conversations/${dm.id}/intake/confirm`,
        { tier: 'standard' },
        { timeoutMs: 120_000 },
      );
      const card = confirmed.messages.find(
        (m) => m.kind === 'task' || (m.kind === 'sheet' && m.data.taskId),
      );
      const taskId = card?.data.taskId;
      if (!taskId)
        throw new Error(`确认任务单后没拿到任务：${JSON.stringify(confirmed).slice(0, 500)}`);
      return { taskId, conversationId: dm.id, quote: sheet.data.quote };
    },

    task: (taskId) => api.get(`/task/v1/tasks/${taskId}`),

    /** 等任务到某个状态；任务提前失败或取消时带上现状报错 */
    async waitTask(taskId, until, label, timeoutMs = 600_000) {
      const deadline = Date.now() + timeoutMs;
      let task;
      while (Date.now() < deadline) {
        task = await api.get(`/task/v1/tasks/${taskId}`);
        if (until(task)) return task;
        // 结束了、或停下来等用户处理（不是在等的那种）：不用再等
        if (FINAL.includes(task.status) || task.status === 'needs_attention')
          throw new Error(
            `等「${label}」时任务${task.status === 'needs_attention' ? '需要处理' : '已经结束'}：\n${describeTask(task)}`,
          );
        await sleep(1_000);
      }
      throw new Error(`等「${label}」超时：\n${task ? describeTask(task) : '没读到任务'}`);
    },

    messages: async (conversationId) =>
      (await api.get(`/conversation/v1/conversations/${conversationId}/messages`)).messages,
    artifacts: async (taskId) => (await api.get(`/canvas/v1/artifacts?taskId=${taskId}`)).artifacts,
    /** 画布在收到交付事件后才登记成果：等到这些文件都在（返回全部成果） */
    async waitArtifacts(taskId, paths, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let list = [];
      while (Date.now() < deadline) {
        list = (await api.get(`/canvas/v1/artifacts?taskId=${taskId}`)).artifacts;
        if (paths.every((p) => list.some((a) => a.path === p))) return list;
        await sleep(1_000);
      }
      return list;
    },
    /** 修改后画布原地更新成果：等到某个文件的内容符合预期（返回最后读到的内容） */
    async waitContent(taskId, file, expected, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        const found = (await api.get(`/canvas/v1/artifacts?taskId=${taskId}`)).artifacts.find(
          (a) => a.path === file,
        );
        if (found) {
          const response = await request(
            'GET',
            `/canvas/v1/artifacts/${found.id}/content`,
            undefined,
            { raw: true },
          );
          text = Buffer.from(await response.arrayBuffer()).toString();
          if (expected(text)) return text;
        }
        await sleep(1_000);
      }
      return text;
    },
    /** 取消并删除这个用户的任务（真删除）；返回删了几个 */
    async removeTasks(ids) {
      const { tasks } = await api.get('/task/v1/tasks');
      const targets = tasks.filter((t) => !ids || ids.includes(t.id));
      for (const t of targets) {
        if (!FINAL.includes(t.status)) await api.post(`/task/v1/tasks/${t.id}/cancel`);
        for (let i = 0; i < 120; i++) {
          if (FINAL.includes((await api.get(`/task/v1/tasks/${t.id}`)).status)) break;
          await sleep(1_000);
        }
        await api.del(`/task/v1/tasks/${t.id}`);
      }
      return targets.length;
    },
    async content(artifactId) {
      const response = await request(
        'GET',
        `/canvas/v1/artifacts/${artifactId}/content`,
        undefined,
        {
          raw: true,
        },
      );
      return Buffer.from(await response.arrayBuffer());
    },
    nodeRuns: async (taskId, nodeId) =>
      (await api.get(`/task/v1/tasks/${taskId}/nodes/${nodeId}/runs`)).runs,
    revise: (taskId, body) => api.post(`/task/v1/tasks/${taskId}/revisions`, body),
    decide: (taskId, choice) => api.post(`/task/v1/tasks/${taskId}/decision`, { choice }),
    stop: (taskId) => api.post(`/task/v1/tasks/${taskId}/stop`),
    run: (taskId) => api.post(`/task/v1/tasks/${taskId}/run`),
    remove: (taskId) => api.del(`/task/v1/tasks/${taskId}`),
    wallet: () => api.get('/billing/v1/wallet'),
  };
}
