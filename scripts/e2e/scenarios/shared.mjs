// 回归场景共用的小工具：开私聊说第一句话、等一轮做完（出错了说「继续」）、按一轮找消息、
// harness 里的每一轮、模拟持久卷被清掉。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { literal, query } from '../db.mjs';
import { marker } from '../fake-provider.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

/**
 * 模拟持久卷被清掉（docker volume prune、换了机器）：删掉这个会话的工作目录和 dsh 会话。
 * 一轮做完沙箱会空着留一会儿、还挂着卷，先连它一起删掉
 */
export function dropWorkspace(sessionId) {
  const listed = spawnSync(
    'docker',
    ['ps', '-aq', '--filter', `label=oasis.session-id=${sessionId}`],
    { encoding: 'utf8' },
  );
  const containers = listed.stdout.split('\n').filter(Boolean);
  if (containers.length) spawnSync('docker', ['rm', '-f', ...containers], { stdio: 'ignore' });
  for (const name of [`oasis-workspace-${sessionId}`, `oasis-sessions-${sessionId}`]) {
    const result = spawnSync('docker', ['volume', 'rm', name], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`删不掉持久卷 ${name}：${result.stderr.trim()}`);
  }
}

/** 这个会话的持久工作目录还在不在 */
export const workspaceExists = (sessionId) =>
  spawnSync('docker', ['volume', 'inspect', `oasis-workspace-${sessionId}`], { stdio: 'ignore' })
    .status === 0;

/** 这个对话在 harness 里的每一轮（按开始的先后） */
export const runsOf = (conversationId) =>
  query(
    'harness',
    `select id, status, session_id, continue_from, error from runs where conversation_id = ${literal(conversationId)} order by created_at`,
  );

/** 开一个私聊、说第一句话（带上场景标记），返回对话 ID（场景结束时删掉） */
export async function start(t, scenario, text) {
  const conversationId = await t.user.openDm();
  t.track(conversationId);
  await t.user.say(conversationId, `${text} ${marker(scenario, 1)}`);
  return conversationId;
}

/** 等这一轮做完；出错了就像用户一样说「继续」（第 say 句话的脚本），再等一次。返回全部消息 */
export async function settle(t, conversationId, label, scenario, say) {
  let messages = await t.user.waitTurn(conversationId, label);
  const last = aiOf(messages).at(-1);
  if (last?.status === 'failed') {
    t.log(`这一轮出错了（${last.error}），说「继续」`);
    await t.user.say(conversationId, `继续 ${marker(scenario, say)}`);
    messages = await t.user.waitTurn(conversationId, `${label}（继续）`);
  }
  return messages;
}

/** AI 说的话（一轮插过话会分成几条）；给了 runId 只要这一轮的 */
export const aiOf = (messages, runId) =>
  messages.filter(
    (m) =>
      m.role === 'assistant' &&
      m.kind === 'text' &&
      (runId === undefined || m.data.runId === runId),
  );

/** 一轮的任务卡（用了生图这类工具或交了文件才有） */
export const cardOf = (messages, runId) =>
  messages.find((m) => m.kind === 'task' && m.data.runId === runId);
