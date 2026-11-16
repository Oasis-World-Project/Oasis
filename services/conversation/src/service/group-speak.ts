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
import type { GroupFiles } from './group-files.ts';
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
/** 最后连着几句是 AI 说的（没有真人插话）；since：只数这一条之后的（被派了活的 AI 从那里重新算） */
const roundsOf = (lines: TalkLine[], since = 0) => {
  const human = lines.findLastIndex((line) => !line.ai || line.seq <= since);
  return lines.length - 1 - human;
};
const CHIME_INTRO = '下面几个 AI 现在有空，没有人 @ 它们。判断此刻它们各自会不会想接话：';
const LEAD_INTRO =
  '群里最后那句话是对全体 AI 说的（@ 了全体，或作为任务发到群里）。下面几个 AI 现在有空，判断它们各自对这件事有多对口：';

export function createGroupSpeak(deps: {
  talk: GroupTalk;
  seats: GroupSeats;
  store: ConversationRepo;
  turns: Turns;
  agent: ServiceClient;
  modelGateway: ServiceClient;
  logger: Logger;
  /** 开一轮时带上群文件里它还没拿到的 */
  files: Pick<GroupFiles, 'attach'>;
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
  /** 这些群下一次判断不看档位（对全体说的话，先出来的 AI 说完了，别的 AI 可以补一句） */
  const forced = new Set<string>();

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
    intro = CHIME_INTRO,
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
      intro,
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
        await deps.files.attach(
          seat,
          ownBrief(seat.modelKey ?? '', hearing.roster, hearing.heard, hearing.skipped, ending),
        ),
      );
    });
  }

  /** 群里安静下来了：判断一次，掷中的那个开口 */
  async function consider(groupId: string) {
    const state = await talk.state(groupId, LINES);
    const last = state?.lines.at(-1);
    if (!state || !last) return;
    const force = forced.delete(groupId);
    const speak = GroupOptions.parse(state.options).speak;
    if ((speak === 'mention' && !force) || !(await talk.claim(groupId, last.seq))) return;
    // 「只在被 @ 时」的群里补话：按「积极参与」的概率算
    const tier = speak === 'mention' ? 'active' : speak;
    const idle = state.seats.filter((seat) => !seat.turn);
    if (!idle.length) return;
    const rounds = roundsOf(state.lines);
    const judgment = await judge(state, idle, rounds);
    if (!judgment) return;
    for (const urge of judgment.urges) {
      const seat = idle.find((item) => item.model_key === urge.key);
      if (seat) await talk.remember(seat.id, urge.warmth);
    }
    // 刚被派了活的 AI「越聊越低」从派活那一条重新算
    const since = new Map(idle.map((seat) => [seat.model_key, seat.options.assignedSeq ?? 0]));
    const picked = pickSpeaker(
      tier,
      judgment,
      (key) => roundsOf(state.lines, since.get(key)),
      random,
    );
    logger.info({ groupId, tier, rounds, judgment, picked }, '群里谁想接话');
    const seat = picked && idle.find((item) => item.model_key === picked.key);
    if (seat) await open(seat.id, CHIME, `speak:${groupId}:${last.seq}`);
  }

  const settle = (groupId: string) =>
    consider(groupId).catch((err: unknown) => logger.warn({ err, groupId }, '判断群里谁接话失败'));

  return {
    /** 群里有了新的话（人说的，或一个 AI 说完了）：等安静一会儿再判断，这期间又有话就重新等 */
    nudge(groupId: string, force = false) {
      if (force) forced.add(groupId);
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
    /**
     * 对全体 AI 说的一句话（@ 了全体，或作为任务发布）让谁先出来负责：问判断模型，挑最对口的那个有空的 AI。
     * 没有有空的、问不出来，返回 undefined（调用方按进群先后挑）。
     */
    async lead(groupId: string): Promise<string | undefined> {
      const state = await talk.state(groupId, LINES);
      const idle = state?.seats.filter((seat) => !seat.turn) ?? [];
      if (!state || !idle.length) return undefined;
      if (idle.length === 1) return idle[0]!.model_key;
      const judgment = await judge(state, idle, 0, LEAD_INTRO);
      const best = judgment?.urges.toSorted((a, b) => b.relevance - a.relevance)[0];
      logger.info({ groupId, judgment, lead: best?.key }, '对全体说的话谁先出来');
      return best?.key;
    },
    close() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}
export type GroupSpeak = ReturnType<typeof createGroupSpeak>;
