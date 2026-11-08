// 工作流调度：按图开跑、并发上限、追问与取消、对账补结局和重交。
import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { RunFinished } from '@oasis/contracts/events';
import {
  fake,
  OWNER,
  STRANGER,
  submitted,
  messages,
  cancelled,
  harnessKnows,
  finishedRemote,
  lostWorkspaces,
  runBody,
  service,
  create,
  runOf,
  finish,
  statusOf,
  keyOf,
} from './support/workflow.ts';

describe('工作流调度', () => {
  it('完成事件解析保留文件摘要，节点及后续交付不会在异步边界丢失校验信息', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const run = runOf('A', task);
    await service.onRunFinished(
      RunFinished.data.parse({
        runId: run.runId,
        payerId: OWNER,
        taskId: task.id,
        nodeId: task.nodes[0]!.id,
        status: 'succeeded',
        error: null,
        summary: null,
        finishedAt: new Date().toISOString(),
        outputs: [{ path: 'result.md', size: 3, sha256: 'a'.repeat(64) }],
      }),
    );
    expect((await service.get(OWNER, task.id)).nodes.find((n) => n.key === 'A')?.outputs).toEqual([
      { path: 'result.md', size: 3, sha256: 'a'.repeat(64) },
    ]);
    expect(runOf('B', task).inputsFrom).toEqual([{ runId: run.runId, as: 'A' }]);
  });
  it('菱形图：A、B 并行 → 都完成后 C 拿着两份上游产出开跑 → C 完成则任务完成', async () => {
    const task = await create(
      ['A', 'B', 'C'],
      [
        ['A', 'C'],
        ['B', 'C'],
      ],
    );
    expect(submitted.map((s) => s.nodeId)).toEqual(
      task.nodes.filter((n) => n.key !== 'C').map((n) => n.id),
    );
    expect(await statusOf(task.id)).toMatchObject({ A: 'running', B: 'running', C: 'waiting' });

    await finish(runOf('A', task).runId, 'succeeded', {
      summary: 'A 写好了',
      outputs: [{ path: 'a.md', size: 3 }],
    });
    expect(submitted).toHaveLength(2); // B 还没完成，C 不跑
    await finish(runOf('B', task).runId, 'succeeded', {
      summary: 'B 写好了',
      outputs: [{ path: 'b.md', size: 3 }],
    });

    const c = runOf('C', task);
    expect(c.inputsFrom.map((i) => i.as).sort()).toEqual(['A', 'B']);
    expect(c.prompt).toContain('in/A/a.md');
    expect(c.prompt).toContain('它最后说：A 写好了');
    expect(c.prompt).toContain('做一份温馨小屋的介绍');
    await finish(c.runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ task: 'succeeded', C: 'succeeded' });
  });

  it('同一个结束事件到两次，只处理一次', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = runOf('A', task).runId;
    await finish(a, 'succeeded');
    await finish(a, 'succeeded');
    expect(submitted.filter((s) => s.nodeId === task.nodes[1]?.id)).toHaveLength(1);
  });

  it('失败后原会话的工作目录还在：重试时接着同一会话和产物', async () => {
    const task = await create(['A'], []);
    const previous = runOf('A', task).runId;
    await finish(previous, 'failed', { resumable: true });
    expect(submitted).toHaveLength(1);
    await service.decide(OWNER, task.id, { choice: 'retry' });
    expect(runOf('A', task)).toMatchObject({ continueFrom: previous, goal: true, inputsFrom: [] });
  });

  it('接不上原会话（工作目录不在了）：这一步重新开会话做，带上上一版产出和原本要修的问题，不算节点失败', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const first = runOf('A', task).runId;
    fake.gateResults = [['标题不对']];
    lostWorkspaces.add(first);
    await finish(first, 'succeeded', { outputs: [{ path: 'a.md', size: 3 }] });

    // 关卡没过 → 接着原会话修 → harness 说工作目录不在了 → 重新开会话做
    const redo = runOf('A', task);
    expect(redo.runId).not.toBe(first);
    expect(redo.continueFrom).toBeUndefined();
    expect(redo.goal).toBe(true);
    expect(redo.inputsFrom).toEqual([{ runId: first, as: '_previous' }]);
    expect(redo.prompt).toContain('你是 Oasis 工作流里的一个节点');
    expect(redo.prompt).toContain('【重新做】');
    expect(redo.prompt).toContain('in/_previous/');
    expect(redo.prompt).toContain('- 标题不对');
    const a = keyOf(task, 'A');
    const runs = await service.nodeRuns(OWNER, task.id, a);
    expect(runs.map((r) => [r.purpose, r.status, r.continued])).toEqual([
      ['work', 'succeeded', false],
      ['rework', 'failed', true],
      ['rework', 'running', false],
    ]);
    expect(runs[1]?.error).toContain('工作目录已经不在了');
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', A: 'running' });

    await finish(redo.runId, 'succeeded', { outputs: [{ path: 'a.md', size: 4 }] });
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
    expect(runOf('B', task).inputsFrom).toEqual([{ runId: redo.runId, as: 'A' }]);
  });

  it('停下后继续时工作目录不在了，节点也没交过产出：重新开会话从头做', async () => {
    const task = await create(['A'], []);
    const first = runOf('A', task).runId;
    await service.stop(OWNER, task.id);
    await finish(first, 'stopped', { resumable: true });
    lostWorkspaces.add(first);
    await service.run(OWNER, task.id);
    const redo = runOf('A', task);
    expect(redo.continueFrom).toBeUndefined();
    expect(redo.inputsFrom).toEqual([]);
    expect(redo.prompt).toContain('之前的进度没有保存下来，从头做');
    expect(redo.prompt).not.toContain('【原本接着要你做的】');
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', A: 'running' });
  });

  it('原生执行器明确失败后报告根因，不在外层复制付费运行，下游不跑', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention).toMatchObject({
      reason: 'node_failed',
      message: '「A」未完成：模型出错',
    });
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'failed',
      attempts: 1,
    });
    expect(submitted).toHaveLength(1);
  });

  it('明确重试后成功，照常往下走', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    await finish(runOf('A', task).runId, 'failed');
    await service.decide(OWNER, task.id, { choice: 'retry' });
    await finish(runOf('A', task).runId, 'succeeded');
    expect(await statusOf(task.id)).toMatchObject({ A: 'succeeded', B: 'running' });
  });

  it('harness 明确拒绝（4xx）报告错误，不重复提交同一无效请求', async () => {
    fake.rejectNext = true;
    const task = await create(['A'], []);
    expect(submitted).toHaveLength(0);
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
  });
});

describe('追问与取消', () => {
  it('还没开始的节点：记下来，开跑时写进说明；运行中的：直接送到它的会话；已完成的：409', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const a = task.nodes.find((n) => n.key === 'A') as { id: string };
    const b = task.nodes.find((n) => n.key === 'B') as { id: string };
    expect(await service.message(OWNER, task.id, b.id, '语气活泼一点')).toBe('noted');
    expect(await service.message(OWNER, task.id, a.id, '加一句结尾')).toBe('delivered');
    expect(messages).toEqual([{ runId: runOf('A', task).runId, text: '加一句结尾' }]);

    await finish(runOf('A', task).runId, 'succeeded');
    expect(runOf('B', task).prompt).toContain('- 语气活泼一点');
    const err = await service.message(OWNER, task.id, a.id, '再改改').catch((e: unknown) => e);
    expect((err as HttpError).statusCode).toBe(409);
  });

  it('取消：没结束的节点都取消，正在跑的通知 harness 停下；之后到的结束事件不再推进', async () => {
    const task = await create(['A', 'B', 'C'], [['A', 'C']]);
    const running = submitted.map((s) => s.runId);
    const after = await service.cancel(OWNER, task.id);
    expect(after.status).toBe('cancelled');
    expect(after.nodes.every((n) => n.status === 'cancelled')).toBe(true);
    expect(cancelled.sort()).toEqual([...running].sort());
    await finish(running[0] as string, 'cancelled');
    expect(submitted).toHaveLength(2);
  });

  it('别人的任务看不到、改不了', async () => {
    const task = await create(['A'], []);
    for (const action of [
      () => service.get(STRANGER, task.id),
      () => service.cancel(STRANGER, task.id),
      () => service.message(STRANGER, task.id, task.nodes[0]?.id ?? '', 'hi'),
    ]) {
      expect(((await action().catch((e: unknown) => e)) as HttpError).statusCode).toBe(404);
    }
    expect(await service.list(STRANGER)).toEqual([]);
  });
});

describe('对账', () => {
  it('harness 已经跑完但事件丢了：对账时补上；harness 根本没收到：重新提交同一个运行', async () => {
    const task = await create(['A', 'B'], []);
    const a = runOf('A', task).runId;
    const b = runOf('B', task).runId;
    finishedRemote.set(a, runBody(a, 'succeeded', { summary: '补上了' }));
    harnessKnows.delete(b);
    await service.reconcile(0);
    const detail = await service.get(OWNER, task.id);
    expect(detail.nodes.find((n) => n.key === 'A')).toMatchObject({
      status: 'succeeded',
      summary: '补上了',
    });
    expect(submitted.filter((s) => s.runId === b)).toHaveLength(2);
  });
});
