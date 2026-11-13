// 停止与继续、需要处理时三选一、花费累加。
import { describe, expect, it } from 'vitest';
import {
  fake,
  OWNER,
  submitted,
  stopped,
  gateCalls,
  service,
  discussion,
  create,
  runsOf,
  runOf,
  finish,
  statusOf,
  keyOf,
  errorOf,
} from './support/workflow.ts';

describe('停止与继续', () => {
  it.each([false, true])(
    '制作成功、检查被暂停后恢复，追加要求=%s 时正确选择复查或原会话续作',
    async (additionalNote) => {
      const task = await create(['A', 'B'], [['A', 'B']]);
      const original = runOf('A', task);
      fake.gateResults = ['throw'];
      await finish(original.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
      expect(await statusOf(task.id)).toMatchObject({ A: 'checking', B: 'waiting' });
      await service.stop(OWNER, task.id);
      if (additionalNote) await service.message(OWNER, task.id, keyOf(task, 'A'), '加上新要求');
      await service.run(OWNER, task.id);
      if (additionalNote) {
        expect(runsOf('A', task)).toHaveLength(2);
        expect(runOf('A', task).continueFrom).toBe(original.runId);
        expect(runOf('A', task).prompt).toContain('加上新要求');
        expect(gateCalls).toHaveLength(1);
        expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'waiting' });
      } else {
        expect(runsOf('A', task)).toHaveLength(1);
        expect(gateCalls.map((call) => call.runId)).toEqual([original.runId, original.runId]);
        expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
      }
    },
  );

  it('停止整个任务：在跑的节点停下（harness 存下产出和会话）；停下时追问记下来；点运行接着原会话做', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = runOf('A', task);
    const after = await service.stop(OWNER, task.id);
    expect(after.status).toBe('stopped');
    expect(after.nodes.find((n) => n.key === 'A')?.status).toBe('stopped');
    expect(stopped).toEqual([a.runId]);
    await finish(a.runId, 'stopped'); // harness 停好了：不再推进
    expect(await service.message(OWNER, task.id, keyOf(task, 'A'), '结尾加一句')).toBe('noted');

    expect((await service.run(OWNER, task.id)).status).toBe('running');
    const resumed = runOf('A', task);
    expect(resumed.continueFrom).toBe(a.runId);
    expect(resumed.prompt).toContain('你刚才被用户停下了');
    expect(resumed.prompt).toContain('- 结尾加一句');
    await finish(resumed.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 1 }] });
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
  });

  it('停止一个节点：其他支路照常跑；都跑不动了任务停下；单独运行它只跑它，不自动往下', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'C'],
        ['B', 'C'],
      ],
    );
    await service.stopNode(OWNER, task.id, keyOf(task, 'A'));
    await finish(runOf('B', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'stopped',
      A: 'stopped',
      B: 'succeeded',
    });

    await service.runNode(OWNER, task.id, keyOf(task, 'A'));
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({
      task: 'stopped',
      A: 'succeeded',
      C: 'waiting',
    });
    expect(runsOf('C', task)).toHaveLength(0);

    await service.run(OWNER, task.id);
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', C: 'running' });
  });

  it('讨论说到一半停下：继续时只让没说完的人重新说这一轮', async () => {
    const task = await create([discussion('D', ['甲', '乙'])], []);
    const [jia, yi] = runsOf('D', task);
    await finish(jia?.runId as string, 'succeeded', { summary: '甲的看法' });
    await service.stop(OWNER, task.id);
    expect(stopped).toEqual([yi?.runId]);
    await service.run(OWNER, task.id);
    const again = runsOf('D', task).slice(2);
    expect(again).toHaveLength(1);
    expect(again[0]?.model).toBe('deepseek/乙');
    expect(again[0]?.prompt).toContain('第 1 轮');
  });

  it('不在跑的节点不能停；已完成的节点不能再运行', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    expect((await errorOf(() => service.stopNode(OWNER, task.id, keyOf(task, 'B')))).status).toBe(
      409,
    );
    await finish(runOf('A', task).runId, 'succeeded');
    expect((await errorOf(() => service.runNode(OWNER, task.id, keyOf(task, 'A')))).status).toBe(
      409,
    );
  });
});

describe('需要处理时三选一', () => {
  const failNode = async (task: { nodes: { id: string; key: string }[] }, key: string) => {
    await finish(runOf(key, task).runId, 'failed');
  };

  it('节点失败 → 用现在的结果继续：它算完成并留提醒，下游照常跑（拿不到它的产出）', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await failNode(task, 'A');
    const detail = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(detail.status).toBe('running');
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      warning: '没能完成，按你的选择用现有的结果继续往下做',
    });
    expect(runOf('B', task).inputsFrom).toEqual([]);
  });

  it('节点失败 → 再试：重做次数重新算', async () => {
    const task = await create(['A'], []);
    await failNode(task, 'A');
    await service.decide(OWNER, task.id, { choice: 'retry' });
    expect((await service.get(OWNER, task.id)).nodes[0]).toMatchObject({
      status: 'running',
      attempts: 1,
    });
    expect(submitted).toHaveLength(2);
  });

  it('不需要处理时不能选', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    expect(
      (await errorOf(() => service.decide(OWNER, task.id, { choice: 'continue' }))).status,
    ).toBe(409);
  });
});

describe('花费', () => {
  const settle = (taskId: string, nodeId: string, callId: string, chargedMicro: number) =>
    service.onCallSettled({ callId, taskId, nodeId, chargedMicro });
  const CALL = (n: number) => `00000000-0000-4000-8000-00000000000${n}`;

  it('没有预算和上限：花多少都照常运行，结算幂等', async () => {
    const task = await create(['A', 'B'], []);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 2_000);
    await settle(task.id, keyOf(task, 'B'), CALL(2), 1_500);
    const detail = await service.get(OWNER, task.id);
    expect(detail.spentMicro).toBe(3_500);
    expect(detail.nodes.find((n) => n.key === 'A')?.spentMicro).toBe(2_000);
    expect(detail.status).toBe('running');
    expect(stopped).toEqual([]);
  });

  it('花得再多也照常运行，不暂停、不停节点', async () => {
    const task = await create(['A', 'B'], []);
    await settle(task.id, keyOf(task, 'A'), CALL(1), 3_500);
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'running', attention: null, spentMicro: 3_500 });
    expect(stopped).toHaveLength(0);
  });
});
