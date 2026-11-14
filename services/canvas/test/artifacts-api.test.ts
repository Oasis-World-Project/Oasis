// 画布接口：列表、读取（分段）、按任务打包、转换预览；让 AI 改时查成果、取内容；批注与批准。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  app,
  CONVERSATION,
  files,
  get,
  KAI,
  MIA,
  objects,
  R1,
  R2,
  repo,
  run,
  S1,
  S2,
  service,
  sha256,
  uploadRows,
} from './artifacts-fixture.ts';

describe('画布接口', () => {
  it('列出自己的成果，可以按类别、对话、话题筛选；别人的看不到', async () => {
    await service.registerRun(run(R1));
    const all = (await get('/v1/artifacts')).json<{ artifacts: { name: string }[] }>();
    expect(all.artifacts.map((a) => a.name)).toEqual(['hero.png', '首页文案.md']);
    expect((await get('/v1/artifacts?category=media')).json()).toEqual({ artifacts: [] });
    for (const query of [`conversationId=${CONVERSATION}`, `sessionId=${S1}`])
      expect(
        (await get(`/v1/artifacts?${query}`)).json<{ artifacts: unknown[] }>().artifacts,
      ).toHaveLength(2);
    expect((await get(`/v1/artifacts?sessionId=${S2}`)).json()).toEqual({ artifacts: [] });
    expect((await get('/v1/artifacts', {}, MIA)).json()).toEqual({ artifacts: [] });
    const id = repo.rows[0]!.id;
    expect((await get(`/v1/artifacts/${id}`, {}, MIA)).statusCode).toBe(404);
  });

  it('读内容：整个、分段（拖动进度）、超出范围；带沙箱头', async () => {
    await service.registerRun(run(R1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const whole = await get(`/v1/artifacts/${image.id}/content`);
    expect(whole.statusCode).toBe(200);
    expect(whole.body).toBe('png-bytes-0123456789');
    expect(whole.headers).toMatchObject({
      'content-type': 'image/png',
      'accept-ranges': 'bytes',
      'content-security-policy': 'sandbox',
    });

    const part = await get(`/v1/artifacts/${image.id}/content`, { range: 'bytes=4-8' });
    expect(part.statusCode).toBe(206);
    expect(part.body).toBe('bytes');
    expect(part.headers['content-range']).toBe('bytes 4-8/20');

    const beyond = await get(`/v1/artifacts/${image.id}/content`, { range: 'bytes=99-' });
    expect(beyond.statusCode).toBe(416);

    const download = await get(`/v1/artifacts/${image.id}/content?download=1`);
    expect(download.headers['content-disposition']).toBe("attachment; filename*=UTF-8''hero.png");
  });

  it('打包一个任务：只含自己的成果，ZIP 路径与桌面同步一致；超限或穿越拒绝', async () => {
    await service.registerRun(run(R1));
    const response = await get(`/v1/runs/${R1}/archive`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('application/zip');
    expect(response.headers['content-disposition']).toContain('attachment');
    const entries = unzipSync(response.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(repo.rows.map((r) => r.syncPath).sort());
    for (const row of repo.rows) expect(strFromU8(entries[row.syncPath]!)).toBe(files[row.path]);
    expect((await get(`/v1/runs/${R1}/archive`, {}, MIA)).statusCode).toBe(404);
    await expect(service.archive(KAI, R1, { bytes: 1, files: 100 })).rejects.toThrow();
    repo.rows[0]!.syncPath = '../逃逸.txt';
    expect((await get(`/v1/runs/${R1}/archive`)).statusCode).toBe(422);
  });

  it('下载整个应用：应用目录里的全部文件（不管哪一轮做的），按 out/ 里的路径；不是应用 404', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    await service.registerRun(run(R1, ['site/oasis-app.json', 'site/index.html', 'hero.png']));
    files['site/index.html'] = '<!doctype html><title>改过</title>';
    await service.registerRun(run(R2, ['site/index.html'], { task: '改标题' }));
    const manifest = repo.rows.find((r) => r.path === 'site/oasis-app.json')!;
    const response = await get(`/v1/artifacts/${manifest.id}/archive`);
    expect(response.statusCode).toBe(200);
    const entries = unzipSync(response.rawPayload);
    expect(Object.keys(entries).sort()).toEqual(['site/index.html', 'site/oasis-app.json']);
    expect(strFromU8(entries['site/index.html']!)).toBe('<!doctype html><title>改过</title>');
    const hero = repo.rows.find((r) => r.path === 'hero.png')!;
    expect((await get(`/v1/artifacts/${hero.id}/archive`)).statusCode).toBe(404);
    expect((await get(`/v1/artifacts/${manifest.id}/archive`, {}, MIA)).statusCode).toBe(404);
  });

  it('转换要求用户身份与二进制请求，按文件内容返回表格', async () => {
    const request = {
      method: 'POST' as const,
      url: '/v1/previews?name=a.csv',
      payload: Buffer.from('标题,值\n甲,10'),
      headers: { [OASIS_HEADERS.userId]: KAI, 'content-type': 'application/octet-stream' },
    };
    expect((await app.inject(request)).json()).toMatchObject({
      kind: 'table',
      sheets: [
        {
          rows: [
            ['标题', '值'],
            ['甲', '10'],
          ],
        },
      ],
    });
    expect(
      (await app.inject({ ...request, headers: { 'content-type': 'application/octet-stream' } }))
        .statusCode,
    ).toBe(401);
  });
});

describe('让 AI 改：查成果、取内容', () => {
  it('核对是这个人的；withFiles 列出应用目录、网页所在目录里的文件；取内容带摘要', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/assets/game.js'] = 'document.title = "运行"';
    files['pages/about.html'] = '<img src="./hero.png">';
    files['pages/hero.png'] = 'png';
    await service.registerRun(
      run(R1, [
        '首页文案.md',
        'hero.png',
        'site/oasis-app.json',
        'site/index.html',
        'site/assets/game.js',
        'pages/about.html',
        'pages/hero.png',
      ]),
    );
    const id = (path: string) => repo.rows.find((r) => r.path === path)!.id;
    const lookup = (ownerId: string, ids: string[], withFiles = false) =>
      app.inject({
        method: 'POST',
        url: '/internal/artifacts/lookup',
        payload: { ownerId, ids, withFiles },
      });
    const paths = (list: ArtifactBody[]) => list.map((a) => a.path);

    const plain = (await lookup(KAI, [id('hero.png'), id('首页文案.md')])).json<{
      artifacts: ArtifactBody[];
      files: ArtifactBody[];
    }>();
    expect(paths(plain.artifacts)).toEqual(['hero.png', '首页文案.md']);
    expect(plain.files).toEqual([]);

    const wide = await lookup(
      KAI,
      [id('site/oasis-app.json'), id('pages/about.html'), id('首页文案.md')],
      true,
    );
    expect(paths(wide.json<{ files: ArtifactBody[] }>().files)).toEqual([
      'pages/about.html',
      'pages/hero.png',
      'site/assets/game.js',
      'site/index.html',
      'site/oasis-app.json',
      '首页文案.md',
    ]);
    // 根目录下的网页：话题里的文件都可能被它引用
    files['index.html'] = '<img src="hero.png">';
    await service.registerRun(run(R2, ['index.html']));
    expect(
      (await lookup(KAI, [id('index.html')], true)).json<{ files: unknown[] }>().files,
    ).toHaveLength(8);

    const missing = '50000000-0000-4000-8000-000000000099';
    expect((await lookup(MIA, [id('hero.png')])).statusCode).toBe(404);
    expect((await lookup(KAI, [id('hero.png'), missing])).statusCode).toBe(404);

    const content = await app.inject({ url: `/internal/artifacts/${id('hero.png')}/content` });
    expect(content.body).toBe('png-bytes-0123456789');
    expect(content.headers['x-oasis-file-sha256']).toBe(sha256('png-bytes-0123456789'));
    expect((await app.inject({ url: `/internal/artifacts/${missing}/content` })).statusCode).toBe(
      404,
    );
  });
});

describe('批注与批准', () => {
  const send = (
    method: 'PUT' | 'POST' | 'DELETE',
    url: string,
    payload?: Record<string, unknown>,
    user = KAI,
  ) =>
    app.inject({
      method,
      url,
      headers: { [OASIS_HEADERS.userId]: user },
      ...(payload === undefined ? {} : { payload }),
    });
  const note = (number: number, extra: object = {}) => ({
    id: `30000000-0000-4000-8000-${String(number).padStart(12, '0')}`,
    number,
    note: `第 ${number} 处要改`,
    page: null,
    time: null,
    quote: null,
    shape: null,
    ...extra,
  });

  it('整份替换批注：只能改自己的，编号不能重复，坐标必须在画面里', async () => {
    await service.registerRun(run(R1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const url = `/v1/artifacts/${image.id}/annotations`;
    const ok = await send('PUT', url, {
      annotations: [
        note(1, { shape: { kind: 'ellipse', x: 0.1, y: 0.2, w: 0.3, h: 0.2 } }),
        note(2, { time: 12.5, shape: { kind: 'pin', x: 0.5, y: 0.5 } }),
      ],
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ annotations: unknown[] }>().annotations).toHaveLength(2);
    expect((await get(`/v1/artifacts/${image.id}`)).json()).toMatchObject({
      annotations: [{ number: 1 }, { number: 2, time: 12.5 }],
    });
    expect((await send('PUT', url, { annotations: [note(1), note(1)] })).statusCode).toBe(400);
    expect(
      (
        await send('PUT', url, {
          annotations: [note(3, { shape: { kind: 'pin', x: 1.5, y: 0 } })],
        })
      ).statusCode,
    ).toBe(400);
    expect((await send('PUT', url, { annotations: [] }, MIA)).statusCode).toBe(404);
  });

  it('应用截图批注：截图必须是自己上传的；删掉批注或删对话时截图一起删', async () => {
    await service.registerRun(run(R1));
    const image = repo.rows.find((r) => r.path === 'hero.png')!;
    const url = `/v1/artifacts/${image.id}/annotations`;
    const frame = (id: string, ownerId: string) => {
      uploadRows.rows.set(id, {
        id,
        ownerId,
        name: '批注截图.png',
        contentType: 'image/png',
        size: 4,
        sha256: 'a'.repeat(64),
        objectKey: `uploads/${id}`,
        state: 'ready',
        createdAt: new Date(),
      } as never);
      objects.objects.set(`uploads/${id}`, { body: Buffer.from('png!'), type: 'image/png' });
    };
    const A = '50000000-0000-4000-8000-00000000000a';
    const B = '50000000-0000-4000-8000-00000000000b';
    const OTHER = '50000000-0000-4000-8000-00000000000c';
    frame(A, KAI);
    frame(B, KAI);
    frame(OTHER, MIA);
    const pin = { kind: 'pin', x: 0.5, y: 0.5 };
    expect(
      (await send('PUT', url, { annotations: [note(1, { frame: OTHER, shape: pin })] })).statusCode,
    ).toBe(422);
    const ok = await send('PUT', url, {
      annotations: [note(1, { frame: A, shape: pin }), note(2, { frame: B, shape: pin })],
    });
    expect(ok.json<{ annotations: { frame: string }[] }>().annotations.map((a) => a.frame)).toEqual(
      [A, B],
    );
    await send('PUT', url, { annotations: [note(2, { frame: B, shape: pin })] });
    expect(uploadRows.rows.has(A)).toBe(false);
    expect(objects.objects.has(`uploads/${A}`)).toBe(false);
    expect(uploadRows.rows.has(B)).toBe(true);
    await service.purgeConversation(KAI, CONVERSATION);
    expect(uploadRows.rows.has(B)).toBe(false);
    expect(objects.objects.has(`uploads/${B}`)).toBe(false);
    // 别人的上传不受影响
    expect(uploadRows.rows.has(OTHER)).toBe(true);
  });

  it('批准是记号（界面已不显示，接口保留）：可以取消，只能改自己的', async () => {
    await service.registerRun(run(R1));
    const copy = repo.rows.find((r) => r.path === '首页文案.md')!;
    const approved = await send('POST', `/v1/artifacts/${copy.id}/approval`);
    expect(approved.json<{ approvedAt: string | null }>().approvedAt).not.toBeNull();
    const undone = await send('DELETE', `/v1/artifacts/${copy.id}/approval`);
    expect(undone.json<{ approvedAt: string | null }>().approvedAt).toBeNull();
    expect(
      (await send('POST', `/v1/artifacts/${copy.id}/approval`, undefined, MIA)).statusCode,
    ).toBe(404);
  });
});
