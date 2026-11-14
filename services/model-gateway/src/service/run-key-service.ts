// 对话里每一轮（一次 agent 运行）专用的临时 Key：签发（明文只返回一次）、校验（换出付费人、归属、
// 「只用国内模型」和这一轮的确认设置）、作废。
// 还有这一轮的确认卡：AI 要做超出权限的事（dsh 插件登记、等结果）、要用花钱的工具（用户设了「问我」），
// 用户在聊天里点允许一次 / 以后都允许 / 拒绝（conversation 转来）。
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Confirmation, ConfirmDecision, RunKeyCreated } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import type { ConfirmationRow, RunKeysRepo } from '../repo/run-keys-repo.ts';
import type { Caller } from './metering.ts';

/** Key 的前缀方便在日志、泄漏扫描里认出来；后面是 32 字节随机数 */
const PREFIX = 'oasis_run_';
/** 等确认结果时多久看一次 */
const POLL_MS = 500;

const hashKey = (key: string) => createHash('sha256').update(key).digest('hex');

const toBody = (row: ConfirmationRow): Confirmation => ({
  id: row.id,
  kind: row.kind,
  text: row.text,
  callId: row.callId,
  status: row.status,
  createdAt: row.createdAt.toISOString(),
});

export function createRunKeyService(deps: {
  repo: RunKeysRepo;
  now?: () => Date;
  pollMs?: number;
}) {
  const { repo } = deps;
  const now = deps.now ?? (() => new Date());

  /** 这一轮的确认卡；别的轮的当作没有 */
  async function owned(runId: string | undefined, id: string): Promise<ConfirmationRow> {
    const row = await repo.confirmation(id);
    if (!row || row.runId !== runId)
      throw new HttpError(404, 'confirmation_not_found', '这一轮没有这张确认卡');
    return row;
  }

  return {
    async issue(input: Caller & { runId: string; ttlSeconds: number }) {
      const key = `${PREFIX}${randomBytes(32).toString('base64url')}`;
      const keyId = randomUUID();
      const expiresAt = new Date(now().getTime() + input.ttlSeconds * 1000);
      await repo.insert({
        id: keyId,
        keyHash: hashKey(key),
        payerId: input.payerId,
        runId: input.runId,
        conversationId: input.conversationId ?? null,
        domesticOnly: input.domesticOnly ?? false,
        askPaid: input.askPaid ?? false,
        expiresAt,
      });
      return { keyId, key, expiresAt: expiresAt.toISOString() } satisfies RunKeyCreated;
    },

    /** 从 Authorization 头换出调用方；Key 不存在、已作废或已过期一律 401。 */
    async authenticate(authorization: string | undefined): Promise<Caller> {
      const key = authorization?.startsWith('Bearer ') ? authorization.slice(7).trim() : '';
      const row = key.startsWith(PREFIX) ? await repo.findActive(hashKey(key), now()) : undefined;
      if (!row) throw new HttpError(401, 'invalid_run_key', '运行凭证无效或已过期');
      return {
        payerId: row.payerId,
        runId: row.runId,
        ...(row.conversationId ? { conversationId: row.conversationId } : {}),
        ...(row.domesticOnly ? { domesticOnly: true } : {}),
        ...(row.askPaid ? { askPaid: true } : {}),
        ...(row.autoAllow.length ? { autoAllow: row.autoAllow } : {}),
      };
    },

    /** 作废是幂等的：重复作废、作废不存在的 Key 都不报错。这一轮还没点的确认卡一起收回。 */
    async revoke(keyId: string): Promise<void> {
      await repo.revoke(keyId, now());
    },
    async renew(keyId: string, ttlSeconds: number): Promise<void> {
      const at = now();
      if (!(await repo.renew(keyId, at, new Date(at.getTime() + ttlSeconds * 1000)))) {
        throw new HttpError(409, 'run_key_not_active', '运行凭证已停止或过期，不能续期');
      }
    },

    /** AI 要做超出权限的事：登记一张确认卡；用户这一轮点过「以后都允许」的直接记成允许 */
    async ask(caller: Caller, text: string, callId?: string): Promise<Confirmation> {
      const always = caller.autoAllow?.includes('command');
      return toBody(
        await repo.addConfirmation({
          id: randomUUID(),
          runId: caller.runId!,
          kind: 'command',
          text,
          callId: callId ?? null,
          status: always ? 'allowed' : 'pending',
        }),
      );
    },

    /** 等这张卡有结果，最多等 waitMs（长轮询）；到时还没点就照实返回待定 */
    async wait(caller: Caller, id: string, waitMs: number): Promise<Confirmation> {
      const deadline = Date.now() + waitMs;
      for (;;) {
        const row = await owned(caller.runId, id);
        if (row.status !== 'pending' || Date.now() >= deadline) return toBody(row);
        await sleep(Math.min(deps.pollMs ?? POLL_MS, Math.max(0, deadline - Date.now())));
      }
    },

    /** AI 那边不等了（这一步取消、这一轮停了）：还没点的收回 */
    async withdraw(caller: Caller, id: string): Promise<Confirmation> {
      await owned(caller.runId, id);
      return toBody(
        (await repo.settle(id, ['pending'], 'cancelled', now())) ?? (await owned(caller.runId, id)),
      );
    },

    /**
     * 花钱的工具，用户设了「问我」：返回要等的确认卡（还没点）；返回 undefined 就是可以调了——这一轮点过
     * 「以后都允许」，或 confirmationId / 同样内容的卡已经允许（用掉它，一张只能用一次）。
     * 同样内容的卡还在等就不再登记一张（AI 等不及先去做别的、回头重跑同一条命令时）。
     */
    async paidTool(
      caller: Caller,
      text: string,
      confirmationId?: string,
    ): Promise<{ id: string } | undefined> {
      if (!caller.askPaid || caller.autoAllow?.includes('tool')) return undefined;
      const use = async (row: ConfirmationRow) => {
        if (row.kind === 'tool' && (await repo.settle(row.id, ['allowed'], 'used', now())))
          return undefined;
        const latest = await owned(caller.runId, row.id);
        if (latest.kind === 'tool' && latest.status === 'pending') return { id: row.id };
        throw new HttpError(
          409,
          'confirmation_not_allowed',
          latest.status === 'denied'
            ? '用户没同意用这个工具；没有调用，没有花钱'
            : '这张确认卡不能用（不是用工具的，或已经用过、收回了）；没有调用，没有花钱',
        );
      };
      if (confirmationId) return use(await owned(caller.runId, confirmationId));
      const open = await repo.openToolConfirmation(caller.runId!, text);
      if (open) return use(open);
      const created = await repo.addConfirmation({
        id: randomUUID(),
        runId: caller.runId!,
        kind: 'tool',
        text,
        callId: null,
        status: 'pending',
      });
      return { id: created.id };
    },

    /** 这一轮在等用户点的 */
    pending: async (runId: string): Promise<Confirmation[]> =>
      (await repo.pendingConfirmations(runId)).map(toBody),

    /**
     * 用户作答（conversation 转来，已核对是这个私聊正在进行的这一轮）。以后都允许：这一轮里同类的
     * 不再问，还在等的同类卡一起允许。卡已经有结果（收回了、AI 不等了）就照实返回。
     */
    async decide(id: string, runId: string, decision: ConfirmDecision): Promise<Confirmation> {
      const row = await owned(runId, id);
      const settled = await repo.settle(
        id,
        ['pending'],
        decision === 'deny' ? 'denied' : 'allowed',
        now(),
      );
      if (settled && decision === 'always') {
        await repo.allowAlways(runId, row.kind);
        await repo.settleKind(runId, row.kind, 'allowed', now());
      }
      return toBody(settled ?? (await owned(runId, id)));
    },

    /** 删对话（真删除）：这个对话各轮的确认卡 */
    purgeConversation: (conversationId: string) => repo.deleteConfirmations(conversationId),
  };
}

export type RunKeyService = ReturnType<typeof createRunKeyService>;
