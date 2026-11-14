// 各页面用到的查询和操作。查询的 key 集中在这里，便于在操作后刷新对应数据。
import { AiSettings, ModelEntry, ModelList, type SaveAiBody } from '@oasis/contracts/agent';
import { GroupList, GroupSnapshot, GroupInvite, GroupInvitePreview } from '@oasis/contracts/group';
import { WalletBody } from '@oasis/contracts/billing';
import { ArtifactBody, ArtifactList, type Annotation } from '@oasis/contracts/canvas';
import {
  ConversationBody,
  ConversationList,
  MessageBody,
  MessageList,
  SendResult,
  SetupResult,
  TaskList,
  type SetupBody,
} from '@oasis/contracts/conversation';
import { MeBody, VerifyCodeResult } from '@oasis/contracts/identity';
import { Confirmation, type ConfirmDecision } from '@oasis/contracts/model-gateway';
import { queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiError, apiVoid, isConnectionError } from './client.ts';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: ({ signal }) => api('/identity/v1/me', MeBody, { signal }),
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

/** 设置页保存一个 AI 的档位和设定，返回存好后的这个 AI；下一轮起生效 */
export const saveAi = (key: string, body: SaveAiBody) =>
  api(`/agent/v1/models/${encodeURIComponent(key)}/settings`, ModelEntry, {
    method: 'PUT',
    body,
  });

/** 给 AI 们的设置（「只用国内模型」） */
export const aiSettingsQuery = queryOptions({
  queryKey: ['ai-settings'],
  queryFn: () => api('/agent/v1/settings', AiSettings),
});
export const saveAiSettings = (settings: AiSettings) =>
  api('/agent/v1/settings', AiSettings, { method: 'PUT', body: settings });

export const dmsQuery = queryOptions({
  queryKey: ['dms'],
  queryFn: async () => (await api('/conversation/v1/dms', ConversationList)).conversations,
});
export const groupsQuery = queryOptions({
  queryKey: ['groups'],
  queryFn: async () => (await api('/conversation/v1/groups', GroupList)).groups,
});
export const createGroup = (title: string, displayName: string) =>
  api('/conversation/v1/groups', GroupSnapshot, { method: 'POST', body: { title, displayName } });
export const previewGroupInvite = (token: string) =>
  api('/conversation/v1/groups/invites/preview', GroupInvitePreview, {
    method: 'POST',
    body: { token },
  });
export const redeemGroupInvite = (token: string, displayName: string) =>
  api('/conversation/v1/groups/invites/redeem', GroupSnapshot, {
    method: 'POST',
    body: { token, displayName, acceptHistory: true },
  });
export const groupSnapshot = (id: string, before?: number) =>
  api(
    `/conversation/v1/groups/${id}${before === undefined ? '' : `?before=${before}`}`,
    GroupSnapshot,
  );
export const createGroupInvite = (id: string) =>
  api(`/conversation/v1/groups/${id}/invites`, GroupInvite, { method: 'POST', body: {} });
export const revokeGroupInvite = (id: string) =>
  apiVoid(`/conversation/v1/groups/${id}/invites`, { method: 'DELETE' });
export const removeGroupMember = (id: string, userId: string) =>
  apiVoid(`/conversation/v1/groups/${id}/members/${userId}`, { method: 'DELETE' });
export const deleteGroup = (id: string) =>
  apiVoid(`/conversation/v1/groups/${id}`, { method: 'DELETE' });
export const sendGroupMessage = (id: string, content: string, requestId: string) =>
  api(`/conversation/v1/groups/${id}/messages`, GroupSnapshot, {
    method: 'POST',
    body: { content, requestId },
  });

export const requestCode = (email: string) =>
  apiVoid('/identity/v1/auth/email-code', { method: 'POST', body: { email } });

export const verifyCode = (email: string, code: string) =>
  api('/identity/v1/auth/verify', VerifyCodeResult, { method: 'POST', body: { email, code } });

export const logout = () => apiVoid('/identity/v1/auth/logout', { method: 'POST', body: {} });

// ---- 私聊：用户说一句开一轮，一轮进行中再说的话是插话 ----
export const createDm = (modelKey: string) =>
  api('/conversation/v1/dms', ConversationBody, { method: 'POST', body: { modelKey } });
/** 删除私聊（真删除）：消息、成果、AI 的记忆和工作目录都删掉；再点开这个 AI 是全新的私聊 */
export const deleteDm = (conversationId: string) =>
  apiVoid(`/conversation/v1/conversations/${conversationId}`, { method: 'DELETE' });

const conversationPath = (conversationId: string) =>
  `/conversation/v1/conversations/${conversationId}`;

/**
 * 消息和正在进行的一轮：有一轮在进行时每秒刷新（AI 说的话、做的步骤一段段出来）；
 * 连不上时和别的查询一样每 5 秒重试。
 */
export const messagesQuery = (conversationId: string) =>
  queryOptions({
    queryKey: ['messages', conversationId],
    queryFn: ({ signal }) =>
      api(`${conversationPath(conversationId)}/messages`, MessageList, { signal }),
    refetchInterval: (query) =>
      query.state.data?.turn ? 1_000 : isConnectionError(query.state.error) ? 5_000 : false,
  });

/** 发一条消息：没有一轮在进行就开一轮，有就是插话；可以带文件、带要改的画布成果 */
export const sendMessage = (
  conversationId: string,
  body: { content: string; attachments?: string[]; artifacts?: string[] },
) => api(`${conversationPath(conversationId)}/messages`, SendResult, { method: 'POST', body });

/** 停下正在进行的一轮：已经做出来的存下，下一轮接着做 */
export const stopTurn = (conversationId: string) =>
  apiVoid(`${conversationPath(conversationId)}/stop`, { method: 'POST', body: {} });

/**
 * 某一轮工作目录里的一个文件（进度页预览这一轮做出的东西）：一轮还在做时从沙箱读，结束后只剩 out/ 里的。
 * version（那一步结束的时间）让同一路径重新生成后不用旧的缓存。
 */
export const runFileUrl = (conversationId: string, runId: string, path: string, version = '') =>
  `/api${conversationPath(conversationId)}/runs/${runId}/files/${path
    .split('/')
    .map(encodeURIComponent)
    .join('/')}${version ? `?v=${encodeURIComponent(version)}` : ''}`;

/** 开新话题：AI 从这里起不记得之前的事，返回分隔消息 */
export const newTopic = (conversationId: string) =>
  api(`${conversationPath(conversationId)}/topics`, z.object({ message: MessageBody }), {
    method: 'POST',
    body: {},
  });

/** 改在哪干活和权限（下一轮起生效）；换了地方从新话题开始，返回分隔消息 */
export const saveSetup = (conversationId: string, body: SetupBody) =>
  api(`${conversationPath(conversationId)}/setup`, SetupResult, { method: 'PUT', body });

/** 点确认卡：允许一次 / 以后都允许 / 拒绝 */
export const confirmTurn = (
  conversationId: string,
  confirmationId: string,
  decision: ConfirmDecision,
) =>
  api(`${conversationPath(conversationId)}/confirmations/${confirmationId}`, Confirmation, {
    method: 'POST',
    body: { decision },
  });

// ---- 画布----
/** 私聊里的任务（任务卡）：画布按任务分框；有任务在做时每 3 秒刷新 */
export const tasksQuery = queryOptions({
  queryKey: ['tasks'],
  queryFn: async () => (await api('/conversation/v1/tasks', TaskList)).tasks,
  refetchInterval: (query) =>
    query.state.data?.some((task) => task.status === 'running') ? 3_000 : false,
});

/** 成果（类别和搜索在前端筛，数量也在前端算）；可以只看某个对话、某个话题的 */
export const artifactsQuery = (filter: { conversationId?: string; sessionId?: string } = {}) =>
  queryOptions({
    queryKey: ['artifacts', filter.conversationId ?? 'all', filter.sessionId ?? 'all'],
    queryFn: async () => {
      const search = new URLSearchParams(
        Object.entries(filter).filter((entry): entry is [string, string] => !!entry[1]),
      ).toString();
      return (await api(`/canvas/v1/artifacts${search ? `?${search}` : ''}`, ArtifactList))
        .artifacts;
    },
  });

export const artifactQuery = (id: string) =>
  queryOptions({
    queryKey: ['artifact', id],
    queryFn: () => api(`/canvas/v1/artifacts/${id}`, ArtifactBody),
  });

/** 批注整份替换，返回更新后的成果 */
export const saveAnnotations = (id: string, annotations: Annotation[]) =>
  api(`/canvas/v1/artifacts/${id}/annotations`, ArtifactBody, {
    method: 'PUT',
    body: { annotations },
  });

/** 成果内容：预览直接用这个地址（支持分段，视频能拖动），download 时让浏览器另存 */
export const artifactContentUrl = (id: string, download = false) =>
  `/api/canvas/v1/artifacts/${id}/content${download ? '?download=1' : ''}`;

/** 一个任务（一轮）的成果打包下载 */
export const taskArchiveUrl = (runId: string) => `/api/canvas/v1/runs/${runId}/archive`;
/** 下载整个应用（应用目录里的全部文件） */
export const appArchiveUrl = (artifactId: string) =>
  `/api/canvas/v1/artifacts/${artifactId}/archive`;
