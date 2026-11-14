// Oasis 的权限衔接：每个会话切到这一轮的权限档（OASIS_PERMISSION：只读 / 可改项目文件夹 / 完全访问，
// 超出时问不问），AI 要做超出权限的事（dsh 的 approval/request）时问 Oasis——在 model-gateway 登记一张
// 确认卡，等用户在聊天里点「允许一次 / 以后都允许 / 拒绝」。用户设了「超出时直接允许」（OASIS_APPROVAL=allow）
// 就不问、直接允许。问不到（断网、Oasis 出错）按 dsh 的规矩算没法问（fail closed）。
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const name = 'oasis-approval';
export const inject = ['permissionPresets'];

/** 每次最多等这么久再问一遍（Oasis 那边长轮询） */
const WAIT_SECONDS = 25;
const MODES = {
  'read-only': '只读',
  'workspace-write': '可改项目文件夹',
  'danger-full-access': '完全访问',
};

/** 确认卡上给人看的一句话：要哪一档权限、AI 说的理由（dsh 原文是 escalate sandbox to <档>: <理由>） */
export function describe(request) {
  const wanted = /^escalate sandbox to ([\w-]+):\s*([\s\S]*)$/.exec(request.reason ?? '');
  if (wanted)
    return `要用「${MODES[wanted[1]] ?? wanted[1]}」权限：${wanted[2].trim() || '没说理由'}`;
  return request.displayReason?.zh ?? request.reason ?? `要用 ${request.toolName}`;
}

export function apply(ctx) {
  const execution = JSON.parse(
    readFileSync(join(process.env.OASIS_IN ?? '/workspace/in', '.oasis-execution.json'), 'utf8'),
  );
  const preset = process.env.OASIS_PERMISSION;
  const answer = process.env.OASIS_APPROVAL ?? 'ask';
  const base = process.env.OASIS_MODEL_BASE_URL;
  const headers = {
    authorization: `Bearer ${process.env.OASIS_RUN_KEY}`,
    'content-type': 'application/json',
  };

  // 接着原会话时会话里记着上一轮的权限档；用户两轮之间改了设置，就切到这一轮的
  ctx.on('agent/created', ({ agent }) => {
    if (!preset || String(agent.session.id) !== execution.sessionId) return;
    if (ctx.permissionPresets.current(agent.session) !== preset)
      ctx.permissionPresets.set(agent.session, preset);
  });

  ctx.on('approval/request', async (request) => {
    if (answer === 'allow') return 'allowed-once';
    if (!base) return 'unavailable';
    const { signal } = request;
    let id;
    try {
      const created = await fetch(`${base}/confirmations`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text: describe(request),
          ...(request.callId ? { callId: request.callId } : {}),
        }),
        signal,
      });
      if (!created.ok) return 'unavailable';
      const card = await created.json();
      id = card.id;
      let { status } = card;
      // 用户这一轮点过「以后都允许」：登记时就是允许
      while (status === 'pending') {
        const response = await fetch(`${base}/confirmations/${id}?wait=${WAIT_SECONDS}`, {
          headers,
          signal,
        });
        if (!response.ok) return 'unavailable';
        ({ status } = await response.json());
      }
      return status === 'allowed' ? 'allowed-once' : status === 'denied' ? 'rejected' : 'cancelled';
    } catch {
      if (!signal?.aborted) return 'unavailable';
      // 这一轮停了或这一步取消了：卡片收回
      if (id)
        await fetch(`${base}/confirmations/${id}/cancel`, { method: 'POST', headers }).catch(
          () => undefined,
        );
      return 'cancelled';
    }
  });
}
