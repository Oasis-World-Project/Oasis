import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { main, parseArgs } from '../sandbox/oasis-tool.ts';
import { matchExt, requireDelivered, startOf, targetsFor } from '../sandbox/tool-files.ts';

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
    // 几个画面的描述里常有逗号：只认 JSON 数组
    expect(parseArgs(['--prompts', '["门店外景，白天, 暖色","海报"]']).args).toEqual({
      prompts: ['门店外景，白天, 暖色', '海报'],
    });
    expect(() => parseArgs(['--prompts', '门店外景,海报'])).toThrow('JSON 数组');
  });

  it('文件存放位置：一个文件用 --out；多个加编号；没给 --out 就放进 out/', () => {
    const files = [
      { name: 'image-1.png', mediaType: 'image/png', base64: '' },
      { name: 'image-2.png', mediaType: 'image/png', base64: '' },
    ];
    expect(targetsFor(files.slice(0, 1), 'out/首屏.png')).toEqual(['out/首屏.png']);
    expect(targetsFor(files, 'out/首屏.png')).toEqual(['out/首屏-1.png', 'out/首屏-2.png']);
    // 中间一张没做出来：编号跟着工具给的号走，和描述的顺序对得上
    expect(targetsFor([files[1]!, { name: 'image-3.png' }], 'out/帧.png')).toEqual([
      'out/帧-2.png',
      'out/帧-3.png',
    ]);
    expect(
      targetsFor(
        [files[0]!, { name: 'project.zip', mediaType: 'application/zip', base64: '' }],
        'out/渲染.png',
      ),
    ).toEqual(['out/渲染.png', 'out/渲染-project.zip']);
    // 后缀不一样、只有一个和 --out 同后缀：它是主结果，原样存到 --out；附带的放旁边（app.check 的报告和截图）
    expect(
      targetsFor(
        [{ name: 'app-check.json' }, { name: 'opening.jpg' }, { name: 'step-3.jpg' }],
        'work/检查报告.json',
      ),
    ).toEqual(['work/检查报告.json', 'work/检查报告-opening.jpg', 'work/检查报告-step-3.jpg']);
    expect(targetsFor(files, undefined)).toEqual([
      join('out', 'image-1.png'),
      join('out', 'image-2.png'),
    ]);
  });

  it('生图、视频这类做出的文件只能存进 out/：写到别处这次不提交、不收费', async () => {
    expect(() => requireDelivered('out/素材/帧.png')).not.toThrow();
    expect(() => requireDelivered('work/帧.png')).toThrow('存进 out/');
    await expect(
      main(['image.generate', '--prompt', '猫', '--out', 'work/猫.png']),
    ).rejects.toThrow('没有收费');
  });

  it('要存成图片但内容是另一种图片格式时按实际格式改后缀；同类或认不出的不动', () => {
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10]);
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    expect(matchExt('out/首帧.png', jpeg)).toBe('out/首帧.jpg');
    expect(matchExt('out/首帧.jpeg', jpeg)).toBe('out/首帧.jpeg');
    expect(matchExt('out/首帧.png', png)).toBe('out/首帧.png');
    expect(matchExt('out/说明.txt', jpeg)).toBe('out/说明.txt');
    expect(matchExt('out/首帧.png', Buffer.from('hello'))).toBe('out/首帧.png');
  });

  it('音频也按实际格式改后缀：挂着 ID3 标签的看标签后面是 FLAC 还是 MP3', async () => {
    // fal 给生成的音频挂一段 ID3 标签（内容凭证），ACE-Step 的标签后面是 FLAC（2026-11-11 真实返回）
    const id3 = (body: number) =>
      Buffer.concat([
        Buffer.from('ID3\x04\x00\x00\x00\x00', 'latin1'),
        Buffer.from([body >> 7, body & 127]),
      ]);
    const tagged = (after: Buffer) => Buffer.concat([id3(300), Buffer.alloc(300), after]);
    const flac = tagged(Buffer.from('fLaC\x00\x00\x00\x22', 'latin1'));
    const mp3 = tagged(Buffer.from([0xff, 0xfb, 0x90, 0x64]));
    expect(matchExt('out/音乐.mp3', flac)).toBe('out/音乐.flac');
    expect(matchExt('out/音乐.mp3', mp3)).toBe('out/音乐.mp3');
    expect(matchExt('out/音乐.flac', Buffer.from('fLaC'))).toBe('out/音乐.flac');
    expect(matchExt('out/音乐.mp3', Buffer.from('RIFF\x00\x00\x00\x00WAVEfmt ', 'latin1'))).toBe(
      'out/音乐.wav',
    );
    expect(matchExt('out/音乐.mp3', Buffer.from([0xff, 0xfb, 0x90, 0x64]))).toBe('out/音乐.mp3');
    // 别的后缀（视频、模型）不管
    expect(matchExt('out/片子.mp4', flac)).toBe('out/片子.mp4');

    // 长任务的文件是先存到盘上的：只读开头够认格式的一段
    const dir = await mkdtemp(join(tmpdir(), 'oasis-ext-'));
    try {
      await writeFile(join(dir, 'a.mp3'), Buffer.concat([flac, Buffer.alloc(4096)]));
      const start = await startOf(join(dir, 'a.mp3'));
      expect(start).toHaveLength(314);
      expect(matchExt('out/a.mp3', start)).toBe('out/a.flac');
      await writeFile(join(dir, 'b.glb'), Buffer.concat([Buffer.from('glTF'), Buffer.alloc(100)]));
      expect(await startOf(join(dir, 'b.glb'))).toHaveLength(16);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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
  fake.get('/v1/tools', async () => ({
    tools: [
      {
        key: 'video.generate',
        name: '生成视频',
        description: '按文字生成短视频',
        usage: 'oasis-tool video.generate --prompt "…" --out out/视频.mp4',
        unit: '秒',
        available: true,
        rates: [{ model: 'alibaba/wan-3.0', costMicro: 50_000, seconds: 153 }],
        args: [
          { name: 'prompt', description: '画面描述' },
          { name: 'resolution', description: '清晰度', choices: ['480p', '720p'] },
        ],
      },
    ],
  }));
  const videoRequests: { args: Record<string, unknown>; idempotency_key: string }[] = [];
  // 「第一段」「第二段」各有自己的任务号（几段一起交、一起等）；别的都是 job-done
  const videoJobs: Record<string, string> = { 第一段: 'job-one', 第二段: 'job-two' };
  fake.post('/v1/tools/video.generate', async (request) => {
    const body = request.body as (typeof videoRequests)[number];
    videoRequests.push(body);
    return {
      tool: 'video.generate',
      text: '生成视频已提交',
      files: [],
      costMicro: 0,
      job: { id: videoJobs[String(body.args.prompt)] ?? 'job-done' },
    };
  });
  fake.get('/v1/tools/jobs/:id', async (request) => {
    const { id } = request.params as { id: string };
    return ['job-done', 'job-one', 'job-two'].includes(id)
      ? {
          status: 'completed',
          result: {
            tool: 'video.generate',
            text: '视频生成好了',
            files: [
              {
                name: 'video.mp4',
                mediaType: 'video/mp4',
                base64: Buffer.from(id === 'job-done' ? 'mp4' : `mp4 ${id}`).toString('base64'),
              },
            ],
            costMicro: 500_000,
          },
        }
      : { status: 'pending' };
  });
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
  // 花钱的工具设了「问我」：第一次交回确认卡，用户点了以后带确认号重交
  const card = '00000000-0000-4000-8000-0000000000ca';
  let cardStatus = 'pending';
  const speechRequests: { confirmation_id?: string }[] = [];
  fake.post('/v1/tools/audio.speech', async (request) => {
    const body = request.body as { confirmation_id?: string };
    speechRequests.push(body);
    if (!body.confirmation_id)
      return {
        tool: 'audio.speech',
        text: '要先确认',
        files: [],
        costMicro: 0,
        confirmation: { id: card },
      };
    const audio = Buffer.from('ID3speech').toString('base64');
    return {
      tool: 'audio.speech',
      text: '配好了',
      files: [{ name: 'speech.mp3', mediaType: 'audio/mpeg', base64: audio }],
      costMicro: 2_000,
    };
  });
  fake.get(`/v1/confirmations/${card}`, async () => {
    if (cardStatus === 'pending') await new Promise((resolve) => setTimeout(resolve, 200));
    return { id: card, status: cardStatus };
  });
  let dir = '';
  const printed: string[] = [];
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oasis-tool-'));
    vi.stubEnv('OASIS_MODEL_BASE_URL', `${await fake.listen({ port: 0, host: '127.0.0.1' })}/v1`);
    vi.stubEnv('OASIS_TOOL_AUTH', 'k');
    vi.stubEnv('OASIS_TOOL_STATE_DIR', join(dir, '.oasis-tools'));
    vi.stubEnv('OASIS_TOOL_WAIT_SECONDS', '1');
    // 临时目录当交付目录：生成的文件只能存在这里面
    vi.stubEnv('OASIS_OUT_DIR', dir);
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

  it('花钱的工具要先问：用户允许了带确认号重交；拒绝了不调；一直没点就让 AI 回头重跑同一条命令', async () => {
    printed.length = 0;
    cardStatus = 'allowed';
    const out = join(dir, '配音.mp3');
    await main(['audio.speech', '--text', '你好', '--out', out]);
    expect(speechRequests.map((body) => body.confirmation_id ?? null)).toEqual([null, card]);
    expect(await readFile(out, 'utf8')).toBe('ID3speech');
    expect(printed.join('')).toContain('等用户在聊天里确认');
    cardStatus = 'denied';
    await expect(main(['audio.speech', '--text', '再来', '--out', out])).rejects.toThrow(
      '用户没同意',
    );
    cardStatus = 'pending';
    await expect(main(['audio.speech', '--text', '再来', '--out', out])).rejects.toThrow(
      '同一条命令',
    );
    expect(speechRequests).toHaveLength(4);
  });

  it('等到上限还没好：告诉 AI 用 wait 接着等', async () => {
    printed.length = 0;
    const out = join(dir, 'v.mp4');
    await main(['wait', 'job-slow', '--out', out]);
    expect(printed.join('')).toContain(`oasis-tool wait job-slow --out ${JSON.stringify(out)}`);
  });
  it('--wait false 只提交、马上给任务号；几个一起等，各存到交的时候写的 --out', async () => {
    const one = join(dir, '镜头一.mp4'),
      two = join(dir, '镜头二.mp4');
    printed.length = 0;
    await main(['video.generate', '--prompt', '第一段', '--out', one, '--wait', 'false']);
    await main(['video.generate', '--prompt', '第二段', '--out', two, '--wait', 'false']);
    expect(printed.join('')).toContain('oasis-tool wait job-two');
    expect(videoRequests.at(-1)?.args).not.toHaveProperty('wait');
    await expect(readFile(one)).rejects.toThrow();

    printed.length = 0;
    await main(['wait', 'job-one', 'job-two', 'job-slow']);
    expect(await readFile(one, 'utf8')).toBe('mp4 job-one');
    expect(await readFile(two, 'utf8')).toBe('mp4 job-two');
    // 先说哪个任务号做好了，存下的每个文件后面也带上任务号（AI 只看末几行时进度页照样对得上）
    expect(printed.join('')).toContain(
      `做好了（任务号 job-one）\n视频生成好了\n已保存：${one}（任务号 job-one）`,
    );
    expect(printed.join('')).toContain('还没做好（任务号 job-slow）');
    await expect(main(['wait', 'job-one', 'job-two', '--out', one])).rejects.toThrow('不写 --out');
  });

  it('oasis-tool <工具> --help 只看这一个：说明、用法、单价和每个参数', async () => {
    printed.length = 0;
    await main(['video.generate', '--help']);
    const text = printed.join('');
    expect(text).toContain('video.generate（生成视频）：按文字生成短视频');
    expect(text).toContain('alibaba/wan-3.0 每秒约 $0.050、一次约 153 秒');
    expect(text).toContain('--resolution：清晰度（480p、720p）');
    await expect(main(['nope.tool', '-h'])).rejects.toThrow('没有能用的工具 nope.tool');
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
    // 看图、看视频、听音频是同一个工具：按后缀认出种类，音频带格式、图片和视频带媒体类型
    const song = join(dirname(path), 'bgm.mp3');
    const clip = join(dirname(path), 'clip.mp4');
    await writeFile(song, 'ID3 music');
    await writeFile(clip, 'mp4 video');
    await main([
      'media.inspect',
      '--question',
      '哪个更好？',
      '--files',
      JSON.stringify([path, song, clip]),
    ]);
    expect(received.at(-1)?.args.files).toEqual([
      { kind: 'image', mediaType: 'image/png', base64: bytes.toString('base64') },
      { kind: 'audio', format: 'mp3', base64: Buffer.from('ID3 music').toString('base64') },
      {
        kind: 'video',
        mediaType: 'video/mp4',
        base64: Buffer.from('mp4 video').toString('base64'),
      },
    ]);
    const count = received.length;
    await expect(
      main(['media.inspect', '--files', JSON.stringify(Array(5).fill(path))]),
    ).rejects.toThrow('1–4');
    await expect(
      main(['media.inspect', '--files', JSON.stringify([join(dirname(path), 'a.txt')])]),
    ).rejects.toThrow('只支持图片');
    // 参考图只收图片
    await expect(
      main(['image.generate', '--prompt', 'x', '--ref', JSON.stringify([song])]),
    ).rejects.toThrow('图片只支持');
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
    // 没写 out/ 的按 out/ 下算；给了 --out 就要完整报告
    await main(['app.check', '--dir', '/workspace/site', '--out', join(dir, 'out', 'report.json')]);
    expect(received.at(-1)!.args).toMatchObject({ dir: 'site', shown: 'out/site', report: true });
    await expect(main(['app.check', '--dir', 'out/missing'])).rejects.toThrow('out/missing 不存在');
    await expect(main(['app.check', '--dir', '../etc'])).rejects.toThrow('--dir');
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
