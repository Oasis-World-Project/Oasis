// oasis-tool 和 Oasis 工具服务说话：经入口代理（在用户电脑上是网页地址上的 gateway）连 model-gateway，
// 带本次运行的临时 Key；花钱的工具设了「问我」时，等用户在聊天里点确认卡。只依赖 Node 自带的能力。

/** 命令的输出（AI 读的就是这些） */
export const say = (text: string) => process.stdout.write(`${text}\n`);

/** 一次命令最多等多久（秒），免得超过运行命令的时间限制 */
export const waitSeconds = () => Number(process.env.OASIS_TOOL_WAIT_SECONDS) || 100;

export async function openRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.OASIS_MODEL_BASE_URL;
  // 在 dsh 的命令里只有 OASIS_TOOL_AUTH（OASIS_RUN_KEY 会被 dsh 去掉）
  const key = process.env.OASIS_TOOL_AUTH ?? process.env.OASIS_RUN_KEY;
  if (!base || !key) throw new Error('这里不是 Oasis 的沙箱，用不了 oasis-tool');
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
      authorization: `Bearer ${key}`,
    },
  });
  if (response.ok) return response;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  throw Object.assign(new Error(body.error?.message ?? `工具服务返回 ${response.status}`), {
    code: body.error?.code,
    status: response.status,
  });
}

export async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  return (await openRequest(path, init)).json();
}

/**
 * 等用户点花钱工具的确认卡（最多等一次命令的时长）。没点就告诉 AI 先做别的、回头重跑同一条命令——
 * 还是这张卡，不会重复问。
 */
export async function confirmed(id: string): Promise<void> {
  say('这个工具要花钱，用户设了先问一声：等用户在聊天里确认……');
  const deadline = Date.now() + waitSeconds() * 1000;
  for (;;) {
    const wait = Math.max(1, Math.min(25, Math.ceil((deadline - Date.now()) / 1000)));
    const { status } = (await request(`/confirmations/${id}?wait=${wait}`)) as { status: string };
    if (status === 'allowed') {
      say('用户同意了，开始调用。');
      return;
    }
    if (status === 'denied')
      throw new Error('用户没同意用这个工具，没有调用、没有花钱；换别的办法，或问问用户');
    if (status !== 'pending') throw new Error('这次确认收回了，没有调用、没有花钱');
    if (Date.now() >= deadline)
      throw new Error(
        '用户还没确认，没有调用、没有花钱。先做别的，过一会儿再运行同一条命令（不会重复问）',
      );
  }
}
