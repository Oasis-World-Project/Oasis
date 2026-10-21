// 各页面用到的查询和操作。查询的 key 集中在这里，便于在操作后刷新对应数据。
import { ModelList } from '@oasis/contracts/agent';
import { WalletBody } from '@oasis/contracts/billing';
import { ConversationBody, ConversationList, MessageList } from '@oasis/contracts/conversation';
import { MeBody, VerifyCodeResult } from '@oasis/contracts/identity';
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
