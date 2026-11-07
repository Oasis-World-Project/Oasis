// 真模型回归（pnpm e2e --real，docs/engineering/回归测试.md）：模型和工具都用 .env 里真的密钥，
// 每个场景（含接需求、聊天）花费上限 $1，超了当场取消任务、判失败。
// 模型每次回答不一样：只断言用户看得到的结果（任务完成、画布里有成果、内容对得上），不断言调用顺序。
import { PAGE_TEST } from './scenarios.mjs';

export const REAL_BUDGET_MICRO = 1_000_000;
const LONG = 20 * 60_000;
const done = (task) => task.status === 'succeeded';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
};
