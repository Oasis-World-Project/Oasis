// 中途调整（ADR 0030 §3.7）：做成果的 AI 提一次，规划员答一次；同意的改动马上生效，答复写回给提出的 AI。
import { describe, expect, it, vi } from 'vitest';
import {
  OWNER,
  answers,
  cancelled,
  createPlanned,
  finish,
  keyOf,
  plans,
  runOf,
  runsOf,
  service,
  statusOf,
  submitted,
} from './support/workflow.ts';

const JOB = '00000000-0000-4000-8000-0000000000c1';
const PLANNER = 'deepseek/planner';

describe('中途调整', () => {
  const agent = (key: string, title: string, extra: Record<string, unknown> = {}) => ({
    key,
    title,
    how: 'agent',
    goal: `做 ${key}`,
    model: 'deepseek/x',
    deliver: ['*.md'],
    ...extra,
  });

  /** 三样成果：首页文案在做，海报文案等它，备用标题和它们没有文件往来 */
  async function started() {
    const task = await createPlanned({
      ownerId: OWNER,
      materials: [],
      payerId: OWNER,
      title: '小木屋首页',
      brief: '为小木屋民宿写官网首页开头',
      sheet: {
        title: '小木屋首页',
        deliverables: ['首页文案', '海报文案', '备用标题'].map((name) => ({
          name,
          form: 'Markdown',
        })),
        criteria: ['语气温馨'],
        style: [],
        assumptions: [],
        materials: [],
      },
    });
    const planner = submitted.find((s) => !s.nodeId) as { runId: string };
    plans.set(
      planner.runId,
      JSON.stringify({
        outcomes: [
          agent('write', '首页文案'),
          agent('poster', '海报文案', { needs: ['write'] }),
          agent('titles', '备用标题'),
        ],
        deliverables: { 首页文案: 'write', 海报文案: 'poster', 备用标题: 'titles' },
      }),
    );
    await finish(planner.runId, 'succeeded');
    return service.get(OWNER, task.id);
  }
  type Started = Awaited<ReturnType<typeof started>>;
  const request = (task: Started, runId: string) => ({
    jobId: JOB,
    taskId: task.id,
    nodeId: keyOf(task, 'write'),
    runId,
    want: '加一份常见问题；海报别写价格；备用标题不用做了',
    why: '首页已经带了标题备选',
  });
  /** 规划员答复调整的那次运行：记在提出的那样成果上 */
  const adjustRuns = (task: Started) => runsOf('write', task).filter((r) => r.model === PLANNER);
  const nodeOf = async (taskId: string, key: string) =>
    (await service.get(OWNER, taskId)).nodes.find((n) => n.key === key)!;

  it('提一次、答一次：同意的改动马上生效（加成果、补说明、停成果），改之前冻结一版，答复写回', async () => {
    const task = await started();
    const work = runOf('write', task).runId;
    const titles = runOf('titles', task).runId;
    expect(await statusOf(task.id)).toMatchObject({
      task: 'running',
      write: 'running',
      poster: 'waiting',
      titles: 'running',
    });

    await service.onAdjustmentRequested(request(task, work));
    const [planner] = adjustRuns(task);
    expect(planner!.prompt).toContain('【提出的调整】来自 write「首页文案」');
    expect(planner!.prompt).toContain('要什么：加一份常见问题');
    expect(planner!.prompt).toContain('- titles「备用标题」：一个 AI（deepseek/x）；正在做');
    expect((await nodeOf(task.id, 'write')).adjust).toEqual({
      asking: true,
      note: '加一份常见问题；海报别写价格；备用标题不用做了',
    });
    // 同一条事件重复到达：不开第二次
    await service.onAdjustmentRequested(request(task, work));
    expect(adjustRuns(task)).toHaveLength(1);

    plans.set(
      planner!.runId,
      JSON.stringify({
        reply: '同意：加常见问题，海报不写价格，备用标题停掉、改由首页文案交付。',
        add: [agent('faq', '常见问题', { needs: ['write'] })],
        deliverables: { 备用标题: 'write' },
        instruct: [{ key: 'poster', text: '不要写价格' }],
        stop: ['titles'],
      }),
    );
    await finish(planner!.runId, 'succeeded');

    const after = await service.get(OWNER, task.id);
    expect(await statusOf(task.id)).toMatchObject({
      task: 'running',
      write: 'running',
      poster: 'waiting',
      titles: 'cancelled',
      faq: 'waiting',
    });
    expect(cancelled).toContain(titles);
    expect([after.version, after.versions.map((v) => v.version)]).toEqual([2, [1]]);
    expect(after.deliverables.find((d) => d.name === '备用标题')?.nodeId).toBe(
      keyOf(after, 'write'),
    );
    expect(after.nodes.find((n) => n.key === 'faq')?.adjust?.note).toContain('中途新加的');
    expect(after.nodes.find((n) => n.key === 'titles')?.adjust?.note).toContain('停掉了');
    expect(after.nodes.find((n) => n.key === 'poster')).toMatchObject({
      userNotes: ['（规划员中途调整）不要写价格'],
      adjust: { asking: false, note: '说明改了：不要写价格' },
    });
    expect(after.nodes.find((n) => n.key === 'write')?.adjust).toMatchObject({ asking: false });
    expect(answers).toEqual([
      {
        jobId: JOB,
        text: expect.stringContaining(
          '已生效：新加了「常见问题」；给「海报文案」补了说明；停掉了「备用标题」',
        ) as string,
      },
    ]);

    // 首页文案做完后，新成果和海报文案才开跑；补的说明带进海报文案的说明里
    const done = { outputs: [{ path: '成稿.md', size: 10 }] };
    await finish(work, 'succeeded', done);
    await vi.waitFor(async () =>
      expect(await statusOf(task.id)).toMatchObject({
        write: 'succeeded',
        poster: 'running',
        faq: 'running',
      }),
    );
    expect(runOf('poster', after).prompt).toContain('（规划员中途调整）不要写价格');
    // 停掉的成果不拦着任务完成
    await finish(runOf('poster', after).runId, 'succeeded', done);
    await finish(runOf('faq', after).runId, 'succeeded', done);
    await vi.waitFor(async () => expect((await statusOf(task.id)).task).toBe('succeeded'));
  });

  it('现在不能调整的直接答复原因，不开规划员运行', async () => {
    const task = await started();
    await service.onAdjustmentRequested(request(task, '00000000-0000-4000-8000-00000000dead'));
    expect(adjustRuns(task)).toHaveLength(0);
    expect(answers).toEqual([{ jobId: JOB, text: '提出调整的这次运行已经不是这样成果当前的运行' }]);
  });

  it('规划员的答复过不了检查：工作流不动，把原因答复回去', async () => {
    const task = await started();
    await service.onAdjustmentRequested(request(task, runOf('write', task).runId));
    const [planner] = adjustRuns(task);
    // 海报文案还要用首页文案；首页文案又是交付物
    plans.set(planner!.runId, JSON.stringify({ reply: '停掉首页文案', stop: ['write'] }));
    await finish(planner!.runId, 'succeeded');
    const after = await service.get(OWNER, task.id);
    expect(await statusOf(task.id)).toMatchObject({ task: 'running', write: 'running' });
    expect([after.version, after.versions]).toEqual([1, []]);
    expect(answers[0]?.text).toContain('这次调整没有生效');
    expect(answers[0]?.text).toContain('「poster」还要用「write」交出的文件');
  });

  it('规划员还在答复时成果都做完了：先不算做完，答复到了再收尾', async () => {
    const task = await started();
    const work = runOf('write', task).runId;
    await service.onAdjustmentRequested(request(task, work));
    const [planner] = adjustRuns(task);
    // 交出了要交付的文件，整体验收才过得去
    const done = { outputs: [{ path: '成稿.md', size: 10 }] };
    await finish(runOf('titles', task).runId, 'succeeded', done);
    await finish(work, 'succeeded', done);
    await vi.waitFor(async () =>
      expect(await statusOf(task.id)).toMatchObject({ poster: 'running' }),
    );
    await finish(runOf('poster', task).runId, 'succeeded', done);
    await vi.waitFor(async () =>
      expect(await statusOf(task.id)).toMatchObject({ task: 'running', poster: 'succeeded' }),
    );
    plans.set(planner!.runId, JSON.stringify({ reply: '不用改，按原来的做。' }));
    await finish(planner!.runId, 'succeeded');
    await vi.waitFor(async () => expect((await statusOf(task.id)).task).toBe('succeeded'));
    expect(answers[0]?.text).toBe('不用改，按原来的做。\n（工作流没有改动）');
  });
});
