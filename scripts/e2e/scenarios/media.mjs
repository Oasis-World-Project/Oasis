// 回归场景（docs/engineering/回归测试.md）：图文和视频：生图工具、长任务工具（生视频要等）、任务卡。
import { cardOf, runsOf, sha256, start } from './shared.mjs';

// ---------- 12. 图文：生图工具出海报，再写一份插着海报的 DOCX；用了生图的一轮出任务卡 ----------
export const media = {
  says: {
    1: {
      steps: [
        {
          bash: 'mkdir -p out && oasis-tool image.generate --prompt "秋季活动海报，暖色渐变" --out out/海报.png && ls out',
          description: '生成海报',
        },
        {
          bash: `python3 -c "from docx import Document; from docx.shared import Inches; d = Document(); d.add_heading('活动海报说明', 1); d.add_paragraph('海报是刚生成的。'); d.add_picture('out/海报.png', width=Inches(2)); d.save('out/说明.docx')"`,
          description: '写说明文档',
        },
      ],
      reply: '海报和说明文档做好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'media', '做一张活动海报（PNG）和一份插着海报的说明文档（DOCX）');
    const messages = await t.user.waitTurn(id, '图文交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'image'),
      '生图工具没有调到供应商',
    );
    const artifacts = await t.user.waitArtifacts(id, ['海报.png', '说明.docx']);
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
    const card = cardOf(messages, run?.id);
    t.check(
      card?.data.status === 'done' &&
        ['海报.png', '说明.docx'].every((p) => card.data.files.some((f) => f.path === p)),
      `任务卡上应列着海报和说明文档：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
  },
};

// ---------- 13. 长任务工具：生视频要等十几秒，等到了交出能播放的 MP4 ----------
const WAIT = /oasis-tool wait (\S+)/;
export const video = {
  says: {
    1: {
      steps: [
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
      reply: '短片做好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'video', '生成一段 5 秒的落叶短片');
    const messages = await t.user.waitTurn(id, '短片交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.submit'),
      '没有向供应商提交视频任务',
    );
    t.check(
      t.provider.calls.some((c) => c.kind === 'video.content'),
      '没有下载生成好的视频',
    );
    const artifacts = await t.user.waitArtifacts(id, ['片段.mp4']);
    const clip = artifacts.find((a) => a.path === '片段.mp4');
    t.check(clip, '画布里没有短片');
    if (clip)
      t.check(
        sha256(await t.user.content(clip.id)) === sha256(t.fixtures.mp4),
        '画布里的短片和供应商给的不一致',
      );
    const card = cardOf(messages, run?.id);
    t.check(
      card?.data.status === 'done' && card.data.files.some((f) => f.path === '片段.mp4'),
      `任务卡上应列着短片：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
  },
};
