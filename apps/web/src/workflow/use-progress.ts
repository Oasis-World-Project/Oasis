// 每样「一个 AI 做」的成果做到哪了：从它各次运行的事件里取 AI 自己列的任务清单和最近几步。
// 和节点详情里的运行过程用的是同一份查询（同一个缓存，运行中才增量刷新），不另外拉数据。
import type { RunEventBody } from '@oasis/contracts/harness';
import type { NodeBody, NodeRunBody } from '@oasis/contracts/task';
import { useQueries } from '@tanstack/react-query';
import { useMemo } from 'react';
import { nodeRunsQuery, runEventsQuery } from '../api/queries.ts';
import { isAgentOutcome, isLiveRun, progressOf, type Progress } from './rules.ts';

const runsOf = (results: { data?: NodeRunBody[] | undefined }[]) => results.map((r) => r.data);
const eventsOf = (results: { data?: RunEventBody[] | undefined }[]) => results.map((r) => r.data);

/** nodes：现在显示的这一版的节点；before：看旧版工作流时只算这一版冻结之前的运行 */
export function useProgress(
  taskId: string,
  nodes: NodeBody[] | undefined,
  before?: string,
): Map<string, Progress> {
  // 还没开始的成果没有运行，不用查
  const agents = useMemo(
    () => (nodes ?? []).filter((n) => isAgentOutcome(n) && n.startedAt),
    [nodes],
  );
  const runs = useQueries({
    queries: agents.map((n) =>
      nodeRunsQuery(taskId, n.id, n.status === 'running' || n.status === 'checking'),
    ),
    combine: runsOf,
  });
  const pairs = useMemo(
    () =>
      agents.flatMap((node, index) =>
        (runs[index] ?? [])
          .filter((run) => !before || run.createdAt <= before)
          .map((run) => ({ nodeId: node.id, run })),
      ),
    [agents, runs, before],
  );
  const events = useQueries({
    queries: pairs.map(({ nodeId, run }) => runEventsQuery(taskId, nodeId, run.id, isLiveRun(run))),
    combine: eventsOf,
  });
  return useMemo(() => {
    const byNode = new Map<string, RunEventBody[][]>();
    pairs.forEach(({ nodeId }, index) => {
      byNode.set(nodeId, [...(byNode.get(nodeId) ?? []), events[index] ?? []]);
    });
    return new Map([...byNode].map(([nodeId, lists]) => [nodeId, progressOf(lists)]));
  }, [pairs, events]);
}
