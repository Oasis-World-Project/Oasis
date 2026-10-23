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
import { TaskBody, type DecisionBody, type TaskStatus } from '@oasis/contracts/task';
import { queryOptions } from '@tanstack/react-query';
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
/** 不会再变的状态：不用再轮询 */
export const SETTLED_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

/** 还在动的任务每 2.5 秒刷新一次（进度、花费、需要处理）；结束后不再刷新 */
export const taskQuery = (taskId: string) =>
  queryOptions({
    queryKey: ['task', taskId],
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
