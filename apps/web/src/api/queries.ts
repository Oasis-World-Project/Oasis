// 各页面用到的查询和操作。查询的 key 集中在这里，便于在操作后刷新对应数据。
import { AiSettings, ModelEntry, ModelList, type SaveAiBody } from '@oasis/contracts/agent';
import {
  type AssignEditBody,
  GroupFileList,
  GroupList,
  GroupSnapshot,
  GroupWork,
  type GroupOptions,
} from '@oasis/contracts/group';
import { TreasuryBody, WalletBody } from '@oasis/contracts/billing';
import { ArtifactBody, ArtifactList, type Annotation } from '@oasis/contracts/canvas';
import {
  ConversationBody,
  ConversationList,
  MessageBody,
  SendResult,
  type Mention,
  SetupResult,
  TaskList,
  type SetupBody,
} from '@oasis/contracts/conversation';
import {
  MeBody,
  PublicProfile,
  VerifyCodeResult,
  type UpdateProfileBody,
} from '@oasis/contracts/identity';
import { Confirmation, type ConfirmDecision } from '@oasis/contracts/model-gateway';
import { FriendChat, FriendRequestResult, FriendsBody } from '@oasis/contracts/social';
import { keepPreviousData, queryOptions } from '@tanstack/react-query';
import { z } from 'zod';
import { api, ApiError, apiVoid } from './client.ts';

export const meQuery = queryOptions({
  queryKey: ['me'],
  queryFn: ({ signal }) => api('/identity/v1/me', MeBody, { signal }),
  staleTime: 5 * 60_000,
  retry: false,
});

/** 改自己的资料：名字、签名、性别、地区 */
export const updateProfile = (body: UpdateProfileBody) =>
  api('/identity/v1/me/profile', MeBody, { method: 'PUT', body });
/** 换头像（data 是图片内容的 base64）、去掉头像 */
export const setAvatar = (type: string, data: string) =>
  api('/identity/v1/me/avatar', MeBody, { method: 'PUT', body: { type, data } });
export const clearAvatar = () => api('/identity/v1/me/avatar', MeBody, { method: 'DELETE' });
/** 一个人的头像地址；没传过头像（version 为 0）就没有，界面用名字的第一个字 */
export const avatarUrl = (userId: string, version: number) =>
  version > 0 ? `/api/identity/v1/users/${userId}/avatar?v=${version}` : undefined;
/** 按账号 ID 查人（加好友前先看到是谁） */
export const lookupUser = (accountNo: string) =>
  api(`/identity/v1/users/lookup?accountNo=${encodeURIComponent(accountNo)}`, PublicProfile);

/** 好友、别人发给我的申请、我发出去还没回的申请 */
export const friendsQuery = queryOptions({
  queryKey: ['friends'],
  queryFn: () => api('/conversation/v1/friends', FriendsBody),
});
export const requestFriend = (userId: string, message: string) =>
  api('/conversation/v1/friends/requests', FriendRequestResult, {
    method: 'POST',
    body: { userId, message },
  });
export const acceptFriend = (requestId: string) =>
  apiVoid(`/conversation/v1/friends/requests/${requestId}/accept`, { method: 'POST', body: {} });
/** 拒绝别人的申请，或撤回自己发出去的 */
export const dropFriendRequest = (requestId: string) =>
  apiVoid(`/conversation/v1/friends/requests/${requestId}`, { method: 'DELETE' });
/** 删好友：两人的私聊一起删掉 */
export const removeFriend = (userId: string) =>
  apiVoid(`/conversation/v1/friends/${userId}`, { method: 'DELETE' });
/** 打开和一个好友的私聊（没有就建），返回它的 ID */
export const openFriendChat = async (userId: string) =>
  (await api(`/conversation/v1/friends/${userId}/chat`, FriendChat, { method: 'POST', body: {} }))
    .id;

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
/** 拉群：群名、叫进来的 AI、一起拉进来的好友、群的光和发言方式 */
export const createGroup = (
  body: { title: string; ais: string[]; members: string[] } & Partial<GroupOptions>,
) => api('/conversation/v1/groups', GroupSnapshot, { method: 'POST', body });
const groupPath = (id: string) => `/conversation/v1/groups/${id}`;
/** 群主改群的设置（光色、发言方式） */
export const setGroupOptions = (id: string, patch: Partial<GroupOptions>) =>
  api(`${groupPath(id)}/options`, GroupSnapshot, { method: 'PUT', body: patch });
/** 群主叫一个 AI 进群、把它移出群、写它在群里负责什么 */
export const addGroupAi = (id: string, key: string) =>
  api(`${groupPath(id)}/ais`, GroupSnapshot, { method: 'POST', body: { key } });
export const removeGroupAi = (id: string, key: string) =>
  apiVoid(`${groupPath(id)}/ais/${encodeURIComponent(key)}`, { method: 'DELETE' });
export const setGroupAiRole = (id: string, key: string, role: string) =>
  api(`${groupPath(id)}/ais/${encodeURIComponent(key)}`, GroupSnapshot, {
    method: 'PUT',
    body: { role },
  });
/** 停下群里这个 AI 正在做的一轮 */
/** 停下正在做的一轮（席位的、云端任务的；和 AI 的私聊里也用它）：已经做出来的会存下 */
export const stopRun = (roomId: string, runId: string) =>
  apiVoid(`${groupPath(roomId)}/runs/${runId}/stop`, { method: 'POST', body: {} });
/** 人改分工单：改派、改要求、撤掉一项（正在做的先停下），或整份全部停下 */
export const editAssign = (id: string, messageId: string, change: AssignEditBody) =>
  apiVoid(`${groupPath(id)}/assigns/${messageId}`, { method: 'POST', body: change });
/** 「现在告诉它」：@ 了这个 AI、它还没看到的一句，现在送进它正在做的一轮 */
export const steerGroupMessage = (id: string, messageId: string, key: string) =>
  apiVoid(`${groupPath(id)}/messages/${messageId}/steer`, { method: 'POST', body: { key } });
/** 群主把一个好友直接拉进群 */
export const addGroupMember = (id: string, userId: string) =>
  api(`${groupPath(id)}/members`, GroupSnapshot, { method: 'POST', body: { userId } });
/** 改自己在这个群里的昵称；空的就是不设 */
export const setGroupNickname = (id: string, nickname: string) =>
  api(`${groupPath(id)}/nickname`, GroupSnapshot, { method: 'PUT', body: { nickname } });
export const groupSnapshot = (id: string, before?: number) =>
  api(
    `/conversation/v1/groups/${id}${before === undefined ? '' : `?before=${before}`}`,
    GroupSnapshot,
  );
export const removeGroupMember = (id: string, userId: string) =>
  apiVoid(`/conversation/v1/groups/${id}/members/${userId}`, { method: 'DELETE' });
/** 群的金库：现在有多少、每个人存了多少、叫 AI 花了多少 */
export const vaultQuery = (id: string) =>
  queryOptions({
    queryKey: ['vault', id],
    queryFn: () => api(`${groupPath(id)}/vault`, TreasuryBody),
  });
/** 从我的钱包往群的金库里存（存进去就是群的），返回金库的新样子 */
export const depositToVault = (id: string, amountMicro: number) =>
  api(`${groupPath(id)}/vault/deposits`, TreasuryBody, { method: 'POST', body: { amountMicro } });
export const deleteGroup = (id: string) =>
  apiVoid(`/conversation/v1/groups/${id}`, { method: 'DELETE' });
/**
 * 发一句话；files：随这句发的文件（已经传到 canvas 的 id）、引用的群文件（路径）、是不是作为任务发布、
 * 是不是让 AI 接着做它的一个云端任务（seat：那个任务的会话）
 */
export const sendGroupMessage = (
  id: string,
  content: string,
  requestId: string,
  mentions: Mention[] = [],
  files: { attachments?: string[]; refs?: string[]; task?: boolean; seat?: string } = {},
) =>
  api(`${groupPath(id)}/messages`, GroupSnapshot, {
    method: 'POST',
    body: {
      content,
      requestId,
      mentions,
      attachments: files.attachments ?? [],
      refs: files.refs ?? [],
      task: files.task ?? false,
      ...(files.seat ? { seat: files.seat } : {}),
    },
  });

/** 群文件；rev 是群上的记号（GroupSnapshot.filesRev），变了就重新读 */
export const groupFiles = async (id: string) =>
  (await api(`${groupPath(id)}/files`, GroupFileList)).files;
export const groupFilesQuery = (id: string, rev: number) =>
  queryOptions({
    queryKey: ['group-files', id, rev],
    queryFn: () => groupFiles(id),
    placeholderData: keepPreviousData,
    staleTime: Infinity,
  });
/** 一个群文件的内容；地址里带上这一版的时间，换了新版本预览就重新读 */
export const groupFileUrl = (
  id: string,
  file: { id: string; updatedAt: string },
  download = false,
) =>
  `/api${groupPath(id)}/files/${file.id}/content?v=${Date.parse(file.updatedAt)}${download ? '&download=1' : ''}`;
/** 一条消息带的文件（群，或和好友的私聊） */
export const groupAttachmentUrl = (id: string, uploadId: string, download = false) =>
  `/api${groupPath(id)}/attachments/${uploadId}/content${download ? '?download=1' : ''}`;
export const deleteGroupFile = (id: string, fileId: string) =>
  apiVoid(`${groupPath(id)}/files/${fileId}`, { method: 'DELETE' });
/** 群主在画布里删掉群里的一个任务：任务卡和它交的文件（群文件里的也删），聊天记录留着 */
export const deleteGroupTask = (id: string, runId: string) =>
  apiVoid(`${groupPath(id)}/tasks/${runId}`, { method: 'DELETE' });
/** 工作台「任务」页签要的消息；mark 变了（有任务开始、结束）就重新读 */
export const groupWorkQuery = (id: string, mark: string) =>
  queryOptions({
    queryKey: ['group-work', id, mark],
    queryFn: async () => (await api(`${groupPath(id)}/work`, GroupWork)).messages,
    placeholderData: keepPreviousData,
  });

export const requestCode = (email: string) =>
  apiVoid('/identity/v1/auth/email-code', { method: 'POST', body: { email } });

export const verifyCode = (email: string, code: string) =>
  api('/identity/v1/auth/verify', VerifyCodeResult, { method: 'POST', body: { email, code } });

export const logout = () => apiVoid('/identity/v1/auth/logout', { method: 'POST', body: {} });

// ---- 私聊：用户说一句开一轮，一轮进行中再说的话先排队，点「引导」才插话进这一轮 ----
export const createDm = (modelKey: string) =>
  api('/conversation/v1/dms', ConversationBody, { method: 'POST', body: { modelKey } });
/** 删除私聊（真删除）：消息、成果、AI 的记忆和工作目录都删掉；再点开这个 AI 是全新的私聊 */
export const deleteDm = (conversationId: string) =>
  apiVoid(`/conversation/v1/conversations/${conversationId}`, { method: 'DELETE' });

const conversationPath = (conversationId: string) =>
  `/conversation/v1/conversations/${conversationId}`;

/**
 * 发一条消息：没有一轮在进行就开一轮，有就先排队（这一轮做完接着做）；可以带文件、带要改的画布成果。
 * 派到云端的（task、seat）不排队
 */
export const sendMessage = (
  conversationId: string,
  body: {
    content: string;
    attachments?: string[];
    artifacts?: string[];
    /** 在云端做：单独派到云端 */
    task?: boolean;
    /** 接着做、改一个云端任务：那个任务的会话 */
    seat?: string;
  },
) => api(`${conversationPath(conversationId)}/messages`, SendResult, { method: 'POST', body });

/** 「引导」：排着队的一句现在交给 AI（插话进正在进行的这一轮，它做完手上这一步就看到） */
export const steerMessage = (conversationId: string, messageId: string) =>
  api(`${conversationPath(conversationId)}/messages/${messageId}/steer`, SendResult, {
    method: 'POST',
    body: {},
  });

/** 从队里删掉一句（还没交给 AI 的） */
export const unqueueMessage = (conversationId: string, messageId: string) =>
  apiVoid(`${conversationPath(conversationId)}/messages/${messageId}`, { method: 'DELETE' });

/** 停下正在进行的一轮：已经做出来的存下，下一轮接着做 */
export const stopTurn = (conversationId: string) =>
  apiVoid(`${conversationPath(conversationId)}/stop`, { method: 'POST', body: {} });

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
/** 私聊里的任务和自己当群主的群里的任务（任务卡）：画布按任务分框；有任务在做时每 3 秒刷新 */
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

/** 成果上要改的地方整份替换，返回更新后的成果 */
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
