// 私聊的「在哪干活和权限」和确认卡：交给 harness 的设置、换地方从新话题开始、点确认卡。
import { describe, expect, it } from 'vitest';
import {
  OWNER,
  activity,
  confirmation,
  conversation,
  decisions,
  dms,
  fake,
  finished,
  repo,
  run,
  send,
} from './support/turn-fixture.ts';

const DEVICE = {
  kind: 'device' as const,
  deviceId: 'desk-0001-abcd',
  folder: 'D:\\Projects\\blog',
};
const setup = (body: Parameters<typeof dms.setup>[2]) =>
  dms.setup(OWNER, conversation.id, body, 'r');
const confirm = (confirmationId: string, decision: 'once' | 'always' | 'deny') =>
  dms.confirm({
    ownerId: OWNER,
    conversationId: conversation.id,
    confirmationId,
    decision,
    requestId: 'r',
  });
const turnOf = async () => (await repo.find(conversation.id))?.turn;
/** 等跟进把 model-gateway 那边待定的卡放进这一轮 */
const cardsShown = async (n: number) => {
  for (const deadline = Date.now() + 3000; Date.now() < deadline;) {
    if ((await turnOf())?.confirmations?.length === n) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('等不到确认卡');
};
const finish = async (runId: string) => {
  fake.runs.set(runId, run(runId, { status: 'succeeded', finishedAt: new Date().toISOString() }));
  await finished();
};

describe('在哪干活和权限', () => {
  it('没设过：云端沙箱、完全访问、超出不做、花钱的工具不问，开一轮照这个交给 harness', async () => {
    const [listed] = await dms.listDms(OWNER);
    expect(listed).toMatchObject({
      workplace: { kind: 'cloud' },
      permissions: { access: 'full', beyond: 'deny', paidTools: 'allow' },
    });
    await send('你好');
    expect(fake.starts[0]).toMatchObject({
      workplace: { kind: 'cloud' },
      permissions: { access: 'full', beyond: 'deny', paidTools: 'allow' },
    });
  });

  it('只改权限：不开新话题，下一轮接着原会话、用新权限；一轮进行中也能改', async () => {
    const first = (await send('写个脚本')).turn!.runId;
    const changed = await setup({
      workplace: { kind: 'cloud' },
      permissions: { access: 'full', beyond: 'deny', paidTools: 'ask' },
    });
    expect(changed.message).toBeNull();
    expect(changed.conversation.permissions.paidTools).toBe('ask');
    expect(fake.purged).toEqual([]);
    await finish(first);
    await send('再加个参数');
    expect(fake.starts[1]).toMatchObject({
      continueFrom: first,
      permissions: { paidTools: 'ask' },
    });
  });

  it('换到电脑上：原来的会话清掉、插一条分隔，下一轮从头开始、在电脑上做；一轮进行中不能换地方', async () => {
    const first = (await send('写个脚本')).turn!.runId;
    const permissions = { access: 'project', beyond: 'ask', paidTools: 'allow' } as const;
    await expect(setup({ workplace: DEVICE, permissions })).rejects.toMatchObject({
      statusCode: 409,
      code: 'turn_active',
    });
    await finish(first);
    const moved = await setup({ workplace: DEVICE, permissions });
    expect(fake.purged).toEqual([`harness:${conversation.id}`]);
    expect(moved.message).toMatchObject({
      kind: 'topic',
      content: '换到你的电脑（D:\\Projects\\blog）干活，开了新话题',
    });
    expect(moved.conversation).toMatchObject({ workplace: DEVICE, permissions });
    await send('改一下 README');
    expect(fake.starts[1]).not.toHaveProperty('continueFrom');
    expect(fake.starts[1]).toMatchObject({ workplace: DEVICE, permissions });
    // 原样再存一次不算换地方
    expect((await setup({ workplace: DEVICE, permissions })).message).toBeNull();
  });
});

describe('确认卡', () => {
  it('model-gateway 那边在等用户点的卡放进这一轮；允许一次：卡收起，权限不变', async () => {
    await setup({
      workplace: DEVICE,
      permissions: { access: 'project', beyond: 'ask', paidTools: 'allow' },
    });
    const runId = (await send('把日志挪到 D:\\logs')).turn!.runId;
    const card = confirmation();
    activity.confirmations = [card];
    await cardsShown(1);
    expect((await dms.listMessages(OWNER, conversation.id)).turn?.confirmations).toEqual([card]);
    const decided = await confirm(card.id, 'once');
    expect(decided).toMatchObject({ id: card.id, status: 'allowed' });
    expect(decisions).toEqual([{ id: card.id, runId, decision: 'once' }]);
    expect((await turnOf())?.confirmations).toEqual([]);
    expect((await repo.find(conversation.id))?.permissions?.beyond).toBe('ask');
  });

  it('以后都允许：同类的卡一起收起，私聊的权限改成直接允许（命令）或不问（花钱的工具）', async () => {
    await setup({
      workplace: DEVICE,
      permissions: { access: 'project', beyond: 'ask', paidTools: 'ask' },
    });
    await send('整理项目，再配一张封面图');
    const command = confirmation();
    const another = confirmation({ callId: 'call-2' });
    const tool = confirmation({
      kind: 'tool',
      text: '生成图片（x/fast），最多 $0.04',
      callId: null,
    });
    activity.confirmations = [command, another, tool];
    await cardsShown(3);
    await confirm(command.id, 'always');
    expect((await turnOf())?.confirmations).toEqual([tool]);
    expect((await repo.find(conversation.id))?.permissions).toEqual({
      access: 'project',
      beyond: 'allow',
      paidTools: 'ask',
    });
    await confirm(tool.id, 'always');
    expect((await repo.find(conversation.id))?.permissions?.paidTools).toBe('allow');
  });

  it('拒绝：卡收起、权限不变；这一轮结束了再点就说不用确认了', async () => {
    const runId = (await send('删掉旧文件')).turn!.runId;
    const card = confirmation();
    activity.confirmations = [card];
    await cardsShown(1);
    expect(await confirm(card.id, 'deny')).toMatchObject({ status: 'denied' });
    expect((await turnOf())?.confirmations).toEqual([]);
    await finish(runId);
    await expect(confirm(card.id, 'once')).rejects.toMatchObject({
      statusCode: 409,
      code: 'turn_not_active',
    });
  });
});
