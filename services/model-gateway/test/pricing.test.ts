import { describe, expect, it } from 'vitest';
import { actualCostMicro, estimateHoldMicro, estimateInputTokens } from '../src/service/pricing.ts';

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
