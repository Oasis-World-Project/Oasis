// 工作流上的操作（运行、停止、改节点、接线……）：同一时间只做一件事；
// 返回任务的操作直接换上最新的任务，再刷新这个任务下的一切（节点运行、运行过程）和额度。
import type { TaskBody } from '@oasis/contracts/task';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { taskQuery, walletQuery } from '../api/queries.ts';

export function useWorkflowActions(taskId: string) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(name: string, action: () => Promise<T>): Promise<T | undefined> => {
      const key = taskQuery(taskId).queryKey;
      setBusy(name);
      setError(null);
      try {
        const result = await action();
        if (result && typeof result === 'object' && 'nodes' in result) {
          queryClient.setQueryData(key, result as unknown as TaskBody);
        }
        return result;
      } catch (err) {
        setError(err instanceof ApiError ? err.message : '操作没成功，请重试');
        return undefined;
      } finally {
        setBusy(null);
        void queryClient.invalidateQueries({ queryKey: key });
        void queryClient.invalidateQueries({ queryKey: walletQuery.queryKey });
      }
    },
    [queryClient, taskId],
  );

  return { busy, error, run, clearError: () => setError(null) };
}

export type WorkflowActions = ReturnType<typeof useWorkflowActions>;
