// 回归场景共用的小工具：方案里的干活节点、把方案写成规划员交的格式、任务做完的判断、模拟持久卷被清掉。
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
    goal: `${marker(scenario, key)} ${goal}`,
    model: DEFAULT_MODEL,
    expects: [],
    ...extra,
  };
}

/**
 * 规划员交的方案按成果排（ADR 0030）。场景里按节点和连线写，这里换成成果：干活节点各是一样由 AI 做的成果，
 * 连到它的线是它的 needs；其余节点（工具、展开）同在一条生产线里。
 */
export function outcomes({ nodes, edges = [], deliverables }) {
  const lineNodes = nodes.filter((n) => n.kind !== 'work');
  const inLine = new Set(lineNodes.map((n) => n.key));
  return {
    outcomes: [
      ...nodes
        .filter((n) => n.kind === 'work')
        .map(({ kind: _kind, ...n }) => ({
          ...n,
          how: 'agent',
          needs: edges.filter((e) => e.to === n.key).map((e) => e.from),
        })),
      ...(lineNodes.length
        ? [
            {
              key: 'line',
              title: '生产线',
              how: 'line',
              nodes: lineNodes,
              edges: edges.filter((e) => inLine.has(e.to)),
            },
          ]
        : []),
    ],
    deliverables,
  };
}

export const done = (task) => task.status === 'succeeded';
