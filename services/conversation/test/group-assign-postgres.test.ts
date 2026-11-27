// 分工：对全体说的话挑一个先出来负责；AI 发分工单，没有上游的同时开工、上游交了的自动接着开；
// 被派的 AI 可以不接；有人没接、没做成，或者都结束了，轮到发单的 AI。真实数据库 + 假 harness / agent / canvas。
import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AssignCard } from '@oasis/contracts/conversation';
import type { AssignEditBody } from '@oasis/contracts/group';
import { createConversationRepo } from '../src/repo/conversation-repo.ts';
import { createGroupRepo } from '../src/repo/group-repo.ts';
import { createGroupSeats } from '../src/repo/group-seats.ts';
import { createGroupSessions } from '../src/repo/group-sessions.ts';
import { createGroupService, type GroupService } from '../src/service/group-service.ts';
import { createPurge } from '../src/service/purge.ts';
import { createTurns, type Turns } from '../src/service/turns.ts';
import {
  befriend,
  fakeProfiles,
  fakeVault,
  groupAssign,
  groupFiles,
  groupTasks,
} from './support/group-fixture.ts';
import { scratchSchema } from './support/schema.ts';
import { client, event, fake, harnessUrl, othersUrl, until } from './support/turn-fixture.ts';

describe.skipIf(!process.env.TEST_DATABASE_URL)('群里的分工', () => {
  const { pool, create, drop } = scratchSchema('group_assign_test');
  const owner = randomUUID();
  const store = createConversationRepo(pool);
  /** 假的「谁最对口」和「别的 AI 补话」：记下被叫了几次 */
  const speak = {
    pick: 'glm' as string | undefined,
    nudged: [] as [string, boolean][],
    nudge: (id: string, force = false) => void speak.nudged.push([id, force]),
    lead: async () => speak.pick,
  };
  let turns: Turns, groups: GroupService;
  beforeAll(async () => {
    await create();
    const harness = client('harness', harnessUrl),
      canvas = client('canvas', othersUrl),
      modelGateway = client('model-gateway', othersUrl),
      agent = client('agent', othersUrl),
      logger = pino({ level: 'silent' });
    turns = createTurns({ repo: store, agent, harness, canvas, modelGateway, logger, pollMs: 20 });
    groups = createGroupService({
      repo: createGroupRepo(pool, { members: 5, groups: 20, messagesPerMinute: 60, ais: 3 }),
      seats: createGroupSeats(pool),
      sessions: createGroupSessions(pool),
      store,
      turns,
      agent,
      profiles: fakeProfiles(new Map([[owner, '阿杰']])),
      files: groupFiles(pool),
      assign: groupAssign(pool, { store, turns, speak }),
      tasks: groupTasks(pool, { store, turns }),
      speak,
      purge: createPurge({ harness, modelGateway, canvas }),
      vault: fakeVault(),
      logger,
    });
  });
  afterAll(async () => {
    await turns.close();
    await drop();
  });

  const setup = async () =>
    (
      await groups.create(
        owner,
        {
          title: '竞品分析',
          ais: ['claude', 'glm', 'kimi'],
          members: [],
          light: 'sky',
          speak: 'mention',
        },
        'r',
      )
    ).id;
  const say = (id: string, content: string, key?: string, task = false) =>
    groups.send(owner, id, content, randomUUID(), key ? [{ kind: 'ai' as const, key }] : [], {
      attachments: [],
      refs: [],
      task,
    });
  /** 这个 AI 现在在做的一轮：席位的，或它名下的云端任务（分工单的一项、作为任务发布的） */
  const runOf = async (id: string, key: string) => {
    const ai = (await groups.get(owner, id)).ais.find((item) => item.key === key)!;
    return ai.runId ?? ai.tasks[0]?.runId ?? null;
  };
  /** 让这个 AI 正在做的一轮说完这句话 */
  async function finish(id: string, key: string, text: string) {
    const runId = (await runOf(id, key))!;
    fake.events.set(runId, [event(0, 'assistant_text', { text })]);
    Object.assign(fake.runs.get(runId)!, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    });
    await until(async () => (await runOf(id, key)) !== runId);
    return runId;
  }
  const card = async (id: string) =>
    (await groups.get(owner, id, { after: 0 })).messages.find((m) => m.kind === 'assign')?.data as
      AssignCard | undefined;
  /** 群里最新的那份分工单 */
  const latestCard = async (id: string) =>
    (await groups.get(owner, id, { after: 0 })).messages.findLast((m) => m.kind === 'assign')
      ?.data as AssignCard | undefined;
  /** 最近开的那一轮交给 harness 的话 */
  const lastPrompt = () => String(fake.starts.at(-1)?.prompt);
  const block = (kind: string, value: unknown) =>
    `\`\`\`oasis-${kind}\n${JSON.stringify(value)}\n\`\`\``;

  it('作为任务发到群里：判断模型挑最对口的一个先出来负责，别的 AI 不动；它说完了让别的 AI 看看要不要补话', async () => {
    const id = await setup();
    const sent = await say(id, '做一份竞品 A 的分析', undefined, true);
    expect(sent.messages.find((m) => m.role === 'user')).toMatchObject({
      data: { task: true, lead: 'glm' },
    });
    expect(fake.starts).toHaveLength(1);
    expect(await runOf(id, 'glm')).toBe(fake.starts[0]!.runId);
    expect(lastPrompt()).toContain(
      '轮到你了：阿杰 把一件事作为任务发到了群里，判断下来你最对口，由你先出来负责（别的 AI 在等你说完）。',
    );
    await finish(id, 'glm', '这件事我自己做完了。');
    // 收尾在它空下来之后才做：等一下
    await until(() => speak.nudged.some(([group, force]) => group === id && force) || undefined);
    expect(fake.starts).toHaveLength(1);
    expect(await card(id)).toBeUndefined();
    // 作为任务发布又点了名：点到的那个负责，不再挑
    speak.pick = 'kimi';
    await say(id, '再做一份英文版', 'claude', true);
    expect(await runOf(id, 'claude')).toBeTruthy();
    expect(await runOf(id, 'kimi')).toBeNull();
    expect(lastPrompt()).toContain('轮到你了：阿杰 @ 了你，这件事是作为任务发到群里的，由你负责。');
  });

  it('分工单：没有上游的马上开工，上游交了的自动接着开；有人没接、都结束了，轮到发单的 AI', async () => {
    const id = await setup();
    await say(id, '做竞品 A 的分析：一份报告、一份图表', 'claude');
    const plan = block('assign', {
      title: '竞品 A 分析',
      items: [
        { id: 1, to: 'glm', task: '按 资料.md 做图表，存成 图表.md', after: [] },
        { id: 2, to: 'kimi', task: '照图表写英文摘要', after: ['1'] },
        { id: 3, to: 'claude', task: '写报告' },
        { id: 4, to: '不存在', task: '做海报' },
      ],
    });
    const leaderRun = await finish(id, 'claude', `资料我整理好了。\n\n${plan}\n\n报告我自己写。`);
    // 分工单是群里的一条消息：写给自己的那项不算；找不到的那项记成没做成
    const opened = await until(async () => {
      const found = await card(id);
      return found?.items[0]?.status === 'running' ? found : undefined;
    });
    expect(opened).toMatchObject({ runId: leaderRun, title: '竞品 A 分析', status: 'open' });
    expect(opened.items.map((item) => [item.id, item.key, item.status, item.after])).toEqual([
      ['1', 'glm', 'running', []],
      ['2', 'kimi', 'waiting', ['1']],
      ['4', '不存在', 'failed', []],
    ]);
    // 第 1 项马上开工，交给它的话里写着是谁的分工单、第几项；第 2 项等着
    const first = fake.starts.find((start) => start.runId === opened.items[0]!.runId)!;
    expect(String(first.prompt)).toContain(
      '发了分工单「竞品 A 分析」，把第 1 项交给你：按 资料.md 做图表，存成 图表.md',
    );
    expect(String(first.prompt)).toContain('不接就只回一个 oasis-decline 代码块');
    // 每一项是一个云端任务：有自己的会话（不是它的席位），花金库的钱
    const { rows: sessions } = await pool.query<{ kind: string; options: { room?: string } }>(
      'select kind,options from conversations where id=$1',
      [first.conversationId],
    );
    expect(sessions).toMatchObject([{ kind: 'task', options: { room: 'group' } }]);
    expect(first).toMatchObject({ payerId: id, scene: 'group' });
    expect(first.continueFrom).toBeUndefined();
    expect(await runOf(id, 'kimi')).toBeNull();
    // 被派了活：它的「越聊越低」从这里重新算
    const { rows } = await pool.query<{ options: { assignedSeq?: number } }>(
      "select options from conversations where parent_id=$1 and kind='seat' and model_key='glm'",
      [id],
    );
    expect(rows[0]!.options.assignedSeq).toBeGreaterThan(0);
    // 有一项没做成：马上轮到发单的 AI，告诉它哪一项、为什么
    await until(async () => (await runOf(id, 'claude')) ?? undefined);
    expect(lastPrompt()).toContain('你发的分工单「竞品 A 分析」有进展：');
    expect(lastPrompt()).toContain('第 4 项（不存在）：没做成——群里没有叫这个名字的 AI');
    expect(lastPrompt()).toContain('有人没接或没做成');
    await finish(id, 'claude', '海报不做了。');
    // 第 1 项交了：第 2 项自动开工，话里写着它等的那一项已经交了
    await finish(id, 'glm', '图表交了。');
    await until(async () => (await runOf(id, 'kimi')) ?? undefined);
    expect(lastPrompt()).toContain('把第 2 项交给你：照图表写英文摘要');
    expect(lastPrompt()).toContain('它要等的第 1 项已经交了');
    // 开工后才把这一项记成在做：等它记上
    const going = await until(async () => {
      const found = await card(id);
      return found?.items[1]?.status === 'running' ? found : undefined;
    });
    expect(going.items.map((item) => item.status)).toEqual(['done', 'running', 'failed']);
    // 第 2 项没接：都结束了，轮到发单的 AI 收口；分工单关上
    await finish(id, 'kimi', block('decline', { reason: '我不擅长英文' }));
    await until(async () => (await runOf(id, 'claude')) ?? undefined);
    expect(lastPrompt()).toContain('第 1 项（DeepSeek）：交了');
    expect(lastPrompt()).toContain('第 2 项（DeepSeek）：没接——我不擅长英文');
    expect(lastPrompt()).toContain('都结束了。核对各项交的东西');
    const closed = await until(async () => {
      const found = await card(id);
      return found?.status === 'closed' ? found : undefined;
    });
    expect(closed.items.map((item) => [item.status, item.told])).toEqual([
      ['done', undefined],
      ['declined', true],
      ['failed', true],
    ]);
    await finish(id, 'claude', '报告和图表都好了，英文摘要没做。');
    // 关上的分工单不再推进
    expect(fake.starts.filter((start) => String(start.prompt).includes('分工单'))).toHaveLength(4);
  });

  it('上游没做成：等它的那一项不开工，结束时记成没开工；发单的 AI 在忙时等它忙完再收口', async () => {
    const id = await setup();
    await say(id, '做图表和摘要', 'claude');
    // 有的模型把整个代码块写在一行里：照样认
    const inline = block('assign', {
      items: [
        { id: 'a', to: 'glm', task: '做图表' },
        { id: 'b', to: 'kimi', task: '写摘要', after: ['a'] },
      ],
    }).replaceAll('\n', ' ');
    await finish(id, 'claude', `我来派： ${inline} 等你们的结果。`);
    await until(async () => (await runOf(id, 'glm')) ?? undefined);
    // 发单的 AI 这时又被叫去做别的
    await say(id, '顺便看看标题', 'claude');
    await finish(id, 'glm', block('decline', { reason: '没有数据' }).replaceAll('\n', ' '));
    // 它在忙：先不打扰，分工单还开着
    await until(async () => ((await card(id))!.items[0]!.status === 'declined' ? true : undefined));
    expect((await card(id))!.status).toBe('open');
    await finish(id, 'claude', '标题没问题。');
    await until(async () => ((await card(id))!.status === 'closed' ? true : undefined));
    expect(lastPrompt()).toContain('第 a 项（DeepSeek）：没接——没有数据');
    expect((await card(id))!.items[1]).toMatchObject({
      status: 'stopped',
      note: '上游没做成，没有开工',
    });
    expect(await runOf(id, 'kimi')).toBeNull();
  });
  it('开两份服务：几处同时推进同一个群，一项只开一次工；收尾那一下没记上的一项，下一遍按它说的话补记', async () => {
    const id = await setup();
    /** 另一份服务：自己的仓库对象，连的是同一个库 */
    const other = groupAssign(pool, { store: createConversationRepo(pool), turns, speak });
    // 被派的 AI 正忙着别的：这一项先等着
    await say(id, '先看看标题', 'glm');
    await say(id, '做图表', 'claude');
    await finish(
      id,
      'claude',
      block('assign', { title: '图表', items: [{ id: 'a', to: 'glm', task: '做图表' }] }),
    );
    await until(async () => ((await card(id))?.items[0]?.status === 'waiting' ? true : undefined));
    // 它忙完了：它自己收尾时会推进一次，另一份服务这时也推进两次
    const busy = (await runOf(id, 'glm'))!;
    fake.events.set(busy, [event(0, 'assistant_text', { text: '标题没问题。' })]);
    Object.assign(fake.runs.get(busy)!, {
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    });
    await Promise.all([other.sweep(), other.sweep()]);
    const going = await until(async () => {
      const found = await card(id);
      return found?.items[0]?.status === 'running' ? found : undefined;
    });
    await other.sweep();
    const handed = () =>
      fake.starts.filter((start) => String(start.prompt).includes('「图表」，把第 a 项交给你'));
    expect(handed()).toHaveLength(1);
    // 收尾那一下没记上（服务正好重启）：这一项还记着在做，那个 AI 却已经不在这一轮里了
    await finish(id, 'glm', '图表交了。');
    await until(async () => ((await card(id))?.status === 'closed' ? true : undefined));
    const message = (await groups.get(owner, id, { after: 0 })).messages.find(
      (m) => m.kind === 'assign',
    )!;
    await finish(id, 'claude', '图表好了。');
    await pool.query('update messages set data = $2 where id = $1', [
      message.id,
      { ...going, status: 'open' },
    ]);
    await other.sweep();
    const fixed = await until(async () => {
      const found = await card(id);
      return found?.status === 'closed' ? found : undefined;
    });
    expect(fixed.items[0]).toMatchObject({ status: 'done', runId: going.items[0]!.runId });
    expect(handed()).toHaveLength(1);
  });
  it('人改分工单：改要求、改派、撤掉；正在做的先停下再改派；整份全部停下；不是群主也不是叫它的人不能改', async () => {
    const id = await setup();
    const plan = (items: unknown[]) => block('assign', { title: '竞品 A', items });
    await say(id, '做竞品 A 的分析', 'claude');
    await finish(
      id,
      'claude',
      plan([
        { id: 1, to: 'glm', task: '查价格' },
        { id: 2, to: 'kimi', task: '写总结', after: ['1'] },
      ]),
    );
    await until(async () => ((await card(id))?.items[0]?.status === 'running' ? true : undefined));
    const messageId = async () =>
      (await groups.get(owner, id, { after: 0 })).messages.findLast((m) => m.kind === 'assign')!.id;
    const edit = async (change: AssignEditBody, user = owner) =>
      groups.editAssign(user, id, await messageId(), change);
    const starts = fake.starts.length;
    // 还没开工的第 2 项：改要求、换一个 AI；群里记一句是谁改的，不叫谁接话
    await edit({ op: 'retask', item: '2', task: '写一页总结，带表格' });
    await edit({ op: 'reassign', item: '2', key: 'glm' });
    expect((await card(id))!.items[1]).toMatchObject({
      key: 'glm',
      task: '写一页总结，带表格',
      status: 'waiting',
    });
    const said = (await groups.get(owner, id, { after: 0 })).messages.filter(
      (m) => m.role === 'user',
    );
    expect(said.slice(-2).map((m) => m.content)).toEqual([
      '把分工单「竞品 A」第 2 项的要求改成：写一页总结，带表格',
      '把分工单「竞品 A」第 2 项从 DeepSeek 改派给 DeepSeek。',
    ]);
    expect(fake.starts).toHaveLength(starts);
    // 发单的 AI 自己做的不进单子；开工了的改不了要求；群里别的成员不能改
    await expect(edit({ op: 'reassign', item: '2', key: 'claude' })).rejects.toMatchObject({
      code: 'assign_to_lead',
    });
    await expect(edit({ op: 'retask', item: '1', task: '查价格和销量' })).rejects.toMatchObject({
      code: 'assign_item_started',
    });
    const member = randomUUID();
    await befriend(pool, owner, member);
    await groups.addMember(owner, id, member, 'r');
    await expect(edit({ op: 'drop', item: '2' }, member)).rejects.toMatchObject({
      code: 'assign_not_allowed',
    });
    // 正在做的第 1 项改派：先停下原来那个 AI 的这一轮，新的 AI 开工时知道之前有人做过一部分
    const stopped = (await runOf(id, 'glm'))!;
    await edit({ op: 'reassign', item: '1', key: 'kimi' });
    expect(fake.stops).toContain(stopped);
    await until(async () => ((await card(id))!.items[0]!.status === 'running' ? true : undefined));
    expect((await card(id))!.items[0]).toMatchObject({ key: 'kimi', from: 'glm' });
    expect(lastPrompt()).toContain('把第 1 项交给你：查价格');
    expect(lastPrompt()).toContain('DeepSeek 之前做过一部分，它交的文件在群文件里。');
    // 被停下的那一轮收尾时，这一项已经不算它的了
    await finish(id, 'glm', '先停在这里。');
    expect((await card(id))!.items[0]).toMatchObject({ key: 'kimi', status: 'running' });
    // 撤掉第 2 项；第 1 项交了就都结束了：发单的 AI 收口时听得到哪一项是人撤掉的
    await edit({ op: 'drop', item: '2' });
    await finish(id, 'kimi', '价格查好了。');
    await until(async () => (await runOf(id, 'claude')) ?? undefined);
    expect(lastPrompt()).toContain('第 1 项（DeepSeek）：交了');
    expect(lastPrompt()).toContain('第 2 项（DeepSeek）：人撤掉了');
    await until(async () => ((await card(id))?.status === 'closed' ? true : undefined));
    await expect(edit({ op: 'drop', item: '1' })).rejects.toMatchObject({ code: 'assign_closed' });
    // 再发一份，两项同时在做：整份全部停下——都停下、单子关上，不再轮到发单的 AI
    await finish(
      id,
      'claude',
      plan([
        { id: 1, to: 'glm', task: '查价格' },
        { id: 2, to: 'kimi', task: '查销量' },
      ]),
    );
    await until(async () =>
      (await latestCard(id))?.items.every((item) => item.status === 'running') ? true : undefined,
    );
    const running = [(await runOf(id, 'glm'))!, (await runOf(id, 'kimi'))!];
    await edit({ op: 'close' });
    expect(fake.stops).toEqual(expect.arrayContaining(running));
    expect(await latestCard(id)).toMatchObject({
      status: 'closed',
      items: [{ status: 'dropped' }, { status: 'dropped' }],
    });
    await finish(id, 'glm', '停了。');
    await finish(id, 'kimi', '停了。');
    expect(await runOf(id, 'claude')).toBeNull();
  });
});
