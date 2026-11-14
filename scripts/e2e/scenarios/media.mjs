// 回归场景（docs/engineering/回归测试.md）：图文和视频：生图工具（几个画面一次交、同时生成）、
// 长任务工具（几段视频先都交上再一起等）、任务卡、进度页用的步骤（工具名、起止时间、存下的文件）。
import { IMAGE_MS } from '../fake-provider.mjs';
import { aiOf, cardOf, runsOf, sha256, start } from './shared.mjs';

/** 这一轮做的步骤 */
const stepsOf = (messages, runId) =>
  aiOf(messages, runId)
    .flatMap((m) => m.data.parts ?? [])
    .filter((p) => p.type === 'step');

/** 这一步带着起止时间和这些文件 */
const timedWith = (step, files) =>
  step?.status === 'done' &&
  !!step.startedAt &&
  !!step.finishedAt &&
  Date.parse(step.finishedAt) >= Date.parse(step.startedAt) &&
  files.every((file) => step.files?.includes(file));

// ---------- 12. 图文：两个画面一次交（同时生成），再写一份插着海报的 DOCX；用了生图的一轮出任务卡 ----------
const PROMPTS = ['秋季活动海报，暖色渐变', '秋季活动横幅，暖色'];
export const media = {
  says: {
    1: {
      steps: [
        {
          bash: `mkdir -p out && oasis-tool image.generate --prompts '${JSON.stringify(PROMPTS)}' --out out/海报.png && ls out`,
          description: '生成海报和横幅',
        },
        {
          bash: `python3 -c "from docx import Document; from docx.shared import Inches; d = Document(); d.add_heading('活动海报说明', 1); d.add_paragraph('海报是刚生成的。'); d.add_picture('out/海报-1.png', width=Inches(2)); d.save('out/说明.docx')"`,
          description: '写说明文档',
        },
      ],
      reply: '海报、横幅和说明文档做好了。',
    },
  },
  async run(t) {
    const id = await start(
      t,
      'media',
      '做一张活动海报、一张横幅（PNG）和一份插着海报的说明文档（DOCX）',
    );
    const messages = await t.user.waitTurn(id, '图文交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    const shots = t.provider.calls.filter((c) => c.kind === 'image' && PROMPTS.includes(c.prompt));
    t.check(shots.length === 2, `两个画面应各调一次供应商：${shots.length} 次`);
    // 每张要做 IMAGE_MS：一张张调的话，第二张要等第一张做完才到
    if (shots.length === 2)
      t.check(
        Math.abs(shots[0].at - shots[1].at) < IMAGE_MS / 2,
        `两张图应同时生成：先后差了 ${Math.abs(shots[0].at - shots[1].at)} 毫秒`,
      );
    const artifacts = await t.user.waitArtifacts(id, ['海报-1.png', '海报-2.png', '说明.docx']);
    const poster = artifacts.find((a) => a.path === '海报-1.png');
    const doc = artifacts.find((a) => a.path === '说明.docx');
    t.check(poster && artifacts.some((a) => a.path === '海报-2.png'), '画布里没有海报和横幅');
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
        ['海报-1.png', '海报-2.png', '说明.docx'].every((p) =>
          card.data.files.some((f) => f.path === p),
        ),
      `任务卡上应列着海报、横幅和说明文档：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
    // 进度页：生图那一步带着工具名、起止时间和存下的两张图；这一轮做出的图读得到
    const shot = stepsOf(messages, run?.id).find((s) => s.oasisTool === 'image.generate');
    t.check(
      timedWith(shot, ['out/海报-1.png', 'out/海报-2.png']),
      `生图那一步应带着起止时间和两张图：${JSON.stringify(shot ?? null).slice(0, 300)}`,
    );
    if (run) {
      const file = await t.user.api.get(
        `/conversation/v1/conversations/${id}/runs/${run.id}/files/out/${encodeURIComponent('海报-2.png')}`,
        { raw: true },
      );
      t.check(
        sha256(Buffer.from(await file.arrayBuffer())) === sha256(t.fixtures.png),
        '进度页读到的横幅和供应商给的不一致',
      );
    }
  },
};

// ---------- 13. 长任务工具：两段视频都先交上（不等），再一起等；等到了交出能播放的 MP4 ----------
const JOB = /任务号 ([0-9a-f-]{36})/g;
const CLIPS = ['落叶飘下', '枫叶特写'];
export const video = {
  says: {
    1: {
      steps: [
        {
          bash: `mkdir -p out && oasis-tool video.generate --prompt "${CLIPS[0]}" --duration 5 --out out/片段一.mp4 --wait false && oasis-tool video.generate --prompt "${CLIPS[1]}" --duration 5 --out out/片段二.mp4 --wait false`,
          description: '交两段视频',
        },
        // 交的时候给了任务号：一起等
        ({ last }) => {
          const ids = [...new Set([...(last ?? '').matchAll(JOB)].map((m) => m[1]))];
          return ids.length
            ? { bash: `oasis-tool wait ${ids.join(' ')} && ls out`, description: '一起等' }
            : { bash: 'ls -la out', description: '看一眼' };
        },
      ],
      reply: '两段短片做好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'video', '生成两段 5 秒的短片：落叶飘下、枫叶特写');
    const messages = await t.user.waitTurn(id, '短片交付');
    const [run] = runsOf(id);
    t.check(run?.status === 'succeeded', `这一轮应成功：${run?.status} ${run?.error ?? ''}`);
    const submits = t.provider.calls.filter(
      (c) => c.kind === 'video.submit' && CLIPS.includes(c.prompt),
    );
    t.check(submits.length === 2, `两段视频应各提交一次：${submits.length} 次`);
    const ids = new Set(submits.map((c) => c.id));
    const downloads = t.provider.calls.filter((c) => c.kind === 'video.content' && ids.has(c.id));
    t.check(downloads.length === 2, `两段视频都应下载：${downloads.length} 次`);
    // 第二段在第一段做好之前就交上了：两段同时做
    if (submits.length === 2 && downloads.length)
      t.check(
        submits[1].at < Math.min(...downloads.map((c) => c.at)),
        '两段视频应先都交上再一起等',
      );
    const artifacts = await t.user.waitArtifacts(id, ['片段一.mp4', '片段二.mp4']);
    for (const path of ['片段一.mp4', '片段二.mp4']) {
      const clip = artifacts.find((a) => a.path === path);
      t.check(clip, `画布里没有${path}`);
      if (clip)
        t.check(
          sha256(await t.user.content(clip.id)) === sha256(t.fixtures.mp4),
          `画布里的${path}和供应商给的不一致`,
        );
    }
    const card = cardOf(messages, run?.id);
    t.check(
      card?.data.status === 'done' &&
        ['片段一.mp4', '片段二.mp4'].every((p) => card.data.files.some((f) => f.path === p)),
      `任务卡上应列着两段短片：${JSON.stringify(card?.data ?? null).slice(0, 300)}`,
    );
    // 进度页：交的那一步带着两个交上去没等的任务号；一起等的那一步带着起止时间和存下的两段，
    // 并按任务号写回各自做好了、存下了哪段（进度页据此一段一张卡）
    const steps = stepsOf(messages, run?.id);
    const handed = steps
      .filter((s) => s.oasisTool === 'video.generate')
      .flatMap((s) => (s.jobs ?? []).filter((j) => j.state === 'submitted').map((j) => j.id));
    const waited = steps.find((s) => s.oasisTool === 'wait');
    t.check(handed.length === 2, `交的那一步应带着两个任务号：${JSON.stringify(handed)}`);
    t.check(
      timedWith(waited, ['out/片段一.mp4', 'out/片段二.mp4']) &&
        handed.every((id) =>
          waited.jobs?.some((j) => j.id === id && j.state === 'done' && j.files?.length === 1),
        ),
      `一起等的那一步应带着起止时间、两段短片和按任务号的结局：${JSON.stringify(waited ?? null).slice(0, 400)}`,
    );
  },
};
