// 成果登记进画布：对话里一轮进行中做好一个登记一个、结束时再登记一遍，复制新增和改过的文件、幂等、
// 每个任务一个同步文件夹；数字人、应用；后来的一轮改了成果；删对话。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import {
  app,
  AVATAR_SESSION,
  CONVERSATION,
  failFiles,
  fetched,
  files,
  gatewayCalls,
  get,
  KAI,
  live,
  MIA,
  objects,
  OTHER_CONVERSATION,
  R1,
  R2,
  R3,
  repo,
  run,
  S1,
  S2,
  service,
  sha256,
  uploadRows,
} from './artifacts-fixture.ts';

describe('登记一轮做好的成果', () => {
  it('复制这一轮交出的文件，按任务放进同步文件夹；返回登记的成果；什么也没交出就不登记', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/artifacts/runs',
      payload: run(R1),
    });
    expect(response.statusCode).toBe(200);
    const { artifacts } = response.json<{ artifacts: ArtifactBody[] }>();
    // 按这一轮交出文件的顺序
    expect(artifacts.map((a) => [a.path, a.runId, a.sessionId, a.conversationId])).toEqual([
      ['首页文案.md', R1, S1, CONVERSATION],
      ['hero.png', R1, S1, CONVERSATION],
    ]);
    expect(repo.rows.map((r) => [r.path, r.category, r.models, r.task])).toEqual([
      ['首页文案.md', 'doc', ['deepseek/x'], '小木屋：首页?'],
      ['hero.png', 'doc', ['deepseek/x'], '小木屋：首页?'],
    ]);
    // 任务名里 Windows 不允许的字符（这里是英文问号）换掉，全角冒号可以留着
    expect(repo.rows.map((r) => r.syncPath)).toEqual([
      '小木屋：首页_/首页文案.md',
      '小木屋：首页_/hero.png',
    ]);
    expect(strFromU8(objects.objects.get(`artifacts/${S1}/hero.png`)!.body)).toBe(
      'png-bytes-0123456789',
    );
    expect(await service.registerRun(run(R2, []))).toEqual([]);
    expect(repo.rows).toHaveLength(2);
  });

  it('重复登记同一轮不会重复，返回同样的成果；中途失败的重试时补上', async () => {
    failFiles(1);
    await expect(service.registerRun(run(R1))).rejects.toThrow();
    expect(repo.rows).toHaveLength(0);
    const first = await service.registerRun(run(R1));
    const again = await service.registerRun(run(R1));
    expect(repo.rows).toHaveLength(2);
    expect(again.map((a) => a.id)).toEqual(first.map((a) => a.id));
    // 第二次全部登记过了，不再取文件
    expect(fetched.filter((p) => p === 'hero.png')).toHaveLength(1);
  });

  it('一轮进行中做好一个登记一个：同一路径又做了一遍，变了换成新版、没变不动；返回这一轮的全部成果', async () => {
    expect((await service.registerRun(live(run(R1, ['hero.png'])))).map((a) => a.path)).toEqual([
      'hero.png',
    ]);
    const hero = repo.rows.find((r) => r.path === 'hero.png')!;
    const first = hero.sha256;
    // 又做好一个：这次的在前，之前登记的也在
    const second = await service.registerRun(live(run(R1, ['首页文案.md'])));
    expect(second.map((a) => a.path)).toEqual(['首页文案.md', 'hero.png']);
    // 同一张图又存了一遍、内容没变：拷过来比过，不动
    await service.registerRun(live(run(R1, ['hero.png'])));
    expect(hero).toMatchObject({ sha256: first, replacesSha256: null });
    files['hero.png'] = 'png-bytes-redone';
    await service.registerRun(live(run(R1, ['hero.png'])));
    expect(hero).toMatchObject({ sha256: sha256('png-bytes-redone'), replacesSha256: first });
    // 结束时按产出清单（带摘要）再登记一遍：都登记过了，不再取文件
    fetched.length = 0;
    expect((await service.registerRun(run(R1))).map((a) => a.path)).toEqual([
      '首页文案.md',
      'hero.png',
    ]);
    expect(fetched).toEqual([]);
    expect(repo.rows).toHaveLength(2);
  });

  it('每个任务一个文件夹：同名的加序号，同一个任务后来做好的放进同一个；话题不属于这个人时拒绝', async () => {
    await service.registerRun(run(R1));
    await service.registerRun(run(R3, ['首页文案.md'], { sessionId: S2 }));
    expect(repo.rows.filter((r) => r.sessionId === S2).map((r) => r.syncPath)).toEqual([
      '小木屋：首页_ (2)/首页文案.md',
    ]);
    // 同一个任务（这一轮）后来又做好的文件，放进同一个文件夹
    files['notes/提纲.md'] = '一、二、三';
    await service.registerRun(live(run(R1, ['notes/提纲.md'])));
    expect(repo.rows.find((r) => r.path === 'notes/提纲.md')?.syncPath).toBe(
      '小木屋：首页_/notes/提纲.md',
    );
    // 同一话题后来的一轮是另一个任务：新文件放进它自己的文件夹
    files['报价.md'] = '一晚 300';
    await service.registerRun(run(R2, ['报价.md'], { task: '报价单' }));
    expect(repo.rows.find((r) => r.path === '报价.md')?.syncPath).toBe('报价单/报价.md');
    await expect(service.registerRun(run(R2, [], { ownerId: MIA }))).rejects.toMatchObject({
      statusCode: 409,
      code: 'session_owner',
    });
  });

  it('数字人配置：合格的登记成数字人，不合格的照普通文件；开会话转给 model-gateway 并带上付费人', async () => {
    files['前台.oasis-avatar.json'] = JSON.stringify({
      name: '民宿前台',
      avatarId: '9c59a215-4c9f-478f-9d95-edca74c7b0d0',
      prompt: '你是山间民宿的前台',
      knowledge: [{ title: '早餐', content: '七点到九点半' }],
    });
    files['坏的.oasis-avatar.json'] = '{"name":""}';
    await service.registerRun(run(R1, ['前台.oasis-avatar.json', '坏的.oasis-avatar.json']));
    const good = repo.rows.find((row) => row.path === '前台.oasis-avatar.json')!;
    const bad = repo.rows.find((row) => row.path === '坏的.oasis-avatar.json')!;
    expect(good).toMatchObject({
      category: 'app',
      avatarSpec: { name: '民宿前台', maxMinutes: 5 },
    });
    expect(bad.avatarSpec).toBeNull();
    expect(bad.category).not.toBe('app');

    const post = (url: string, user = KAI) =>
      app.inject({
        method: 'POST',
        url,
        headers: { [OASIS_HEADERS.userId]: user, 'content-type': 'application/json' },
        payload: '{}',
      });
    const started = await post(`/v1/artifacts/${good.id}/avatar-sessions`);
    expect(started.statusCode).toBe(201);
    expect(started.json()).toMatchObject({ sessionId: AVATAR_SESSION, livekitUrl: 'wss://room' });
    expect(gatewayCalls[0]).toMatchObject({
      path: '/internal/avatar/sessions',
      headers: { [OASIS_HEADERS.payerId]: KAI },
      body: { artifactId: good.id, spec: { name: '民宿前台' } },
    });
    expect((await post(`/v1/artifacts/${bad.id}/avatar-sessions`)).statusCode).toBe(422);
    expect((await post(`/v1/artifacts/${good.id}/avatar-sessions`, MIA)).statusCode).toBe(404);
    expect((await post(`/v1/avatar-sessions/${AVATAR_SESSION}/stop`)).statusCode).toBe(204);
    expect(gatewayCalls.at(-1)).toMatchObject({
      path: `/internal/avatar/sessions/${AVATAR_SESSION}/stop`,
      headers: { [OASIS_HEADERS.payerId]: KAI },
    });
  });

  it('应用：话题里的文件组成应用；重复登记时补齐描述', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/assets/game.js'] = 'document.title = "运行"';
    const appFiles = ['site/oasis-app.json', 'site/index.html', 'site/assets/game.js'];
    await service.registerRun(run(R1, appFiles));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.category).toBe('app');
    expect(manifest.appSpec?.entry).toBe('index.html');
    // 画面转发式的平台容器预览已删除
    expect((await get(`/v1/artifacts/${manifest.id}/preview/quote`)).statusCode).toBe(404);
    manifest.appSpec = null;
    await service.registerRun(run(R1, appFiles));
    expect(repo.rows.find((row) => row.id === manifest.id)?.appSpec).toMatchObject({
      root: 'site',
    });
  });

  it('含隐藏文件的运行包不登记为应用', async () => {
    files['site/oasis-app.json'] = JSON.stringify({
      version: 1,
      kind: 'static',
      root: 'site',
      entry: 'index.html',
    });
    files['site/index.html'] = '<!doctype html><title>测试</title>';
    files['site/.env'] = 'PRIVATE=sample';
    await service.registerRun(run(R1, ['site/oasis-app.json', 'site/index.html', 'site/.env']));
    const manifest = repo.rows.find((row) => row.path === 'site/oasis-app.json')!;
    expect(manifest.appSpec).toBeNull();
  });
});

describe('后来的一轮改了成果；删对话', () => {
  it('内容变了的原地换成新版（链接、同步路径不变，批注和截图清掉）；没变的不动；重复登记幂等', async () => {
    await service.registerRun(run(R1));
    const copy = repo.rows.find((r) => r.path === '首页文案.md')!;
    const hero = repo.rows.find((r) => r.path === 'hero.png')!;
    const before = { id: copy.id, sha256: copy.sha256, syncPath: copy.syncPath };
    const FRAME = '50000000-0000-4000-8000-0000000000f1';
    uploadRows.rows.set(FRAME, {
      id: FRAME,
      ownerId: KAI,
      name: '批注截图.png',
      contentType: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
      objectKey: `uploads/${FRAME}`,
      state: 'ready',
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${FRAME}`, { body: Buffer.from('png!'), type: 'image/png' });
    copy.annotations = [
      {
        id: '30000000-0000-4000-8000-0000000000a1',
        number: 1,
        note: '标题改短',
        page: null,
        time: null,
        quote: null,
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
        frame: FRAME,
      },
    ];
    files['首页文案.md'] = '# 山居（改过）';
    fetched.length = 0;
    // hero.png 没变：harness 报了摘要，canvas 不再取
    const second = run(R2, undefined, { task: '首页改短' });
    const changed = await service.registerRun(second);
    expect(changed.map((a) => a.path)).toEqual(['首页文案.md']);
    expect(fetched).toEqual(['首页文案.md']);
    expect((await service.registerRun(second)).map((a) => a.id)).toEqual([before.id]);

    expect(repo.rows).toHaveLength(2);
    const updated = repo.rows.find((r) => r.path === '首页文案.md')!;
    expect(updated.id).toBe(before.id);
    expect(updated.syncPath).toBe(before.syncPath);
    // 归到改它的那一轮（任务）下；电脑上还在原来的文件夹里
    expect(updated).toMatchObject({ runId: R2, task: '首页改短' });
    expect(updated.sha256).not.toBe(before.sha256);
    expect(updated.replacesSha256).toBe(before.sha256);
    expect(updated.annotations).toEqual([]);
    expect(uploadRows.rows.has(FRAME)).toBe(false);
    expect(objects.objects.has(`uploads/${FRAME}`)).toBe(false);
    expect(strFromU8(objects.objects.get(updated.objectKey)!.body)).toBe('# 山居（改过）');
    const same = repo.rows.find((r) => r.path === 'hero.png')!;
    expect(same).toMatchObject({ sha256: hero.sha256, replacesSha256: null, runId: R1 });
  });

  it('删对话：成果行、对象和批注截图都删掉；重复调用没有副作用；别的对话、别人的不受影响', async () => {
    await service.registerRun(run(R1));
    await service.registerRun(
      run(R3, ['首页文案.md'], { conversationId: OTHER_CONVERSATION, sessionId: S2 }),
    );
    const FRAME = '50000000-0000-4000-8000-0000000000f2';
    uploadRows.rows.set(FRAME, {
      id: FRAME,
      ownerId: KAI,
      name: '批注截图.png',
      contentType: 'image/png',
      size: 4,
      sha256: 'a'.repeat(64),
      objectKey: `uploads/${FRAME}`,
      state: 'ready',
      createdAt: new Date(),
    } as never);
    objects.objects.set(`uploads/${FRAME}`, { body: Buffer.from('png!'), type: 'image/png' });
    repo.rows.find((r) => r.sessionId === S1)!.annotations = [
      {
        id: '30000000-0000-4000-8000-0000000000a2',
        number: 1,
        note: '这里',
        page: null,
        time: null,
        quote: null,
        shape: { kind: 'pin', x: 0.5, y: 0.5 },
        frame: FRAME,
      },
    ];
    const purge = (ownerId: string) =>
      app.inject({
        method: 'POST',
        url: `/internal/conversations/${CONVERSATION}/purge`,
        payload: { ownerId },
      });
    expect((await purge(MIA)).statusCode).toBe(204);
    expect(repo.rows).toHaveLength(3);
    expect((await purge(KAI)).statusCode).toBe(204);
    expect((await purge(KAI)).statusCode).toBe(204);
    expect(repo.rows.map((r) => r.sessionId)).toEqual([S2]);
    expect([...objects.objects.keys()]).toEqual([`artifacts/${S2}/首页文案.md`]);
    expect(uploadRows.rows.has(FRAME)).toBe(false);
  });
});
