// 整体验收（只查交付文件齐不齐）和修改（ADR 0022：规划、确认、沿用 / 接着改 / 重新做、版本）。
import { describe, expect, it, vi } from 'vitest';
import { events } from './support/memory-store.ts';
import {
  fake,
  OWNER,
  submitted,
  cancelled,
  plans,
  gateCalls,
  service,
  work,
  create,
  createPlanned,
  type Submitted,
  runsOf,
  runOf,
  finish,
  keyOf,
  errorOf,
} from './support/workflow.ts';

describe('整体验收（从任务单来的任务）', () => {
  const start = async (
    criteria = ['语气温馨', '不超过 80 字'],
    edges: { from: string; to: string }[] = [],
  ) => {
    const task = await createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: {
        title: '小木屋首页',
        deliverables: [
          { name: '首页文案', form: 'Markdown' },
          { name: '海报文案', form: 'Markdown' },
        ],
        criteria,
        style: [],
        budgetMicro: null,
        assumptions: [],
        materials: [],
      },
    });
    const planner = submitted.find((s) => !s.nodeId) as { runId: string };
    plans.set(
      planner.runId,
      JSON.stringify({
        nodes: [work('home'), work('poster')],
        edges,
        deliverables: { 首页文案: 'home', 海报文案: 'poster' },
      }),
    );
    await finish(planner.runId, 'succeeded');
    return service.get(OWNER, task.id);
  };

  it('交付文件不齐：只让缺文件的交付节点接着原会话补一次，补齐后才完成', async () => {
    const task = await start();
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.txt', size: 9 }],
    });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: '海报.md', size: 9 }],
    });
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'running', finishedAt: null });
    expect(detail.acceptance?.unmet).toContain('最终交付缺少文件 out/*.md');
    expect(runOf('home', task).continueFrom).toBe(runsOf('home', task)[0]?.runId);
    expect(runOf('home', task).goal).toBeFalsy();
    expect(runOf('home', task).prompt).toContain('最终交付缺少文件 out/*.md');
    expect(runsOf('poster', task)).toHaveLength(1);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual([
      'running',
      'accepting',
      'running',
    ]);
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    expect(await service.get(OWNER, task.id)).toMatchObject({
      status: 'succeeded',
      acceptance: { unmet: [] },
    });
    // 整体验收不再调关卡（不对照任务单逐条打分）
    expect(gateCalls).toHaveLength(3);
  });

  const plannerRuns = () => submitted.filter((s) => !s.nodeId) as unknown as Submitted[];
  /** 发起修改后等规划员交到 harness（ADR 0022） */
  const reviseAndWait = async (taskId: string, body: Parameters<typeof service.revise>[1]) => {
    const before = plannerRuns().length;
    const task = await service.revise(taskId, body);
    await vi.waitFor(() => expect(plannerRuns().length).toBe(before + 1));
    return task;
  };
  const planned = async (plan: unknown) => {
    const run = plannerRuns().at(-1)!;
    plans.set(run.runId, JSON.stringify(plan));
    await finish(run.runId, 'succeeded');
    return run;
  };
  const delivered = async (edges: { from: string; to: string }[] = []) => {
    const task = await start(['语气温馨'], edges);
    for (const key of ['home', 'poster'])
      await finish(runOf(key, task).runId, 'succeeded', {
        outputs: [{ path: key + '.md', size: 9 }],
      });
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
    return task;
  };

  it('修改交给规划员看上一版决定怎么改，用户确认后才开跑：接着原会话改、重新做（上一版产出在 in/_previous/）', async () => {
    const task = await delivered([{ from: 'home', to: 'poster' }]);
    const firstHome = runOf('home', task).runId;
    const firstPoster = runOf('poster', task).runId;
    const SHOT = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
    const homeId = keyOf(task, 'home');
    const revised = await reviseAndWait(task.id, {
      ownerId: OWNER,
      request: '标题改短\n批注：\n1.「home.md」画面右上：去掉这句（见截图 批注-home-截图1.png）',
      materials: [{ uploadId: SHOT, name: '批注-home-截图1.png', size: 4 }],
      nodeIds: [homeId],
    });
    expect(revised).toMatchObject({
      id: task.id,
      status: 'planning',
      version: 1,
      revision: { version: 2, stage: 'planning', request: expect.stringContaining('标题改短') },
    });
    expect(revised.materials).toEqual([{ uploadId: SHOT, name: '批注-home-截图1.png', size: 4 }]);
    // 规划中工作流还是上一版
    expect(revised.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'home=succeeded',
      'poster=succeeded',
    ]);
    // 任务列表标出「修改中」；修改附件算任务素材，删私聊时留着
    expect((await service.list(OWNER))[0]).toMatchObject({ id: task.id, revising: true });
    expect(
      await service.materialsInUse(OWNER, [SHOT, '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b']),
    ).toEqual([SHOT]);
    const planner = plannerRuns().at(-1)!;
    expect(planner.prompt).toContain('【修改意见】\n标题改短');
    expect(planner.prompt).toContain('是这些节点交出的：home');
    expect(planner.prompt).toContain('"home.md"');
    expect(planner.prompt).toContain('"home → poster"');

    await planned({
      summary: '首页接着原会话改标题，海报按新首页重新写。',
      nodes: [
        { ...work('home'), from: 'home', mode: 'continue' },
        { ...work('poster'), from: 'poster' },
      ],
      edges: [{ from: 'home', to: 'poster' }],
      deliverables: { 首页文案: 'home', 海报文案: 'poster' },
    });
    const pending = await service.get(OWNER, task.id);
    expect(pending).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'revision_plan', message: '首页接着原会话改标题，海报按新首页重新写。' },
      revision: {
        stage: 'confirm',
        estimateMicro: 6_000,
        changes: [
          { key: 'home', change: 'continue' },
          { key: 'poster', change: 'fresh' },
        ],
      },
    });
    // 确认前不跑任何节点
    expect(runsOf('home', task)).toHaveLength(1);
    expect(runsOf('poster', task)).toHaveLength(1);

    const running = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(running).toMatchObject({ status: 'running', version: 2, revision: null });
    expect(running.versions).toMatchObject([{ version: 1, request: null }]);
    // 节点 ID 不变（成果和运行记录接得上）
    expect(keyOf(running, 'home')).toBe(homeId);
    const home = runOf('home', task) as Submitted & {
      materials: { uploadId: string; path: string }[];
    };
    expect(home.continueFrom).toBe(firstHome);
    expect(home.prompt).toContain('标题改短');
    expect(home.materials).toContainEqual({
      uploadId: SHOT,
      path: 'materials/批注-home-截图1.png',
    });
    expect(runsOf('poster', task)).toHaveLength(1);
    await finish(home.runId, 'succeeded', { outputs: [{ path: 'home.md', size: 10 }] });
    // 重新做：新会话，拿上游新产出，上一版自己的产出放在 in/_previous/
    const poster = runOf('poster', task);
    expect(poster.continueFrom).toBeUndefined();
    expect(poster.inputsFrom).toEqual(
      expect.arrayContaining([
        { runId: home.runId, as: 'home' },
        { runId: firstPoster, as: '_previous' },
      ]),
    );
    expect(poster.prompt).toContain('【上一版】');
    await finish(poster.runId, 'succeeded', { outputs: [{ path: 'poster.md', size: 10 }] });
    expect(await service.get(OWNER, task.id)).toMatchObject({ status: 'succeeded', version: 2 });
    expect((await service.list(OWNER)).map((t) => [t.id, t.revising])).toEqual([[task.id, false]]);
    // 冻结的第 1 版能看，节点和线照旧
    const first = await service.version(OWNER, task.id, 1);
    expect(first.nodes.map((n) => n.key)).toEqual(['home', 'poster']);
    expect(first.edges).toHaveLength(1);
    expect((await errorOf(() => service.version(OWNER, task.id, 2))).status).toBe(404);

    // 规划中不能再发起修改；「不改了」回到修改前的样子
    await reviseAndWait(task.id, { ownerId: OWNER, request: '再改', materials: [] });
    expect(
      (
        await errorOf(() =>
          service.revise(task.id, { ownerId: OWNER, request: '又改', materials: [] }),
        )
      ).status,
    ).toBe(409);
    // 规划中「不改了」走取消：只撤掉这次修改，任务不取消
    const restored = await service.cancel(OWNER, task.id);
    expect(restored).toMatchObject({ status: 'succeeded', version: 2, revision: null });
    expect(cancelled).toContain(plannerRuns().at(-1)!.runId);
  });

  it('沿用、新增、删除节点；规划门挡住拿不到新产出的沿用，退回规划员', async () => {
    const task = await delivered();
    await reviseAndWait(task.id, { ownerId: OWNER, request: '海报换成一句宣传语', materials: [] });
    const planners = plannerRuns().length;
    // 沿用的节点的上游要重新做：它拿不到新产出
    await planned({
      summary: 's',
      nodes: [{ key: 'home', reuse: 'home' }, { ...work('slogan') }],
      edges: [{ from: 'slogan', to: 'home' }],
      deliverables: { 首页文案: 'home', 海报文案: 'slogan' },
    });
    await vi.waitFor(() => expect(plannerRuns()).toHaveLength(planners + 1));
    expect(plannerRuns().at(-1)!.prompt).toContain('沿用的「home」的上游「slogan」要重新做');
    expect((await service.get(OWNER, task.id)).status).toBe('planning');
    await planned({
      summary: '首页不动，海报换成宣传语。',
      nodes: [{ key: 'home', reuse: 'home' }, { ...work('slogan') }],
      edges: [],
      deliverables: { 首页文案: 'home', 海报文案: 'slogan' },
    });
    expect((await service.get(OWNER, task.id)).revision).toMatchObject({
      estimateMicro: 3_000,
      changes: [
        { key: 'home', change: 'reuse' },
        { key: 'slogan', change: 'new' },
        { key: 'poster', change: 'remove' },
      ],
    });
    const posterId = keyOf(task, 'poster');
    const running = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(running.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'home=succeeded',
      'slogan=running',
    ]);
    expect(running.deliverables.map((d) => d.nodeId)).toEqual([
      keyOf(task, 'home'),
      keyOf(running, 'slogan'),
    ]);
    expect(runsOf('home', task)).toHaveLength(1);
    await finish(runOf('slogan', running).runId, 'succeeded', {
      outputs: [{ path: 'slogan.md', size: 9 }],
    });
    expect(await service.get(OWNER, task.id)).toMatchObject({ status: 'succeeded' });
    // 删掉的节点留在第 1 版里，运行记录还能看
    expect((await service.version(OWNER, task.id, 1)).nodes.map((n) => n.key)).toEqual([
      'home',
      'poster',
    ]);
    expect(await service.nodeRuns(OWNER, task.id, posterId)).toHaveLength(1);
  });

  it('修改方案确认前不改了：回到修改前的状态；停下的任务也能改', async () => {
    const task = await start();
    await service.stop(OWNER, task.id);
    expect((await service.get(OWNER, task.id)).status).toBe('stopped');
    await reviseAndWait(task.id, { ownerId: OWNER, request: '换个语气', materials: [] });
    await planned({
      summary: '都重新写。',
      nodes: [
        { ...work('home'), from: 'home' },
        { ...work('poster'), from: 'poster' },
      ],
      edges: [],
      deliverables: { 首页文案: 'home', 海报文案: 'poster' },
    });
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
    expect(await service.decide(OWNER, task.id, { choice: 'cancel' })).toMatchObject({
      status: 'stopped',
      revision: null,
      attention: null,
      version: 1,
    });
  });

  it('交付文件补过一次仍不齐：带着记录交付，不再退回、不停下', async () => {
    const task = await start();
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: 'poster.md', size: 9 }],
    });
    for (let i = 0; i < 2; i++)
      await finish(runOf('home', task).runId, 'succeeded', {
        outputs: [{ path: 'home.txt', size: 9 }],
      });
    const done = await service.get(OWNER, task.id);
    expect(done).toMatchObject({ status: 'succeeded', attention: null });
    expect(done.acceptance?.unmet).toContain('最终交付缺少文件 out/*.md');
    expect(done.acceptance).not.toHaveProperty('repairs');
    expect(runsOf('home', task)).toHaveLength(2);
    expect(runsOf('poster', task)).toHaveLength(1);
  });

  it('跳过失败节点不能让缺文件的整体验收成功', async () => {
    const task = await start();
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: '首页.md', size: 9 }],
    });
    for (let i = 0; i < 3; i++) await finish(runOf('poster', task).runId, 'failed');
    await service.decide(OWNER, task.id, { choice: 'continue' });
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('running');
    expect(detail.acceptance?.unmet).toEqual([
      '最终交付缺少文件 out/*.md',
      '「海报文案」没有交出文件',
    ]);
  });

  it('最终修复沿依赖顺序推进，下游收到上游最新产物且沿用自己的原会话', async () => {
    const task = await start(['两份文案一致'], [{ from: 'home', to: 'poster' }]);
    await finish(runOf('home', task).runId, 'succeeded', {
      outputs: [{ path: 'home.txt', size: 9 }],
    });
    const oldPoster = runOf('poster', task).runId;
    await finish(oldPoster, 'succeeded', { outputs: [{ path: 'poster.md', size: 9 }] });
    const newHome = runOf('home', task).runId;
    expect(runsOf('poster', task)).toHaveLength(1);
    expect(newHome).not.toBe(runsOf('home', task)[0]!.runId);
    await finish(newHome, 'succeeded', { outputs: [{ path: 'home.md', size: 10 }] });
    expect(runOf('poster', task)).toMatchObject({
      continueFrom: oldPoster,
      inputsFrom: [{ runId: newHome, as: 'home' }],
    });
    await finish(runOf('poster', task).runId, 'succeeded', {
      outputs: [{ path: 'poster.md', size: 10 }],
    });
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
  });

  it('节点没检查到：直接完成、下游开跑，提醒里写明没检查到', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    fake.gateResults = [
      { unmet: [], unchecked: ['验收点检查没做完：连不上模型服务商（网络中断或超时）'] },
    ];
    await finish(runOf('A', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('running');
    expect(detail.attention).toBeNull();
    const a = detail.nodes.find((n) => n.key === 'A')!;
    expect(a.status).toBe('succeeded');
    expect(a.warning).toBe('没检查到：验收点检查没做完：连不上模型服务商（网络中断或超时）');
    expect(runsOf('A', task)).toHaveLength(1);
    expect(runsOf('B', task)).toHaveLength(1);
  });
});
