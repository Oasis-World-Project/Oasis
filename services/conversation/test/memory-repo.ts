// 测试用的内存版私聊仓库，行为和 SQL 版一致（锁：同名同对话拿着时 409）。
import { randomUUID } from 'node:crypto';
import { HttpError } from '@oasis/service-kit';
import type { Conversation, ConversationRepo, Message } from '../src/repo/conversation-repo.ts';

export function memoryRepo(): ConversationRepo & {
  conversations: Map<string, Conversation>;
  messages: Message[];
  locks: Set<string>;
} {
  const conversations = new Map<string, Conversation>();
  const messages: Message[] = [];
  const locks = new Set<string>();
  let seq = 0;
  const repo: ReturnType<typeof memoryRepo> = {
    conversations,
    messages,
    locks,
    async withLock(name, conversationId, work) {
      const key = `${name}:${conversationId}`;
      if (locks.has(key)) throw new HttpError(409, 'conversation_busy', '正在处理这段对话');
      locks.add(key);
      try {
        return await work(repo);
      } finally {
        locks.delete(key);
      }
    },
    async upsertDm(ownerId, modelKey, title) {
      const found = [...conversations.values()].find(
        (c) => c.ownerId === ownerId && c.modelKey === modelKey && c.kind === 'dm',
      );
      if (found) return found;
      const row: Conversation = {
        id: randomUUID(),
        kind: 'dm',
        ownerId,
        modelKey,
        title,
        createdAt: new Date(),
        lastMessageAt: null,
        nextMessageSeq: 0,
        turn: null,
        lastRunId: null,
        topic: null,
        workplace: null,
        permissions: null,
      };
      conversations.set(row.id, row);
      return row;
    },
    listDms: async (ownerId) => [...conversations.values()].filter((c) => c.ownerId === ownerId),
    findOwned: async (id, ownerId) => {
      const row = conversations.get(id);
      return row?.ownerId === ownerId && row.kind === 'dm' ? structuredClone(row) : undefined;
    },
    find: async (id) => {
      const row = conversations.get(id);
      return row ? structuredClone(row) : undefined;
    },
    async insertMessage(message) {
      const row: Message = {
        id: randomUUID(),
        seq: ++seq,
        error: null,
        kind: 'text',
        data: {},
        createdAt: new Date(),
        ...message,
      } as Message;
      messages.push(row);
      return structuredClone(row);
    },
    async updateMessage(id, patch) {
      const row = messages.find((m) => m.id === id);
      if (!row) return undefined;
      Object.assign(row, patch);
      return structuredClone(row);
    },
    async deleteMessage(id) {
      const index = messages.findIndex((m) => m.id === id);
      if (index >= 0) messages.splice(index, 1);
    },
    async touchConversation(id) {
      const row = conversations.get(id);
      if (row) row.lastMessageAt = new Date();
    },
    listMessages: async (conversationId, limit) =>
      structuredClone(
        messages
          .filter((m) => m.conversationId === conversationId)
          .sort((a, b) => a.seq - b.seq)
          .slice(0, limit),
      ),
    findMessage: async (conversationId, id) => {
      const row = messages.find((m) => m.id === id && m.conversationId === conversationId);
      return row ? structuredClone(row) : undefined;
    },
    pendingMessages: async (conversationId) =>
      structuredClone(
        messages.filter(
          (m) => m.conversationId === conversationId && m.authorKind === 'user' && m.data.pending,
        ),
      ),
    attachmentIds: async (conversationId) => [
      ...new Set(
        messages
          .filter((m) => m.conversationId === conversationId)
          .flatMap((m) =>
            ((m.data.attachments as { id: string }[] | undefined) ?? []).map((a) => a.id),
          ),
      ),
    ],
    async deleteConversation(id) {
      conversations.delete(id);
      for (let i = messages.length - 1; i >= 0; i -= 1)
        if (messages[i]!.conversationId === id) messages.splice(i, 1);
    },
    async startTurn(id, turn, topic) {
      const row = conversations.get(id);
      if (!row || row.turn) return false;
      row.turn = { ...turn };
      row.topic ??= topic;
      return true;
    },
    async updateTurn(id, runId, patch) {
      const row = conversations.get(id);
      if (row?.turn?.runId !== runId) return false;
      row.turn = { ...row.turn, ...patch };
      return true;
    },
    async endTurn(id, runId, lastRunId) {
      const row = conversations.get(id);
      if (row?.turn?.runId !== runId) return;
      row.turn = null;
      row.lastRunId = lastRunId;
    },
    activeTurns: async () => [...conversations.values()].filter((c) => c.turn),
    async newTopic(id) {
      const row = conversations.get(id);
      if (row) Object.assign(row, { lastRunId: null, topic: null });
    },
    async saveSetup(id, setup) {
      const row = conversations.get(id);
      if (row) Object.assign(row, structuredClone(setup));
    },
  };
  return repo;
}
