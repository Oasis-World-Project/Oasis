// 从任务单开始：规划员排方案、规划门退回重排、报价；下载节点交出的文件。
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
  work,
  create,
  createPlanned,
  runOf,
  finish,
  keyOf,
  errorOf,
} from './support/workflow.ts';

describe('规划（从任务单开始）', () => {
  const sheetOf = (budgetMicro: number | null = null) => ({
    title: '小木屋首页',
    deliverables: [{ name: '首页文案', form: 'Markdown' }],
    criteria: ['语气温馨'],
    style: [],
    budgetMicro,
    assumptions: [],
    materials: [],
  });
  const fromSheet = (budgetMicro: number | null = null) =>
    createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: sheetOf(budgetMicro),
    });
  const plannerRuns = () =>
    submitted.filter((s) => !s.nodeId) as unknown as {
      runId: string;
      model: string;
      prompt: string;
      continueFrom?: string;
    }[];
  const goodPlan = JSON.stringify({
    nodes: [work('write', '写初稿'), work('polish', '润色')],
    edges: [{ from: 'write', to: 'polish' }],
    deliverables: { 首页文案: 'polish' },
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

  it('节点花费越过份额的 1.5 倍、2 倍时各提醒一次收尾，之后不再重复', async () => {
    const task = await createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: 'b',
      sheet: {
        ...sheetOf(),
        budget: { tier: 'standard', micro: 100_000, minutes: 5, steps: [] },
      },
    });
    await plannerDone(
      JSON.stringify({
        nodes: [work('write', '写文案')],
        edges: [],
        deliverables: { 首页文案: 'write' },
      }),
    );
    const detail = await service.get(OWNER, task.id);
    const node = detail.nodes[0]!;
    const run = runOf('write', detail).runId;
    const settle = (n: number, micro: number) =>
      service.onCallSettled({
        callId: `00000000-0000-4000-8000-00000000010${n}`,
        taskId: task.id,
        nodeId: node.id,
        chargedMicro: micro,
      });
    await settle(1, 120_000);
    expect(messages).toEqual([]);
    await settle(2, 40_000);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ runId: run });
    expect(messages[0]?.text).toContain('已花 $0.16（分到约 $0.10）');
    expect(messages[0]?.text).toContain('请收尾');
    await settle(3, 10_000);
    expect(messages).toHaveLength(1);
    await settle(4, 50_000);
    expect(messages).toHaveLength(2);
    await settle(5, 100_000);
    expect(messages).toHaveLength(2);
  });

  it('建任务后先规划；方案过了规划门就建节点、算预估和上限、开跑，并发出状态事件', async () => {
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
    // 经验手册（ADR 0016 §6）：不再让 Jev 挑，全文放进 in/playbooks/，说明里只列名字和适用范围
    expect(planner?.prompt).toContain('in/playbooks/images.md：图片类（图片）');
    expect(planner?.prompt).not.toContain('图片的经验');
    const inputs = (planner as unknown as { inputs: { path: string; contentBase64: string }[] })
      .inputs;
    expect(inputs.map((i) => i.path)).toEqual(['playbooks/documents.md', 'playbooks/images.md']);
    expect(Buffer.from(inputs[1]!.contentBase64, 'base64').toString()).toContain('图片的经验');
    expect(decisions.filter((d) => d.headers['x-oasis-task-id'] === task.id)).toHaveLength(0);

    await plannerDone(goodPlan);
    const detail = await service.get(OWNER, task.id);
    // 两个节点各 3000（没有记录时的兜底），不再乘 1.2
    expect(detail).toMatchObject({
      status: 'running',
      estimateMicro: 6_000,
      budgetLimitMicro: null,
    });
    expect(detail.nodes.map((n) => `${n.key}=${n.status}`)).toEqual([
      'write=running',
      'polish=waiting',
    ]);
    expect(detail.deliverables).toEqual([
      { name: '首页文案', form: 'Markdown', nodeId: keyOf(detail, 'polish') },
    ]);
    expect(events.map((e) => (e.data as { status: string }).status)).toEqual(['running']);
  });

  it('规划员看得到能用的工具；节点分到的工具计入预估，并写进节点的说明', async () => {
    const task = await fromSheet();
    const [planner] = plannerRuns();
    expect(planner?.prompt).toContain('- image.generate（image.generate）');
    expect(planner?.prompt).toContain('型号与单价：每次约 $0.04');
    expect(planner?.prompt).not.toContain('- web.search');

    await plannerDone(
      JSON.stringify({
        nodes: [{ ...work('draw', '画首屏'), tools: [{ key: 'image.generate', uses: 2 }] }],
        edges: [],
        deliverables: { 首页文案: 'draw' },
      }),
    );
    const detail = await service.get(OWNER, task.id);
    // 3000 + 2 × 40000（工具没有记录时用目录的兜底单价）
    expect(detail.estimateMicro).toBe(83_000);
    expect(detail.nodes[0]?.tools).toEqual([{ key: 'image.generate', uses: 2 }]);
    const prompt = runOf('draw', detail).prompt;
    expect(prompt).toContain('规划建议用：image.generate');
    expect(prompt).toContain('oasis-tool list');
  });

  it('方案里用了不能用的工具：退回给规划员改', async () => {
    await fromSheet();
    await plannerDone(
      JSON.stringify({
        nodes: [{ ...work('find'), tools: [{ key: 'web.search', uses: 1 }] }],
        edges: [],
        deliverables: { 首页文案: 'find' },
      }),
    );
    expect(plannerRuns().at(-1)?.prompt).toContain(
      '节点「find」的工具 web.search 不在可以用的工具里',
    );
  });

  it('方案没过规划门：接着原会话让规划员改；改好了照常开跑', async () => {
    const task = await fromSheet();
    const bad = JSON.stringify({
      nodes: [{ ...work('write'), model: 'openai/unknown' }],
      edges: [],
      deliverables: {},
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

  it('规划中不能改工作流；取消会停掉规划员', async () => {
    const task = await fromSheet();
    expect(await errorOf(() => service.createNode(OWNER, task.id, work('x')))).toMatchObject({
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
