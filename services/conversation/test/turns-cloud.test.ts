// 私聊里的云端任务：「在云端做」单独派出去，有自己的会话，和私聊自己那一轮互不挡；点名这个任务就接着它做；
// 删私聊时一起清。
import { describe, expect, it } from 'vitest';
import type { TaskCard } from '@oasis/contracts/conversation';
import {
  OWNER,
  event,
  fake,
  repo,
  dms,
  conversation,
  send,
  until,
  finished,
} from './support/turn-fixture.ts';

/** 让这一轮说一句、交出这些文件、做完 */
async function finish(runId: string, outputs: string[] = []) {
  fake.events.set(runId, [event(1, 'assistant_text', { text: '做好了' })]);
  Object.assign(fake.runs.get(runId)!, {
    status: 'succeeded',
    finishedAt: new Date().toISOString(),
    outputs: outputs.map((path) => ({ path, size: 10, sha256: 'a'.repeat(64) })),
  });
  await until(() => ![...repo.conversations.values()].some((row) => row.turn?.runId === runId));
}
const cards = () =>
  repo.messages.flatMap((m) => (m.kind === 'task' ? [m.data as unknown as TaskCard] : []));

describe('私聊里的云端任务', () => {
  it('在云端做：私聊自己那一轮还在做也马上开工，用自己的会话；点名这个任务接着它做，算在原来那张卡上；删私聊一起清', async () => {
    const home = (await send('聊聊这个季度的计划')).turn!.runId;
    const sent = await send('另外做一张海报', { task: true });
    // 不排队：这句话上记着是派出去的任务，马上有一轮
    expect(sent.messages[0]).toMatchObject({ role: 'user', data: { task: true } });
    expect(sent.messages[0]!.data).not.toHaveProperty('pending');
    expect(sent.turn?.runId).toBe(home);
    expect(fake.starts).toHaveLength(2);
    const start = fake.starts[1]!;
    const taskId = String(start.conversationId);
    expect(taskId).not.toBe(conversation.id);
    expect(repo.conversations.get(taskId)).toMatchObject({
      kind: 'task',
      parentId: conversation.id,
      ownerId: OWNER,
      options: { room: 'dm' },
    });
    // 花自己的钱包，在云端沙箱，带过去的只有这句话
    expect(start).toMatchObject({ payerId: OWNER, workplace: { kind: 'cloud' } });
    expect(start.actorId).toBeUndefined();
    expect(start.continueFrom).toBeUndefined();
    expect(String(start.prompt)).toContain('另外做一张海报');
    expect(String(start.prompt)).not.toContain('这个季度');
    await finish(String(start.runId), ['海报.png']);
    expect(cards()).toMatchObject([{ runId: start.runId, status: 'done', seat: taskId }]);
    // 私聊自己那一轮没受影响
    expect((await repo.find(conversation.id))?.turn?.runId).toBe(home);

    // ---- 点名这个任务：接着它的会话做，算在原来那张卡上；它还在做时先别发 ----
    await send('标题再大一点', { seat: taskId });
    const again = fake.starts[2]!;
    expect(again).toMatchObject({ conversationId: taskId, continueFrom: start.runId });
    await expect(send('颜色也换一下', { seat: taskId })).rejects.toMatchObject({
      statusCode: 409,
      code: 'task_running',
    });
    await finish(String(again.runId), ['海报.png']);
    expect(cards()).toMatchObject([
      { status: 'done', revision: 1, runs: [start.runId, again.runId] },
    ]);

    await finish(home);
    await finished();
    // ---- 删私聊：云端任务的会话一起清 ----
    fake.purged.length = 0;
    await dms.deleteDm(OWNER, conversation.id, 'r');
    expect(fake.purged).toContain(`harness:${taskId}`);
    expect(fake.purged).toContain(`harness:${conversation.id}`);
  });
});
