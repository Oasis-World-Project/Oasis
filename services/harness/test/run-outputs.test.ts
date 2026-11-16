// 运行服务：对话里的一轮从输入到产出（平台说明和技能、用户发的文件、持久工作目录、产出文件、删对话）。
import { Readable } from 'node:stream';
import { extractFiles, packFiles } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { SANDBOX_PATHS } from '../src/adapter/dsh.ts';
import {
  executor,
  PAYER,
  CONVERSATION,
  methods,
  started,
  destroyed,
  workspaces,
  rows,
  events,
  finishes,
  stored,
  issued,
  revoked,
  compute,
  lifecycle,
  PHOTO,
  uploadOwners,
  BIG,
  POSTER,
  service,
  finished,
  base,
  tarEntries,
} from './support/run-fixture.ts';

const UPLOADER = '6e6e6e6e-6e6e-4e6e-8e6e-6e6e6e6e6e6e';

const OTHER_CONVERSATION = '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d';
const placed = (index: number, dir: string) =>
  started[index]?.files.find((f) => f.dir === dir)?.tar ?? Buffer.alloc(0);

describe('对话里的一轮：输入和产出', () => {
  it.each(['TRUNCATED', 'NO_END'])(
    '非正常结束不能当成功：%s（即使有产物和空闲通知）',
    async (prompt) => {
      const run = await service.start({ ...base, prompt });
      const row = await finished(run.id);
      expect(row.status).toBe('failed');
      expect(row.error).toMatch(/未完成|未收到正常结束/);
      expect(finishes[0]?.outcome).toMatchObject({ status: 'failed' });
    },
  );

  it('跑完：签发 Key → 起沙箱（挂持久工作目录、放说明和技能）→ 交用户的话 → 收产出 → 销毁沙箱、作废 Key → 写结局', async () => {
    const run = await service.start({
      ...base,
      persona: '你是小绿，擅长做海报。',
      prompt: '写一份成果',
    });
    expect(run).toMatchObject({ status: 'queued', conversationId: CONVERSATION });
    const row = await finished(run.id);

    expect(row.status).toBe('succeeded');
    expect(row.outputs).toMatchObject([{ path: 'result.md', size: Buffer.byteLength('# 成果') }]);
    // 存产出前先给 Word、PPT 配同名 PDF（画布按 PDF 预览）
    expect(lifecycle.slice(0, 2)).toEqual([
      expect.stringMatching(/^exec sh -c [\s\S]*soffice --headless/),
      'archive',
    ]);
    // 会话在持久工作目录里，对象存储只存产出
    expect([...stored.keys()]).toEqual([`runs/${run.id}/outputs.tar`]);
    expect(started[0]).toMatchObject({ workspaceId: run.id, restore: false });
    // 平台说明（开头是这个 AI 的人设）和技能每轮放进 dsh 的用户目录
    const guide = await tarEntries(placed(0, SANDBOX_PATHS.dshHome));
    expect(guide.map((f) => f.path)).toEqual(['AGENTS.md', 'skills/images/SKILL.md']);
    expect(guide[0]?.content.toString()).toContain('你是小绿，擅长做海报。');
    expect(guide[0]?.content.toString()).toContain('# 在 Oasis 里干活');
    expect(issued[0]).toMatchObject({
      runId: run.id,
      payerId: PAYER,
      conversationId: CONVERSATION,
    });
    expect(started[0]?.env).toMatchObject({
      OASIS_RUN_KEY: 'oasis_run_secret',
      OASIS_MODEL: base.model,
      // 装软件包走出口代理；调模型和工具的入口代理不走
      HTTPS_PROXY: 'http://sandbox-egress:8888',
      NO_PROXY: 'sandbox-ingress,localhost,127.0.0.1',
      npm_config_registry: 'https://registry.npmmirror.com/',
      PIP_INDEX_URL: 'https://pypi.example/simple',
    });
    expect(destroyed).toEqual([run.id]);
    expect(revoked).toHaveLength(1);
    // 算力：开沙箱前按最长时间冻结，销毁后按实际时长结算
    expect(compute.map((c) => c.path)).toEqual(['hold', 'settle']);
    expect(compute[0]?.body).toMatchObject({ runId: run.id, cores: 2, maxMs: 300_000 });
    expect(compute[1]?.body).toMatchObject({ cores: 2, elapsedMs: expect.any(Number) });
    expect(finishes).toMatchObject([
      {
        id: run.id,
        outcome: {
          status: 'succeeded',
          outputs: [{ path: 'result.md' }],
          summary: '收到：写一份成果',
        },
      },
    ]);
    // 运行时上下文那条不是用户说的，不记
    const kinds = events.map((e) => e.kind);
    expect(kinds).toEqual([
      'status',
      'status',
      'user_message',
      'assistant_text',
      'turn_end',
      'status',
    ]);
    expect((await service.events(run.id, -1, 100))[0]?.data).toEqual({ status: 'admitted' });
  });

  it('删对话：这个对话的产出包、运行记录和持久工作目录都删掉；还有一轮没结束就先不删；别的对话不动', async () => {
    const kept = await service.start({
      ...base,
      conversationId: OTHER_CONVERSATION,
      prompt: '别的对话',
    });
    await finished(kept.id);
    const first = await service.start({ ...base, prompt: '写' });
    expect(await service.purgeConversation(CONVERSATION)).toBe(false);
    expect(rows.has(first.id)).toBe(true);
    await finished(first.id);
    const next = await service.start({ ...base, prompt: '接着写', continueFrom: first.id });
    await finished(next.id);

    expect(await service.purgeConversation(CONVERSATION)).toBe(true);
    expect([...rows.keys()]).toEqual([kept.id]);
    expect([...stored.keys()]).toEqual([`runs/${kept.id}/outputs.tar`]);
    expect([...workspaces]).toEqual([kept.id]);
    // 再删一次也不报错
    expect(await service.purgeConversation(CONVERSATION)).toBe(true);
  });

  it('用户发的文件、要改的成果向 canvas 取出来放进 materials/；取不到或太大时这一轮失败', async () => {
    const run = await service.start({
      ...base,
      prompt: '用照片改海报',
      materials: [
        { uploadId: PHOTO, path: 'materials/照片.jpg' },
        { artifactId: POSTER, path: 'materials/canvas/site/poster.png' },
        // 群里别的成员传的群文件：不在付费人名下，按给的那个人查
        { uploadId: PHOTO, ownerId: UPLOADER, path: 'materials/group/名单.jpg' },
      ],
    });
    await finished(run.id);
    const files = await extractFiles(placed(0, SANDBOX_PATHS.workdir));
    expect(uploadOwners.slice(-2).sort()).toEqual([base.payerId, UPLOADER].sort());
    expect(files.find((f) => f.path === 'group/名单.jpg')?.content.toString()).toBe('photo-bytes');
    expect(files.find((f) => f.path === '照片.jpg')?.content.toString()).toBe('photo-bytes');
    expect(files.find((f) => f.path === 'canvas/site/poster.png')?.content.toString()).toBe(
      'poster-bytes',
    );

    const errors: (string | null)[] = [];
    for (const material of [
      { uploadId: '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c', path: 'materials/x.bin' },
      { artifactId: '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c6c', path: 'materials/canvas/x.bin' },
      { uploadId: BIG, path: 'materials/x.bin' },
    ]) {
      const failed = await service.start({ ...base, prompt: '用照片', materials: [material] });
      await finished(failed.id);
      const body = await service.get(failed.id);
      expect(body.status).toBe('failed');
      errors.push(body.error);
    }
    expect(errors[2]).toContain('素材加起来超过');
  });

  it('接着上一轮：挂上原来的持久工作目录接着原会话做；只能接同一对话的；工作目录不在了就拒绝（409 workspace_unavailable）', async () => {
    const first = await service.start({ ...base, prompt: '先写' });
    await finished(first.id);
    expect(await service.get(first.id)).toMatchObject({ resumable: true });
    await expect(
      service.start({
        ...base,
        conversationId: OTHER_CONVERSATION,
        prompt: '别的对话想接',
        continueFrom: first.id,
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'continue_unavailable' });
    const next = await service.start({ ...base, prompt: '按意见改', continueFrom: first.id });
    await finished(next.id);
    expect(started[1]).toMatchObject({ workspaceId: first.id, restore: true });
    expect(methods).toContain('session/resume');
    expect(rows.get(next.id)).toMatchObject({ sessionId: first.id, continueFrom: first.id });

    // 持久卷被清掉：只剩对象存储里的产出，不能冒充接着原会话做，也不登记这一轮
    workspaces.clear();
    expect(await service.get(next.id)).toMatchObject({ resumable: false });
    const count = rows.size;
    await expect(
      service.start({ ...base, prompt: '再改', continueFrom: next.id }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'workspace_unavailable' });
    expect(rows.size).toBe(count);
    expect(started).toHaveLength(2);

    await expect(
      service.start({ ...base, prompt: 'p', continueFrom: '0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'continue_unavailable' });
  });

  it('读一个产出文件：带上内容类型和大小；没有的文件、平台自己的文件 404', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    const file = await service.fileStream(run.id, 'result.md');
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(chunk as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('# 成果');
    expect(file).toMatchObject({
      contentType: 'text/markdown; charset=utf-8',
      size: Buffer.byteLength('# 成果'),
    });
    for (const path of ['.oasis-keep', '.oasis-batches/batch/meta.json', 'missing.md'])
      await expect(service.fileStream(run.id, path)).rejects.toMatchObject({
        statusCode: 404,
        code: 'file_not_found',
      });
  });

  it('一轮还没收尾时读产出文件（做好一个就登记进画布）：从沙箱的 out/ 里读，没有摘要', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    rows.get(run.id)!.outputKey = null;
    executor.readStoredArchive = async (_id, path) =>
      path === `${SANDBOX_PATHS.workdir}/out/素材/帧.png`
        ? Readable.from([await packFiles([{ path: '帧.png', content: Buffer.from('png') }])])
        : undefined;
    try {
      const file = await service.fileStream(run.id, '素材/帧.png');
      expect(file).toMatchObject({ size: 3, contentType: 'image/png', sha256: undefined });
      expect(Buffer.concat(await file.content.toArray()).toString()).toBe('png');
      await expect(service.fileStream(run.id, 'missing.png')).rejects.toMatchObject({
        statusCode: 404,
      });
    } finally {
      delete executor.readStoredArchive;
    }
  });

  it('读这一轮工作目录里的一个文件：沙箱还在就从沙箱读（只给普通文件），收尾后只剩 out/ 里的', async () => {
    const run = await service.start({ ...base, prompt: '写' });
    await finished(run.id);
    const read = async (stream: Readable) => Buffer.concat(await stream.toArray()).toString();
    // 沙箱还在：Docker 取单个文件得到的 tar 里只有这个文件
    const asked: string[] = [];
    executor.readStoredArchive = async (_id, path) => {
      asked.push(path);
      if (path.endsWith('missing.png')) return undefined;
      const files = path.endsWith('folder')
        ? [{ path: 'folder/a.txt', content: Buffer.from('x') }]
        : [{ path: '帧-1.png', content: Buffer.from('png') }];
      return Readable.from([await packFiles(files)]);
    };
    try {
      const file = await service.workspaceFile(run.id, 'out/关键帧/帧-1.png');
      expect(asked).toEqual([`${SANDBOX_PATHS.workdir}/out/关键帧/帧-1.png`]);
      expect(file).toMatchObject({ size: 3, contentType: 'image/png' });
      expect(await read(file.content)).toBe('png');
      await expect(service.workspaceFile(run.id, 'folder')).rejects.toMatchObject({
        statusCode: 422,
      });
      await expect(service.workspaceFile(run.id, 'missing.png')).rejects.toMatchObject({
        statusCode: 404,
      });
      await expect(service.workspaceFile(run.id, 'out/../x')).rejects.toMatchObject({
        statusCode: 400,
      });
    } finally {
      delete executor.readStoredArchive;
    }
    // 沙箱没了：从产出包读 out/ 下的，别处的 404
    expect(await read((await service.workspaceFile(run.id, 'out/result.md')).content)).toBe(
      '# 成果',
    );
    await expect(service.workspaceFile(run.id, 'notes.md')).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
