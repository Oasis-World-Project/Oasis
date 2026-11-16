// AI 自己开口的概率（没人 @ 它的时候）。程序不设门槛、不设次数上限，只按概率掷骰子：
//   接话的概率 = min(1, (档位的底 + 档位的幅度 × 爱说话的程度) × 2 × 有多少值得说的) × 兴致
//   兴致 = (0.35 + 0.5 × 话题有多复杂) 的「已经连着几句没有真人插话」次方
// 「有多少值得说的」「爱说话的程度」「话题有多复杂」由判断模型看着群聊和每个 AI 的人设给出（都是 0 到 1）。
// 例：「看情况」里话题对口一半（0.5）时，热情的 AI（1）是 25%，冷淡的（0）是 15%；正好问到它本行（1）时翻倍。
// 话题越复杂兴致掉得越慢（最复杂每句 ×0.85，最简单每句 ×0.35），真人一说话就从头算。
import type { GroupSpeak } from '@oasis/contracts/group';

type Lively = Exclude<GroupSpeak, 'mention'>;
/** 两档的底和幅度：「积极参与」比「看情况」更爱接话 */
const TIER: Record<Lively, { base: number; range: number }> = {
  auto: { base: 0.15, range: 0.1 },
  active: { base: 0.35, range: 0.25 },
};
/** 群里安静时自己起话头（只有「积极参与」）：每安静 10 分钟的概率，再按没人理的句数减半 */
const START = { base: 0.02, range: 0.06, perMs: 600_000 };

const unit = (value: unknown, fallback: number) =>
  typeof value === 'number' && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;

/** 判断模型对一个 AI 给的两个数 */
export interface Urge {
  key: string;
  /** 这时候它有多少值得说的 */
  relevance: number;
  /** 照它的人设，它平时有多爱说话 */
  warmth: number;
}
export interface Judgment {
  /** 现在的话题有多复杂、多值得接着讨论 */
  depth: number;
  urges: Urge[];
}

/** 兴致：连着 rounds 句没有真人插话以后还剩多少 */
const mood = (depth: number, rounds: number) => (0.35 + 0.5 * depth) ** rounds;

/** 这个 AI 现在接话的概率 */
export function speakChance(tier: Lively, urge: Urge, depth: number, rounds: number): number {
  const { base, range } = TIER[tier];
  return Math.min(1, (base + range * urge.warmth) * 2 * urge.relevance) * mood(depth, rounds);
}

/** 群里安静了 quietMs：这个 AI 在这段时间里自己起话头的概率（rounds：前面已经有几句 AI 的话没人理） */
export function startChance(warmth: number, rounds: number, quietMs: number): number {
  return Math.min(1, ((START.base + START.range * warmth) * quietMs) / START.perMs) * 0.5 ** rounds;
}

/**
 * 掷骰子：每个 AI 各掷一次，掷中的里面挑最有话说的那个开口（一次只让一个开口，它说完再判断，
 * 别的 AI 那时看得到它说了什么）。都没掷中就没人开口。
 */
export function pickSpeaker(
  tier: Lively,
  judgment: Judgment,
  rounds: number,
  random: () => number,
): { key: string; chance: number } | undefined {
  return judgment.urges
    .map((urge) => ({ urge, chance: speakChance(tier, urge, judgment.depth, rounds) }))
    .filter(({ chance }) => random() < chance)
    .sort((a, b) => b.urge.relevance - a.urge.relevance)
    .map(({ urge, chance }) => ({ key: urge.key, chance }))[0];
}

/** 读判断模型的回答（JSON，可能包在代码块里）；读不懂返回 undefined（这次就没人开口） */
export function parseJudgment(text: string, keys: string[]): Judgment | undefined {
  const start = text.indexOf('{'),
    end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  let value: { depth?: unknown; ais?: Record<string, { relevance?: unknown; warmth?: unknown }> };
  try {
    value = JSON.parse(text.slice(start, end + 1)) as typeof value;
  } catch {
    return undefined;
  }
  const ais = value.ais && typeof value.ais === 'object' ? value.ais : {};
  return {
    depth: unit(value.depth, 0.3),
    urges: keys.map((key) => ({
      key,
      relevance: unit(ais[key]?.relevance, 0),
      warmth: unit(ais[key]?.warmth, 0.5),
    })),
  };
}
