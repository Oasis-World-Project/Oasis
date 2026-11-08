// 真模型回归 real-shots（ADR 0026）：6 个镜头的短片——真规划员排「分镜 → 展开出关键帧（每帧两版挑一版）
// → 展开图生视频 → 拼成片」，真生图、真看图挑选、真视频。按秒、按张收钱：开跑前看一眼方案，没照要求用
// 便宜型号、没用展开就当场取消。预算 $4.5，在单次 $5 的授权内。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { literal, query } from './db.mjs';

/** 关键帧用的生图型号：目录里便宜的那档 */
const CHEAP_IMAGE = 'bytedance-seed/seedream-4.5';
const SHOTS = 6;
const usd = (micro) => `$${(Number(micro) / 1_000_000).toFixed(4)}`;
const done = (task) => task.status === 'succeeded';

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

/** 方案里的生图、生视频步骤合不合要求（模板参数等展开时才知道，先放过） */
function costProblems(steps, video) {
  const problems = [];
  for (const step of steps) {
    const a = step.args ?? {};
    if (step.tool === 'video.generate') {
      if (a.model !== video) problems.push(`视频型号 ${a.model ?? '（默认）'}`);
      if (![undefined, '480p'].includes(a.resolution)) problems.push(`清晰度 ${a.resolution}`);
      const seconds = Number(a.duration ?? 5);
      if (!String(a.duration ?? '').includes('{{') && seconds > 6) problems.push(`${seconds} 秒`);
    }
    if (step.tool === 'image.generate' && a.model !== CHEAP_IMAGE)
      problems.push(`生图型号 ${a.model ?? '（默认）'}`);
  }
  return problems;
}

/** helpers：real.mjs 里的 waitFiles、logBill、便宜视频型号、长任务等待时长 */
export const realShots = ({ waitFiles, logBill, CHEAP_VIDEO, LONG }) => ({
  // 6 张 × 2 版生图 + 6 段 4 秒 480p 视频约 $1.7，再加规划、分镜、看图和检查；超了当场取消
  budgetMicro: 4_500_000,
  async run(t) {
    const { taskId } = await t.user.createTask(
      `做一段 ${SHOTS} 个镜头的短片，主题：一只橘猫在秋天小镇里的一天。` +
        `先写 ${SHOTS} 个镜头的分镜（写成 JSON 清单，每个镜头一项，含画面描述）；` +
        '每个镜头先生成一张关键帧（同时做 2 版，看图挑更贴合描述的那版）；' +
        '再用挑中的关键帧做首帧，生成一段 4 秒的视频；最后按镜头顺序拼成「成片.mp4」，只交付这一个文件。' +
        `为了控制成本：关键帧用 ${CHEAP_IMAGE}，视频用 ${CHEAP_VIDEO}、480p、16:9、每段 4 秒。`,
    );
    t.track(taskId);
    const planned = await t.user.waitTask(taskId, (x) => x.status !== 'planning', '方案排好', LONG);
    const configs = query(
      'task',
      `select key, kind, config from nodes where task_id = ${literal(taskId)} and parent_id is null`,
    );
    const foreach = configs.filter((n) => n.kind === 'foreach');
    const steps = configs.flatMap((n) =>
      n.kind === 'foreach' ? (n.config.each?.steps ?? []) : (n.config.steps ?? []),
    );
    const twoUp = foreach.some((n) => (n.config.each?.variants?.n ?? 0) >= 2);
    t.log(
      `方案：${planned.nodes
        .filter((n) => !n.parentId)
        .map((n) => `${n.title}（${n.kind}）`)
        .join(' → ')}，估价 ${usd(planned.estimateMicro ?? 0)}`,
    );
    const problems = [
      ...(foreach.length ? [] : ['没有用展开节点']),
      ...(twoUp ? [] : ['关键帧没有做两版挑一版']),
      ...(foreach.some((n) => n.config.count > 8) ? ['预计条数太多'] : []),
      ...costProblems(steps, CHEAP_VIDEO),
    ];
    if (problems.length) {
      await t.user.api.post(`/task/v1/tasks/${taskId}/cancel`).catch(() => {});
      t.check(false, `方案不合要求，已取消：${problems.join('；')}`);
      return;
    }

    const task = await t.user.waitTask(taskId, done, '成片交付', 2 * LONG);
    for (const node of task.nodes.filter((n) => n.warning))
      t.log(`「${node.title}」带着提醒：${node.warning.slice(0, 200)}`);
    const kids = (node) => task.nodes.filter((n) => n.parentId === node.id);
    for (const node of task.nodes.filter((n) => n.kind === 'foreach')) {
      const items = kids(node);
      t.log(`展开「${node.title}」：${items.length} 条`);
      t.check(
        items.length >= 4 && items.length <= 8,
        `「${node.title}」应展开约 ${SHOTS} 条：${items.length}`,
      );
      for (const item of items.filter((i) => i.variants))
        t.log(`  ${item.key} 用第 ${item.variants.chosen} 版：${item.variants.reason ?? ''}`);
      const picked = items.filter((i) => i.variants);
      if (picked.length)
        t.check(
          picked.every((i) => i.variants.chosen !== null),
          `每条关键帧都应挑好一版：${picked.map((i) => `${i.key}=${i.variants.chosen}`).join(' ')}`,
        );
    }
    const videos = query(
      'model_gateway',
      `select status from calls where task_id = ${literal(taskId)} and kind = 'tool' and model = ${literal(CHEAP_VIDEO)}`,
    );
    t.log(`视频调用：${videos.map((v) => v.status).join('、')}`);
    t.check(
      videos.filter((v) => v.status === 'succeeded').length >= 4,
      `应真生成约 ${SHOTS} 段视频`,
    );
    // 按 harness 收到到结束算（task 的运行记录里同一事务开出的新运行时间会早几毫秒）
    const toolRuns = query(
      'harness',
      `select created_at, finished_at from runs where task_id = ${literal(taskId)} and model = 'oasis/tool'`,
    );
    const most = maxOverlap(toolRuns);
    t.log(`工具运行 ${toolRuns.length} 次，同时最多 ${most} 个`);
    t.check(most <= 6, `工具子节点同时跑了 ${most} 个，最多 6 个`);
    const list = await waitFiles(t, taskId, (files) => files.some((a) => a.path.endsWith('.mp4')));
    const film =
      list.find((a) => a.path.includes('成片')) ?? list.find((a) => a.path.endsWith('.mp4'));
    t.check(film, `画布里没有成片（有：${list.map((a) => a.path).join('、') || '无'}）`);
    if (film) {
      const bytes = await t.user.content(film.id);
      t.check(bytes.subarray(4, 8).toString() === 'ftyp', `${film.path} 不是 MP4`);
      t.check(bytes.length > 100_000, `${film.path} 只有 ${bytes.length} 字节，不像 24 秒的视频`);
      writeFileSync(path.join(t.outDir, 'real-shots-成片.mp4'), bytes);
      t.log(`成片 ${film.path}：${(bytes.length / 1024).toFixed(0)} KB，已存到回归目录`);
    }
    t.log(`任务花费 ${usd(task.spentMicro)}（估价 ${usd(task.estimateMicro ?? 0)}）`);
    logBill(t);
  },
});
