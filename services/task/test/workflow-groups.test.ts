// 子节点（ADR 0026）：展开节点按清单开子节点、工具子节点另算并发池、做几版挑一版、改用另一版。
import type { TaskBody } from '@oasis/contracts/task';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  fake,
  finish,
  keyOf,
  OWNER,
  plans,
  runOf,
  runsOf,
  service,
  submitted,
  toolEntry,
  work,
} from './support/workflow.ts';

type Run = { runId: string; steps?: { tool: string; args: Record<string, unknown> }[] };
type WithInputs = { inputsFrom: { runId: string; as: string }[]; inputs?: { path: string }[] };

const tools = [
  {
    ...toolEntry('image.generate', 40_000, true),
    args: [
      { name: 'prompt', kind: 'text', required: true, description: '画面' },
      { name: 'ref', kind: 'paths', description: '参考图' },
    ],
  },
  {
    ...toolEntry('image.inspect', 2_000, true),
    args: [
      { name: 'images', kind: 'paths', required: true, min: 1, max: 4, description: '图' },
      { name: 'question', kind: 'text', required: true, description: '问题' },
    ],
  },
];

/** 按清单每条出一张图的展开节点 */
const frames = (key: string, extra: Record<string, unknown> = {}, count = 3) => ({
  key,
  title: key,
  kind: 'foreach',
  role: '',
  goal: `每条一张图（${key}）`,
  model: '',
  checks: [],
  expects: [],
  over: 'in/list/shots.json',
  count,
  each: {
    kind: 'tool',
    title: `${key} {{index}}`,
    role: '',
    goal: '画第 {{index}} 条',
    model: '',
    checks: [],
    expects: [],
    steps: [{ tool: 'image.generate', args: { prompt: '{{item.prompt}}' }, out: 'out/frame.png' }],
    ...extra,
  },
});
const film = (from: string, file: string) => ({
  key: 'film',
  title: '成片',
  kind: 'tool',
  role: '',
  goal: '拼起来',
  model: '',
  checks: [],
  expects: [],
  steps: [{ tool: 'op.video.concat', args: { in: `in/${from}/*/${file}` }, out: 'out/film.mp4' }],
});
const start = (nodes: unknown[], edges: [string, string][]) =>
  service.create({
    ownerId: OWNER,
    payerId: OWNER,
    materials: [],
    title: '分镜视频',
    brief: '按分镜做视频',
    plan: { nodes, edges: edges.map(([from, to]) => ({ from, to })) } as never,
  });
const latest = (task: TaskBody) => service.get(OWNER, task.id);
const childrenOf = (task: TaskBody, key: string) =>
  task.nodes
    .filter((n) => n.parentId === keyOf(task, key))
    .sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
const png = (path = 'frame.png') => ({ outputs: [{ path, size: 5 }] });

/** 清单节点交出 shots.json */
async function listDone(task: TaskBody, items: unknown[]) {
  const run = runOf('list', task);
  plans.set(run.runId, JSON.stringify(items));
  await finish(run.runId, 'succeeded', { outputs: [{ path: 'shots.json', size: 20 }] });
}

beforeEach(() => {
  fake.tools = tools;
});

describe('展开节点', () => {
  it('按清单每条开一个子节点，套上模板；都做完后按条目号汇总，下游拿到每条的目录和 index.json', async () => {
    const task = await start(
      [work('list'), frames('shots'), film('shots', 'frame.png')],
      [
        ['list', 'shots'],
        ['shots', 'film'],
      ],
    );
    await listDone(task, [{ prompt: '红' }, { prompt: '绿' }, { prompt: '蓝' }]);
    let now = await latest(task);
    const kids = childrenOf(now, 'shots');
    expect(kids.map((k) => [k.key, k.slot, k.title])).toEqual([
      ['shots-01', 1, 'shots 01'],
      ['shots-02', 2, 'shots 02'],
      ['shots-03', 3, 'shots 03'],
    ]);
    const runs = kids.map((k) => runOf(k.key, now) as unknown as Run & WithInputs);
    expect(runs.map((r) => r.steps?.[0]?.args.prompt)).toEqual(['红', '绿', '蓝']);
    // 步骤没点名用上游文件：一个也不搬
    expect(runs.every((r) => r.inputsFrom.length === 0 && !r.inputs)).toBe(true);
    for (const r of runs) await finish(r.runId, 'succeeded', png());
    now = await latest(now);
    const shots = now.nodes.find((n) => n.key === 'shots')!;
    expect(shots.status).toBe('succeeded');
    expect(shots.foreach).toMatchObject({ items: 3, count: 3 });
    expect(shots.outputs.map((f) => f.path)).toEqual([
      '01/frame.png',
      '02/frame.png',
      '03/frame.png',
    ]);
    const cut = runOf('film', now) as unknown as WithInputs;
    expect(cut.inputsFrom).toEqual(runs.map((r, i) => ({ runId: r.runId, as: `shots/0${i + 1}` })));
    expect(cut.inputs?.map((f) => f.path)).toEqual(['shots/index.json']);
    // 任务列表只数工作流图里的节点
    const [summary] = await service.list(OWNER);
    expect(summary).toMatchObject({ nodesTotal: 3, nodesDone: 2 });
  });

  it('工具子节点最多 6 个同时跑，AI 节点另算', async () => {
    const task = await start(
      [work('list'), frames('shots', {}, 8), film('shots', 'frame.png')],
      [
        ['list', 'shots'],
        ['shots', 'film'],
      ],
    );
    await listDone(
      task,
      Array.from({ length: 8 }, (_, i) => ({ prompt: `镜头${i}` })),
    );
    let now = await latest(task);
    const running = () => childrenOf(now, 'shots').filter((k) => k.status === 'running');
    expect(running()).toHaveLength(6);
    await finish(runOf(running()[0]!.key, now).runId, 'succeeded', png());
    now = await latest(now);
    expect(running()).toHaveLength(6);
    expect(childrenOf(now, 'shots').filter((k) => k.status === 'waiting')).toHaveLength(1);
  });

  it('清单格式不对：上游是 AI 节点就接着原会话改一次清单，改好后照常展开', async () => {
    const task = await start(
      [work('list'), frames('shots'), film('shots', 'frame.png')],
      [
        ['list', 'shots'],
        ['shots', 'film'],
      ],
    );
    const first = runOf('list', task);
    plans.set(first.runId, '{"不是":"数组","也不是":"数组"}');
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'shots.json', size: 20 }] });
    let now = await latest(task);
    const fix = runOf('list', now) as unknown as {
      runId: string;
      continueFrom?: string;
      prompt: string;
    };
    expect(fix.continueFrom).toBe(first.runId);
    expect(fix.prompt).toContain('in/list/shots.json');
    expect(now.nodes.find((n) => n.key === 'shots')?.status).toBe('waiting');
    plans.set(fix.runId, JSON.stringify([{ prompt: '红' }]));
    await finish(fix.runId, 'succeeded', { outputs: [{ path: 'shots.json', size: 20 }] });
    now = await latest(now);
    expect(childrenOf(now, 'shots')).toHaveLength(1);
  });

  it('清单还是不对（改过一次了）：展开节点失败交给用户；字段缺了也一样', async () => {
    const task = await start(
      [work('list'), frames('shots'), film('shots', 'frame.png')],
      [
        ['list', 'shots'],
        ['shots', 'film'],
      ],
    );
    const first = runOf('list', task);
    plans.set(first.runId, JSON.stringify([{ text: '没有 prompt' }]));
    await finish(first.runId, 'succeeded', { outputs: [{ path: 'shots.json', size: 20 }] });
    let now = await latest(task);
    const fix = runOf('list', now);
    plans.set(fix.runId, JSON.stringify([{ text: '还是没有' }]));
    await finish(fix.runId, 'succeeded', { outputs: [{ path: 'shots.json', size: 20 }] });
    now = await latest(now);
    expect(now.status).toBe('needs_attention');
    expect(now.attention?.message).toContain('{{item.prompt}}');
  });
});

describe('做几版挑一版', () => {
  const art = { ...work('art'), variants: { n: 2, pick: '构图最贴近描述' } };

  it('同时做两版（AI 版本各走各的方向），都做完后看图挑一版，下游拿到挑中的那版', async () => {
    const task = await start([art, work('post')], [['art', 'post']]);
    let now = await latest(task);
    const versions = childrenOf(now, 'art');
    expect(versions.map((v) => v.key)).toEqual(['art-v1', 'art-v2']);
    const [v1, v2] = versions.map((v) => runOf(v.key, now));
    expect(v1!.prompt).toContain('第 1 版（共 2 版）');
    await finish(v1!.runId, 'succeeded', png('a.png'));
    await finish(v2!.runId, 'succeeded', png('a.png'));
    now = await latest(now);
    const pick = runOf('art', now) as unknown as Run & WithInputs & { model: string };
    expect(pick.model).toBe('oasis/tool');
    // 先各缩成小 JPEG 再看：原图两版加起来可能超过看图工具 20 MiB 的上限
    expect(pick.steps).toMatchObject([
      {
        tool: 'op.media.convert',
        args: { in: 'in/v1/a.png', width: '1024' },
        out: 'out/preview-v1.jpg',
      },
      {
        tool: 'op.media.convert',
        args: { in: 'in/v2/a.png', width: '1024' },
        out: 'out/preview-v2.jpg',
      },
      {
        tool: 'image.inspect',
        args: { images: ['out/preview-v1.jpg', 'out/preview-v2.jpg'] },
        out: 'out/pick.txt',
      },
    ]);
    expect(pick.inputsFrom.map((r) => r.as)).toEqual(['v1', 'v2']);
    plans.set(pick.runId, '{"choice": 2, "reason": "第 2 版人物在画面中央，光线和描述的黄昏一致"}');
    await finish(pick.runId, 'succeeded', { outputs: [{ path: 'pick.txt', size: 40 }] });
    now = await latest(now);
    const chosen = now.nodes.find((n) => n.key === 'art')!;
    expect(chosen).toMatchObject({ status: 'succeeded', variants: { chosen: 2 } });
    expect(chosen.variants?.reason).toContain('黄昏');
    expect(runOf('post', now).inputsFrom).toEqual([{ runId: v2!.runId, as: 'art' }]);
  });

  it('理由说不出具体差别：先用第 1 版并留提醒；只有一版做成就直接用它，不打扰用户', async () => {
    const task = await start([art, work('post')], [['art', 'post']]);
    let now = await latest(task);
    const [v1, v2] = childrenOf(now, 'art').map((v) => runOf(v.key, now));
    await finish(v1!.runId, 'succeeded', png('a.png'));
    await finish(v2!.runId, 'succeeded', png('a.png'));
    now = await latest(now);
    const pick = runOf('art', now);
    plans.set(pick.runId, '{"choice": 2, "reason": "更好"}');
    await finish(pick.runId, 'succeeded');
    now = await latest(now);
    expect(now.nodes.find((n) => n.key === 'art')).toMatchObject({
      variants: { chosen: 1 },
      warning: expect.stringContaining('理由太笼统'),
    });

    const again = await start([art, work('post')], [['art', 'post']]);
    let later = await latest(again);
    const [w1, w2] = childrenOf(later, 'art').map((v) => runOf(v.key, later));
    await finish(w1!.runId, 'failed');
    later = await latest(later);
    expect(later.status).toBe('running');
    await finish(w2!.runId, 'succeeded', png('a.png'));
    later = await latest(later);
    expect(later.nodes.find((n) => n.key === 'art')).toMatchObject({
      status: 'succeeded',
      variants: { chosen: 2, reason: '只有第 2 版做成了' },
    });
    expect(runsOf('art', later)).toHaveLength(0);
  });

  it('改用另一版：下游做完了就排成修改等确认，确认后下游拿新的那版重做', async () => {
    const task = await start([art, work('post')], [['art', 'post']]);
    let now = await latest(task);
    const [v1, v2] = childrenOf(now, 'art').map((v) => runOf(v.key, now));
    await finish(v1!.runId, 'succeeded', png('a.png'));
    await finish(v2!.runId, 'succeeded', png('a.png'));
    now = await latest(now);
    const pick = runOf('art', now);
    plans.set(pick.runId, '{"choice": 2, "reason": "第 2 版人物在画面中央，光线也更自然"}');
    await finish(pick.runId, 'succeeded');
    now = await latest(now);
    await finish(runOf('post', now).runId, 'succeeded', png('post.md'));
    expect((await latest(now)).status).toBe('succeeded');

    now = await service.pickVersion(OWNER, task.id, keyOf(now, 'art'), 1);
    expect(now).toMatchObject({
      status: 'needs_attention',
      attention: { reason: 'revision_plan' },
      revision: { stage: 'confirm' },
    });
    expect(now.revision?.changes).toEqual([
      { key: 'art', title: 'art', change: 'reuse' },
      { key: 'post', title: 'post', change: 'fresh' },
    ]);
    now = await service.decide(OWNER, task.id, { choice: 'continue' });
    expect(now.nodes.find((n) => n.key === 'art')?.variants?.chosen).toBe(1);
    expect(runOf('post', now).inputsFrom[0]).toEqual({ runId: v1!.runId, as: 'art' });
  });
});

describe('挑选也占名额', () => {
  it('看图挑选算在工具子节点的池里：池满时等名额，优先于还没开始的版本', async () => {
    const task = await start(
      [
        work('list'),
        frames('keys', { variants: { n: 2, pick: '构图' } }, 4),
        film('keys', 'frame.png'),
      ],
      [
        ['list', 'keys'],
        ['keys', 'film'],
      ],
    );
    await listDone(
      task,
      [1, 2, 3, 4].map((i) => ({ prompt: `镜头${i}` })),
    );
    let now = await latest(task);
    const versions = () => childrenOf(now, 'keys').flatMap((item) => childrenOf(now, item.key));
    expect(versions().filter((v) => v.status === 'running')).toHaveLength(6);
    for (const key of ['keys-01-v1', 'keys-01-v2'])
      await finish(runOf(key, now).runId, 'succeeded', png());
    now = await latest(now);
    // 第 1 条开了挑选（占一个名额），第 4 条的第 2 版还在等
    expect(runsOf('keys-01', now)).toHaveLength(1);
    expect(versions().find((v) => v.key === 'keys-04-v2')?.status).toBe('waiting');
    await finish(runOf('keys-02-v1', now).runId, 'succeeded', png());
    now = await latest(now);
    expect(versions().find((v) => v.key === 'keys-04-v2')?.status).toBe('running');
  });
});

describe('展开里每条做几版，改用某一条的另一版', () => {
  it('只重做用到这一条的下游条目和后面的节点', async () => {
    const keyframes = frames('keys', { variants: { n: 2, pick: '构图贴近描述' } }, 2);
    const clips = frames(
      'clips',
      {
        steps: [
          {
            tool: 'image.generate',
            args: { prompt: '{{item.prompt}}', ref: 'in/keys/{{index}}/frame.png' },
            out: 'out/clip.png',
          },
        ],
      },
      2,
    );
    const task = await start(
      [work('list'), keyframes, clips, film('clips', 'clip.png')],
      [
        ['list', 'keys'],
        ['list', 'clips'],
        ['keys', 'clips'],
        ['clips', 'film'],
      ],
    );
    await listDone(task, [{ prompt: '日出' }, { prompt: '日落' }]);
    let now = await latest(task);
    const items = childrenOf(now, 'keys');
    expect(items.map((i) => i.key)).toEqual(['keys-01', 'keys-02']);
    // 每条两版，四个工具子节点一起跑
    const versions = items.flatMap((i) => childrenOf(now, i.key));
    expect(versions.map((v) => [v.key, v.status])).toEqual([
      ['keys-01-v1', 'running'],
      ['keys-01-v2', 'running'],
      ['keys-02-v1', 'running'],
      ['keys-02-v2', 'running'],
    ]);
    const versionRuns = versions.map((v) => runOf(v.key, now));
    for (const r of versionRuns) await finish(r.runId, 'succeeded', png());
    now = await latest(now);
    for (const item of items) {
      const pick = runOf(item.key, now);
      plans.set(pick.runId, '{"choice": 1, "reason": "第 1 版的构图更贴近描述，地平线也更平"}');
      await finish(pick.runId, 'succeeded');
    }
    now = await latest(now);
    const clipRuns = childrenOf(now, 'clips').map(
      (c) => runOf(c.key, now) as unknown as Run & WithInputs,
    );
    // 每个镜头只拿到自己那一条的关键帧
    expect(clipRuns.map((r) => r.inputsFrom)).toEqual([
      [{ runId: versionRuns[0]!.runId, as: 'keys/01' }],
      [{ runId: versionRuns[2]!.runId, as: 'keys/02' }],
    ]);
    for (const r of clipRuns) await finish(r.runId, 'succeeded', png('clip.png'));
    now = await latest(now);
    await finish(runOf('film', now).runId, 'succeeded', png('film.mp4'));
    expect((await latest(now)).status).toBe('succeeded');

    const before = submitted.length;
    now = await service.pickVersion(OWNER, task.id, keyOf(now, 'keys-01'), 2);
    expect(now.revision?.changes.map((c) => [c.key, c.change])).toEqual([
      ['list', 'reuse'],
      ['keys', 'reuse'],
      ['clips', 'fresh'],
      ['film', 'fresh'],
    ]);
    now = await service.decide(OWNER, task.id, { choice: 'continue' });
    // 只重做第 1 个镜头：第 2 个镜头的关键帧没变，沿用
    const redone = submitted.slice(before) as unknown as (Run & WithInputs)[];
    expect(redone).toHaveLength(1);
    expect(redone[0]!.inputsFrom).toEqual([{ runId: versionRuns[1]!.runId, as: 'keys/01' }]);
    expect(childrenOf(now, 'clips').map((c) => [c.key, c.status])).toEqual([
      ['clips-01', 'running'],
      ['clips-02', 'succeeded'],
    ]);
    await finish(redone[0]!.runId, 'succeeded', png('clip.png'));
    now = await latest(now);
    // 成片重新做：两个镜头 + 上一版的成片（in/_previous/）
    expect(runOf('film', now).inputsFrom.map((r) => r.as)).toEqual([
      'clips/01',
      'clips/02',
      '_previous',
    ]);
  });
});
