import { describe, expect, it } from 'vitest';
import {
  actualCostMicro,
  estimateHoldMicro,
  estimateInputTokens,
  videoSecondRate,
  withNodeRate,
} from '../src/service/pricing.ts';

// $0.10 / 百万输入 token，$0.50 / 百万输出 token
const PRICE = { prompt: 0.0000001, completion: 0.0000005 };
const messages = [{ role: 'user' as const, content: '你好'.repeat(30) }]; // 60 个字符

describe('冻结金额估算', () => {
  it('按 1.5 字符 / token 加每条消息 8 token 估算输入', () => {
    expect(estimateInputTokens(messages)).toBe(40 + 8);
  });
  it('冻结 = 全部输入 + 输出写满 max_tokens，向上取整', () => {
    // 48 × 0.1 + 1000 × 0.5 = 504.8 微美元
    expect(estimateHoldMicro(PRICE, messages, 1000)).toBe(505);
  });
  it('工具调用和工具定义也计入输入', () => {
    const withTools = [
      ...messages,
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [
          {
            id: 'c',
            type: 'function' as const,
            function: { name: 'write', arguments: 'x'.repeat(90) },
          },
        ],
      },
    ];
    expect(estimateInputTokens(withTools)).toBeGreaterThan(estimateInputTokens(messages) + 60);
    expect(estimateInputTokens(messages, 150)).toBe(estimateInputTokens(messages) + 100);
  });
  it('再便宜也至少冻结 1 微美元', () => {
    expect(estimateHoldMicro({ prompt: 0, completion: 0 }, messages, 10)).toBe(1);
  });
});

describe('实际花费', () => {
  it('优先用供应商返回的 cost', () => {
    expect(
      actualCostMicro({
        usage: { cost: 0.000321, prompt_tokens: 1, completion_tokens: 1 },
        price: PRICE,
        messages,
        completionChars: 0,
      }),
    ).toEqual({ costMicro: 321, source: 'provider' });
  });
  it('没有 cost 时按 token 数计算', () => {
    expect(
      actualCostMicro({
        usage: { prompt_tokens: 100, completion_tokens: 200 },
        price: PRICE,
        messages,
        completionChars: 0,
      }),
    ).toEqual({ costMicro: 110, source: 'tokens' });
  });
  it('什么都没有（中途断开）时按已生成的字数估算', () => {
    const result = actualCostMicro({
      usage: undefined,
      price: PRICE,
      messages,
      completionChars: 300,
    });
    expect(result.source).toBe('estimate');
    expect(result.costMicro).toBe(Math.ceil(48 * 0.1 + 200 * 0.5));
  });
});

describe('估价用的典型单价（ADR 0016 §4）', () => {
  const capabilities = {
    id: 'v/m',
    name: 'M',
    contextWindow: 100_000,
    maxTokens: 8_000,
    input: ['text' as const],
    reasoning: false,
  };
  const price = { capabilities, prompt: 1e-6, completion: 4e-6 };

  it('节点：有这个型号的记录用记录，没有按价格表乘典型用量；不给记录时按假设用量', () => {
    const usage = {
      tools: new Map(),
      nodes: new Map([['v/m', { costMicro: 30_000, seconds: 240, samples: 5 }]]),
      nodeTokens: { prompt: 200_000, completion: 10_000 },
    };
    const assumed = { prompt: 300_000, completion: 20_000 };
    expect(withNodeRate(price, usage, assumed).node).toEqual({
      costMicro: 30_000,
      seconds: 240,
      basis: 'history',
    });
    expect(withNodeRate(price, { ...usage, nodes: new Map() }, assumed).node).toEqual({
      costMicro: 240_000,
      seconds: null,
      basis: 'catalog',
    });
    // 开发阶段不看记录：300k × $1/M + 20k × $4/M = $0.38
    expect(withNodeRate(price, undefined, assumed).node).toEqual({
      costMicro: 380_000,
      seconds: null,
      basis: 'catalog',
    });
  });

  it('视频每秒：美元和美分 SKU 都认，取较高档；没有 SKU 是 NaN', () => {
    expect(videoSecondRate({ duration_seconds_720p: '0.1' }, '720p', false)).toBe(0.1);
    expect(
      videoSecondRate(
        { duration_seconds_720p: '0.1', cents_per_video_output_second: '15' },
        '720p',
        false,
      ),
    ).toBe(0.15);
    expect(videoSecondRate({}, '720p', false)).toBeNaN();
  });
});
