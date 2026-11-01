// 数字人测试共用的假依赖：内存会话表、内存调用记录、假计量、假 LiveAvatar。
import type { AvatarTurn } from '@oasis/contracts/avatar';
import type { AvatarSessionRequest, LiveAvatarClient } from '../src/adapters/liveavatar.ts';
import type { AvatarSession, AvatarSessionsRepo } from '../src/repo/avatar-sessions-repo.ts';
import type { Call, CallsRepo } from '../src/repo/calls-repo.ts';
import type { NewRunKey, RunKey, RunKeysRepo } from '../src/repo/run-keys-repo.ts';
import type { Meter } from '../src/service/metering.ts';

export function memoryRunKeys(): RunKeysRepo & { rows: RunKey[] } {
  const rows: RunKey[] = [];
  return {
    rows,
    async insert(key: NewRunKey) {
      rows.push({
        ...key,
        taskId: key.taskId ?? null,
        nodeId: key.nodeId ?? null,
        revokedAt: null,
        createdAt: new Date(),
      });
    },
    async findActive(keyHash, now) {
      return rows.find((r) => r.keyHash === keyHash && !r.revokedAt && r.expiresAt > now);
    },
    async revoke(id, now) {
      const row = rows.find((r) => r.id === id && !r.revokedAt);
      if (row) row.revokedAt = now;
      return Boolean(row);
    },
  };
}

export function memorySessions(
  clock: () => Date,
): AvatarSessionsRepo & { rows: Map<string, AvatarSession> } {
  const rows = new Map<string, AvatarSession>();
  const patch = (id: string, change: Partial<AvatarSession>) => {
    const row = rows.get(id);
    if (row) rows.set(id, { ...row, ...change });
  };
  return {
    rows,
    async create(s) {
      rows.set(s.id, {
        ...s,
        artifactId: s.artifactId ?? null,
        taskId: s.taskId ?? null,
        status: 'starting',
        resources: {},
        callId: null,
        turns: [],
        startedAt: null,
        endedAt: null,
        endReason: null,
        settledAt: null,
        chargedMicro: null,
        cleanedAt: null,
        createdAt: clock(),
      });
    },
    async get(id) {
      return rows.get(id);
    },
    async addResources(id, resources) {
      patch(id, { resources: { ...rows.get(id)?.resources, ...resources } });
    },
    async setCall(id, callId) {
      patch(id, { callId });
    },
    async markLive(id, startedAt) {
      if (rows.get(id)?.status === 'starting') patch(id, { status: 'live', startedAt });
    },
    async end(id, reason, endedAt) {
      const row = rows.get(id);
      if (!row || row.status === 'ended') return undefined;
      patch(id, { status: 'ended', endReason: reason, endedAt });
      return rows.get(id);
    },
    async appendTurn(id, turn: AvatarTurn) {
      patch(id, { turns: [...(rows.get(id)?.turns ?? []), turn] });
    },
    async setEndReason(id, reason) {
      patch(id, { endReason: reason });
    },
    async markSettled(id, chargedMicro, at) {
      if (rows.get(id)?.settledAt) return false;
      patch(id, { settledAt: at, chargedMicro });
      return true;
    },
    async markCleaned(id, at) {
      patch(id, { cleanedAt: at });
    },
    async unfinished() {
      return [...rows.values()].filter((r) => r.status !== 'ended' || !r.settledAt || !r.cleanedAt);
    },
  };
}

/** 假计量：冻结登记进内存调用记录，结算记下金额 */
export function fakeMeter() {
  const calls = new Map<string, Call>();
  const settled: { id: string; costMicro: number; source: string }[] = [];
  const holds: { amountMicro: number; ttlMs?: number }[] = [];
  let n = 0;
  const meter = {
    async hold(input: {
      caller: { payerId: string; runId?: string };
      kind: Call['kind'];
      model: string;
      amountMicro: number;
      requestId: string;
      ttlMs?: number;
    }) {
      const id = `00000000-0000-4000-8000-00000000000${++n}`;
      holds.push({
        amountMicro: input.amountMicro,
        ...(input.ttlMs ? { ttlMs: input.ttlMs } : {}),
      });
      calls.set(id, {
        id,
        kind: input.kind,
        payerId: input.caller.payerId,
        runId: input.caller.runId ?? null,
        taskId: null,
        nodeId: null,
        model: input.model,
        requestId: input.requestId,
        status: 'running',
        holdId: `hold-${n}`,
      } as Call);
      return {
        id,
        holdId: `hold-${n}`,
        requestId: input.requestId,
        model: input.model,
        kind: input.kind,
        caller: input.caller,
      };
    },
    async settle(call: { id: string }, cost: { costMicro: number; source: string }) {
      settled.push({ id: call.id, ...cost });
      const row = calls.get(call.id);
      if (row) calls.set(call.id, { ...row, status: 'succeeded' });
    },
  } as unknown as Meter;
  const repo = { get: async (id: string) => calls.get(id) } as unknown as CallsRepo;
  return { meter, repo, settled, holds };
}

/** 假 LiveAvatar：记下每一步；能在指定步骤失败；getSession 的返回可以改 */
export function fakeClient(options: { failAt?: string } = {}) {
  const log: string[] = [];
  const secrets = new Map<string, string>();
  const tokens: AvatarSessionRequest[] = [];
  let sessionInfo: Record<string, unknown> = {};
  const step = async <T>(name: string, value: T): Promise<T> => {
    log.push(name);
    if (name === options.failAt) throw new Error(`${name} failed`);
    return value;
  };
  const client = {
    configured: true,
    credits: async () => 10,
    createSecret: async (_name: string, value: string) => {
      secrets.set('sec-1', value);
      return step('createSecret', 'sec-1');
    },
    deleteSecret: async () => void (await step('deleteSecret', undefined)),
    createLlmConfiguration: async () => step('createLlmConfiguration', 'llm-1'),
    deleteLlmConfiguration: async () => void (await step('deleteLlmConfiguration', undefined)),
    createContext: async () => step('createContext', 'ctx-1'),
    deleteContext: async () => void (await step('deleteContext', undefined)),
    createSessionToken: async (input: AvatarSessionRequest) => {
      tokens.push(input);
      return step('createSessionToken', { providerSessionId: 'la-sess', sessionToken: 'tok' });
    },
    startSession: async () =>
      step('startSession', { livekitUrl: 'wss://room', livekitToken: 'lk' }),
    stopSession: async () => void (await step('stopSession', undefined)),
    getSession: async () => sessionInfo,
  } satisfies LiveAvatarClient;
  return {
    client,
    log,
    secrets,
    tokens,
    setSession: (info: Record<string, unknown>) => {
      sessionInfo = info;
    },
  };
}
