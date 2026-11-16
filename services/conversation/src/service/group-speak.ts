// 没人 @ 的时候，群里的 AI 谁开口。群设成「看情况」或「积极参与」才会：
// 一句话进群（或一个 AI 说完）后等群里安静一会儿，让一个快的小模型看着最近的群聊和每个有空的 AI 的人设，
// 给出「这时候它有多少值得说的、它平时有多爱说话、话题有多复杂」，再按概率掷骰子（speak-chance.ts）。
// 掷中的开一轮，和被 @ 时是同一套：先听它没听过的群聊，再说话。「积极参与」的群安静久了，AI 还有很小的概率自己起话头。
// 程序不拦 AI：有人说「都别说了」，判断模型和 AI 自己都看得到。
import { ModelRoute } from '@oasis/contracts/agent';
import { GroupOptions } from '@oasis/contracts/group';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import { z } from 'zod';
import { withMessageLock, type ConversationRepo } from '../repo/conversation-repo.ts';
import type { GroupSeats } from '../repo/group-seats.ts';
import type { GroupTalk, TalkLine } from '../repo/group-talk.ts';
import { ownBrief } from './group-hearing.ts';
import { parseJudgment, pickSpeaker, startChance, type Judgment } from './speak-chance.ts';
import type { Turns } from './turns.ts';

/** 判断时看最近多少句、每句和每段人设最多多少字 */
const LINES = 30;
const LINE_CHARS = 400;
const PERSONA_CHARS = 600;
/** 群里安静这么久以后，「积极参与」的 AI 才可能自己起话头 */
const START_AFTER_MS = 180_000;
const CHIME =
  '没人 @ 你。你看了群里这些话，自己想接一句：回答、补充、不同意都可以，话不用多；没叫你做的事不做。';
const START =
  '群里安静了一阵，没人 @ 你。你想起个话头就说一句（闲聊、问问进展、提个想法都行），简短；不要自己开始做任务。';
const Completion = z.looseObject({
  choices: z.array(z.looseObject({ message: z.looseObject({ content: z.string().nullable() }) })),
});
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
/** 最后连着几句是 AI 说的（没有真人插话） */
const roundsOf = (lines: TalkLine[]) => {
  const human = lines.findLastIndex((line) => !line.ai);
  return lines.length - 1 - human;
};

export function createGroupSpeak(deps: {
  talk: GroupTalk;
  seats: GroupSeats;
  store: ConversationRepo;
  turns: Turns;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  /** 判断用的型号：要快 */
  model: string;
  /** 一句话之后群里安静多久再判断（等人把话说完） */
  quietMs: number;
  /** 这个群现在有没有人开着（有人在才会自己起话头） */
  watched: (groupId: string) => boolean;
  random?: () => number;
  now?: () => number;
}) {
  const { talk, seats, logger } = deps;
  const random = deps.random ?? Math.random;
  const now = deps.now ?? Date.now;
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  /** 群主给这个 AI 写的人设（判断它爱不爱说话要看） */
  async function persona(ownerId: string, key: string): Promise<string> {
    const route = await deps.agent
      .json('GET', `/internal/models/${encodeURIComponent(key)}/route?userId=${ownerId}`, {
        schema: ModelRoute,
      })
      .catch(() => undefined);
    return clip(route?.systemPrompt.trim() ?? '', PERSONA_CHARS);
  }

  /** 问判断模型：有空的这几个 AI 各有多少值得说的。花的是群主的钱；问不出来这次就没人开口 */
  async function judge(
    state: NonNullable<Awaited<ReturnType<GroupTalk['state']>>>,
    idle: { model_key: string; title: string; options: { role?: string } }[],
    rounds: number,
  ): Promise<Judgment | undefined> {
    const ais = await Promise.all(
      idle.map(async (seat) => {
        const role = seat.options.role ? `；在群里负责：${seat.options.role}` : '';
        const text = await persona(state.ownerId, seat.model_key);
        return `- key=${seat.model_key}，名字：${seat.title}${role}${text ? `\n  人设：${text.replaceAll('\n', ' ')}` : ''}`;
      }),
    );
    const chat = state.lines.map(
      (line) => `${line.ai ? '[AI] ' : ''}${line.name}：${clip(line.content, LINE_CHARS)}`,
    );
    const prompt = [
      `群名：${state.title}`,
      '',
      '下面几个 AI 现在有空，没有人 @ 它们。判断此刻它们各自会不会想接话：',
      ...ais,
      '',
      `最近的群聊（按先后；最后已经连着 ${rounds} 句是 AI 说的、没有真人插话）：`,
      ...chat,
      '',
      '只输出一个 JSON，不要别的字：',
      '{"depth": 0到1, "ais": {"<key>": {"relevance": 0到1, "warmth": 0到1}}}',
      '- depth：现在这个话题有多复杂、多值得接着讨论。闲聊、已经说清楚的事接近 0；要反复推敲的方案、分歧接近 1。',
      '- relevance：这时候这个 AI 有多少值得说的。正好问到它负责的事、它能补充或纠正，接近 1；和它无关、别人已经说清楚、有人让大家别说了，接近 0。',
      '- warmth：照它的人设，它平时有多爱说话。话少、冷淡接近 0；热情、话多接近 1；人设没写就给 0.5。',
    ].join('\n');
    try {
      const { choices } = await deps.modelGateway.json('POST', '/internal/v1/chat/completions', {
        headers: { 'x-oasis-payer-id': state.ownerId },
        body: {
          model: deps.model,
          stream: false,
          temperature: 0,
          max_tokens: 400,
          messages: [
            {
              role: 'system',
              content: '你替一个群聊判断：现在群里哪些 AI 会想接话。只输出 JSON。',
            },
            { role: 'user', content: prompt },
          ],
        },
        schema: Completion,
      });
      return parseJudgment(
        choices[0]?.message.content ?? '',
        idle.map((seat) => seat.model_key),
      );
    } catch (err) {
      logger.warn({ err }, '没问出群里谁想接话，这次没人开口');
      return undefined;
    }
  }

  /** 让这个席位开一轮：先听它没听过的群聊，最后一行告诉它为什么轮到它。它已经在忙就算了 */
  async function open(seatId: string, ending: string, requestId: string) {
    await withMessageLock(deps.store, seatId, async (locked) => {
      const seat = await locked.find(seatId);
      if (!seat || seat.kind !== 'seat' || seat.turn || seat.options.removedAt) return;
      const hearing = await seats.hearing(seatId, 200);
      if (!hearing) return;
      const last = hearing.heard.at(-1);
      if (last) await seats.setHeard(seatId, last.seq);
      await deps.turns.begin(
        locked,
        seat,
        [],
        requestId,
        ownBrief(seat.modelKey ?? '', hearing.roster, hearing.heard, hearing.skipped, ending),
      );
    });
  }

  /** 群里安静下来了：判断一次，掷中的那个开口 */
  async function consider(groupId: string) {
    const state = await talk.state(groupId, LINES);
    const last = state?.lines.at(-1);
    if (!state || !last) return;
    const tier = GroupOptions.parse(state.options).speak;
    if (tier === 'mention' || !(await talk.claim(groupId, last.seq))) return;
    const idle = state.seats.filter((seat) => !seat.turn);
    if (!idle.length) return;
    const rounds = roundsOf(state.lines);
    const judgment = await judge(state, idle, rounds);
    if (!judgment) return;
    for (const urge of judgment.urges) {
      const seat = idle.find((item) => item.model_key === urge.key);
      if (seat) await talk.remember(seat.id, urge.warmth);
    }
    const picked = pickSpeaker(tier, judgment, rounds, random);
    logger.info({ groupId, tier, rounds, judgment, picked }, '群里谁想接话');
    const seat = picked && idle.find((item) => item.model_key === picked.key);
    if (seat) await open(seat.id, CHIME, `speak:${groupId}:${last.seq}`);
  }

  const settle = (groupId: string) =>
    consider(groupId).catch((err: unknown) => logger.warn({ err, groupId }, '判断群里谁接话失败'));

  return {
    /** 群里有了新的话（人说的，或一个 AI 说完了）：等安静一会儿再判断，这期间又有话就重新等 */
    nudge(groupId: string) {
      clearTimeout(timers.get(groupId));
      const timer = setTimeout(() => {
        timers.delete(groupId);
        void settle(groupId);
      }, deps.quietMs);
      timer.unref();
      timers.set(groupId, timer);
    },
    /**
     * 隔一会儿看一遍会自己开口的群（elapsedMs：离上次看过了多久）：有话还没判断过的（比如服务重启过）补上；
     * 「积极参与」的群安静久了、又有人开着，有空的 AI 按很小的概率起个话头（一次最多一个）。
     */
    async sweep(elapsedMs: number) {
      for (const groupId of await talk.lively()) {
        if (timers.has(groupId)) continue;
        const state = await talk.state(groupId, LINES);
        const last = state?.lines.at(-1);
        if (!state || !last) continue;
        const quiet = now() - last.at.getTime();
        if (quiet < deps.quietMs) continue;
        if (last.seq > Number(state.options.judgedSeq ?? 0)) {
          await settle(groupId);
          continue;
        }
        if (GroupOptions.parse(state.options).speak !== 'active' || quiet < START_AFTER_MS)
          continue;
        if (!deps.watched(groupId)) continue;
        const rounds = roundsOf(state.lines);
        const starter = state.seats.find(
          (seat) =>
            !seat.turn && random() < startChance(seat.options.warmth ?? 0.5, rounds, elapsedMs),
        );
        if (starter)
          await open(starter.id, START, `start:${groupId}:${now()}`).catch((err: unknown) =>
            logger.warn({ err, groupId }, '没能让 AI 起话头'),
          );
      }
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
export type GroupSpeak = ReturnType<typeof createGroupSpeak>;
