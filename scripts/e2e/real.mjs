// 真模型回归（pnpm e2e --real，docs/engineering/回归测试.md）：模型和工具都用 .env 里真的密钥，
// 每个场景（含接需求、聊天）花费上限 $1（场景写了 budgetMicro 的按它），超了当场取消任务、判失败。
// 模型每次回答不一样：只断言用户看得到的结果（任务完成、画布里有成果、内容对得上），不断言调用顺序。
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { literal, query } from './db.mjs';
import { realShots } from './real-shots.mjs';
import { PAGE_TEST } from './scenarios.mjs';

export const REAL_BUDGET_MICRO = 1_000_000;
const LONG = 20 * 60_000;
const done = (task) => task.status === 'succeeded';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usd = (micro) => `$${(Number(micro) / 1_000_000).toFixed(4)}`;
/** 工具节点样本用的视频型号：OpenRouter 上 480p 每秒 $0.05，是目录里最便宜的 */
const CHEAP_VIDEO = 'alibaba/wan-3.0';

/** 画布在交付事件之后才登记成果：等到成果列表满足条件（返回最后看到的列表） */
async function waitFiles(t, taskId, test, ms = 120_000) {
  const deadline = Date.now() + ms;
  let list = [];
  while (Date.now() < deadline) {
    list = await t.user.artifacts(taskId);
    if (test(list)) return list;
    await sleep(2_000);
  }
  return list;
}

/** 修改：只改交付了这个文件的节点（没对上就改全部干活节点） */
function nodesOf(task, artifact) {
  const owner = task.nodes.find((n) => n.id === artifact.nodeId);
  return owner ? [owner.id] : task.nodes.filter((n) => n.kind === 'work').map((n) => n.id);
}

export const REAL_SCENARIOS = {
  // 网页：真规划员排方案、真模型写三个文件、浏览器关卡、桌面端画布里点一遍
  'real-web': {
    async run(t) {
      const { taskId } = await t.user.createTask(
        '做一个计数小网页：页面上用 id 为 count 的元素显示次数，初始是 0；再放一个 id 为 inc 的按钮，点一下次数加一。HTML、CSS、JS 分成三个文件。',
      );
      t.track(taskId);
      const task = await t.user.waitTask(taskId, done, '网页交付', LONG);
      for (const node of task.nodes)
        if (node.warning) t.log(`节点「${node.title}」带着提醒交付：${node.warning}`);
      const artifacts = await waitFiles(t, taskId, (list) =>
        list.some((a) => a.application?.kind === 'static'),
      );
      const app = artifacts.find((a) => a.application?.kind === 'static');
      t.check(
        app,
        `画布里没有可运行的网页成果（有：${artifacts.map((a) => a.path).join('、') || '无'}）`,
      );
      if (app) await t.canvas(taskId, app, PAGE_TEST);
    },
  },

  // 文档 + 修改：交付 Markdown 短文 → 提修改 → 确认方案 → 第二版画布里原地更新
  'real-revise': {
    async run(t) {
      const { taskId } = await t.user.createTask(
        '写一篇 300 字以内的 Markdown 短文，标题是「多喝水的好处」，交一个 .md 文件。',
      );
      t.track(taskId);
      let task = await t.user.waitTask(taskId, done, '短文交付', LONG);
      const list = await waitFiles(t, taskId, (files) => files.some((a) => a.path.endsWith('.md')));
      const doc = list.find((a) => a.path.endsWith('.md'));
      t.check(doc, `画布里没有 Markdown 成果（有：${list.map((a) => a.path).join('、') || '无'}）`);
      if (!doc) return;
      const first = (await t.user.content(doc.id)).toString();
      t.check(first.includes('多喝水'), `第一版短文没写到题目上：${first.slice(0, 200)}`);

      await t.user.revise(taskId, {
        request: '把标题改成「每天八杯水」，正文不用动',
        nodeIds: nodesOf(task, doc),
      });
      task = await t.user.waitTask(
        taskId,
        (x) => x.revision?.stage === 'confirm',
        '修改方案待确认',
        LONG,
      );
      t.log(`修改方案：${task.revision.changes.map((c) => `${c.key}=${c.change}`).join(' ')}`);
      await t.user.decide(taskId, 'continue');
      await t.user.waitTask(
        taskId,
        (x) => done(x) && x.version === 2 && !x.revising,
        '第二版交付',
        LONG,
      );
      // 模型可能顺手给文件改了名：画布里任何一篇 Markdown 改好了就行
      let texts = [];
      for (let i = 0; i < 60; i++) {
        const docs = (await t.user.artifacts(taskId)).filter((a) => a.path.endsWith('.md'));
        texts = await Promise.all(
          docs.map(async (a) => `${a.path}：${(await t.user.content(a.id)).toString()}`),
        );
        if (texts.some((text) => text.includes('每天八杯水'))) break;
        await sleep(2_000);
      }
      t.check(
        texts.some((text) => text.includes('每天八杯水')),
        `第二版画布里的短文没改标题：${texts.map((text) => text.slice(0, 120)).join(' | ') || '画布里没有 Markdown'}`,
      );
    },
  },

  // 图片：真的生图工具（按现在的方式：经模型网关的 image.generate）
  'real-image': {
    async run(t) {
      const { taskId } = await t.user.createTask(
        '生成一张 PNG 图片：一只坐在窗台上晒太阳的橘猫，扁平插画风格，横版。只要这一张图。',
      );
      t.track(taskId);
      await t.user.waitTask(taskId, done, '图片交付', LONG);
      const list = await waitFiles(t, taskId, (files) =>
        files.some((a) => /\.(png|jpe?g|webp)$/i.test(a.path)),
      );
      const image = list.find((a) => /\.(png|jpe?g|webp)$/i.test(a.path));
      t.check(image, `画布里没有图片成果（有：${list.map((a) => a.path).join('、') || '无'}）`);
      if (!image) return;
      const bytes = await t.user.content(image.id);
      const png = bytes
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
      const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
      const webp =
        bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
      t.check(
        png || jpeg || webp,
        `${image.path} 不是图片（开头 ${bytes.subarray(0, 8).toString('hex')}）`,
      );
      t.check(bytes.length > 10_000, `${image.path} 只有 ${bytes.length} 字节，不像一张真图`);
    },
  },

  // 工具节点（ADR 0025）：「生成两段 → 拼成片」是固定流水线，真规划员应排成工具节点；真视频工具
  // 生成，沙箱里 oasis-op 拼接。这一条就是验证规划员会不会选工具节点，所以断言节点类型。
  // 视频按秒收钱：开跑前看一眼步骤，没照要求用便宜型号就当场取消。
  'real-tool': {
    // 两段 4 秒 480p 约 $0.40，再加接需求、规划、解码检查；留出余量，仍在单次 $5 的授权内
    budgetMicro: 2_000_000,
    async run(t) {
      const { taskId } = await t.user.createTask(
        '用视频生成工具做两段 4 秒的短镜头，再按顺序拼接成一个「成片.mp4」，只交付这一个文件。' +
          '镜头一：秋天的落叶在风里缓缓飘落；镜头二：阳光穿过金黄的树梢。' +
          `为了控制成本，两段都用 ${CHEAP_VIDEO} 模型、480p、16:9。` +
          '生成和拼接都是固定步骤，照做就行，不需要 AI 发挥。',
      );
      t.track(taskId);
      const planned = await t.user.waitTask(
        taskId,
        (x) => x.status !== 'planning',
        '方案排好',
        LONG,
      );
      t.log(
        `方案：${planned.nodes
          .map(
            (n) =>
              `${n.title}（${n.kind}${n.steps ? `：${n.steps.map((s) => s.tool).join(' → ')}` : ''}）`,
          )
          .join('；')}，估价 ${usd(planned.estimateMicro ?? 0)}`,
      );
      const tools = planned.nodes.filter((n) => n.kind === 'tool');
      const videos = tools.flatMap((n) => n.steps).filter((s) => s.tool === 'video.generate');
      const cheap =
        videos.length === 2 &&
        videos.every(
          (s) =>
            s.args.model === CHEAP_VIDEO &&
            [undefined, '480p', '720p'].includes(s.args.resolution) &&
            Number(s.args.duration ?? 5) <= 6,
        );
      if (!tools.length || !cheap) {
        await t.user.api.post(`/task/v1/tasks/${taskId}/cancel`).catch(() => {});
        t.check(
          false,
          tools.length
            ? `视频步骤没照要求用 ${CHEAP_VIDEO}，已取消：${JSON.stringify(videos.map((s) => s.args))}`
            : '规划员没有排工具节点，已取消',
        );
        return;
      }

      const task = await t.user.waitTask(taskId, done, '成片交付', LONG);
      for (const node of task.nodes)
        if (node.warning) t.log(`节点「${node.title}」带着提醒交付：${node.warning}`);
      const toolNodes = task.nodes.filter((n) => n.kind === 'tool');
      const ids = toolNodes.map((n) => literal(n.id)).join(',');
      // 不起 AI：harness 里是工具运行，节点上没有模型调用
      const runs = query(
        'harness',
        `select node_id, model, status from runs where node_id in (${ids})`,
      );
      t.check(
        toolNodes.every((n) =>
          runs.some(
            (r) => r.node_id === n.id && r.model === 'oasis/tool' && r.status === 'succeeded',
          ),
        ),
        `每个工具节点都应有一次成功的工具运行：${JSON.stringify(runs)}`,
      );
      const chats = query(
        'model_gateway',
        `select count(*)::int as n from calls where node_id in (${ids}) and kind = 'chat'`,
      )[0].n;
      t.check(Number(chats) === 0, `工具节点不应调用模型（调用了 ${chats} 次）`);
      // 两段视频是按要求的型号真生成的
      const made = query(
        'model_gateway',
        `select status, charged_micro from calls where task_id = ${literal(taskId)} and kind = 'tool' and model = ${literal(CHEAP_VIDEO)}`,
      );
      t.check(
        made.filter((c) => c.status === 'succeeded').length === 2,
        `应用 ${CHEAP_VIDEO} 真生成两段视频：${JSON.stringify(made)}`,
      );
      // 拼接在沙箱里由 oasis-op 做
      const commands = [];
      for (const node of toolNodes) {
        const { events } = await t.user.api.get(
          `/task/v1/tasks/${taskId}/nodes/${node.id}/events?after=-1`,
        );
        for (const e of events)
          if (e.kind === 'tool_call') commands.push(JSON.parse(e.data.arguments).command);
      }
      t.log(`过程：${commands.join(' | ')}`);
      t.check(
        commands.some((c) => c.startsWith('oasis-op video.concat')),
        `拼接应由 oasis-op 做：${commands.join(' | ')}`,
      );
      // 画布里有成片，是 MP4，留一份在回归目录里方便看
      const list = await waitFiles(t, taskId, (files) =>
        files.some((a) => a.path.endsWith('.mp4')),
      );
      t.log(`画布：${list.map((a) => a.path).join('、')}`);
      const film =
        list.find((a) => a.path.includes('成片')) ?? list.find((a) => a.path.endsWith('.mp4'));
      t.check(film, `画布里没有成片（有：${list.map((a) => a.path).join('、') || '无'}）`);
      if (film) {
        const bytes = await t.user.content(film.id);
        t.check(
          bytes.subarray(4, 8).toString() === 'ftyp',
          `${film.path} 不是 MP4（开头 ${bytes.subarray(0, 12).toString('hex')}）`,
        );
        t.check(bytes.length > 50_000, `${film.path} 只有 ${bytes.length} 字节，不像 8 秒的视频`);
        writeFileSync(path.join(t.outDir, 'real-tool-成片.mp4'), bytes);
        t.log(`成片 ${film.path}：${(bytes.length / 1024).toFixed(0)} KB，已存到回归目录`);
      }
      logBill(t);
    },
  },

  // 展开和做几版挑一版（ADR 0026）：6 个镜头的短片
  'real-shots': realShots({ waitFiles, logBill, CHEAP_VIDEO, LONG }),
};

/** 这个回归用户的花费明细（按类型、型号） */
function logBill(t) {
  const bill = query(
    'model_gateway',
    `select kind, model, count(*)::int as n, coalesce(sum(charged_micro), 0)::bigint as micro from calls where payer_id = ${literal(t.user.userId)} group by kind, model order by micro desc`,
  );
  t.log(`花费明细：${bill.map((r) => `${r.kind}/${r.model}×${r.n} ${usd(r.micro)}`).join('，')}`);
}
