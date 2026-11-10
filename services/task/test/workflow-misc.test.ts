// 只用国内模型、模型在当前网络用不了时换模型、用户素材、节点详情、删除任务（真删除）。
import { createServiceClient, HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { createModelScopes } from '../src/service/model-scope.ts';
import { events } from './support/memory-store.ts';
import {
  fake,
  harnessUrl,
  OWNER,
  STRANGER,
  submitted,
  cancelled,
  eventRequests,
  service,
  work,
  discussion,
  create,
  createPlanned,
  runsOf,
  runOf,
  finish,
  keyOf,
  errorOf,
} from './support/workflow.ts';

describe('只用国内模型（ADR 0027）', () => {
  const plannerPrompt = async (ownerId: string) => {
    await createPlanned({
      ownerId,
      materials: [],
      payerId: ownerId,
      title: 't',
      brief: 'b',
      sheet: {
        title: 't',
        deliverables: [{ name: 'd', form: 'f' }],
        criteria: ['c'],
        style: [],
        budgetMicro: null,
        assumptions: [],
        materials: [],
      },
    });
    return (submitted.findLast((x) => !x.nodeId) as { prompt: string }).prompt;
  };

  it('开关经 task 读写；打开后这个用户的规划员和编辑节点时都只看到国内模型，别的用户不受影响', async () => {
    const scopes = createModelScopes(createServiceClient('model-gateway', harnessUrl));
    expect(await scopes.get(OWNER)).toEqual({ domesticOnly: false });
    expect(await plannerPrompt(OWNER)).toContain('openai/blocked（GPT');
    expect((await service.options(OWNER)).models.map((m) => m.providerModel)).toEqual([
      'deepseek/x',
      'openai/blocked',
    ]);

    expect(await scopes.set(OWNER, { domesticOnly: true })).toEqual({ domesticOnly: true });
    expect(await scopes.get(OWNER)).toEqual({ domesticOnly: true });
    const prompt = await plannerPrompt(OWNER);
    expect(prompt).toContain('deepseek/x（DeepSeek');
    expect(prompt).not.toContain('openai/blocked');
    const options = await service.options(OWNER);
    expect(options.models.map((m) => m.providerModel)).toEqual(['deepseek/x']);
    expect(options.tools.map((t) => t.key)).toEqual(['image.generate']);
    expect(await plannerPrompt(STRANGER)).toContain('openai/blocked（GPT');

    await scopes.set(OWNER, { domesticOnly: false });
    expect((await service.options(OWNER)).models).toHaveLength(2);
  });
});

describe('模型在当前网络用不了', () => {
  const REGION =
    '502: {"code":"provider_region_unavailable","message":"这个模型在当前网络所在的地区用不了"}';

  it('干活节点碰上了：换默认模型接着做，不算一次重做，节点上留提醒', async () => {
    const task = await service.create({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: 't',
      brief: 'b',
      plan: { nodes: [{ ...work('A'), model: 'openai/blocked' }], edges: [] },
    });
    await finish(runOf('A', task).runId, 'failed', { error: REGION });
    const next = runOf('A', task);
    expect(next.model).toBe('deepseek/x');
    const node = (await service.get(OWNER, task.id)).nodes[0];
    expect(node).toMatchObject({
      status: 'running',
      model: 'deepseek/x',
      attempts: 1,
      warning: '原定的模型 openai/blocked 在当前网络用不了，改用 deepseek/x',
    });
    // 默认模型也不可用：报告实际故障，不反复付费重放
    await finish(next.runId, 'failed', { error: REGION });
    expect((await service.get(OWNER, task.id)).status).toBe('needs_attention');
  });

  it('讨论里某位参与者碰上了：只换他的模型，重新说这一句', async () => {
    const d = discussion('D', ['甲', '乙'], 1);
    d.participants[1]!.model = 'openai/blocked';
    const task = await create([d], []);
    const yi = runsOf('D', task).find((r) => r.model === 'openai/blocked')!;
    await finish(yi.runId, 'failed', { error: REGION });
    const again = runOf('D', task);
    expect(again.model).toBe('deepseek/x');
    expect(again.prompt).toContain('你是「乙」');
    const node = (await service.get(OWNER, task.id)).nodes[0];
    expect(node?.discussion?.participants.map((p) => p.model)).toEqual([
      'deepseek/甲',
      'deepseek/x',
    ]);
    expect(node?.warning).toBe('「乙」原定的模型 openai/blocked 在当前网络用不了，改用 deepseek/x');
  });
});

describe('用户给的素材（ADR 0007 §4）', () => {
  it('每次运行都带上素材，同名的加序号；节点说明里列出素材路径', async () => {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      title: '测试任务',
      brief: '用照片做首页',
      materials: [
        { uploadId: '11111111-0000-4000-8000-000000000001', name: '照片.jpg', size: 10 },
        { uploadId: '11111111-0000-4000-8000-000000000002', name: '照片.jpg', size: 20 },
      ],
      plan: { nodes: [work('A')], edges: [] },
    });
    expect(task.materials).toHaveLength(2);
    const [run] = submitted;
    expect(run!.materials).toEqual([
      { uploadId: '11111111-0000-4000-8000-000000000001', path: 'materials/照片.jpg' },
      { uploadId: '11111111-0000-4000-8000-000000000002', path: 'materials/照片 (2).jpg' },
    ]);
    expect(run!.prompt).toContain('【用户给的素材】');
    expect(run!.prompt).toContain('- materials/照片 (2).jpg');
  });
});

describe('节点详情（ADR 0007 §6）', () => {
  it('列出节点的每次运行；能看指定那次的运行过程，别的节点的运行看不到', async () => {
    const task = await create(['A', 'B'], [['A', 'B']]);
    const first = runOf('A', task);
    fake.gateResults = [['缺少文件 out/*.md']];
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'a.txt', size: 3 }] });
    const rework = runOf('A', task);

    const a = keyOf(task, 'A');
    const runs = await service.nodeRuns(OWNER, task.id, a);
    expect(runs.map((r) => [r.id, r.purpose, r.continued])).toEqual([
      [first.runId, 'work', false],
      [rework.runId, 'rework', true],
    ]);

    eventRequests.length = 0;
    await service.nodeEvents(OWNER, task.id, a, -1);
    await service.nodeEvents(OWNER, task.id, a, -1, first.runId);
    expect(eventRequests).toEqual([rework.runId, first.runId]);

    const b = keyOf(task, 'B');
    expect(
      (await errorOf(() => service.nodeEvents(OWNER, task.id, b, -1, first.runId))).status,
    ).toBe(404);
  });
});

describe('删除任务（真删除）', () => {
  /** 建一个只有一个节点的任务并跑完 */
  async function delivered() {
    const task = await service.create({
      ownerId: OWNER,
      payerId: OWNER,
      materials: [],
      title: '测试任务',
      brief: '做一份介绍',
      plan: { nodes: [work('A')], edges: [] },
    });
    await finish(runOf('A', task).runId, 'succeeded', { outputs: [{ path: 'a.md', size: 3 }] });
    return task;
  }
  const codeOf = (p: Promise<unknown>) =>
    p.then(
      () => 'ok',
      (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
    );
  const deletedEvents = () => events.filter((e) => e.type === 'task.task.deleted');

  it('别人的任务删不了', async () => {
    const task = await delivered();
    expect(await codeOf(service.remove(STRANGER, task.id))).toBe('task_not_found');
    expect(deletedEvents()).toHaveLength(0);
  });

  it('用户删除还在跑的任务：先停掉正在跑的运行，再连同工作流一起删', async () => {
    const task = await create(['A', 'B'], []);
    const running = [runOf('A', task).runId, runOf('B', task).runId];
    await service.remove(OWNER, task.id);
    expect(cancelled.sort()).toEqual([...running].sort());
    expect(deletedEvents().map((e) => e.data)).toEqual([
      expect.objectContaining({ taskId: task.id, ownerId: OWNER }),
    ]);
    await finish(running[0]!, 'cancelled');
    expect(await codeOf(service.get(OWNER, task.id))).toBe('task_not_found');
  });

  it('用户删除已结束的任务：连同工作流一起删；之后迟到的结算和运行结束事件被忽略', async () => {
    const task = await delivered();
    const run = runOf('A', task).runId;
    await service.remove(OWNER, task.id);
    expect(deletedEvents().map((e) => e.data)).toEqual([
      expect.objectContaining({ taskId: task.id, ownerId: OWNER }),
    ]);
    await service.onCallSettled({
      callId: '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b',
      taskId: task.id,
      nodeId: task.nodes[0]!.id,
      chargedMicro: 100,
    });
    await finish(run, 'succeeded');
    expect(await codeOf(service.get(OWNER, task.id))).toBe('task_not_found');
  });
});
