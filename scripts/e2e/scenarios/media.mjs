// 回归场景（docs/engineering/回归测试.md）：图文和视频：长任务工具、媒体检查。
import { literal, query } from '../db.mjs';
import { marker } from '../fake-provider.mjs';
import { DEFAULT_MODEL, done, sha256, work } from './shared.mjs';

// ---------- 2. 图文交付：生图工具 → 下游节点用上游的图写 DOCX ----------
export const media = {
  title: '活动海报和说明',
  deliverables: [
    { name: '活动海报', form: 'PNG' },
    { name: '说明文档', form: 'DOCX' },
  ],
  criteria: ['海报和说明文档都交付', '说明文档里插着海报'],
  quoteTools: [{ key: 'image.generate', uses: { economy: 1, standard: 1, premium: 2 } }],
  get request() {
    return `做一张活动海报（PNG）和一份插着海报的说明文档（DOCX）${marker('media')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('media', 'poster', '画海报', '用 image.generate 生成海报，交出 out/海报.png', {
        model: pick(DEFAULT_MODEL),
        tools: [{ key: 'image.generate', uses: 1 }],
        expects: ['海报.png'],
        deliver: ['海报.png'],
      }),
      work('media', 'doc', '写说明', '用 in/poster/海报.png 写说明文档，交出 out/说明.docx', {
        model: pick(DEFAULT_MODEL),
        expects: ['说明.docx'],
        deliver: ['说明.docx'],
      }),
    ],
    edges: [{ from: 'poster', to: 'doc' }],
    deliverables: { 活动海报: 'poster', 说明文档: 'doc' },
  }),
  nodes: {
    poster: {
      work: [
        {
          bash: 'oasis-tool image.generate --prompt "秋季活动海报，暖色渐变" --out out/海报.png && ls out',
          description: '生成海报',
        },
      ],
    },
    doc: {
      work: [
        {
          bash: [
            'test -f in/poster/海报.png',
            `python3 -c "from docx import Document; from docx.shared import Inches; d = Document(); d.add_heading('活动海报说明', 1); d.add_paragraph('海报由上游节点生成。'); d.add_picture('in/poster/海报.png', width=Inches(2)); d.save('out/说明.docx')"`,
          ].join(' && '),
          description: '写说明文档',
        },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    await t.user.waitTask(taskId, done, '图文交付');
    const images = t.provider.calls.filter((c) => c.kind === 'image');
    t.check(images.length >= 1, '生图工具没有调到供应商');
    const artifacts = await t.user.waitArtifacts(taskId, ['海报.png', '说明.docx']);
    const poster = artifacts.find((a) => a.path === '海报.png');
    const doc = artifacts.find((a) => a.path === '说明.docx');
    t.check(poster, '画布里没有海报');
    t.check(doc, '画布里没有说明文档');
    if (poster)
      t.check(
        sha256(await t.user.content(poster.id)) === sha256(t.fixtures.png),
        '画布里的海报和供应商给的图不一致',
      );
    if (doc) {
      const bytes = await t.user.content(doc.id);
      t.check(bytes.includes(Buffer.from('word/media/')), '说明文档里没有插图');
    }
  },
};

// ---------- 5. 长任务工具：生视频要等十几秒，交出能完整解码的 MP4 ----------
const WAIT = /oasis-tool wait (\S+)/;
export const video = {
  title: '落叶短片',
  deliverables: [{ name: '短片', form: 'MP4' }],
  criteria: ['交出能播放的短片'],
  quoteTools: [{ key: 'video.generate', uses: { economy: 5, standard: 5, premium: 10 } }],
  get request() {
    return `生成一段 5 秒的落叶短片 ${marker('video')}`;
  },
  plan: ({ pick }) => ({
    nodes: [
      work('video', 'clip', '生成短片', '用 video.generate 生成 5 秒短片，交出 out/片段.mp4', {
        model: pick(DEFAULT_MODEL),
        tools: [{ key: 'video.generate', uses: 5 }],
        expects: ['片段.mp4'],
        deliver: ['片段.mp4'],
      }),
    ],
    edges: [],
    deliverables: { 短片: 'clip' },
  }),
  nodes: {
    clip: {
      work: [
        {
          bash: 'mkdir -p out && oasis-tool video.generate --prompt "落叶飘下" --duration 5 --out out/片段.mp4; ls out',
          description: '生成视频',
        },
        // 工具没等到就会提示 oasis-tool wait <任务号>：照着等
        ({ last }) =>
          WAIT.test(last ?? '')
            ? { bash: `oasis-tool wait ${WAIT.exec(last)[1]} && ls out`, description: '等视频' }
            : { bash: 'ls -la out', description: '看一眼' },
      ],
    },
  },
  async run(t) {
    const { taskId } = await t.user.createTask(this.request);
    t.track(taskId);
    const task = await t.user.waitTask(taskId, done, '短片交付');
    t.check(!task.nodes[0].warning, `短片节点不应有提醒：${task.nodes[0].warning}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.submit'),
      '没有向供应商提交视频任务',
    );
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.content'),
      '没有下载生成好的视频',
    );
    // 关卡的解码检查在 inspector 的检查容器里做，算力按实际用时结算在这个任务上（ADR 0024）
    const decoded = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'compute' and model = 'media-check'`,
    );
    t.check(
      decoded.length > 0 && decoded.every((c) => c.status === 'succeeded'),
      `解码检查的算力应结算在任务上（${decoded.map((c) => c.status).join('、') || '没有记录'}）`,
    );
    const artifacts = await t.user.waitArtifacts(taskId, ['片段.mp4']);
    const clip = artifacts.find((a) => a.path === '片段.mp4');
    t.check(clip, '画布里没有短片');
    if (clip)
      t.check(
        sha256(await t.user.content(clip.id)) === sha256(t.fixtures.mp4),
        '画布里的短片和供应商给的不一致',
      );
  },
};
