// 分工：群里一个 AI 把一件事的几部分交给群里别的 AI。拆不拆、交给谁由它自己定，程序只给通道：
// 它在回复里写一个 oasis-assign 代码块（分工单），这一轮说完后程序照着开工——没有上游的同时开，
// 上游都交了的自动接着开；被派的 AI 可以不接（oasis-decline）；有人没接、没做成，或者都结束了，
// 轮到发单的 AI 处理和收口。分工单存成群里的一条消息。对全体说的话挑谁先出来也记在这里。
import {
  AssignBlock,
  DeclineBlock,
  type AssignCard,
  type AssignItem,
} from '@oasis/contracts/conversation';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { z } from 'zod';
import type { Conversation, ConversationRepo } from '../repo/conversation-repo.ts';
import type { AssignRow, GroupAssignRepo } from '../repo/group-assign-repo.ts';
import type { GroupSeats } from '../repo/group-seats.ts';
import { ownBrief, type SeatBrief } from './group-hearing.ts';
import { fenceJson, taskTitle } from './task-title.ts';
import type { Turns } from './turns.ts';

// 有的模型把整个代码块写在一行里：不要求换行
const FENCE = /```oasis-(assign|decline)\b([\s\S]*?)```/g;
/** AI 说的话里第一个格式对的这种代码块 */
function blockOf<T extends z.ZodType>(
  text: string,
  kind: string,
  schema: T,
): z.infer<T> | undefined {
  for (const match of text.matchAll(FENCE)) {
    if (match[1] !== kind) continue;
    try {
      const parsed = schema.safeParse(fenceJson(match[2] ?? ''));
      if (parsed.success) return parsed.data;
    } catch {
      // 不是 JSON：当普通的话
    }
  }
  return undefined;
}

const ENDED: AssignItem['status'][] = ['done', 'declined', 'failed', 'stopped'];
/** 没接、没做成的：要告诉发单的 AI */
const TROUBLE: AssignItem['status'][] = ['declined', 'failed', 'stopped'];
const STATUS_TEXT: Record<AssignItem['status'], string> = {
  waiting: '还没开工',
  running: '还在做',
  done: '交了',
  declined: '没接',
  failed: '没做成',
  stopped: '停下了',
};
/** 一次取多少条没听过的群聊 */
const HEARING = 200;

export function createGroupAssign(deps: {
  repo: GroupAssignRepo;
  seats: GroupSeats;
  store: ConversationRepo;
  turns: Turns;
  /** 开一轮前给它带上群文件、各 AI 的型号 */
  brief: { attach(seat: Conversation, brief: SeatBrief): Promise<SeatBrief> };
  /** 先出来负责的那个 AI 说完了：让别的 AI 看看有没有话要补 */
  speak: { nudge(groupId: string, force?: boolean): void };
  logger: Logger;
}) {
  const { repo, seats, logger } = deps;
  /** 同一个群的分工单一次只改一处（单实例；多实例部署时要换成库里的锁，见《待办》） */
  const chains = new Map<string, Promise<unknown>>();
  function inGroup<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    const run = (chains.get(groupId) ?? Promise.resolve()).then(work, work);
    const tail = run.catch(() => undefined);
    chains.set(groupId, tail);
    void tail.then(() => {
      if (chains.get(groupId) === tail) chains.delete(groupId);
    });
    return run;
  }

  /**
   * 让这个席位开一轮（它有空才开）：先听它没听过的群聊，最后一行是 ending。
   * 返回这一轮的编号；它在忙、锁被占着返回 undefined（之后再试）；开不成返回 error。
   */
  async function open(
    seatId: string,
    key: string,
    requestId: string,
    ending: (names: Map<string, string>) => string,
    title?: string,
  ): Promise<{ runId: string } | { error: string } | undefined> {
    try {
      return await deps.store.withLock('message', seatId, async (locked) => {
        const seat = await locked.find(seatId);
        if (!seat || seat.kind !== 'seat' || seat.turn || seat.options.removedAt) return undefined;
        const hearing = await seats.hearing(seatId, HEARING);
        if (!hearing) return undefined;
        const last = hearing.heard.at(-1);
        if (last) await seats.setHeard(seatId, last.seq);
        const names = new Map(hearing.roster.ais.map((ai) => [ai.key, ai.name]));
        const brief = ownBrief(key, hearing.roster, hearing.heard, hearing.skipped, ending(names));
        const [message] = await deps.turns.begin(
          locked,
          seat,
          [],
          requestId,
          await deps.brief.attach(seat, title ? { ...brief, title } : brief),
        );
        const runId = (message?.data as { runId?: string } | undefined)?.runId;
        return message?.status === 'failed' || !runId
          ? { error: message?.error ?? '这一轮没能开始' }
          : { runId };
      });
    } catch (err) {
      if (err instanceof HttpError && err.code === 'conversation_busy') return undefined;
      logger.warn({ err, seatId }, '分工：没能给这个 AI 开一轮');
      return undefined;
    }
  }

  /** 把分工单里的一项交给它负责的 AI */
  async function start(row: AssignRow, item: AssignItem): Promise<boolean> {
    const seat = await seats.seat(row.groupId, item.key);
    if (!seat) {
      Object.assign(item, { status: 'failed', note: '它已经不在群里了' });
      return true;
    }
    if (seat.turn) return false;
    await repo.assigned(seat.id);
    const upstream = item.after.length
      ? `它要等的第 ${item.after.join('、')} 项已经交了，文件在群文件里。`
      : '';
    const opened = await open(
      seat.id,
      item.key,
      `assign:${row.id}:${item.id}`,
      (names) =>
        `轮到你了：${names.get(row.key) ?? row.key} 发了分工单「${row.card.title}」，把第 ${item.id} 项交给你：${item.task}\n${upstream}这一项由你负责：做完把成果放进 out/ 交到群里，再说一句交了什么。不接就只回一个 oasis-decline 代码块写明原因，不要动手。`,
      taskTitle([], item.task),
    );
    if (!opened) return false;
    if ('error' in opened) Object.assign(item, { status: 'failed', note: opened.error });
    else Object.assign(item, { status: 'running', runId: opened.runId });
    return true;
  }

  /** 轮到发单的 AI：有人没接、没做成，或者都结束了该收口。它在忙就以后再说（返回 false） */
  async function report(row: AssignRow, over: boolean): Promise<boolean> {
    const seat = await seats.seat(row.groupId, row.key);
    // 发单的 AI 已经不在群里：没人收口，直接关上
    if (!seat) return true;
    if (seat.turn) return false;
    const opened = await open(
      seat.id,
      row.key,
      `assign-report:${row.id}:${Date.now()}`,
      (names) =>
        [
          `你发的分工单「${row.card.title}」有进展：`,
          ...row.card.items.map(
            (item) =>
              `- 第 ${item.id} 项（${names.get(item.key) ?? item.key}）：${STATUS_TEXT[item.status]}${item.note ? `——${item.note}` : ''}`,
          ),
          over
            ? '都结束了。核对各项交的东西（在群文件里）对不对得上，再向大家说清楚结果；要返工或改派可以再发一份分工单。'
            : '有人没接或没做成：可以改派（再发一份分工单）或自己做；其余的还在做。',
        ].join('\n'),
      `${row.card.title}：${over ? '收口' : '有人没做成'}`,
    );
    return opened !== undefined;
  }

  /** 推进这个群里没关上的分工单：能开工的开工，该告诉发单的 AI 的告诉它 */
  async function advance(groupId: string) {
    for (const row of await repo.open(groupId)) {
      const { items } = row.card;
      const before = JSON.stringify(row.card);
      const ready = () => {
        const done = new Set(items.filter((i) => i.status === 'done').map((i) => i.id));
        return items.filter((i) => i.status === 'waiting' && i.after.every((id) => done.has(id)));
      };
      for (const item of ready()) await start(row, item);
      const over = !items.some((i) => i.status === 'running') && !ready().length;
      const news = items.filter((i) => TROUBLE.includes(i.status) && !i.told);
      if ((over || news.length) && (await report(row, over))) {
        for (const item of news) item.told = true;
        if (over) {
          row.card.status = 'closed';
          // 上游没做成、一直没轮到的：不再等
          for (const item of items)
            if (!ENDED.includes(item.status))
              Object.assign(item, { status: 'stopped', note: '上游没做成，没有开工' });
        }
      }
      if (JSON.stringify(row.card) !== before) await repo.save(row.id, row.card);
    }
  }

  const later = (groupId: string) =>
    inGroup(groupId, () => advance(groupId)).catch((err: unknown) =>
      logger.warn({ err, groupId }, '推进分工单失败，稍后再试'),
    );

  return {
    /**
     * 一个席位的一轮结束了（调用方拿着它的 message 锁）：它做的是分工单里的一项就记下结果；
     * 它这一轮发了分工单就收下；它是对全体说的那句话挑中先出来的，说完了就让别的 AI 接话。
     */
    async settled(seat: Conversation, runId: string) {
      const groupId = seat.parentId,
        key = seat.modelKey;
      if (!groupId || !key) return;
      const said = await repo.said(groupId, runId);
      await inGroup(groupId, async () => {
        for (const row of await repo.open(groupId)) {
          const item = row.card.items.find((i) => i.runId === runId && i.status === 'running');
          if (!item) continue;
          const declined = blockOf(said.text, 'decline', DeclineBlock);
          item.status = declined
            ? 'declined'
            : said.failed
              ? 'failed'
              : said.stopped
                ? 'stopped'
                : 'done';
          if (declined?.reason) item.note = declined.reason;
          await repo.save(row.id, row.card);
        }
        const plan = said.failed ? undefined : blockOf(said.text, 'assign', AssignBlock);
        if (!plan) return;
        const all = await seats.list(groupId);
        const named = (to: string) =>
          all.find(
            (other) =>
              other.title.toLowerCase() === to.toLowerCase() ||
              other.model_key.toLowerCase() === to.toLowerCase(),
          );
        // 写给自己的那几项不算（自己做的不用进分工单）；编号重复的只留第一个
        const wanted = plan.items.filter(
          (item, index) =>
            named(item.to)?.model_key !== key &&
            plan.items.findIndex((i) => i.id === item.id) === index,
        );
        if (!wanted.length) return;
        const ids = new Set(wanted.map((item) => item.id));
        const card: AssignCard = {
          runId,
          title: plan.title || taskTitle([], wanted[0]!.task),
          status: 'open',
          items: wanted.map((item): AssignItem => {
            const target = named(item.to);
            return {
              id: item.id,
              key: target?.model_key ?? item.to,
              task: item.task,
              after: item.after.filter((id) => ids.has(id) && id !== item.id),
              status: target ? 'waiting' : 'failed',
              runId: null,
              ...(target ? {} : { note: '群里没有叫这个名字的 AI' }),
            };
          }),
        };
        await repo.create(groupId, key, card);
        logger.info({ groupId, key, items: card.items.length }, '群里发了分工单');
      });
      if (await repo.leadSpoke(groupId, key, seat.heardSeq)) deps.speak.nudge(groupId, true);
    },
    /** 稍后推进这个群的分工单（不占着调用方手里的锁） */
    schedule(groupId: string) {
      setTimeout(() => void later(groupId), 0).unref();
    },
    /** 隔一会儿把所有没关上的分工单推进一遍：服务重启过、上次锁被占着没开成的补上 */
    async sweep() {
      for (const groupId of await repo.openGroups()) await later(groupId);
    },
    setLead: repo.setLead,
  };
}
