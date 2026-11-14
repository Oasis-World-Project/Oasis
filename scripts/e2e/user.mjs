// 回归测试里的「用户」：和桌面端一样只经 gateway 的 /api/* 说话（Cookie 登录、Origin 校验都照真的来）。
// 登录用本地邮件服务（mailpit）收验证码；在私聊里说话，等 AI 这一轮做完，到画布里看成果。
import { randomUUID } from 'node:crypto';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class ApiError extends Error {
  constructor(status, body, route) {
    super(
      `${route} → ${status} ${typeof body === 'string' ? body.slice(0, 400) : JSON.stringify(body).slice(0, 400)}`,
    );
    this.status = status;
    this.body = body;
  }
}

/** 对话最后几条消息，等不到时附在报错里 */
function describe(messages) {
  return messages
    .slice(-6)
    .map(
      (m) =>
        `  - ${m.role}/${m.kind} ${m.status}${m.error ? ` 出错：${m.error}` : ''}：${m.content.slice(0, 160).replaceAll('\n', ' ')}`,
    )
    .join('\n');
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

  const dm = (id) => `/conversation/v1/conversations/${id}`;
  const listOf = async (conversationId) =>
    (await api.get(`/canvas/v1/artifacts?conversationId=${conversationId}`)).artifacts;

  /** 成果在一轮结束时登记进画布：轮询这个对话的成果，直到满足条件（返回最后读到的全部成果） */
  async function waitList(conversationId, ready, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    let list = [];
    while (Date.now() < deadline) {
      list = await listOf(conversationId);
      if (ready(list)) return list;
      await sleep(1_000);
    }
    return list;
  }

  async function content(artifactId) {
    const response = await request('GET', `/canvas/v1/artifacts/${artifactId}/content`, undefined, {
      raw: true,
    });
    return Buffer.from(await response.arrayBuffer());
  }

  return {
    email,
    userId: signed.user.id,
    cookie: () => cookie,
    api,

    /** 和桌面端一样开一个私聊，返回对话 ID */
    async openDm() {
      const { models } = await api.get('/agent/v1/models');
      // 和用户平时一样用 DeepSeek 私聊：开发机所在地区有些模型用不了（真模型回归时会报地区不可用）
      const model =
        models.find((m) => m.available && /deepseek/i.test(m.key)) ??
        models.find((m) => m.available);
      if (!model) throw new Error('没有可用的私聊模型');
      return (await api.post('/conversation/v1/dms', { modelKey: model.key })).id;
    },
    /** 说一句话：开一轮，或插话进正在进行的一轮；extra 可以带 artifacts（让 AI 改的画布成果） */
    say: (conversationId, content, extra = {}) =>
      api.post(`${dm(conversationId)}/messages`, { content, ...extra }),
    messages: (conversationId) => api.get(`${dm(conversationId)}/messages`),
    /** 等这一轮（和收尾时留下的话接着开的一轮）做完，返回全部消息 */
    async waitTurn(conversationId, label, timeoutMs = 600_000) {
      const deadline = Date.now() + timeoutMs;
      let list;
      while (Date.now() < deadline) {
        list = await api.get(`${dm(conversationId)}/messages`);
        if (!list.turn && !list.messages.some((m) => m.status === 'streaming'))
          return list.messages;
        await sleep(1_000);
      }
      throw new Error(`等「${label}」超时：\n${list ? describe(list.messages) : '没读到消息'}`);
    },
    stop: (conversationId) => api.post(`${dm(conversationId)}/stop`),
    newTopic: (conversationId) => api.post(`${dm(conversationId)}/topics`),
    /** 删除这个用户的私聊（真删除：进行中的一轮先取消，成果、会话记录、工作目录一起删）；返回删了几个 */
    async removeDms(ids) {
      const { conversations } = await api.get('/conversation/v1/dms');
      const targets = conversations.filter((c) => !ids || ids.includes(c.id));
      for (const c of targets) await api.del(dm(c.id));
      return targets.length;
    },
    artifacts: listOf,
    /** 等到这些文件都在（返回全部成果） */
    waitArtifacts: (conversationId, paths, timeoutMs = 60_000) =>
      waitList(
        conversationId,
        (list) => paths.every((p) => list.some((a) => a.path === p)),
        timeoutMs,
      ),
    /** 应用描述在这一轮的文件全部登记完之后才写：等到画布里有这种可运行的应用（返回全部成果） */
    waitApplication: (conversationId, kind = 'static', timeoutMs = 60_000) =>
      waitList(conversationId, (list) => list.some((a) => a.application?.kind === kind), timeoutMs),
    /** 改过的成果在画布里原地换新：等到某个文件的内容符合预期（返回最后读到的内容） */
    async waitContent(conversationId, file, expected, timeoutMs = 60_000) {
      const deadline = Date.now() + timeoutMs;
      let text = '';
      while (Date.now() < deadline) {
        const found = (await listOf(conversationId)).filter((a) => a.path === file);
        for (const artifact of found) {
          text = (await content(artifact.id)).toString();
          if (expected(text)) return text;
        }
        await sleep(1_000);
      }
      return text;
    },
    content,
    wallet: () => api.get('/billing/v1/wallet'),
  };
}
