// 从任务单开始：规划员按成果排方案、规划门退回重排；下载节点交出的文件。
import { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import { events } from './support/memory-store.ts';
import {
  OWNER,
  STRANGER,
  submitted,
  messages,
  cancelled,
  plans,
  decisions,
  service,
  create,
  createPlanned,
  runOf,
  finish,
  keyOf,
  errorOf,
} from './support/workflow.ts';

describe('规划（从任务单开始）', () => {
  const sheetOf = () => ({
    title: '小木屋首页',
    deliverables: [
      { name: '首页文案', form: 'Markdown' },
      { name: '海报文案', form: 'Markdown' },
    ],
    criteria: ['语气温馨'],
    style: [],
    assumptions: [],
    materials: [],
  });
  const fromSheet = () =>
    createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: sheetOf(),
    });
  /** 一样由一个 AI 做的成果 */
  const agent = (key: string, title = key, extra: Record<string, unknown> = {}) => ({
    key,
    title,
    how: 'agent',
    goal: `做 ${key}`,
    model: 'deepseek/x',
    deliver: ['*.md'],
    ...extra,
  });
  const plannerRuns = () =>
    submitted.filter((s) => !s.nodeId) as unknown as {
      runId: string;
      model: string;
      prompt: string;
      continueFrom?: string;
    }[];
  // 海报文案要用首页文案：两样都是交付物，各由一个 AI 做
  const goodPlan = JSON.stringify({
    outcomes: [agent('write', '首页文案'), agent('poster', '海报文案', { needs: ['write'] })],
    deliverables: { 首页文案: 'write', 海报文案: 'poster' },
  });
  const solo = (key: string, title: string) =>
    JSON.stringify({
      outcomes: [agent(key, title, { deliver: ['首页.md', '海报.md'] })],
      deliverables: { 首页文案: key, 海报文案: key },
    });
  const plannerDone = async (
    plan: string | undefined,
    status: 'succeeded' | 'failed' = 'succeeded',
  ) => {
    const run = plannerRuns().at(-1)!;
    if (plan) plans.set(run.runId, plan);
    await finish(run.runId, status);
    return run;
  };

  it('花费只累加到任务和成果上：没有预算，不提醒、不暂停', async () => {
    const task = await fromSheet();
    await plannerDone(solo('write', '写文案'));
    const node = (await service.get(OWNER, task.id)).nodes[0]!;
    const settle = (n: number, micro: number) =>
      service.onCallSettled({
        callId: `00000000-0000-4000-8000-00000000010${n}`,
        taskId: task.id,
        nodeId: node.id,
        chargedMicro: micro,
      });
    await settle(1, 120_000);
    await settle(2, 40_000);
    // 同一次调用只算一次
    await settle(2, 40_000);
    await settle(3, 5_000_000);
    const detail = await service.get(OWNER, task.id);
    expect(detail).toMatchObject({ status: 'running', spentMicro: 5_160_000 });
    expect(detail.nodes[0]?.spentMicro).toBe(5_160_000);
    expect(detail).not.toHaveProperty('estimateMicro');
    expect(messages).toEqual([]);
  });

  it('建任务后先规划；方案过了规划门就建节点、开跑，并发出状态事件', async () => {
    const task = await fromSheet();
    expect(task).toMatchObject({ status: 'planning', nodes: [], sheet: { title: '小木屋首页' } });
    const [planner] = plannerRuns();
    expect(planner?.model).toBe('deepseek/planner');
    // 规划员不分档：一律最强型号、最高思考档
    expect((planner as unknown as { reasoningEffort?: string }).reasoningEffort).toBe('max');
    // 规划员只写方案交给规划门：单轮，不用持续目标
    expect((planner as unknown as { goal?: boolean }).goal).toBeFalsy();
    expect(planner?.prompt).toContain('首页文案');
    expect(planner?.prompt).toContain('deepseek/x（DeepSeek');
    expect(planner?.prompt).not.toContain('最多 4 个节点');
    // 经验手册：不再让 Jev 挑，全文放进 in/playbooks/，说明里只列名字和适用范围
    expect(planner?.prompt).toContain('in/playbooks/images.md：图片类（图片）');
    expect(planner?.prompt).not.toContain('图片的经验');
    const inputs = (planner as unknown as { inputs: { path: string; contentBase64: string }[] })
      .inputs;
    expect(inputs.map((i) => i.path)).toEqual(['playbooks/documents.md', 'playbooks/images.md']);
    expect(Buffer.from(inputs[1]!.contentBase64, 'base64').toString()).toContain('图片的经验');
    expect(decisions.filter((d) => d.headers['x-oasis-task-id'] === task.id)).toHaveLength(0);

    await plannerDone(goodPlan);
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('running');
    expect(detail.nodes.map((n) => `${n.key}=${n.kind}=${n.status}`)).toEqual([
      'write=work=running',
      'poster=work=waiting',
    ]);
    expect(detail.deliverables).toEqual([
      { name: '首页文案', form: 'Markdown', nodeId: keyOf(detail, 'write') },
      { name: '海报文案', form: 'Markdown', nodeId: keyOf(detail, 'poster') },
    ]);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['running']);
  });

  it('规划员看得到能用的工具；做成果的 AI 的说明里写去哪查工具，没有预算和自查清单', async () => {
    const task = await fromSheet();
    const [planner] = plannerRuns();
    expect(planner?.prompt).toContain('- image.generate（image.generate）');
    expect(planner?.prompt).toContain('型号与单价：每次约 $0.04');
    expect(planner?.prompt).not.toContain('- web.search');

    await plannerDone(solo('draw', '画首屏'));
    const detail = await service.get(OWNER, task.id);
    const prompt = runOf('draw', detail).prompt;
    expect(prompt).toContain('你是 Oasis 里负责「画首屏」的 AI');
    expect(prompt).toContain('oasis-tool list');
    expect(prompt).toContain('in/.oasis-environment.json');
    expect(prompt).toContain('怎么做、分几步、怎么校验由你定');
    for (const gone of ['预算', '规划建议用', '交付前看一眼', '够用就交'])
      expect(prompt).not.toContain(gone);
  });

  it('生产线里用了不能用的工具：退回给规划员改', async () => {
    await fromSheet();
    await plannerDone(
      JSON.stringify({
        outcomes: [
          {
            key: 'pages',
            title: '两份文案',
            how: 'line',
            nodes: [
              {
                key: 'find',
                title: '查资料',
                kind: 'tool',
                goal: '查',
                steps: [{ tool: 'web.search' }],
                deliver: ['*.md'],
              },
            ],
          },
        ],
        deliverables: { 首页文案: 'find', 海报文案: 'find' },
      }),
    );
    expect(plannerRuns().at(-1)?.prompt).toContain(
      '工具节点「find」第 1 步的工具 web.search 不在可以用的工具里',
    );
  });

  it('方案没过规划门：接着原会话让规划员改；改好了照常开跑', async () => {
    const task = await fromSheet();
    const bad = JSON.stringify({
      outcomes: [agent('write', '首页文案', { model: 'openai/unknown' })],
      deliverables: { 海报文案: 'write' },
    });
    const first = await plannerDone(bad);
    const revise = plannerRuns().at(-1)!;
    expect(revise.continueFrom).toBe(first.runId);
    expect(revise.prompt).toContain('模型 openai/unknown 不在可以用的模型里');
    expect(revise.prompt).toContain('交付物「首页文案」没有指定由哪个节点交出');
    await plannerDone(goodPlan);
    expect((await service.get(OWNER, task.id)).status).toBe('running');
  });

  it('原生规划失败保留根因；用户选择重新规划后再执行', async () => {
    const task = await fromSheet();
    await plannerDone(undefined, 'failed');
    const detail = await service.get(OWNER, task.id);
    expect(detail.status).toBe('needs_attention');
    expect(detail.attention?.reason).toBe('plan_failed');
    expect(detail.attention?.message).toContain('模型出错');
    expect(plannerRuns()).toHaveLength(1);
    expect((await service.decide(OWNER, task.id, { choice: 'retry' })).status).toBe('planning');
    await plannerDone('不是 JSON');
    await plannerDone('还是错误');
    expect((await service.get(OWNER, task.id)).status).toBe('planning');
    await plannerDone(goodPlan);
    expect((await service.get(OWNER, task.id)).status).toBe('running');
  });

  it('同一个任务 ID 再提交一次：返回已经建好的任务，不建第二个，也不再开规划员', async () => {
    const id = '6a6a6a6a-6a6a-4a6a-8a6a-6a6a6a6a6a6a';
    const body = {
      id,
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: sheetOf(),
    };
    const first = await createPlanned(body);
    const again = await service.create(body);
    expect(again.id).toBe(first.id);
    expect((await service.list(OWNER)).filter((t) => t.id === id)).toHaveLength(1);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(plannerRuns()).toHaveLength(1);
    expect(
      await service.create({ ...body, ownerId: STRANGER, payerId: STRANGER }).then(
        () => 'ok',
        (e: unknown) => (e instanceof HttpError ? e.code : String(e)),
      ),
    ).toBe('task_id_taken');
  });

  it('规划中不能运行或停止工作流；取消会停掉规划员', async () => {
    const task = await fromSheet();
    expect(await errorOf(() => service.run(OWNER, task.id))).toMatchObject({
      status: 409,
      message: 'AI 团队还在搭建工作流，请稍等',
    });
    await service.cancel(OWNER, task.id);
    expect(cancelled).toEqual([plannerRuns()[0]?.runId]);
    await plannerDone(goodPlan); // 取消后才到的结束事件不再推进
    expect((await service.get(OWNER, task.id)).nodes).toEqual([]);
  });
});

describe('下载成果', () => {
  it('转给 harness 读交出这份产出的那次运行；节点没有这个文件就 404', async () => {
    const task = await create(['A'], []);
    const run = runOf('A', task);
    plans.set(run.runId, '# 小木屋');
    await finish(run.runId, 'succeeded', { outputs: [{ path: '首页.md', size: 11 }] });
    const file = await service.file(OWNER, task.id, keyOf(task, 'A'), '首页.md');
    const chunks: Buffer[] = [];
    for await (const chunk of file.content) chunks.push(Buffer.from(chunk as Uint8Array));
    expect(Buffer.concat(chunks).toString()).toBe('# 小木屋');
    expect(
      (await errorOf(() => service.file(OWNER, task.id, keyOf(task, 'A'), '别的.md'))).status,
    ).toBe(404);
  });
});
