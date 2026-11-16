// AI 自己开口的概率：两档的高低、爱说话的多说、话题复杂的多聊几轮、越聊越低；读判断模型的回答。
import { describe, expect, it } from 'vitest';
import {
  parseJudgment,
  pickSpeaker,
  speakChance,
  startChance,
} from '../src/service/speak-chance.ts';

const urge = (relevance: number, warmth: number, key = 'a') => ({ key, relevance, warmth });

describe('AI 自己开口的概率', () => {
  it('「看情况」：话题对口一半时热情的 25%、冷淡的 15%；正好问到本行翻倍；无关就不说', () => {
    expect(speakChance('auto', urge(0.5, 1), 0.5, 0)).toBeCloseTo(0.25);
    expect(speakChance('auto', urge(0.5, 0), 0.5, 0)).toBeCloseTo(0.15);
    expect(speakChance('auto', urge(1, 1), 0.5, 0)).toBeCloseTo(0.5);
    expect(speakChance('auto', urge(0, 1), 1, 0)).toBe(0);
  });

  it('「积极参与」比「看情况」更爱接话，最多到 1', () => {
    expect(speakChance('active', urge(0.5, 0), 0.5, 0)).toBeCloseTo(0.35);
    expect(speakChance('active', urge(0.5, 1), 0.5, 0)).toBeCloseTo(0.6);
    expect(speakChance('active', urge(1, 1), 0.5, 0)).toBe(1);
  });

  it('没有真人插话时越聊越低；话题越复杂掉得越慢', () => {
    const hard = [0, 1, 2, 5].map((rounds) => speakChance('active', urge(1, 1), 1, rounds));
    const easy = [0, 1, 2, 5].map((rounds) => speakChance('active', urge(1, 1), 0, rounds));
    expect(hard).toEqual([...hard].sort((a, b) => b - a));
    expect(hard[1]).toBeCloseTo(0.85);
    expect(easy[1]).toBeCloseTo(0.35);
    expect(hard[3]).toBeGreaterThan(0.4);
    expect(easy[3]).toBeLessThan(0.01);
  });

  it('掷骰子：掷中的里面最有话说的开口；都没掷中没人开口', () => {
    const judgment = { depth: 0.5, urges: [urge(0.6, 1, 'a'), urge(1, 1, 'b'), urge(0, 1, 'c')] };
    expect(pickSpeaker('active', judgment, 0, () => 0)?.key).toBe('b');
    expect(pickSpeaker('active', judgment, 0, () => 0.99)?.key).toBe('b');
    expect(pickSpeaker('auto', judgment, 0, () => 0.99)).toBeUndefined();
    // 第二次掷才中：只有 b 那一次不中，开口的就是 a
    const rolls = [0, 0.999, 0];
    expect(pickSpeaker('auto', judgment, 0, () => rolls.shift()!)?.key).toBe('a');
  });

  it('自己起话头的概率很小：再热情每 10 分钟也只有 8%，前面的话没人理就减半', () => {
    expect(startChance(1, 0, 600_000)).toBeCloseTo(0.08);
    expect(startChance(0, 0, 600_000)).toBeCloseTo(0.02);
    expect(startChance(1, 0, 30_000)).toBeCloseTo(0.004);
    expect(startChance(1, 2, 600_000)).toBeCloseTo(0.02);
  });

  it('读判断模型的回答：包在代码块里也行；缺的、越界的按不想说处理；读不懂就算了', () => {
    const text = '```json\n{"depth": 3, "ais": {"a": {"relevance": 0.8, "warmth": "高"}}}\n```';
    expect(parseJudgment(text, ['a', 'b'])).toEqual({
      depth: 1,
      urges: [urge(0.8, 0.5, 'a'), urge(0, 0.5, 'b')],
    });
    expect(parseJudgment('好的。', ['a'])).toBeUndefined();
    expect(parseJudgment('{不是 JSON}', ['a'])).toBeUndefined();
  });
});
