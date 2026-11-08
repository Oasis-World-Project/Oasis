import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { defaultDockerSocket, demultiplex } from '../src/docker.ts';

const frame = (stream: 1 | 2, text: string) => {
  const payload = Buffer.from(text);
  const header = Buffer.alloc(8);
  header[0] = stream;
  header.writeUInt32BE(payload.length, 4);
  return Buffer.concat([header, payload]);
};

describe('Docker 输出拆流', () => {
  it('按帧头把 stdout 和 stderr 分开，帧被拆成几段也能拼回来', async () => {
    const source = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    demultiplex(source, stdout, stderr);
    const all = Buffer.concat([frame(1, '{"a":1}\n'), frame(2, 'warn'), frame(1, '{"b":2}\n')]);
    source.write(all.subarray(0, 5));
    source.write(all.subarray(5, 20));
    source.end(all.subarray(20));
    const read = async (s: PassThrough) => Buffer.concat(await s.toArray()).toString();
    expect(await read(stdout)).toBe('{"a":1}\n{"b":2}\n');
    expect(await read(stderr)).toBe('warn');
  });

  it('默认 socket：Windows 用 Docker Desktop 的命名管道', () => {
    expect(defaultDockerSocket('win32')).toBe('//./pipe/docker_engine');
    expect(defaultDockerSocket('linux')).toBe('/var/run/docker.sock');
  });
});
