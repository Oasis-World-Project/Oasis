// 节点关卡（只提醒、不拦截，最多自动改一次）和讨论节点（几轮发言、汇总、停止后继续）。
import { HttpError } from '@oasis/service-kit';
import { describe, expect, it, vi } from 'vitest';
import {
  fake,
  OWNER,
  submitted,
  cancelled,
  lostWorkspaces,
  gateSignals,
  gateCalls,
  service,
  discussion,
  create,
  runsOf,
  runOf,
  finish,
  statusOf,
} from './support/workflow.ts';

describe('出口关卡', () => {
  it('没过：接着原会话改一次（带上没满足的地方）→ 再检查通过才算完成，下游才跑', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const first = runOf('A', task);
    fake.gateResults = [['缺少文件 out/*.md']];
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'a.txt', size: 3 }] });

    const rework = runOf('A', task);
    expect(rework.runId).not.toBe(first.runId);
    expect(rework.continueFrom).toBe(first.runId);
    expect(rework.prompt).toContain('- 缺少文件 out/*.md');
    // 修复是单轮的，跑完回到关卡（ADR 0017）
    expect(rework.goal).toBeFalsy();
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });

    await finish(rework.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 3 }] });
    expect(gateCalls.map((c) => c.runId)).toEqual([first.runId, rework.runId]);
    const detail = await service.get(OWNER, task.id);
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      reworks: 1,
      warning: null,
      outputs: [{ path: 'a.md', size: 3 }],
    });
    // 下游拿到的是改过的那次运行的产出
    expect(runOf('B', task).inputsFrom).toEqual([{ runId: rework.runId, as: 'A' }]);
  });

  it('明确没满足最多自动改一次；改过仍没满足就带着提醒往下走，不停下', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    fake.gateResults = [['语气不够友好'], ['语气不够友好']];
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });
    expect(runOf('A', task).continueFrom).toBe(runsOf('A', task).at(-2)?.runId);
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'running',
      A: 'succeeded',
      B: 'running',
    });
    expect(runsOf('A', task)).toHaveLength(2);
    const a = (await service.get(OWNER, task.id)).nodes.find((n) => n.key === 'A')!;
    expect(a.warning).toContain('改过一次仍可能没满足：语气不够友好');
  });

  it('节点检查未返回时多次对账共享同一检查，不重复发起付费验收', async () => {
    const task = await create(['A'], []);
    let release!: () => void;
    fake.gateWaits = [
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    ];
    const pending = finish(runOf('A', task).runId, 'succeeded');
    const overlaps: Promise<void>[] = [];
    try {
      await vi.waitFor(() => expect(gateCalls).toHaveLength(1));
      overlaps.push(service.reconcile(0), service.reconcile(0));
      await new Promise((resolve) => setImmediate(resolve));
      expect(gateCalls).toHaveLength(1);
    } finally {
      release();
    }
    await Promise.all([pending, ...overlaps]);
    expect((await service.get(OWNER, task.id)).status).toBe('succeeded');
    expect(gateCalls).toHaveLength(1);
  });

  it.each(['stop', 'cancel'] as const)(
    '验收长判断由用户 %s 中止，迟到结果不能覆盖用户状态',
    async (how) => {
      const task = await create(['A'], []);
      let release!: () => void;
      fake.gateWaits = [
        new Promise<void>((resolve) => {
          release = resolve;
        }),
      ];
      const pending = finish(runOf('A', task).runId, 'succeeded');
      try {
        await vi.waitFor(() => expect(gateSignals).toHaveLength(1));
        await service[how](OWNER, task.id);
        expect(gateSignals[0]?.aborted).toBe(true);
      } finally {
        release();
      }
      await pending;
      expect((await service.get(OWNER, task.id)).status).toBe(
        how === 'stop' ? 'stopped' : 'cancelled',
      );
    },
  );

  it('关卡检查中途断了：节点停在检查中，对账时重新检查', async () => {
    const task = await create(['A'], []);
    fake.gateResults = ['throw'];
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'checking' });
    await service.reconcile(0);
    expect(await statusOf(task.id)).toMatchObject({ task: 'succeeded', A: 'succeeded' });
  });

  it('正在过关卡的节点不能追问', async () => {
    const task = await create(['A'], []);
    fake.gateResults = ['throw'];
    await finish(runOf('A', task).runId, 'succeeded');
    const err = await service
      .message(OWNER, task.id, task.nodes[0]?.id ?? '', '再改改')
      .catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });
});

describe('讨论节点', () => {
  it('每轮所有人并行发言 → 下一轮接着自己的会话回应别人 → 汇总者写结论 → 过关卡', async () => {
    const task = await create([discussion('D', ['甲', '乙']), 'W'], [['D', 'W']]);
    const round1 = runsOf('D', task);
    expect(round1.map((r) => r.model)).toEqual(['deepseek/甲', 'deepseek/乙']);
    expect(round1[0]?.prompt).toContain('你是「甲」');
    expect(round1[0]?.prompt).toContain('甲的立场');
    expect(round1[0]?.prompt).toContain('第 1 轮（共 2 轮）');

    await finish(round1[0]?.runId as string, 'succeeded', { summary: '我觉得要温馨' });
    expect(runsOf('D', task)).toHaveLength(2); // 乙还没说完，不开下一轮
    await finish(round1[1]?.runId as string, 'succeeded', { summary: '我觉得要简洁' });

    const round2 = runsOf('D', task).slice(2);
    expect(round2).toHaveLength(2);
    expect(round2[0]?.continueFrom).toBe(round1[0]?.runId);
    expect(round2[0]?.prompt).toContain('第 1 轮 乙：我觉得要简洁');
    expect(round2[0]?.prompt).not.toContain('我觉得要温馨');
    expect(round2[1]?.continueFrom).toBe(round1[1]?.runId);

    await finish(round2[0]?.runId as string, 'succeeded', { summary: '可以兼顾' });
    await finish(round2[1]?.runId as string, 'succeeded', { summary: '同意兼顾' });
    const summary = runOf('D', task);
    expect(summary.model).toBe('deepseek/summary');
    expect(summary.prompt).toContain('第 2 轮 甲：可以兼顾');
    expect(summary.prompt).toContain('第 1 轮 乙：我觉得要简洁');

    await finish(summary.runId, 'succeeded', { outputs: [{ path: '讨论结论.md', size: 10 }] });
    expect(gateCalls.map((c) => c.runId)).toEqual([summary.runId]);
    const detail = await service.get(OWNER, task.id);
    const d = detail.nodes.find((n) => n.key === 'D');
    expect(d?.status).toBe('succeeded');
    expect(d?.discussion).toMatchObject({ rounds: 2, round: 2 });
    expect(d?.discussion?.transcript).toHaveLength(4);
    expect(runOf('W', task).inputsFrom).toEqual([{ runId: summary.runId, as: 'D' }]);
  });

  it('下一轮接不上自己原来的会话（工作目录不在了）：重新开会话说，带上完整题目和之前的发言', async () => {
    const task = await create([discussion('D', ['甲', '乙'])], []);
    const [jia, yi] = runsOf('D', task);
    lostWorkspaces.add(jia!.runId);
    await finish(jia!.runId, 'succeeded', { summary: '我觉得要温馨' });
    await finish(yi!.runId, 'succeeded', { summary: '我觉得要简洁' });
    const round2 = runsOf('D', task).slice(2);
    expect(round2).toHaveLength(2);
    const fresh = round2.find((r) => r.model === 'deepseek/甲')!;
    expect(fresh.continueFrom).toBeUndefined();
    expect(fresh.prompt).toContain('你是「甲」');
    expect(fresh.prompt).toContain('做一份温馨小屋的介绍');
    expect(fresh.prompt).toContain(
      '【之前的讨论】\n- 第 1 轮 甲：我觉得要温馨\n- 第 1 轮 乙：我觉得要简洁',
    );
    expect(fresh.prompt).toContain('第 2 轮（共 2 轮）');
    expect(round2.find((r) => r.model === 'deepseek/乙')?.continueFrom).toBe(yi!.runId);

    for (const r of round2) await finish(r.runId, 'succeeded', { summary: '兼顾' });
    expect(runOf('D', task).model).toBe('deepseek/summary');
  });

  it('讨论进行中追问：记下来，下一轮发言带上', async () => {
    const task = await create([discussion('D', ['甲', '乙'])], []);
    const d = task.nodes[0]?.id ?? '';
    expect(await service.message(OWNER, task.id, d, '别超过 100 字')).toBe('noted');
    for (const r of runsOf('D', task)) await finish(r.runId, 'succeeded', { summary: '好' });
    expect(runOf('D', task).prompt).toContain('【用户新追加的要求】\n- 别超过 100 字');
  });

  it('发言最终失败时保留原因并结束同轮其他在途发言，不自行从头复制', async () => {
    const task = await create([discussion('D', ['甲', '乙'], 1)], []);
    const [jia, yi] = runsOf('D', task);
    await finish(jia?.runId as string, 'failed');
    expect(await statusOf(task.id)).toMatchObject({ task: 'needs_attention', D: 'failed' });
    expect(cancelled).toEqual([yi?.runId]);
    expect(submitted).toHaveLength(2);
  });
});
