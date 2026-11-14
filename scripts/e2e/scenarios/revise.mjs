// 回归场景（docs/engineering/回归测试.md）：让 AI 改、插话、停下后继续、开新话题、持久工作目录丢了。
import { marker, writeFiles } from '../fake-provider.mjs';
import { aiOf, cardOf, dropWorkspace, runsOf, start, workspaceExists } from './shared.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/**
 * 要改的成果是之前的话题做的：已经连同它用到的文件拷进工作目录（conversation 的 hand-over.ts）。
 * 话题文件夹取自第一句话，可能带括号（如「写一份笔记（之后……）」），一直匹配到 /笔记.md
 */
const COPIED = /materials\/canvas\/[^\n]+?\/笔记\.md/;
/** 从拷进来的那份改：加一句结尾交出来 */
const fromCopy =
  (ending) =>
  ({ seg }) =>
    COPIED.test(seg.text)
      ? {
          bash: `mkdir -p out && cp materials/canvas/*/笔记.md out/笔记.md && printf '%s\\n' '${ending}' >> out/笔记.md`,
          description: '拷过来改',
        }
      : { text: `没说之前的成果拷到了哪：${seg.text.slice(0, 200)}` };
const NOTE = { steps: [{ bash: writeFiles({ 'out/笔记.md': '# 笔记\n第一版。\n' }) }] };

// ---------- 4. 让 AI 改：在画布里挑一样成果让 AI 改；它还在这个会话的工作目录里，
// AI 接着原会话直接改，画布里原地换新（ID 不变、不多出一份） ----------
export const revise = {
  says: {
    1: {
      steps: [
        {
          bash: writeFiles({
            'out/文案.md': '# 秋日市集\n周末一起逛市集。\n',
            'out/海报说明.md': '# 秋日市集\n海报用暖色。\n',
          }),
          description: '写文案和海报说明',
        },
      ],
      reply: '文案和海报说明写好了。',
    },
    2: {
      steps: [
        ({ seg }) =>
          seg.text.includes('直接改：out/海报说明.md')
            ? {
                bash: `sed -i 's/秋日市集/冬日市集/' out/海报说明.md && cat out/海报说明.md`,
                description: '改标题',
              }
            : { text: `没说要改的成果在哪：${seg.text.slice(0, 200)}` },
      ],
      reply: '标题改成冬日市集了。',
    },
  },
  async run(t) {
    const id = await start(t, 'revise', '写一段活动文案，再按文案写一份海报说明');
    await t.user.waitTurn(id, '第一版');
    const first = await t.user.waitArtifacts(id, ['文案.md', '海报说明.md']);
    const sheet = first.find((a) => a.path === '海报说明.md');
    if (!sheet) {
      t.check(false, `画布里没有海报说明（有：${first.map((a) => a.path).join('、')}）`);
      return;
    }
    await t.user.say(id, `把标题改成「冬日市集」 ${marker('revise', 2)}`, {
      artifacts: [sheet.id],
    });
    const messages = await t.user.waitTurn(id, '改好');
    const runs = runsOf(id);
    t.check(
      runs.length === 2 &&
        runs[1].continue_from === runs[0].id &&
        runs[1].session_id === runs[0].session_id,
      `让 AI 改应接着原会话：${JSON.stringify(runs)}`,
    );
    const edits = t.provider.of('revise', 2);
    t.check(
      edits.some((c) => c.action === 'bash:0') && edits.every((c) => c.says === 2),
      `AI 应接着原会话直接改工作目录里的文件：${edits.map((c) => `${c.action}/${c.says}`).join(' ')}`,
    );
    const asked = messages.find((m) => m.role === 'user' && m.content.includes('冬日市集'));
    t.check(
      asked?.data.artifacts?.some((a) => a.id === sheet.id),
      `用户的话上应带着要改的成果：${JSON.stringify(asked?.data ?? null)}`,
    );
    const winter = await t.user.waitContent(id, '海报说明.md', (text) => text.includes('冬日市集'));
    t.check(winter.includes('冬日市集'), `画布里的海报说明没改成冬日市集：${winter}`);
    const after = await t.user.artifacts(id);
    t.check(
      after.length === 2 && after.some((a) => a.id === sheet.id && a.path === '海报说明.md'),
      `改过的成果应原地换新（还是 2 个、ID 不变）：${after.map((a) => `${a.path}:${a.id.slice(0, 8)}`).join('、')}`,
    );
    const card = cardOf(messages, runs[1]?.id);
    t.check(
      card?.data.files.length === 1 && card.data.files[0].artifactId === sheet.id,
      `第二轮的任务卡上应只列改过的海报说明：${JSON.stringify(card?.data.files ?? null)}`,
    );
  },
};

// ---------- 5. 插话：AI 跑一条慢命令时用户插一句，AI 做完那条命令就看到、按新要求做；还是同一轮，
// AI 看到之后说的话接在插话后面 ----------
export const interject = {
  says: {
    1: {
      steps: [
        {
          bash: `mkdir -p out && sleep 15 && ${writeFiles({ 'out/标语.md': '秋日市集\n' })}`,
          description: '慢慢写标语',
        },
      ],
      reply: '标语写好了。',
    },
    2: {
      steps: [
        { bash: `sed -i 's/秋日/冬日/' out/标语.md && cat out/标语.md`, description: '按插话改' },
      ],
      reply: '按你说的改成冬日了。',
    },
  },
  async run(t) {
    const id = await start(t, 'interject', '写一句活动标语');
    await t.provider.waitFor(
      (c) => c.scenario === 'interject' && c.action === 'bash:0',
      'AI 开始跑命令',
    );
    await sleep(2_000);
    const sent = await t.user.say(id, `改成冬日的 ${marker('interject', 2)}`);
    const said = sent.messages.find((m) => m.role === 'user');
    t.check(
      said?.data.interjection === true,
      `一轮进行中说的话应是插话：${JSON.stringify(said?.data ?? null)}`,
    );
    const messages = await t.user.waitTurn(id, '插话后做完');
    const runs = runsOf(id);
    t.check(
      runs.length === 1 && runs[0].status === 'succeeded',
      `插话应在同一轮里做完：${JSON.stringify(runs)}`,
    );
    t.check(
      t.provider.of('interject', 2).some((c) => c.action === 'bash:0'),
      'AI 应在下一步看到插话、按它改',
    );
    const order = messages
      .filter((m) => m.kind === 'text')
      .map((m) => (m.role === 'assistant' ? 'AI' : m.data.interjection ? '插话' : '用户'));
    t.check(
      order.join('、') === '用户、AI、插话、AI',
      `插话后 AI 的话应接在后面：${order.join('、')}`,
    );
    // AI 看到插话前跑完的慢命令留在插话前面那条，按插话改的那步在后面那条，都标成做完
    const [before, after] = aiOf(messages, runs[0]?.id).map((m) =>
      (m.data.parts ?? []).filter((p) => p.type === 'step'),
    );
    t.check(
      before?.length === 1 &&
        after?.length === 1 &&
        [...before, ...after].every((s) => s.status === 'done'),
      `插话前后各一步、都做完：${[before, after].map((steps) => (steps ?? []).map((s) => `${s.label}/${s.status}`).join('、')).join(' | ')}`,
    );
    const text = await t.user.waitContent(id, '标语.md', (x) => x.includes('冬日'));
    t.check(text.includes('冬日市集'), `标语应按插话改成冬日：${text}`);
  },
};

// ---------- 6. 停下后继续：AI 跑命令时用户停下，说「继续」后接着原会话做完 ----------
export const stop = {
  says: {
    1: {
      steps: [
        { bash: 'mkdir -p out && echo 开始 > out/进度.txt && sleep 600', description: '慢慢做' },
      ],
    },
    2: {
      steps: [
        {
          bash: `test -f out/进度.txt && ${writeFiles({ 'out/报告.md': '# 报告\n停下后接着做完。\n' })}`,
          description: '接着写',
        },
      ],
      reply: '报告写好了。',
    },
  },
  async run(t) {
    const id = await start(t, 'stop', '写一份报告，中途我可能会停下');
    await t.provider.waitFor(
      (c) => c.scenario === 'stop' && c.action === 'bash:0',
      'AI 开始跑命令',
    );
    await sleep(3_000);
    await t.user.stop(id);
    const halted = aiOf(await t.user.waitTurn(id, '停下')).at(-1);
    t.check(
      halted?.status === 'complete' && halted.data.stopped === true,
      `停下后 AI 的话应标着停下了：${halted?.status} ${halted?.data.stopped}`,
    );
    const step = halted?.data.parts?.find((p) => p.type === 'step');
    t.check(step?.status === 'failed', `停下时没做完的那步应标成没做完：${step?.status}`);
    await t.user.say(id, `继续 ${marker('stop', 2)}`);
    await t.user.waitTurn(id, '继续后做完');
    const runs = runsOf(id);
    t.check(
      runs.length === 2 &&
        runs[0].status === 'stopped' &&
        runs[1].status === 'succeeded' &&
        runs[1].continue_from === runs[0].id,
      `应有停下的和接着做完的两轮：${JSON.stringify(runs)}`,
    );
    const resumed = t.provider.of('stop', 2);
    t.check(resumed.length > 0 && resumed.every((c) => c.says === 2), '继续后没有接上原会话');
    const artifacts = await t.user.waitArtifacts(id, ['报告.md']);
    t.check(
      artifacts.some((a) => a.path === '报告.md'),
      '画布里没有报告',
    );
  },
};

// ---------- 7. 开新话题后改之前的成果：AI 不记得之前的事（新会话），要改的成果连同用到的文件
// 拷进工作目录，改好的在新话题里另登记一份，原来那份不动 ----------
export const topic = {
  says: { 1: NOTE, 2: { steps: [fromCopy('结尾：新话题里改的')], reply: '加好结尾了。' } },
  async run(t) {
    const id = await start(t, 'topic', '写一份笔记');
    await t.user.waitTurn(id, '第一版');
    const note = (await t.user.waitArtifacts(id, ['笔记.md'])).find((a) => a.path === '笔记.md');
    if (!note) {
      t.check(false, '画布里没有笔记');
      return;
    }
    const old = runsOf(id)[0]?.session_id;
    await t.user.newTopic(id);
    // AI 不记得之前的事：之前话题的运行记录和工作目录真删除（成果还在画布里）
    t.check(old && !workspaceExists(old), '开新话题后之前话题的工作目录应删掉');
    await t.user.say(id, `给这份笔记加一句结尾 ${marker('topic', 2)}`, { artifacts: [note.id] });
    const messages = await t.user.waitTurn(id, '新话题里改好');
    t.check(
      messages.some((m) => m.kind === 'topic'),
      '对话里应有开新话题的分隔',
    );
    const runs = runsOf(id);
    t.check(
      runs.length === 1 &&
        runs[0].status === 'succeeded' &&
        !runs[0].continue_from &&
        runs[0].session_id !== old,
      `开新话题后只剩新话题这一轮、是新会话：${JSON.stringify(runs)}`,
    );
    const calls = t.provider.of('topic', 2);
    t.check(
      calls.some((c) => c.action === 'bash:0') && calls.every((c) => c.says === 1),
      `新话题里 AI 不记得之前的事，从拷进来的那份改：${calls.map((c) => `${c.action}/${c.says}`).join(' ')}`,
    );
    const notes = (await t.user.artifacts(id)).filter((a) => a.path === '笔记.md');
    const texts = await Promise.all(
      notes.map(async (a) => (await t.user.content(a.id)).toString()),
    );
    t.check(
      notes.length === 2 &&
        texts.some((x) => x.includes('第一版') && x.includes('结尾：新话题里改的')) &&
        texts.some((x) => !x.includes('结尾')),
      `改好的另登记一份、原来那份不动：${texts.join(' | ')}`,
    );
  },
};

// ---------- 8. 持久工作目录丢了：让 AI 改时接不上原会话，这一轮开新会话（告诉用户），
// 要改的成果拷进来接着改 ----------
export const workspace = {
  says: { 1: NOTE, 2: { steps: [fromCopy('结尾：新会话补上的')], reply: '加好结尾了。' } },
  async run(t) {
    const id = await start(t, 'workspace', '写一份笔记（之后它的工作目录会被清掉）');
    await t.user.waitTurn(id, '第一版');
    const note = (await t.user.waitArtifacts(id, ['笔记.md'])).find((a) => a.path === '笔记.md');
    if (!note) {
      t.check(false, '画布里没有笔记');
      return;
    }
    dropWorkspace(runsOf(id)[0].session_id);
    await t.user.say(id, `给这份笔记加一句结尾 ${marker('workspace', 2)}`, {
      artifacts: [note.id],
    });
    const messages = await t.user.waitTurn(id, '新会话里改好');
    const runs = runsOf(id);
    t.check(
      runs.length === 2 && runs[1].status === 'succeeded' && !runs[1].continue_from,
      `接不上原会话时这一轮应开新会话：${JSON.stringify(runs)}`,
    );
    const notice = aiOf(messages, runs[1]?.id)
      .flatMap((m) => m.data.parts ?? [])
      .find((p) => p.type === 'notice');
    t.check(
      notice?.text.includes('工作目录已经不在了'),
      `应告诉用户原来的工作目录不在了：${notice?.text ?? '没有提示'}`,
    );
    const calls = t.provider.of('workspace', 2);
    t.check(
      calls.some((c) => c.action === 'bash:0') && calls.every((c) => c.says === 1),
      `工作目录没了，应在新会话里从拷进来的那份改：${calls.map((c) => `${c.action}/${c.says}`).join(' ')}`,
    );
    const text = await t.user.waitContent(id, '笔记.md', (x) => x.includes('结尾'));
    t.check(
      text.includes('第一版') && text.includes('结尾：新会话补上的'),
      `笔记应在上一版的基础上改：${text}`,
    );
  },
};
