// 回归场景（docs/engineering/回归测试.md）：动态展开和做几版挑一版（ADR 0026）。
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, work } from './shared.mjs';

// ---------- 13. 按 12 个镜头的分镜出片：分镜 → 每镜关键帧（两版挑一版）→ 每镜图生视频 → 拼成片 ----------
const COUNT = 12;
const SHOTS = Array.from({ length: COUNT }, (_, i) => ({
  prompt: `展开回归镜头${i + 1}：秋日小镇第 ${i + 1} 景`,
  seconds: 4,
}));
const ours = (prompt) => typeof prompt === 'string' && prompt.startsWith('展开回归镜头');
/** 工具子节点（和挑选运行）同时最多几个（用户 2026-11-08 定 6） */
const TOOL_POOL = 6;

/** 同一时刻最多有几个运行开着（开出到结束） */
function maxOverlap(runs) {
  const marks = runs.flatMap((r) => [
    [Date.parse(r.created_at), 1],
    [Date.parse(r.finished_at ?? new Date().toISOString()), -1],
  ]);
  marks.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let open = 0;
  let most = 0;
  for (const [, step] of marks) most = Math.max(most, (open += step));
  return most;
}

const shots12 = {
  title: '十二镜头短片',
  deliverables: [{ name: '成片', form: 'MP4' }],
  criteria: ['按分镜的 12 个镜头拼成一段能播放的成片'],
  quoteTools: [
    { key: 'image.generate', uses: { economy: 24, standard: 24, premium: 24 } },
    { key: 'video.generate', uses: { economy: 48, standard: 48, premium: 48 } },
  ],
  get request() {
    return `按 12 个镜头的分镜做一段短片：每镜先出关键帧（两版挑一版），再图生视频，最后拼成成片 ${marker('shots12')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('shots12', 'storyboard', '写分镜', '写 12 个镜头的分镜，交出 out/shots.json', {
        model: pick(DEFAULT_MODEL),
        expects: ['shots.json'],
      }),
      {
        key: 'keys',
        title: '关键帧',
        kind: 'foreach',
        goal: '每个镜头一张关键帧',
        over: 'in/storyboard/shots.json',
        count: COUNT,
        each: {
          kind: 'tool',
          title: '关键帧 {{index}}',
          goal: '镜头 {{index}} 的关键帧',
          steps: [
            { tool: 'image.generate', args: { prompt: '{{item.prompt}}' }, out: 'out/frame.png' },
          ],
          expects: ['frame.png'],
          variants: { n: 2, pick: '构图最贴合镜头描述' },
        },
      },
      {
        key: 'clips',
        title: '镜头视频',
        kind: 'foreach',
        goal: '每个镜头用关键帧做首帧生成视频',
        over: 'in/storyboard/shots.json',
        count: COUNT,
        each: {
          kind: 'tool',
          title: '镜头 {{index}}',
          goal: '镜头 {{index}} 的视频',
          steps: [
            {
              tool: 'video.generate',
              args: {
                prompt: '{{item.prompt}}',
                first_frame: 'in/keys/{{index}}/frame.png',
                duration: '{{item.seconds}}',
              },
              out: 'out/clip.mp4',
            },
          ],
          expects: ['clip.mp4'],
        },
      },
      {
        key: 'film',
        title: '拼成片',
        kind: 'tool',
        goal: '按镜头顺序拼成成片',
        steps: [
          { tool: 'op.video.concat', args: { in: 'in/clips/*/clip.mp4' }, out: 'out/成片.mp4' },
        ],
        expects: ['成片.mp4'],
        deliver: ['成片.mp4'],
      },
    ],
    edges: [
      { from: 'storyboard', to: 'keys' },
      { from: 'storyboard', to: 'clips' },
      { from: 'keys', to: 'clips' },
      { from: 'clips', to: 'film' },
    ],
    deliverables: { 成片: 'film' },
  }),
  nodes: {
    storyboard: {
      work: [
        { bash: writeFiles({ 'out/shots.json': JSON.stringify(SHOTS) }), description: '写分镜' },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    let task = await t.user.waitTask(taskId, done, '12 镜头成片交付', 900_000);
    const byKey = (key) => task.nodes.find((n) => n.key === key);
    const kids = (key) =>
      task.nodes.filter((n) => n.parentId === byKey(key)?.id).sort((a, b) => a.slot - b.slot);
    // 工作流图上只有 4 个节点；展开出来的条目和各版挂在父节点下
    const roots = task.nodes
      .filter((n) => !n.parentId)
      .map((n) => n.key)
      .sort();
    t.check(
      roots.join(',') === 'clips,film,keys,storyboard',
      `工作流图上的节点不对：${roots.join(',')}`,
    );
    t.check(byKey('keys')?.foreach?.items === COUNT, `关键帧应展开 ${COUNT} 条`);
    const frames = kids('keys');
    t.check(
      frames.length === COUNT &&
        frames.every((f) => f.variants?.chosen === 2 && f.variants.reason?.includes('假视觉模型')),
      `每条关键帧应按看图结果用第 2 版：${frames.map((f) => `${f.key}=${f.variants?.chosen}`).join(' ')}`,
    );
    t.check(
      kids('clips').length === COUNT && kids('clips').every((c) => c.status === 'succeeded'),
      `应有 ${COUNT} 段镜头视频`,
    );
    const calls = () => t.provider.calls.filter((c) => ours(c.prompt));
    const images = calls().filter((c) => c.kind === 'image').length;
    const videos = () => calls().filter((c) => c.kind === 'video.submit').length;
    t.check(images === COUNT * 2, `应生成 ${COUNT * 2} 张关键帧（两版）：${images}`);
    t.check(videos() === COUNT, `应提交 ${COUNT} 段视频：${videos()}`);
    // 工具子节点和看图挑选同时最多 6 个。按 harness 收到到结束算：task 的运行记录里新运行的开出时间是
    // 事务开始的时间，和同一事务里刚结束的那次会差几毫秒，看起来像重叠
    const toolRuns = query(
      'harness',
      `select created_at, finished_at from runs where task_id = ${literal(taskId)} and model = 'oasis/tool'`,
    );
    const most = maxOverlap(toolRuns);
    t.check(most <= TOOL_POOL, `工具子节点同时跑了 ${most} 个，最多 ${TOOL_POOL} 个`);
    t.check(most >= 3, `工具子节点应并发跑（最多同时 ${most} 个）`);
    const artifacts = await t.user.waitArtifacts(taskId, ['成片.mp4']);
    t.check(artifacts.length === 1, `只交付成片：${artifacts.map((a) => a.path).join('、')}`);

    // 改用第 3 条关键帧的第 1 版：成片已经做完，排成修改；确认后只重做第 3 段视频和成片
    const third = frames[2];
    task = await t.user.api.post(`/task/v1/tasks/${taskId}/nodes/${third.id}/pick`, {
      version: 1,
    });
    const change = Object.fromEntries((task.revision?.changes ?? []).map((c) => [c.key, c.change]));
    t.check(
      task.revision?.stage === 'confirm' &&
        change.storyboard === 'reuse' &&
        change.keys === 'reuse' &&
        change.clips === 'fresh' &&
        change.film === 'fresh',
      `改用另一版应排成修改等确认：${JSON.stringify(change)}`,
    );
    const before = { videos: videos(), images: calls().filter((c) => c.kind === 'image').length };
    await t.user.decide(taskId, 'continue');
    task = await t.user.waitTask(
      taskId,
      (x) => done(x) && x.version === 2 && !x.revising,
      '换版本后的成片',
      600_000,
    );
    t.check(
      videos() === before.videos + 1,
      `只应重做第 3 段视频（多提交了 ${videos() - before.videos} 段）`,
    );
    t.check(
      calls().filter((c) => c.kind === 'image').length === before.images,
      '换版本不应重新生成关键帧',
    );
    t.check(kids('keys')[2]?.variants?.chosen === 1, '第 3 条关键帧应改用第 1 版');
    const filmRuns = query(
      'task',
      `select r.status from node_runs r join nodes n on n.id = r.node_id where n.task_id = ${literal(taskId)} and n.key = 'film'`,
    );
    t.check(
      filmRuns.filter((r) => r.status === 'succeeded').length === 2,
      `成片应重新拼过一次：${JSON.stringify(filmRuns)}`,
    );
  },
};

export const groups = { shots12 };
