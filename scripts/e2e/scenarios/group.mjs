// 回归场景（docs/engineering/回归测试.md）：群里的 AI。@ 谁谁回，回之前先听它没听过的群聊；@ 全体各回各的；
// 它忙着时 @ 它的话先等着，「现在告诉它」作为插话送进正在做的一轮；群员叫的 AI 花群主的钱；
// 解散群，席位的会话、工作目录、成果一起清掉。
import { randomUUID } from 'node:crypto';
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { runsOf, workspaceExists } from './shared.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = '/conversation/v1/groups';

/** 群里说一句话；mentions 是 @ 了谁 */
const say = (user, groupId, content, mentions = []) =>
  user.api.post(`${base}/${groupId}/messages`, {
    content,
    requestId: randomUUID(),
    mentions,
  });

/** 等群里的 AI 都空下来、没有还在写的话，返回群现在的样子 */
async function idle(user, groupId, label, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  let group;
  while (Date.now() < deadline) {
    group = await user.api.get(`${base}/${groupId}`);
    if (!group.ais.some((ai) => ai.runId) && !group.live.length) return group;
    await sleep(1_000);
  }
  throw new Error(
    `等「${label}」超时：${JSON.stringify(group?.ais.map((ai) => [ai.key, ai.runId]))}`,
  );
}

/** 这个 AI 在群里说的话 */
const spoke = (group, key) =>
  group.messages.filter((m) => m.authorId === key && m.kind === 'text' && m.role === 'assistant');

export const group = {
  says: {
    // 群员 @ 第一个 AI：它开口前应先听到之前没 @ 它的那句群聊，知道是谁叫的它
    1: {
      steps: [
        ({ seg }) =>
          seg.text.includes('场地定在 B 栋天台') &&
          seg.text.includes('阿杰') &&
          seg.text.includes('@ 了你')
            ? { bash: 'echo heard', description: '听完群聊' }
            : { text: `没听到之前的群聊：${seg.text.slice(0, 300)}` },
      ],
      reply: '开场白：欢迎来到 B 栋天台。',
    },
    2: { reply: '收到，我来说一句。' },
    3: {
      steps: [
        {
          bash: `mkdir -p out && sleep 15 && ${writeFiles({ 'out/标语.md': '秋日市集\n' })}`,
          description: '慢慢写标语',
        },
      ],
      reply: '标语写好了。',
    },
    4: {
      steps: [
        { bash: `sed -i 's/秋日/冬日/' out/标语.md && cat out/标语.md`, description: '按插话改' },
      ],
      reply: '按你说的改成冬日了。',
    },
  },
  async run(t) {
    const owner = t.user;
    const member = await t.another();
    const { models } = await owner.api.get('/agent/v1/models');
    const usable = models.filter((m) => m.available);
    const first = usable.find((m) => /deepseek/i.test(m.key))?.key ?? usable[0]?.key;
    const second = usable.find((m) => m.key !== first)?.key;
    if (!first || !second) throw new Error('可用的对话 AI 不到两个，群聊场景跑不了');

    const created = await owner.api.post(base, {
      title: '回归测试群',
      displayName: '群主',
      ais: [first, second],
    });
    const groupId = created.id;
    t.log(`群 ${groupId}（AI：${first}、${second}）`);
    const seats = () =>
      query(
        'conversation',
        `select id, model_key from conversations where parent_id = ${literal(groupId)}`,
      );
    const seatOf = (key) => seats().find((seat) => seat.model_key === key)?.id;
    let destroyed = false;
    try {
      t.check(
        created.ais.map((ai) => ai.key).join() === [first, second].join() && created.aiCount === 2,
        `建群时叫的两个 AI 应都在群里：${JSON.stringify(created.ais)}`,
      );
      // 朋友进群（好友系统做好后改成群主直接拉好友）
      const invite = await owner.api.post(`${base}/${groupId}/invites`);
      await member.api.post(`${base}/invites/redeem`, {
        token: invite.token,
        displayName: '阿杰',
        acceptHistory: true,
      });
      const before = { owner: await owner.wallet(), member: await member.wallet() };

      // ---- 没 @ 谁：AI 不说话 ----
      await say(member, groupId, '场地定在 B 栋天台');
      await sleep(2_000);
      let now = await owner.api.get(`${base}/${groupId}`);
      t.check(
        !now.ais.some((ai) => ai.runId) && !now.messages.some((m) => m.role === 'assistant'),
        `没 @ 谁时 AI 不应开口：${JSON.stringify(now.ais.map((ai) => [ai.key, ai.runId]))}`,
      );

      // ---- 群员 @ 一个 AI：只有它回，回之前听到了没 @ 它的那句；花的是群主的钱 ----
      await say(member, groupId, `写一句开场白 ${marker('group', 1)}`, [
        { kind: 'ai', key: first },
      ]);
      now = await idle(owner, groupId, '@ 一个 AI');
      const opening = spoke(now, first).at(-1);
      t.check(
        opening?.status === 'complete' && opening.content.includes('B 栋天台'),
        `被 @ 的 AI 应听完群聊再回：${JSON.stringify(spoke(now, first).map((m) => [m.status, m.content]))}`,
      );
      t.check(spoke(now, second).length === 0, '没被 @ 的 AI 不应开口');
      t.check(
        (opening?.data.spentMicro ?? 0) > 0,
        `这一轮的花费应写在它的话上：${opening?.data.spentMicro}`,
      );
      const after = { owner: await owner.wallet(), member: await member.wallet() };
      t.check(
        after.owner.availableMicro < before.owner.availableMicro &&
          after.member.availableMicro === before.member.availableMicro,
        `群员叫的 AI 应花群主的钱：群主 ${before.owner.availableMicro}→${after.owner.availableMicro}，群员 ${before.member.availableMicro}→${after.member.availableMicro}`,
      );

      // ---- @ 全体：两个各回各的；第一个接着自己的会话，第二个第一次开口 ----
      await say(owner, groupId, `各说一句 ${marker('group', 2)}`, [{ kind: 'all' }]);
      now = await idle(owner, groupId, '@ 全体');
      t.check(
        spoke(now, first).length === 2 && spoke(now, second).length === 1,
        `@ 全体后两个 AI 应各回一句：${first} ${spoke(now, first).length} 句、${second} ${spoke(now, second).length} 句`,
      );
      const sessions = t.provider
        .of('group', 2)
        .filter((c) => c.action === 'done')
        .map((c) => c.says)
        .sort();
      t.check(
        sessions.join() === '1,2',
        `第一个 AI 应接着自己在群里的会话（2 句），第二个是第一次（1 句）：${sessions.join()}`,
      );

      // ---- 它忙着时 @ 它：这句先等着；「现在告诉它」作为插话送进正在做的一轮 ----
      await say(owner, groupId, `写一句活动标语 ${marker('group', 3)}`, [
        { kind: 'ai', key: first },
      ]);
      await t.provider.waitFor(
        (c) => c.scenario === 'group' && c.say === '3' && c.action === 'bash:0',
        '群里的 AI 开始跑命令',
      );
      await sleep(2_000);
      const sent = await say(member, groupId, `改成冬日的 ${marker('group', 4)}`, [
        { kind: 'ai', key: first },
      ]);
      const waiting = sent.messages.findLast((m) => m.role === 'user');
      const busy = sent.ais.find((ai) => ai.key === first);
      t.check(
        Boolean(busy?.runId) && busy.heardSeq < (waiting?.seq ?? 0),
        `它忙着时 @ 它的话应先等着：在忙 ${Boolean(busy?.runId)}，听到第 ${busy?.heardSeq} 条，这句是第 ${waiting?.seq} 条`,
      );
      await member.api.post(`${base}/${groupId}/messages/${waiting.id}/steer`, { key: first });
      now = await idle(owner, groupId, '插话后做完');
      const seatId = seatOf(first);
      const runs = runsOf(seatId);
      t.check(
        runs.length === 3 && runs.every((run) => run.status === 'succeeded'),
        `插话应在同一轮里做完（这个席位一共 3 轮）：${JSON.stringify(runs.map((run) => run.status))}`,
      );
      t.check(
        t.provider.of('group', 4).some((c) => c.action === 'bash:0'),
        'AI 应在下一步看到插话、按它改',
      );
      t.check(
        now.ais.find((ai) => ai.key === first)?.heardSeq >= waiting.seq,
        '插话送到后这句应算它听过了',
      );
      const card = now.messages.find((m) => m.kind === 'task' && m.authorId === first);
      t.check(
        card?.data.status === 'done' && card.data.files.some((file) => file.path === '标语.md'),
        `交了文件应有它的任务卡：${JSON.stringify(card?.data ?? null)}`,
      );
      const text = await owner.waitContent(seatId, '标语.md', (x) => x.includes('冬日'));
      t.check(text.includes('冬日市集'), `标语应按插话改成冬日：${text}`);

      // ---- 解散群：席位的会话、工作目录、成果一起清掉 ----
      const sessionIds = [...new Set(runs.map((run) => run.session_id).filter(Boolean))];
      await owner.api.del(`${base}/${groupId}`);
      destroyed = true;
      let left = [];
      for (let i = 0; i < 30; i++) {
        left = await owner.artifacts(seatId);
        if (!left.length) break;
        await sleep(1_000);
      }
      t.check(left.length === 0, `解散群 30 秒后画布里还剩 ${left.length} 个成果`);
      t.check(
        query(
          'conversation',
          `select id from conversations where id = ${literal(groupId)} or parent_id = ${literal(groupId)}`,
        ).length === 0,
        '解散群后群和席位都应删掉',
      );
      for (const sessionId of sessionIds)
        t.check(!workspaceExists(sessionId), `解散群后席位的工作目录应删掉：${sessionId}`);
    } finally {
      if (!destroyed) await owner.api.del(`${base}/${groupId}`).catch(() => undefined);
    }
  },
};
