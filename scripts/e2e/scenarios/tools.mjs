// 回归场景（docs/engineering/回归测试.md）：工具节点（ADR 0025）。
import { literal, query } from '../db.mjs';
import { marker } from '../fake-provider.mjs';
import { done, sha256 } from './shared.mjs';

// ---------- 12. 工具节点：不用 AI，按步骤生成两段视频、再在沙箱里拼成片（ADR 0025） ----------
const SHOTS = ['工具节点镜头一：秋叶', '工具节点镜头二：树梢'];
const STEPS = [
  { tool: 'video.generate', args: { prompt: SHOTS[0], duration: 5 }, out: 'out/镜头/1.mp4' },
  { tool: 'video.generate', args: { prompt: SHOTS[1], duration: 5 }, out: 'out/镜头/2.mp4' },
  {
    tool: 'op.video.concat',
    args: { in: ['out/镜头/1.mp4', 'out/镜头/2.mp4'] },
    out: 'out/成片.mp4',
  },
];
export const toolnode = {
  title: '两段拼成片',
  deliverables: [{ name: '成片', form: 'MP4' }],
  criteria: ['两段镜头拼成一段能播放的成片'],
  quoteTools: [{ key: 'video.generate', uses: { economy: 10, standard: 10, premium: 10 } }],
  get request() {
    return `生成两段 5 秒镜头，再拼成成片 ${marker('toolnode')}`;
  },
  plan: () => ({
    nodes: [
      {
        key: 'cut',
        title: '出片',
        kind: 'tool',
        role: '',
        goal: `${marker('toolnode', 'cut')} 生成两段镜头，拼成 out/成片.mp4`,
        steps: STEPS,
        checks: [],
        expects: ['成片.mp4'],
        deliver: ['成片.mp4'],
      },
    ],
    edges: [],
    deliverables: { 成片: 'cut' },
  }),
  nodes: {},
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '成片交付');
    const node = task.nodes[0];
    t.check(
      node?.kind === 'tool' && node.steps?.length === 3,
      `应是 3 步的工具节点：${node?.kind}`,
    );
    t.check(!node?.warning, `工具节点不应有提醒：${node?.warning}`);
    // 估价按目录：两段 × 5 秒 × 每秒 $0.05，加一次算力
    t.check(task.estimateMicro >= 500_000, `估价应含两段视频的钱：${task.estimateMicro}`);
    // 不起 AI：这个节点没有任何模型调用；视频提交了两次
    const asked = t.provider.calls.filter((c) => c.scenario === 'toolnode' && c.kind === 'node');
    t.check(asked.length === 0, `工具节点不应调用模型（调用了 ${asked.length} 次）`);
    // 别的场景可能同时在生视频：按提示词认
    const submitted = t.provider.calls.filter(
      (c) => c.kind === 'video.submit' && SHOTS.includes(c.prompt),
    );
    t.check(submitted.length === 2, `应提交两段视频（提交了 ${submitted.length} 次）`);
    // harness 里这次是工具运行
    const runs = query(
      'harness',
      `select model, status from runs where task_id = ${literal(taskId)} and node_id is not null`,
    );
    t.check(
      runs.length === 1 && runs[0].model === 'oasis/tool' && runs[0].status === 'succeeded',
      `节点应有一次成功的工具运行：${JSON.stringify(runs)}`,
    );
    // 过程：三步各一条命令，拼接由 oasis-op 做
    const { events } = await t.user.api.get(
      `/task/v1/tasks/${taskId}/nodes/${node.id}/events?after=-1`,
    );
    const commands = events
      .filter((e) => e.kind === 'tool_call')
      .map((e) => JSON.parse(e.data.arguments).command);
    t.check(
      commands.length === 3 && commands[2].startsWith('oasis-op video.concat'),
      `过程里应有三步命令、最后一步是 oasis-op：${commands.join(' | ')}`,
    );
    // 关卡照常做解码检查（inspector），算力结算在任务上
    const decoded = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'compute' and model = 'media-check'`,
    );
    t.check(
      decoded.length > 0 && decoded.every((c) => c.status === 'succeeded'),
      `成片的解码检查应结算在任务上（${decoded.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['成片.mp4']);
    const film = artifacts.find((a) => a.path === '成片.mp4');
    t.check(film, '画布里没有成片');
    // 镜头和进度文件只在节点之间传，不交付
    t.check(
      !artifacts.some((a) => a.path.startsWith('.oasis-steps') || a.path.startsWith('镜头/')),
      `只交付成片：${artifacts.map((a) => a.path).join('、')}`,
    );
    if (film) {
      const bytes = await t.user.content(film.id);
      t.check(
        bytes.length > 0 && sha256(bytes) !== sha256(t.fixtures.mp4),
        '成片应是拼接后重新编码的，不是供应商给的原片',
      );
    }
  },
};
