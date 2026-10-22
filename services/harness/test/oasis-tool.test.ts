import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, parseArgs, targetsFor } from '../sandbox/oasis-tool.ts';

describe('oasis-tool', () => {
  it('解析 --名字 值；列表参数按逗号拆或读 JSON；--out、--file 单独拿出来', () => {
    expect(
      parseArgs([
        '--prompt',
        '山里的小木屋',
        '--n',
        '2',
        '--urls',
        'https://a.com, https://b.com',
        '--options',
        '["甲,乙","丙"]',
        '--out',
        'out/图.png',
      ]),
    ).toEqual({
      args: {
        prompt: '山里的小木屋',
        n: '2',
        urls: ['https://a.com', 'https://b.com'],
        options: ['甲,乙', '丙'],
      },
      out: 'out/图.png',
    });
    expect(parseArgs(['--file', 'in/录音.mp3'])).toEqual({ args: {}, file: 'in/录音.mp3' });
    expect(() => parseArgs(['prompt', 'x'])).toThrow('参数要写成 --名字 值');
    expect(() => parseArgs(['--prompt'])).toThrow('--prompt 后面缺少值');
  });

  it('文件存放位置：一个文件用 --out；多个加编号；没给 --out 就放进 out/', () => {
    const files = [
      { name: 'image-1.png', mediaType: 'image/png', base64: '' },
      { name: 'image-2.png', mediaType: 'image/png', base64: '' },
    ];
    expect(targetsFor(files.slice(0, 1), 'out/首屏.png')).toEqual(['out/首屏.png']);
    expect(targetsFor(files, 'out/首屏.png')).toEqual(['out/首屏-1.png', 'out/首屏-2.png']);
    expect(targetsFor(files, undefined)).toEqual(['out/image-1.png', 'out/image-2.png']);
  });
});

describe('oasis-tool 长任务', () => {
  // 假的入口代理：提交视频返回任务号；job-done 已做好，job-slow 一直在做
  const fake = Fastify();
  fake.post('/v1/tools/video.generate', async () => ({
    tool: 'video.generate',
    text: '生成视频已提交',
    files: [],
    costMicro: 0,
    job: { id: 'job-done' },
  }));
  fake.get('/v1/tools/jobs/:id', async (request) =>
    (request.params as { id: string }).id === 'job-done'
      ? {
          status: 'completed',
          result: {
            tool: 'video.generate',
            text: '视频生成好了',
            files: [
              {
                name: 'video.mp4',
                mediaType: 'video/mp4',
                base64: Buffer.from('mp4').toString('base64'),
              },
            ],
            costMicro: 500_000,
          },
        }
      : { status: 'pending' },
  );
  let dir = '';
  const printed: string[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oasis-tool-'));
    vi.stubEnv('OASIS_MODEL_BASE_URL', `${await fake.listen({ port: 0, host: '127.0.0.1' })}/v1`);
    vi.stubEnv('OASIS_RUN_KEY', 'k');
    vi.stubEnv('OASIS_TOOL_WAIT_SECONDS', '1');
    vi.spyOn(process.stdout, 'write').mockImplementation((text) => {
      printed.push(String(text));
      return true;
    });
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await fake.close();
    await rm(dir, { recursive: true, force: true });
  });

  it('提交后自己等：做好了就保存到 --out', async () => {
    const out = join(dir, '视频.mp4');
    await main(['video.generate', '--prompt', '木屋', '--out', out]);
    expect(await readFile(out, 'utf8')).toBe('mp4');
    expect(printed.join('')).toContain('花费：$0.5000');
  });

  it('等到上限还没好：告诉 AI 用 wait 接着等', async () => {
    printed.length = 0;
    await main(['wait', 'job-slow', '--out', 'out/v.mp4']);
    expect(printed.join('')).toContain('oasis-tool wait job-slow --out "out/v.mp4"');
  });
});
