import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { checkedParts } from '../src/object-store.ts';

describe('有界文件传输', () => {
  it('跨越多段时保持内容、大小和校验和，任意分段不累积整文件', async () => {
    const chunk = Buffer.alloc(64 * 1024, 42);
    const count = 400;
    const hash = createHash('sha256');
    for (let n = 0; n < count; n++) hash.update(chunk);
    const expected = hash.digest('hex');
    const source = Readable.from(
      (async function* () {
        for (let n = 0; n < count; n++) yield chunk;
      })(),
    );
    const parts = checkedParts(source, { maxBytes: chunk.length * count, sha256: expected });
    let size = 0;
    for (;;) {
      const next = await parts.next();
      if (next.done) {
        expect(next.value).toEqual({ size, sha256: expected });
        break;
      }
      expect(next.value.length).toBeLessThanOrEqual(8 * 1024 * 1024);
      size += next.value.length;
    }
    expect(size).toBe(chunk.length * count);
  });
  it('超过上限、截断或错误摘要都不能完成写入', async () => {
    for (const limits of [
      { maxBytes: 2 },
      { maxBytes: 10, size: 4 },
      { maxBytes: 10, sha256: '0'.repeat(64) },
    ]) {
      await expect(
        (async () => {
          for await (const _part of checkedParts(Readable.from([Buffer.from('abc')]), limits)) {
            /* 消费 */
          }
        })(),
      ).rejects.toThrow();
    }
  });
});
