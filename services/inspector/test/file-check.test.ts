import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { HttpError, packFiles } from '@oasis/service-kit';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createFileCheck } from '../src/service/file-check.ts';
import { defaultInspectionLimits } from '../src/service/file-inspection.ts';
import { createSources, type Sources } from '../src/service/sources.ts';

/** harness 存的产出包：Docker 取出 /workspace/out 时带着 out/ 这一层 */
const outputs = () =>
  packFiles([
    { path: 'out/result.md', content: Buffer.from('# 成果') },
    { path: 'out/.oasis-keep', content: Buffer.alloc(0) },
    { path: 'out/big.txt', content: Buffer.alloc(64, 97) },
  ]);
const sourcesOf = (tar: Buffer): Sources => ({ open: async () => Readable.from([tar]) });

describe('关卡的文件解析（运行产出包）', () => {
  it('只解析要的文件，总长超过上限就截断；没要的、包里没有的都不报', async () => {
    const check = createFileCheck({
      sources: sourcesOf(await outputs()),
      limits: defaultInspectionLimits,
      maxArchiveBytes: 1024 * 1024,
    });
    const url = 'http://s3.test/harness/runs/1/outputs.tar?sig';
    expect(await check({ url, paths: ['result.md'], maxChars: 3 })).toEqual({
      files: [{ path: 'result.md', text: '# 成', valid: true, truncated: true }],
      truncated: true,
    });
    expect(await check({ url, paths: [], maxChars: 100 })).toEqual({
      files: [],
      truncated: false,
    });
    expect(await check({ url, paths: ['missing.md'], maxChars: 100 })).toEqual({
      files: [],
      truncated: false,
    });
    expect(
      (await check({ url, paths: ['result.md', 'missing.md'], maxChars: 100 })).files.map(
        (f) => f.path,
      ),
    ).toEqual(['result.md']);
  });

  it('单个文件超过解析上限：记为没检查完，不当成损坏', async () => {
    const check = createFileCheck({
      sources: sourcesOf(await outputs()),
      limits: { ...defaultInspectionLimits, inputBytes: 10 },
      maxArchiveBytes: 1024 * 1024,
    });
    expect(await check({ url: 'http://s3.test/x', paths: ['big.txt'], maxChars: 100 })).toEqual({
      files: [
        {
          path: 'big.txt',
          text: '',
          valid: false,
          error: '文件超过解析大小上限',
          errorKind: 'incomplete',
        },
      ],
      truncated: false,
    });
  });
});

describe('下载链接', () => {
  let server: http.Server;
  let origin: string;
  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/ok') response.end('内容');
      else response.writeHead(403).end('expired');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));

  it('只认放行的对象存储地址；过期或不在了是 404', async () => {
    const sources = createSources({ origins: [origin], timeoutMs: 5000 });
    const body = await sources.open(`${origin}/ok`);
    expect(Buffer.concat(await body.toArray()).toString()).toBe('内容');
    await expect(sources.open('http://169.254.169.254/latest')).rejects.toMatchObject({
      statusCode: 400,
      code: 'source_not_allowed',
    });
    const expired = await sources.open(`${origin}/old`).catch((err: unknown) => err);
    expect(expired).toBeInstanceOf(HttpError);
    expect(expired).toMatchObject({ statusCode: 404, code: 'source_not_found' });
  });
});
