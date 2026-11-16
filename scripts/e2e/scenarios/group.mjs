// 回归场景（docs/engineering/回归测试.md）：好友和群里的 AI。按账号 ID 加好友、对方同意；好友之间私聊；
// 群主建群时直接把好友拉进来。@ 谁谁回，回之前先听它没听过的群聊；@ 全体只挑一个先出来负责，
// 它发分工单把一项交给另一个 AI，那个 AI 做完交了，再轮到它收口；
// 它忙着时 @ 它的话先等着，「现在告诉它」作为插话送进正在做的一轮；群员叫的 AI 花群主的钱；
// 群文件：人发的文件和 AI 交的文件都在里面，别的 AI 开一轮时拿到、改了就是新版本；好友私聊里也能发文件。
// 解散群，席位的会话、工作目录、成果、发过的文件一起清掉；删好友，两人的私聊一起删。
import { randomUUID } from 'node:crypto';
import { literal, query } from '../db.mjs';
import { marker, writeFiles } from '../fake-provider.mjs';
import { runsOf, workspaceExists } from './shared.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const base = '/conversation/v1/groups';

/** 群里说一句话；mentions 是 @ 了谁 */
const say = (user, groupId, content, mentions = [], files = {}) =>
  user.api.post(`${base}/${groupId}/messages`, {
    content,
    requestId: randomUUID(),
    mentions,
    ...files,
  });
/** 读一个地址的文字内容 */
const textOf = async (user, route) => (await user.api.get(route, { raw: true })).text();
/** 这个地址现在回什么状态码 */
const statusOf = (user, route) =>
  user.api.get(route, { raw: true }).then(
    () => 200,
    (err) => err.status,
  );

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

/** 分工单里那一项交给谁（跑起来才知道第二个 AI 是谁） */
let assignTo = '';

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
    // @ 全体：先出来的那个 AI 发一份分工单，把欢迎词交给另一个 AI（单子的标题带着收口那一轮的标记）
    2: {
      get reply() {
        const plan = {
          title: `开场 ${marker('group', '2r')}`,
          items: [
            { id: '1', to: assignTo, task: `写一句欢迎词 ${marker('group', '2i')}`, after: [] },
          ],
        };
        return `我来负责，欢迎词交给别人写。\n\`\`\`oasis-assign\n${JSON.stringify(plan)}\n\`\`\``;
      },
    },
    // 被派到的 AI：应听到是谁发的单子、交给它的是哪一项；写好交出来
    '2i': {
      steps: [
        ({ seg }) =>
          seg.text.includes('发了分工单') && seg.text.includes('把第 1 项交给你：写一句欢迎词')
            ? {
                bash: writeFiles({ 'out/欢迎词.md': '欢迎来到 B 栋天台\n' }),
                description: '写欢迎词',
              }
            : { text: `没听到交给它的那一项：${seg.text.slice(-300)}` },
      ],
      reply: '欢迎词写好了。',
    },
    // 发单的 AI 收口：应听到各项都结束了，交的文件已经在它的工作目录里
    '2r': {
      steps: [
        ({ seg }) =>
          seg.text.includes('都结束了') && /第 1 项（[^）]+）：交了/.test(seg.text)
            ? { bash: 'cat materials/group/欢迎词.md', description: '核对欢迎词' }
            : { text: `没听到分工单的结果：${seg.text.slice(-300)}` },
        ({ last }) =>
          String(last).includes('欢迎来到 B 栋天台')
            ? { text: '都交了，欢迎词在群文件里。' }
            : { text: `交的文件没在工作目录里：${String(last).slice(0, 300)}` },
      ],
    },
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
    // 没 @ 谁：判断模型说第二个 AI 有话说（speaker 是有空的 AI 里第几个），它自己接话
    5: { speaker: 1, reply: '叫「天台见」怎么样？' },
    // 群员带着一份名单、引用第一个 AI 交的标语 @ 第二个 AI：它工作目录里应有这两份群文件，改了标语交回来
    6: {
      steps: [
        ({ seg }) =>
          seg.text.includes('带了群文件：名单.csv、标语.md')
            ? {
                bash: 'cat materials/group/名单.csv materials/group/标语.md',
                description: '看群文件',
              }
            : { text: `没听到这句话带的群文件：${seg.text.slice(-300)}` },
        ({ last }) =>
          String(last).includes('林夏') && String(last).includes('冬日市集')
            ? {
                bash: `mkdir -p out && sed 's/冬日市集/冬日市集（3 位嘉宾）/' materials/group/标语.md > out/标语.md`,
                description: '改标语',
              }
            : { text: `群文件没拷进工作目录：${String(last).slice(0, 300)}` },
      ],
      reply: '标语里加上了嘉宾数。',
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

    // ---- 好友：各自起名字；群员按群主的账号 ID 查到人、发申请，群主同意 ----
    const profile = { bio: '', gender: '', region: '' };
    const boss = await owner.api.put('/identity/v1/me/profile', { name: '群主', ...profile });
    await member.api.put('/identity/v1/me/profile', { name: '阿杰', ...profile });
    const found = await member.api.get(`/identity/v1/users/lookup?accountNo=${boss.accountNo}`);
    t.check(
      found.id === owner.userId && found.name === '群主' && found.email === undefined,
      `按账号 ID 应查到群主的公开资料（不带邮箱）：${JSON.stringify(found)}`,
    );
    await member.api.post('/conversation/v1/friends/requests', {
      userId: found.id,
      message: '我是阿杰',
    });
    const asked = (await owner.api.get('/conversation/v1/friends')).incoming;
    t.check(
      asked.length === 1 && asked[0].message === '我是阿杰' && asked[0].profile.name === '阿杰',
      `群主应收到带验证消息的好友申请：${JSON.stringify(asked)}`,
    );
    await owner.api.post(`/conversation/v1/friends/requests/${asked[0].id}/accept`);
    // ---- 好友之间的私聊：普通聊天，没有 AI ----
    const chat = await owner.api.post(`/conversation/v1/friends/${member.userId}/chat`);
    await say(owner, chat.id, '周五见');
    const talk = await member.api.get(`${base}/${chat.id}`);
    t.check(
      talk.kind === 'direct' &&
        talk.ais.length === 0 &&
        talk.messages.at(-1)?.content === '周五见' &&
        talk.messages.at(-1)?.displayName === '群主',
      `好友应在私聊里看到这句话：${JSON.stringify(talk.messages.at(-1) ?? null)}`,
    );

    // ---- 建群：两个 AI，好友直接拉进来（不用对方同意）----
    const created = await owner.api.post(base, {
      title: '回归测试群',
      ais: [first, second],
      members: [member.userId],
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
      t.check(
        created.members.map((m) => m.displayName).join() === '群主,阿杰' &&
          (await member.api.get(base)).groups.some((g) => g.id === groupId),
        `建群时拉的好友应直接在群里、显示账号的名字：${JSON.stringify(created.members)}`,
      );
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

      // ---- @ 全体：只挑一个先出来负责（判断模型都给 0 分时是第一个）；它发分工单把欢迎词交给第二个，
      //      第二个做完交了，再轮到它收口。第一个接着自己的会话，第二个第一次开口 ----
      assignTo = second;
      const toAll = await say(owner, groupId, `准备开场 ${marker('group', 2)}`, [{ kind: 'all' }]);
      t.check(
        toAll.messages.findLast((m) => m.role === 'user')?.data.lead === first &&
          !toAll.ais.find((ai) => ai.key === second)?.runId,
        `@ 全体应只挑一个先出来负责，别的不开工：${JSON.stringify(toAll.ais.map((ai) => [ai.key, Boolean(ai.runId)]))}`,
      );
      const planOf = (group) => group.messages.find((m) => m.kind === 'assign');
      for (let i = 0; i < 180; i++) {
        now = await owner.api.get(`${base}/${groupId}`);
        if (planOf(now)?.data.status === 'closed') break;
        await sleep(1_000);
      }
      now = await idle(owner, groupId, '分工单收口');
      const plan = planOf(now);
      t.check(
        plan?.authorId === first &&
          plan.data.status === 'closed' &&
          plan.data.items.length === 1 &&
          plan.data.items[0].key === second &&
          plan.data.items[0].status === 'done',
        `分工单应是第一个 AI 发的、交给第二个的那一项交了、已经收口：${JSON.stringify(plan?.data ?? null)}`,
      );
      t.check(
        spoke(now, first).length === 3 && spoke(now, second).length === 1,
        `发单的 AI 应说两次（发单、收口），被派的说一次：${first} ${spoke(now, first).length} 句、${second} ${spoke(now, second).length} 句`,
      );
      t.check(
        spoke(now, first).at(-1)?.content.includes('都交了'),
        `发单的 AI 收口时应拿得到交上来的文件：${spoke(now, first).at(-1)?.content}`,
      );
      const sessions = ['2', '2i', '2r'].map(
        (mark) =>
          t.provider.of('group', mark).findLast((c) => c.kind === 'agent' && c.model)?.says ?? 0,
      );
      t.check(
        sessions.join() === '2,1,3',
        `第一个 AI 应一直接着自己在群里的会话（2 句、3 句），第二个是第一次（1 句）：${sessions.join()}`,
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
        runs.length === 4 && runs.every((run) => run.status === 'succeeded'),
        `插话应在同一轮里做完（这个席位一共 4 轮）：${JSON.stringify(runs.map((run) => run.status))}`,
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

      // ---- 「积极参与」：没 @ 谁，有话说的那个 AI 自己接话，别的不开口；它说完不会没完没了地接下去 ----
      await owner.api.put(`${base}/${groupId}/options`, { speak: 'active' });
      const spokeBefore = spoke(now, first).length;
      await say(owner, groupId, `谁帮我想个活动名 ${marker('group', 5)}`);
      await t.provider.waitFor(
        (c) => c.scenario === 'group' && c.say === '5' && c.action === 'done',
        '没被 @ 的 AI 自己接话',
      );
      now = await idle(owner, groupId, '自己接话');
      t.check(
        spoke(now, second).at(-1)?.content.includes('天台见') &&
          spoke(now, first).length === spokeBefore,
        `没 @ 谁时应只有有话说的那个 AI 接话：${JSON.stringify(spoke(now, second).map((m) => m.content))}`,
      );
      t.check(
        t.provider.calls.some((c) => c.kind === 'judge' && c.say === '5' && c.keys.length === 2),
        '接话前应问过一次「谁想接话」，两个有空的 AI 都在里面',
      );
      await owner.api.put(`${base}/${groupId}/options`, { speak: 'mention' });

      // ---- 群文件：AI 交的在里面；群员发一份名单、引用标语 @ 第二个 AI，它拿到两份、改了标语就是新版本 ----
      const filesOf = async () => (await member.api.get(`${base}/${groupId}/files`)).files;
      const slogan = (await filesOf()).find((file) => file.path === '标语.md');
      t.check(
        slogan?.madeBy.id === first && slogan.changedBy.id === first,
        `第一个 AI 交的标语应在群文件里：${JSON.stringify(slogan ?? null)}`,
      );
      const roster = await member.upload('名单.csv', '姓名\n林夏\n阿杰\n小满\n');
      const asked = await say(
        member,
        groupId,
        `按名单把标语改一下 ${marker('group', 6)}`,
        [{ kind: 'ai', key: second }],
        { attachments: [roster.id], refs: ['标语.md'] },
      );
      const withFiles = asked.messages.findLast((m) => m.role === 'user');
      t.check(
        withFiles?.data.attachments?.[0]?.id === roster.id &&
          withFiles.data.refs?.[0]?.path === '标语.md',
        `这句话上应写着带的文件和引用的群文件：${JSON.stringify(withFiles?.data ?? null)}`,
      );
      await idle(owner, groupId, '第二个 AI 改标语');
      t.check(
        t.provider.of('group', 6).some((c) => c.action === 'bash:1'),
        '第二个 AI 的工作目录里应有名单和标语这两份群文件',
      );
      let files = [];
      for (let i = 0; i < 20; i++) {
        files = await filesOf();
        if (files.find((file) => file.path === '标语.md')?.changedBy.id === second) break;
        await sleep(1_000);
      }
      const changed = files.find((file) => file.path === '标语.md');
      t.check(
        files.length === 3 && changed?.madeBy.id === first && changed.changedBy.id === second,
        `标语应还是一份、写着第一个 AI 做的第二个 AI 改过：${JSON.stringify(files.map((f) => [f.path, f.madeBy.id, f.changedBy.id]))}`,
      );
      const sloganText = await textOf(owner, `${base}/${groupId}/files/${changed.id}/content`);
      t.check(sloganText.includes('3 位嘉宾'), `群文件里的标语应是改过的那一版：${sloganText}`);
      const list = files.find((file) => file.path === '名单.csv');
      t.check(
        list?.madeBy.kind === 'user' && list.madeBy.id === member.userId,
        `群员发的名单应在群文件里：${JSON.stringify(list ?? null)}`,
      );
      const work = (await member.api.get(`${base}/${groupId}/work`)).messages;
      t.check(
        work.some((m) => m.kind === 'text' && m.authorId === second && m.data.title) &&
          work.some((m) => m.kind === 'task' && m.authorId === first),
        `工作台应看得到两个 AI 动过手的那几轮：${JSON.stringify(work.map((m) => [m.kind, m.authorId]))}`,
      );
      // AI 交的文件群员删不了；传的人能删自己传的（这里留着名单，解散时看它有没有被清掉）
      const denied = await member.api.del(`${base}/${groupId}/files/${changed.id}`).then(
        () => 204,
        (err) => err.status,
      );
      t.check(denied === 403, `群员不应能删 AI 交的群文件：${denied}`);

      // ---- 好友私聊里发文件：只跟着那条消息，对方能读 ----
      const photo = await owner.upload('合照.txt', '天台合照');
      await say(owner, chat.id, '', [], { attachments: [photo.id] });
      const photoRoute = `${base}/${chat.id}/attachments/${photo.id}/content`;
      t.check((await textOf(member, photoRoute)) === '天台合照', '好友私聊里发的文件对方应能读到');

      // ---- 解散群：席位的会话、工作目录、成果、发过的文件一起清掉 ----
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
      const rosterLeft = await statusOf(member, `/canvas/v1/uploads/${roster.id}`);
      t.check(rosterLeft === 404, `解散群后群里发过的文件应从画布删掉：${rosterLeft}`);

      // ---- 删好友：两人的私聊（连消息）一起删掉 ----
      await member.api.del(`/conversation/v1/friends/${owner.userId}`);
      const gone = await statusOf(owner, `${base}/${chat.id}`);
      t.check(gone === 404, `删好友后两人的私聊应不在了：${gone}`);
      const photoLeft = await statusOf(owner, `/canvas/v1/uploads/${photo.id}`);
      t.check(photoLeft === 404, `删好友后私聊里发过的文件应从画布删掉：${photoLeft}`);
      t.check(
        (await owner.api.get('/conversation/v1/friends')).friends.length === 0,
        '删好友后好友列表里应没有他',
      );
    } finally {
      if (!destroyed) await owner.api.del(`${base}/${groupId}`).catch(() => undefined);
    }
  },
};
