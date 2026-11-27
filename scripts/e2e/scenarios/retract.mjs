// 回归场景（docs/engineering/回归测试.md）：删掉我的最后一句——这句话和 AI 的回复没了，AI 的记忆退回
// 这句话之前（harness 每轮存一版会话记录，撤回时放回上一版），已经交的成果不动；删到第一句整份会话清掉。
import { marker, writeFiles } from '../fake-provider.mjs';
import { aiOf, runsOf, start, workspaceExists } from './shared.mjs';

/** 用户说的带这个标记的那句话 */
const saidAt = (messages, say) =>
  messages.find((m) => m.role === 'user' && m.content.includes(marker('retract', say)));

export const retract = {
  says: {
    1: { reply: '记住了。' },
    2: { steps: [{ bash: writeFiles({ 'out/多余.md': '# 多余的一页\n' }) }], reply: '写好了。' },
    3: { reply: '第三句收到。' },
  },
  async run(t) {
    const id = await start(t, 'retract', '记住暗号：青柠');
    await t.user.waitTurn(id, '第一句');
    await t.user.say(id, `另外写一页多余的 ${marker('retract', 2)}`);
    let messages = await t.user.waitTurn(id, '第二句');
    await t.user.waitArtifacts(id, ['多余.md']);
    const [first, second] = runsOf(id);

    // ---- 删掉第二句：它和 AI 的回复没了，harness 里那一轮也没了；交的成果、任务卡留着 ----
    const removed = await t.user.removeMessage(id, saidAt(messages, 2)?.id);
    messages = await t.user.messages(id).then((list) => list.messages);
    t.check(
      removed?.length === 2 &&
        !saidAt(messages, 2) &&
        !aiOf(messages, second?.id).length &&
        aiOf(messages, first?.id).length === 1 &&
        messages.some((m) => m.kind === 'task'),
      `删掉第二句后应只剩第一句、它的回复和任务卡：${JSON.stringify(messages.map((m) => [m.role, m.kind, m.content.slice(0, 20)]))}`,
    );
    t.check(
      runsOf(id)
        .map((run) => run.id)
        .join() === first?.id,
      `harness 里应只剩第一轮：${JSON.stringify(runsOf(id))}`,
    );
    t.check(
      (await t.user.artifacts(id)).some((a) => a.path === '多余.md'),
      '已经交的成果不跟着退回，还在画布里',
    );

    // ---- 再说一句：接着第一轮做，AI 不记得删掉的那句（会话里只有两句用户的话） ----
    await t.user.say(id, `现在说第三句 ${marker('retract', 3)}`);
    messages = await t.user.waitTurn(id, '第三句');
    const runs = runsOf(id);
    t.check(
      runs.length === 2 &&
        runs[1].status === 'succeeded' &&
        runs[1].continue_from === first?.id &&
        runs[1].session_id === first?.session_id,
      `删掉一句后的下一轮应接着它之前的那一轮：${JSON.stringify(runs)}`,
    );
    const calls = t.provider.of('retract', 3);
    t.check(
      calls.length > 0 && calls.every((c) => c.says === 2),
      `AI 的记忆应退回删掉的那句之前（会话里是第一句和第三句）：${calls.map((c) => `${c.action}/${c.says}`).join(' ')}`,
    );

    // ---- 连着删：第三句（退回第一轮），再删第一句——整份会话清掉，下一句从头开 ----
    await t.user.removeMessage(id, saidAt(messages, 3)?.id);
    await t.user.removeMessage(id, saidAt(messages, 1)?.id);
    messages = await t.user.messages(id).then((list) => list.messages);
    t.check(
      !messages.some((m) => m.kind === 'text') &&
        runsOf(id).length === 0 &&
        !workspaceExists(first?.session_id),
      `删到第一句后聊天里没有话了、harness 里没有这份会话了：${JSON.stringify(runsOf(id))}`,
    );
  },
};
