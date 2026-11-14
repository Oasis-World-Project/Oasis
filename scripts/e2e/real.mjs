// 真模型回归（pnpm e2e --real，docs/engineering/回归测试.md）：模型和工具都用 .env 里真的密钥，
// 每个场景花费上限 $1（场景写了 budgetMicro 的按它），超了当场停下这一轮、判失败。
// 模型每次回答不一样：只断言用户看得到的结果（这一轮做完、画布里有成果、内容对得上），不断言调用顺序。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { literal, query } from './db.mjs';
import { PAGE_TEST } from './scenarios.mjs';
import { aiOf, cardOf, runsOf } from './scenarios/shared.mjs';

export const REAL_BUDGET_MICRO = 1_000_000;
const LONG = 20 * 60_000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const usd = (micro) => `$${(Number(micro) / 1_000_000).toFixed(4)}`;

/** 开一个私聊说第一句话，等这一轮做完（AI 最后说的话记进日志）；返回对话 ID 和全部消息 */
async function ask(t, text, label, timeoutMs = LONG) {
  const id = await t.user.openDm();
  t.track(id);
  await t.user.say(id, text);
  const messages = await t.user.waitTurn(id, label, timeoutMs);
  const last = aiOf(messages).at(-1);
  t.log(`AI：${(last?.content ?? '').slice(0, 300).replaceAll('\n', ' ')}`);
  t.check(last?.status === 'complete', `这一轮没做完：${last?.status} ${last?.error ?? ''}`);
  return { id, messages };
}

/** 成果在一轮结束时登记进画布：等到成果列表满足条件（返回最后看到的列表） */
async function waitFiles(t, id, test, ms = 120_000) {
  const deadline = Date.now() + ms;
  let list = [];
  while (Date.now() < deadline) {
    list = await t.user.artifacts(id);
    if (test(list)) return list;
    await sleep(2_000);
  }
  return list;
}

const IMAGE = /\.(png|jpe?g|webp)$/i;

export const REAL_SCENARIOS = {
  // 聊天：说「你好」，真模型回一句话；只聊天不出任务卡
  'real-chat': {
    async run(t) {
      const { messages } = await ask(t, '你好', '回话', 5 * 60_000);
      t.check(!messages.some((m) => m.kind === 'task'), '只聊天不应出任务卡');
      logBill(t);
    },
  },

  // 网页：真模型写三个文件、自己查，桌面端画布里点一遍
  'real-web': {
    async run(t) {
      const { id } = await ask(
        t,
        '做一个计数小网页：页面上用 id 为 count 的元素显示次数，初始是 0；再放一个 id 为 inc 的按钮，点一下次数加一。HTML、CSS、JS 分成三个文件。',
        '网页交付',
      );
      const artifacts = await waitFiles(t, id, (list) =>
        list.some((a) => a.application?.kind === 'static'),
      );
      const app = artifacts.find((a) => a.application?.kind === 'static');
      t.check(
        app,
        `画布里没有可运行的网页成果（有：${artifacts.map((a) => a.path).join('、') || '无'}）`,
      );
      if (app) await t.canvas(app, PAGE_TEST);
      logBill(t);
    },
  },

  // 文档 + 让 AI 改：交 Markdown 短文 → 在画布里挑它让 AI 改标题 → 画布里换成新的
  'real-revise': {
    async run(t) {
      const { id } = await ask(
        t,
        '写一篇 300 字以内的 Markdown 短文，标题是「多喝水的好处」，交一个 .md 文件。',
        '短文交付',
      );
      const list = await waitFiles(t, id, (files) => files.some((a) => a.path.endsWith('.md')));
      const doc = list.find((a) => a.path.endsWith('.md'));
      t.check(doc, `画布里没有 Markdown 成果（有：${list.map((a) => a.path).join('、') || '无'}）`);
      if (!doc) return;
      const first = (await t.user.content(doc.id)).toString();
      t.check(first.includes('多喝水'), `第一版短文没写到题目上：${first.slice(0, 200)}`);

      await t.user.say(id, '把标题改成「每天八杯水」，正文不用动', { artifacts: [doc.id] });
      const messages = await t.user.waitTurn(id, '改好', LONG);
      t.log(`AI：${(aiOf(messages).at(-1)?.content ?? '').slice(0, 300).replaceAll('\n', ' ')}`);
      // 模型可能顺手给文件改了名：画布里任何一篇 Markdown 改好了就行
      let texts = [];
      for (let i = 0; i < 30; i++) {
        const docs = (await t.user.artifacts(id)).filter((a) => a.path.endsWith('.md'));
        texts = await Promise.all(
          docs.map(async (a) => `${a.path}：${(await t.user.content(a.id)).toString()}`),
        );
        if (texts.some((text) => text.includes('每天八杯水'))) break;
        await sleep(2_000);
      }
      t.check(
        texts.some((text) => text.includes('每天八杯水')),
        `改过的短文没改标题：${texts.map((text) => text.slice(0, 120)).join(' | ') || '画布里没有 Markdown'}`,
      );
      logBill(t);
    },
  },

  // 图片：真的生图工具（经模型网关的 image.generate）
  'real-image': {
    async run(t) {
      const { id, messages } = await ask(
        t,
        '生成一张 PNG 图片：一只坐在窗台上晒太阳的橘猫，扁平插画风格，横版。只要这一张图。',
        '图片交付',
      );
      const list = await waitFiles(t, id, (files) => files.some((a) => IMAGE.test(a.path)));
      const image = list.find((a) => IMAGE.test(a.path));
      t.check(image, `画布里没有图片成果（有：${list.map((a) => a.path).join('、') || '无'}）`);
      t.check(
        cardOf(messages, runsOf(id)[0]?.id)?.data.status === 'done',
        '用了生图工具的一轮应出任务卡',
      );
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
      logBill(t);
    },
  },

  // 小游戏：和 dsh 对比用的同一句话，一个 AI 从头做到交付。记下用时、花费、它用了几次浏览器；
  // 游戏文件留一份在回归目录里，质量由人看
  'real-game': {
    // 2026-11-11 改造前几个 AI 接力做花了 $1.56；留出余量，仍在单次 $5 的授权内
    budgetMicro: 3_000_000,
    async run(t) {
      const started = Date.now();
      const { id, messages } = await ask(
        t,
        '做一个网页小游戏：一只橘猫在雨夜屋顶上躲雨滴，两关，难度递增，像素风。要有背景音乐和跳跃、被淋到、过关的音效。',
        '小游戏交付',
        3 * LONG,
      );
      const runs = runsOf(id);
      const ids = runs.map((r) => literal(r.id)).join(',');
      const count = (extra) =>
        query(
          'harness',
          `select count(*)::int as n from run_events where run_id in (${ids}) and kind = 'tool_call'${extra}`,
        )[0].n;
      const card = cardOf(messages, runs.at(-1)?.id);
      t.log(
        `用时 ${((Date.now() - started) / 60_000).toFixed(1)} 分钟，花费 ${usd(card?.data.spentMicro ?? 0)}；` +
          `工具调用 ${count('')} 次，其中用到浏览器 ${count(` and data->>'arguments' ~ 'chromium|playwright|app.check'`)} 次`,
      );
      const list = await waitFiles(t, id, (files) =>
        files.some((a) => a.application?.kind === 'static'),
      );
      t.check(
        list.some((a) => a.application?.kind === 'static'),
        `画布里没有可运行的游戏（有：${list.map((a) => a.path).join('、') || '无'}）`,
      );
      for (const file of list) {
        const target = path.join(t.outDir, 'real-game', file.path);
        mkdirSync(path.dirname(target), { recursive: true });
        writeFileSync(target, await t.user.content(file.id));
      }
      t.log(`画布：${list.map((a) => a.path).join('、')}；已存到回归目录的 real-game/`);
      logBill(t);
    },
  },
};

/** 这个回归用户的花费明细（按类型、型号） */
function logBill(t) {
  const bill = query(
    'model_gateway',
    `select kind, model, count(*)::int as n, coalesce(sum(charged_micro), 0)::bigint as micro from calls where payer_id = ${literal(t.user.userId)} group by kind, model order by micro desc`,
  );
  t.log(`花费明细：${bill.map((r) => `${r.kind}/${r.model}×${r.n} ${usd(r.micro)}`).join('，')}`);
}
