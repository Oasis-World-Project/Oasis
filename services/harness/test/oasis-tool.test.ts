import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../sandbox/oasis-tool.ts';
import { matchImageExt, targetsFor } from '../sandbox/tool-files.ts';

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
    expect(
      targetsFor(
        [files[0]!, { name: 'project.zip', mediaType: 'application/zip', base64: '' }],
        'out/渲染.png',
      ),
    ).toEqual(['out/渲染-1.png', 'out/渲染-2.zip']);
    expect(targetsFor(files, undefined)).toEqual([
      join('out', 'image-1.png'),
      join('out', 'image-2.png'),
    ]);
  });

  it('要存成图片但内容是另一种图片格式时按实际格式改后缀；同类或认不出的不动', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(matchImageExt('out/首帧.png', jpeg)).toBe('out/首帧.jpg');
    expect(matchImageExt('out/首帧.jpeg', jpeg)).toBe('out/首帧.jpeg');
    expect(matchImageExt('out/首帧.png', png)).toBe('out/首帧.png');
    expect(matchImageExt('out/说明.txt', jpeg)).toBe('out/说明.txt');
    expect(matchImageExt('out/首帧.png', Buffer.from('hello'))).toBe('out/首帧.png');
  });
});

describe('oasis-tool 长任务', () => {
  // 假的入口代理：提交视频返回任务号；job-done 已做好，job-slow 一直在做
  const fake = Fastify();
  const received: { key: string; args: Record<string, unknown> }[] = [];
  fake.post('/v1/tools/:key', async (request) => {
    const { key } = request.params as { key: string };
    const { args } = request.body as { args: Record<string, unknown> };
    received.push({ key, args });
    return {
      text: '已读取',
      costMicro: 100,
      files:
        key === 'web.fetch'
          ? [
              {
                name: '1-012345abcdef.md',
                mediaType: 'text/markdown',
                base64: Buffer.from(
                  '来源：https://example.com\n\n' + '长正文'.repeat(20_000),
                ).toString('base64'),
              },
            ]
          : [],
    };
  });
  fake.get('/v1/tools', async () => ({ tools: [] }));
  const videoRequests: { args: Record<string, unknown>; idempotency_key: string }[] = [];
  fake.post('/v1/tools/video.generate', async (request) => {
    videoRequests.push(request.body as (typeof videoRequests)[number]);
    return {
      tool: 'video.generate',
      text: '生成视频已提交',
      files: [],
      costMicro: 0,
      job: { id: 'job-done' },
    };
  });
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
  const musicId = '00000000-0000-4000-8000-000000000099';
  let musicSubmissions = 0;
  let corruptMusic = false;
  const musicHash = createHash('sha256').update('ID3music').digest('hex');
  fake.post('/v1/tools/audio.music', async () => {
    musicSubmissions++;
    return {
      tool: 'audio.music',
      text: 'submitted',
      files: [],
      costMicro: 0,
      job: { id: musicId },
    };
  });
  fake.get(`/v1/tools/jobs/${musicId}`, async () => ({
    status: 'completed',
    result: {
      tool: 'audio.music',
      text: 'done',
      files: [
        {
          id: '0',
          name: 'music.mp3',
          mediaType: 'audio/mpeg',
          base64: '',
          size: 8,
          sha256: musicHash,
        },
      ],
      costMicro: 150000,
      job: { id: musicId },
    },
  }));
  fake.get(`/v1/tools/jobs/${musicId}/files/0`, async (_request, reply) =>
    reply.type('audio/mpeg').send(Buffer.from(corruptMusic ? 'badmusic' : 'ID3music')),
  );
  let dir = '';
  const printed: string[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oasis-tool-'));
    vi.stubEnv('OASIS_MODEL_BASE_URL', `${await fake.listen({ port: 0, host: '127.0.0.1' })}/v1`);
    vi.stubEnv('OASIS_TOOL_AUTH', 'k');
    vi.stubEnv('OASIS_TOOL_STATE_DIR', join(dir, '.oasis-tools'));
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

  it('流式结果校验后落盘；重复命令沿用任务，损坏的字节不覆盖文件', async () => {
    const out = join(dir, 'music.mp3');
    const command = [
      'audio.music',
      '--prompt',
      'A complete instrumental song',
      '--instrumental',
      'true',
      '--out',
      out,
    ];
    await main(command);
    expect(await readFile(out, 'utf8')).toBe('ID3music');
    await main(command);
    expect(musicSubmissions).toBe(1);
    corruptMusic = true;
    await expect(main(command)).rejects.toThrow('校验和');
    expect(await readFile(out, 'utf8')).toBe('ID3music');
    corruptMusic = false;
  });
  it('提交后自己等：做好了就保存到 --out', async () => {
    const out = join(dir, '视频.mp4');
    await main(['video.generate', '--prompt', '木屋', '--out', out]);
    expect(await readFile(out, 'utf8')).toBe('mp4');
    expect(printed.join('')).toContain('花费：$0.5000');
  });
  it('视频首帧读取本地字节；同一图片复用，图片内容改变则生成不同幂等键', async () => {
    const source = join(dir, 'first.png'),
      output = join(dir, 'image-video.mp4');
    const bytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
    await writeFile(source, bytes);
    const command = [
      'video.generate',
      '--prompt',
      '镜头推进',
      '--first_frame',
      source,
      '--out',
      output,
    ];
    const before = videoRequests.length;
    await main(command);
    await main(command);
    expect(videoRequests.length - before).toBe(1);
    expect(videoRequests.at(-1)?.args.first_frame).toEqual([
      { mediaType: 'image/png', base64: bytes.toString('base64') },
    ]);
    const prior = videoRequests.at(-1)?.idempotency_key;
    await writeFile(source, Buffer.concat([bytes, Buffer.from('changed')]));
    await main(command);
    expect(videoRequests.length - before).toBe(2);
    expect(videoRequests.at(-1)?.idempotency_key).not.toBe(prior);
  });

  it('等到上限还没好：告诉 AI 用 wait 接着等', async () => {
    printed.length = 0;
    await main(['wait', 'job-slow', '--out', 'out/v.mp4']);
    expect(printed.join('')).toContain('oasis-tool wait job-slow --out "out/v.mp4"');
  });

  it('工具目录同时展示本次沙箱实际安装的软件清单', async () => {
    const manifest = join(dir, 'software.txt');
    await writeFile(manifest, 'libreoffice-writer 25.2\nopenpyxl==3.1.5\n');
    vi.stubEnv('OASIS_SOFTWARE_MANIFEST', manifest);
    printed.length = 0;
    await main(['list']);
    expect(printed.join('')).toContain('libreoffice-writer 25.2');
    expect(printed.join('')).toContain('openpyxl==3.1.5');
  });

  it('参考图和看图读取本地文件，保留 MIME 与原始字节；超数量不发送', async () => {
    const path = join(dir, 'reference.png');
    const bytes = Buffer.from('89504e470d0a1a0a0000000d494844520000000100000001', 'hex');
    await writeFile(path, bytes);
    await main(['image.generate', '--prompt', '修改背景', '--ref', JSON.stringify([path])]);
    expect(received.at(-1)).toEqual({
      key: 'image.generate',
      args: {
        prompt: '修改背景',
        references: [{ mediaType: 'image/png', base64: bytes.toString('base64') }],
      },
    });
    await main(['image.inspect', '--question', '图里是什么？', '--images', JSON.stringify([path])]);
    expect(received.at(-1)?.args.images).toEqual([
      { mediaType: 'image/png', base64: bytes.toString('base64') },
    ]);
    const count = received.length;
    await expect(
      main(['image.inspect', '--images', JSON.stringify(Array(5).fill(path))]),
    ).rejects.toThrow('1–4');
    expect(received).toHaveLength(count);
  });

  it('app.check 把 out/<dir> 里的文件随调用带上（检查在平台的隔离浏览器里跑，读不到沙箱）', async () => {
    const site = join(dir, 'out', 'site');
    await mkdir(join(site, 'js'), { recursive: true });
    await writeFile(join(site, 'index.html'), '<h1>hi</h1>');
    await writeFile(join(site, 'js', 'app.js'), 'export {}');
    vi.stubEnv('OASIS_OUT_DIR', join(dir, 'out'));
    await main(['app.check', '--dir', 'out/site/']);
    const sent = received.at(-1)!;
    expect(sent.key).toBe('app.check');
    expect(sent.args.dir).toBe('site');
    expect(sent.args.files).toEqual(
      expect.arrayContaining([
        { path: 'index.html', contentBase64: Buffer.from('<h1>hi</h1>').toString('base64') },
        { path: 'js/app.js', contentBase64: Buffer.from('export {}').toString('base64') },
      ]),
    );
    expect(sent.args.files).toHaveLength(2);
    await expect(main(['app.check', '--dir', 'out/missing'])).rejects.toThrow('out/missing 不存在');
    await expect(main(['app.check', '--dir', '../etc'])).rejects.toThrow('--dir');
  });

  it('app.check 也能检查上游交来的网页（in/<上游 key>/…）：按清单的 root 认应用，给了 --out 就要完整报告', async () => {
    // 2026-11-10：规划员让工具节点检查 in/build/site，以前一律到 out/ 下找，报「out/in/build/site 不存在」
    const manifest = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    for (const folder of [
      join(dir, 'in', 'build', 'site'),
      join(dir, 'in', 'pages', '02', 'site'),
    ]) {
      await mkdir(folder, { recursive: true });
      await writeFile(join(folder, 'index.html'), '<h1>up</h1>');
      await writeFile(join(folder, 'oasis-app.json'), manifest);
    }
    vi.stubEnv('OASIS_OUT_DIR', join(dir, 'out'));
    await main(['app.check', '--dir', 'in/build/site', '--out', join(dir, 'out', 'report.json')]);
    let sent = received.at(-1)!;
    expect(sent.args).toMatchObject({ dir: 'site', shown: 'in/build/site', report: true });
    expect(sent.args.files).toEqual(
      expect.arrayContaining([
        { path: 'index.html', contentBase64: Buffer.from('<h1>up</h1>').toString('base64') },
        { path: 'oasis-app.json', contentBase64: Buffer.from(manifest).toString('base64') },
      ]),
    );
    // 展开节点的每一条在 in/<上游 key>/<条目号>/ 下：条目号不算进应用的位置
    await main(['app.check', '--dir', '/workspace/in/pages/02/site/']);
    sent = received.at(-1)!;
    expect(sent.args).toMatchObject({ dir: 'site', shown: 'in/pages/02/site' });
    expect(sent.args.report).toBeUndefined();
    await expect(main(['app.check', '--dir', 'in/build/none'])).rejects.toThrow(
      'in/build/none 不存在',
    );
    await expect(main(['app.check', '--dir', 'in/build'])).rejects.toThrow('--dir');
  });

  it('web.fetch --out 传全文模式并写入完整 Markdown，终端只显示摘要', async () => {
    printed.length = 0;
    await main(['web.fetch', '--urls', 'https://example.com', '--out', join(dir, 'sources')]);
    expect(received.at(-1)?.args).toEqual({ urls: ['https://example.com'], format: 'files' });
    expect(
      (await readFile(join(dir, 'sources', '1-012345abcdef.md'), 'utf8')).endsWith(
        '长正文'.repeat(20_000),
      ),
    ).toBe(true);
    expect(printed.join('')).toContain('已保存 1 份全文');
    expect(printed.join('')).not.toContain('长正文');
  });
});
