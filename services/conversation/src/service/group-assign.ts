// 分工：群里一个 AI 把一件事的几部分交给群里别的 AI。拆不拆、交给谁由它自己定，程序只给通道：
// 它在回复里写一个 oasis-assign 代码块（分工单），这一轮说完后程序照着开工——每一项是一个云端任务、
// 有自己的会话（同一个 AI 可以同时做几项）；没有上游的同时开，
// 上游都交了的自动接着开；被派的 AI 可以不接（oasis-decline）；有人没接、没做成，或者都结束了，
// 轮到发单的 AI 处理和收口。分工单存成群里的一条消息。对全体说的话挑谁先出来也记在这里。
import {
  AssignBlock,
  DeclineBlock,
  type AssignCard,
  type AssignItem,
} from '@oasis/contracts/conversation';
import type { AssignEditBody } from '@oasis/contracts/group';
import { HttpError, type Logger } from '@oasis/service-kit';
import type { z } from 'zod';
import {
  inGroup as isGroupSession,
  type Conversation,
  type ConversationRepo,
} from '../repo/conversation-repo.ts';
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

const ENDED: AssignItem['status'][] = ['done', 'declined', 'failed', 'stopped', 'dropped'];
/** 没接、没做成的：要告诉发单的 AI */
const TROUBLE: AssignItem['status'][] = ['declined', 'failed', 'stopped'];
const STATUS_TEXT: Record<AssignItem['status'], string> = {
  waiting: '还没开工',
  running: '还在做',
  done: '交了',
  declined: '没接',
  failed: '没做成',
  stopped: '停下了',
  dropped: '人撤掉了',
};
/** 一次取多少条没听过的群聊 */
const HEARING = 200;
/** 分工单的锁被占着时隔多久再试、最多试几次（一共约 30 秒） */
const LOCK_WAIT_MS = 100;
const LOCK_TRIES = 300;

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
  /**
   * 同一个群的分工单一次只改一处：库里的租约锁（开几份服务也只有一份在改）。别人正拿着就等一会儿再试，
   * 等太久（服务卡住了）抛错，由每 30 秒那一遍补上。
   */
  async function inGroup<T>(groupId: string, work: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      let entered = false;
      try {
        return await deps.store.withLock('assign', groupId, () => {
          entered = true;
          return work();
        });
      } catch (err) {
        const busy = err instanceof HttpError && err.code === 'conversation_busy';
        if (entered || !busy || attempt >= LOCK_TRIES) throw err;
        await new Promise((resolve) => setTimeout(resolve, LOCK_WAIT_MS));
      }
    }
  }

  /**
   * 让群里的这份会话（席位、云端任务）开一轮（它有空才开）：先听它没听过的群聊，最后一行是 ending。
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
        if (!seat || !isGroupSession(seat) || seat.turn || seat.options.removedAt) return undefined;
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

  /** 把分工单里的一项交给它负责的 AI：这一项是一个云端任务，开一份自己的会话 */
  async function start(row: AssignRow, item: AssignItem): Promise<boolean> {
    const seat = await seats.seat(row.groupId, item.key);
    const group = seat && (await deps.store.find(row.groupId));
    if (!seat || !group) {
      Object.assign(item, { status: 'failed', note: '它已经不在群里了' });
      return true;
    }
    await repo.assigned(seat.id);
    const task = await deps.store.createTask({
      room: group,
      modelKey: item.key,
      title: taskTitle([], item.task),
      heardSeq: Number(seat.heard_seq),
    });
    const upstream = item.after.length
      ? `它要等的第 ${item.after.join('、')} 项已经交了，文件在群文件里。`
      : '';
    const from = item.from;
    const opened = await open(
      task.id,
      item.key,
      `assign:${row.id}:${item.id}`,
      (names) =>
        `轮到你了：${names.get(row.key) ?? row.key} 发了分工单「${row.card.title}」，把第 ${item.id} 项交给你：${item.task}\n${upstream}${from ? `${names.get(from) ?? from} 之前做过一部分，它交的文件在群文件里。` : ''}这一项由你负责：做完把成果放进 out/ 交到群里，再说一句交了什么。不接就只回一个 oasis-decline 代码块写明原因，不要动手。`,
      taskTitle([], item.task),
    );
    if (!opened) {
      // 没开成（锁被占着）：这份会话不留，下次再开一份
      await deps.store.deleteConversation(task.id);
      return false;
    }
    if ('error' in opened) Object.assign(item, { status: 'failed', note: opened.error });
    else Object.assign(item, { status: 'running', runId: opened.runId });
    return true;
  }

  /** 轮到发单的 AI：有人没接、没做成，或者都结束了该收口。它在忙就以后再说（返回 false） */
  async function report(row: AssignRow, over: boolean): Promise<boolean> {
    // 回到发单的那份会话（席位，或它当时在做的那个云端任务）
    const seatId = row.card.seat ?? (await seats.seat(row.groupId, row.key))?.id;
    const seat = seatId ? await deps.store.find(seatId) : undefined;
    // 发单的 AI 已经不在群里：没人收口，直接关上
    if (!seat || seat.options.removedAt) return true;
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

  /** 一项的这一轮结束了：按它说的话记结果（不接、出错、被停下、交了） */
  function record(item: AssignItem, said: Awaited<ReturnType<GroupAssignRepo['said']>>) {
    const declined = blockOf(said.text, 'decline', DeclineBlock);
    item.status = declined
      ? 'declined'
      : said.failed
        ? 'failed'
        : said.stopped
          ? 'stopped'
          : 'done';
    if (declined?.reason) item.note = declined.reason;
  }

  /** 推进这个群里没关上的分工单：能开工的开工，该告诉发单的 AI 的告诉它 */
  async function advance(groupId: string) {
    for (const row of await repo.open(groupId)) {
      const { items } = row.card;
      const before = JSON.stringify(row.card);
      // 记着在做、那个 AI 却已经不在这一轮里了（收尾那一下没记上：服务正好重启，或锁等得太久）：补记
      for (const item of items) {
        if (item.status !== 'running' || !item.runId) continue;
        if (!(await seats.running(groupId, item.runId)))
          record(item, await repo.said(groupId, item.runId));
      }
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
     * 群里一份会话（席位、云端任务）的一轮结束了（调用方拿着它的 message 锁）：它做的是分工单里的一项就记下结果；
     * 它这一轮发了分工单就收下；它是对全体说的那句话挑中先出来的，说完了就让别的 AI 接话。
     */
    async settled(seat: Conversation, runId: string, callers: string[] = []) {
      const groupId = seat.parentId,
        key = seat.modelKey;
      if (!groupId || !key) return;
      const said = await repo.said(groupId, runId);
      await inGroup(groupId, async () => {
        for (const row of await repo.open(groupId)) {
          const item = row.card.items.find((i) => i.runId === runId && i.status === 'running');
          if (!item) continue;
          record(item, said);
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
          callers,
          seat: seat.id,
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
    /**
     * 人改一份没关上的分工单（调用方核对过他是群成员，owner 是他是不是群主）：群主和引来这份单子的人可以。
     * 改派、撤掉正在做的一项会先停下那个 AI 的这一轮，它已经交的文件留在群文件里；发单的 AI 仍然负责
     * 核对和收口。返回改了什么的一句话（调用方记进群里）。
     */
    async edit(input: {
      groupId: string;
      messageId: string;
      userId: string;
      owner: boolean;
      change: AssignEditBody;
    }): Promise<string> {
      const { groupId, change } = input;
      return inGroup(groupId, async () => {
        const row = (await repo.open(groupId)).find((found) => found.id === input.messageId);
        if (!row) throw new HttpError(409, 'assign_closed', '这份分工单已经关上了');
        if (!input.owner && !(row.card.callers ?? []).includes(input.userId))
          throw new HttpError(403, 'assign_not_allowed', '只有群主和叫它做这件事的人可以改分工单');
        const all = await seats.list(groupId);
        const name = (key: string) => all.find((seat) => seat.model_key === key)?.title ?? key;
        /** 停下正在做这一项的那一轮：它收尾时这一项已经不算它的了，不会再记成它的结果 */
        const halt = async (item: AssignItem) => {
          const running = item.runId && (await seats.running(groupId, item.runId));
          const turn = running ? (await deps.store.find(running))?.turn : undefined;
          if (turn) await deps.turns.stop(turn);
        };
        const live = (item: AssignItem) => item.status === 'waiting' || item.status === 'running';
        let said: string;
        if (change.op === 'close') {
          for (const item of row.card.items.filter(live)) {
            if (item.status === 'running') await halt(item);
            item.status = 'dropped';
          }
          row.card.status = 'closed';
          said = `把分工单「${row.card.title}」全部停下了。`;
        } else {
          const item = row.card.items.find((found) => found.id === change.item);
          if (!item) throw new HttpError(404, 'assign_item_not_found', '分工单里没有这一项');
          if (!live(item)) throw new HttpError(409, 'assign_item_ended', '这一项已经结束了');
          const which = `分工单「${row.card.title}」第 ${item.id} 项`;
          if (change.op === 'retask') {
            if (item.status !== 'waiting')
              throw new HttpError(
                409,
                'assign_item_started',
                '这一项已经开工了，要求改不了；可以停下并改派',
              );
            item.task = change.task;
            said = `把${which}的要求改成：${change.task}`;
          } else if (change.op === 'drop') {
            if (item.status === 'running') await halt(item);
            item.status = 'dropped';
            said = `把${which}（${name(item.key)}）撤掉了。`;
          } else {
            if (!all.some((seat) => seat.model_key === change.key))
              throw new HttpError(404, 'ai_not_in_group', '群里没有这个 AI');
            if (change.key === item.key)
              throw new HttpError(409, 'assign_same_ai', '这一项本来就是它的');
            if (change.key === row.key)
              throw new HttpError(
                409,
                'assign_to_lead',
                '发单的 AI 自己做的不进分工单：撤掉这一项，再对它说',
              );
            const was = item.key;
            const started = item.status === 'running';
            if (started) await halt(item);
            Object.assign(item, { key: change.key, status: 'waiting', runId: null });
            if (started) item.from = was;
            said = `把${which}从 ${name(was)} 改派给 ${name(change.key)}。`;
          }
        }
        await repo.save(row.id, row.card);
        return said;
      });
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
