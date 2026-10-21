import { describe, expect, it } from 'vitest';
import { createSseParser } from '../src/index.ts';

function collect(chunks: string[]): string[] {
  const out: string[] = [];
  const parser = createSseParser((data) => out.push(data));
  for (const chunk of chunks) parser.push(chunk);
  parser.end();
  return out;
}

describe('SSE 解析', () => {
  it('事件跨分片到达也能完整拼出', () => {
    expect(collect(['data: {"a"', ':1}\n', '\ndata: [DONE]\n\n'])).toEqual(['{"a":1}', '[DONE]']);
  });
  it('忽略注释行，兼容 CRLF', () => {
    expect(collect([': OPENROUTER PROCESSING\r\n\r\ndata: x\r\n\r\n'])).toEqual(['x']);
  });
  it('多行 data 用换行拼接；末尾没有空行也会派发', () => {
    expect(collect(['data: a\ndata: b\n\ndata: tail'])).toEqual(['a\nb', 'tail']);
  });
});
