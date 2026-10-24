// 各页面用到的查询和操作。查询的 key 集中在这里，便于在操作后刷新对应数据。
import { ModelList } from '@oasis/contracts/agent';
import { WalletBody } from '@oasis/contracts/billing';
import {
  ConversationBody,
  ConversationList,
  IntakeResult,
  MessageList,
} from '@oasis/contracts/conversation';
import { MeBody, VerifyCodeResult } from '@oasis/contracts/identity';
import { RunEventList, type RunEventBody } from '@oasis/contracts/harness';
import {
  NodeRunList,
  TaskBody,
  WorkflowOptions,
  type DecisionBody,
  type PlanNode,
  type TaskStatus,
  type UpdateEdgeBody,
  type UpdateNodeBody,
} from '@oasis/contracts/task';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiError, apiVoid } from './client.ts';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: () => api('/identity/v1/me', MeBody),
  staleTime: 5 * 60_000,
  retry: false,
});

export const walletQuery = queryOptions({
  queryKey: ['wallet'],
  queryFn: () => api('/billing/v1/wallet', WalletBody),
  // 刚注册时赠送额度经事件异步到账，钱包可能还没建好：稍等重试
  retry: (count, error) =>
    error instanceof ApiError && error.code === 'wallet_not_ready' && count < 8,
  retryDelay: 1_500,
});

export const modelsQuery = queryOptions({
  queryKey: ['models'],
  queryFn: async () => (await api('/agent/v1/models', ModelList)).models,
  staleTime: 10 * 60_000,
});

export const dmsQuery = queryOptions({
  queryKey: ['dms'],
  queryFn: async () => (await api('/conversation/v1/dms', ConversationList)).conversations,
});

export const messagesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ['messages', conversationId],
    queryFn: async () =>
      (await api(`/conversation/v1/conversations/${conversationId}/messages`, MessageList))
        .messages,
  });

export const requestCode = (email: string) =>
  apiVoid('/identity/v1/auth/email-code', { method: 'POST', body: { email } });

export const verifyCode = (email: string, code: string) =>
  api('/identity/v1/auth/verify', VerifyCodeResult, { method: 'POST', body: { email, code } });

export const logout = () => apiVoid('/identity/v1/auth/logout', { method: 'POST', body: {} });

export const createDm = (modelKey: string) =>
  api('/conversation/v1/dms', ConversationBody, { method: 'POST', body: { modelKey } });

// ---- 在私聊里接任务（ADR 0005）：接口都返回这次新增的消息 ----
const intakePath = (conversationId: string, action: string) =>
  `/conversation/v1/conversations/${conversationId}/intake/${action}`;

const intakeCall = (conversationId: string, action: string, body: object) =>
  api(intakePath(conversationId, action), IntakeResult, { method: 'POST', body });

/** 从某条用户消息开始接需求（点了「当成任务来做」） */
export const startIntake = (conversationId: string, messageId: string) =>
  intakeCall(conversationId, 'start', { messageId });

/** 回答问题卡；skip = 直接开始，没答的按默认 */
export const answerIntake = (
  conversationId: string,
  answers: Record<string, string>,
  skip: boolean,
) => intakeCall(conversationId, 'answers', { answers, skip });

export const cancelIntake = (conversationId: string) => intakeCall(conversationId, 'cancel', {});

export const confirmIntake = (conversationId: string) => intakeCall(conversationId, 'confirm', {});

// ---- 任务 ----
/** 任务和它下面的节点运行、运行过程都挂在 ['task', id] 下，改了任务一起刷新 */
const taskKey = (taskId: string) => ['task', taskId] as const;
/** 不会再变的状态：不用再轮询 */
export const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/** 还在动的任务每 2.5 秒刷新一次（进度、花费、需要处理）；结束后不再刷新 */
export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: taskKey(taskId),
    queryFn: () => api(`/task/v1/tasks/${taskId}`, TaskBody),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      return status && SETTLED_STATUSES.has(status) ? false : 2_500;
    },
  });

const taskCall = (taskId: string, action: string, body: object = {}) =>
  apiVoid(`/task/v1/tasks/${taskId}/${action}`, { method: 'POST', body });

/** 需要处理时的选择：继续 / 再试（重新规划）/ 取消 */
export const decideTask = (taskId: string, choice: DecisionBody['choice']) =>
  taskCall(taskId, 'decision', { choice });

export const runTask = (taskId: string) => taskCall(taskId, 'run');
export const stopTask = (taskId: string) => taskCall(taskId, 'stop');
export const cancelTask = (taskId: string) => taskCall(taskId, 'cancel');

/** 节点交出的文件：预览直接用这个地址，download 时让浏览器另存 */
export function taskFileUrl(
  taskId: string,
  nodeId: string,
  path: string,
  download = false,
): string {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  return `/api/task/v1/tasks/${taskId}/files/${nodeId}/${encoded}${download ? '?download=1' : ''}`;
}

// ---- 工作流（ADR 0007 §6）----
const taskPath = (taskId: string) => `/task/v1/tasks/${taskId}`;
const nodePath = (taskId: string, nodeId: string) => `${taskPath(taskId)}/nodes/${nodeId}`;

/** 改工作流的接口都返回改完的任务 */
const taskChange = (path: string, method: string, body?: unknown) =>
  api(path, TaskBody, { method, body: body ?? {} });

export const runNode = (taskId: string, nodeId: string) =>
  taskChange(`${nodePath(taskId, nodeId)}/run`, 'POST');
export const stopNode = (taskId: string, nodeId: string) =>
  taskChange(`${nodePath(taskId, nodeId)}/stop`, 'POST');
export const addNode = (taskId: string, node: PlanNode) =>
  taskChange(`${taskPath(taskId)}/nodes`, 'POST', node);
export const updateNode = (taskId: string, nodeId: string, body: UpdateNodeBody) =>
  taskChange(nodePath(taskId, nodeId), 'PATCH', body);
export const deleteNode = (taskId: string, nodeId: string) =>
  taskChange(nodePath(taskId, nodeId), 'DELETE');
export const addEdge = (taskId: string, from: string, to: string) =>
  taskChange(`${taskPath(taskId)}/edges`, 'POST', { from, to });
export const updateEdge = (taskId: string, edgeId: string, body: UpdateEdgeBody) =>
  taskChange(`${taskPath(taskId)}/edges/${edgeId}`, 'PATCH', body);
export const deleteEdge = (taskId: string, edgeId: string) =>
  taskChange(`${taskPath(taskId)}/edges/${edgeId}`, 'DELETE');

/** 追问 / 补充要求：运行中的直接送达，还没开始、已停止的记下来，开跑时带上 */
export const messageNode = (taskId: string, nodeId: string, text: string) =>
  api(`${nodePath(taskId, nodeId)}/messages`, NodeMessageResult, {
    method: 'POST',
    body: { text },
  });
const NodeMessageResult = z.object({ result: z.enum(['delivered', 'noted']) });

/** 节点的每次运行；节点在动时跟着任务一起刷新 */
export const nodeRunsQuery = (taskId: string, nodeId: string, live: boolean) =>
  queryOptions({
    queryKey: [...taskKey(taskId), 'node', nodeId, 'runs'],
    queryFn: async () => (await api(`${nodePath(taskId, nodeId)}/runs`, NodeRunList)).runs,
    refetchInterval: live ? 2_500 : false,
  });

/** 一次运行的过程：运行中每 2 秒增量拉一次，接在已有的后面 */
export const runEventsQuery = (taskId: string, nodeId: string, runId: string, live: boolean) =>
  queryOptions({
    queryKey: [...taskKey(taskId), 'node', nodeId, 'events', runId],
    queryFn: async ({ client, queryKey }) => {
      const old = client.getQueryData<RunEventBody[]>(queryKey) ?? [];
      const after = old.at(-1)?.seq ?? -1;
      const { events } = await api(
        `${nodePath(taskId, nodeId)}/events?runId=${runId}&after=${after}`,
        RunEventList,
      );
      return [...old, ...events];
    },
    refetchInterval: live ? 2_000 : false,
  });

/** 编辑节点时能选的模型和工具 */
export const workflowOptionsQuery = queryOptions({
  queryKey: ['workflow-options'],
  queryFn: () => api('/task/v1/workflow/options', WorkflowOptions),
  staleTime: 5 * 60_000,
});
