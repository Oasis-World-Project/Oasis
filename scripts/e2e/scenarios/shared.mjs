// 回归场景共用的小工具：方案里的干活节点、任务做完的判断、模拟持久卷被清掉。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { marker } from '../fake-provider.mjs';

export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export const DEFAULT_MODEL = 'deepseek/deepseek-v4-pro-0813';

/** 模拟持久卷被清掉（docker volume prune、换了机器）：删掉这个会话的工作目录和 dsh 会话 */
export function dropWorkspace(sessionId) {
  for (const name of [`oasis-workspace-${sessionId}`, `oasis-sessions-${sessionId}`]) {
    const result = spawnSync('docker', ['volume', 'rm', name], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`删不掉持久卷 ${name}：${result.stderr.trim()}`);
  }
}

/** 方案里的一个干活节点 */
export function work(scenario, key, title, goal, extra) {
  return {
    key,
    title,
    kind: 'work',
    role: '',
    goal: `${marker(scenario, key)} ${goal}`,
    model: DEFAULT_MODEL,
    tools: [],
    checks: [],
    expects: [],
    ...extra,
  };
}

export const done = (task) => task.status === 'succeeded';
