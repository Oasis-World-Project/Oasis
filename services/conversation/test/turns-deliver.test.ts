// 做好一个就进画布：一轮进行中，做完的步骤存下的 out/ 里的文件登记进画布、写到任务卡上；结束时按
// 产出清单再登记一遍。画布按任务分用的任务列表。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  activity,
  conversation,
  dms,
  event,
  fake,
  finished,
  OWNER,
  registered,
  repo,
  run,
  send,
  unreadable,
  until,
} from './support/turn-fixture.ts';

const taskCard = () => repo.messages.find((m) => m.kind === 'task');
const cardFiles = () => (taskCard()?.data.files ?? []) as { path: string }[];

describe('做好一个就进画布', () => {
  it('进行中做完的步骤存下的 out/ 文件马上登记、写到任务卡上；别处的、隐藏的不登记；结束时再登记一遍', async () => {
    const runId = (await send('画两张海报')).turn!.runId;
    fake.events.set(runId, [
      event(0, 'user_message', { text: '画两张海报' }),
      event(1, 'tool_call', {
        callId: 'c1',
        name: 'bash',
        label: '生成图片',
        oasisTool: 'image.generate',
      }),
      event(2, 'tool_result', {
        callId: 'c1',
        ok: true,
        files: ['out/素材/海报-1.png', 'work/草稿.png', 'out/.oasis-tools/x.json'],
      }),
    ]);
    await until(() => cardFiles().length || undefined);
    expect(registered[0]).toMatchObject({
      runId,
      task: '画两张海报',
      outputs: [{ path: '素材/海报-1.png' }],
    });
    expect(taskCard()?.data).toMatchObject({
      runId,
      title: '画两张海报',
      status: 'running',
      files: [{ path: '素材/海报-1.png' }],
    });

    // 又做好两个，其中一个读不到：不挡别的
    unreadable.add('素材/坏的.png');
    fake.events.get(runId)!.push(
      event(3, 'tool_call', {
        callId: 'c2',
        name: 'write',
        label: '写文件',
        path: 'out/海报-2.png',
      }),
      event(4, 'tool_result', { callId: 'c2', ok: true }),
      event(5, 'tool_call', { callId: 'c3', name: 'bash', label: '生成图片' }),
      event(6, 'tool_result', { callId: 'c3', ok: true, files: ['out/素材/坏的.png'] }),
    );
    await until(() => cardFiles().length === 2 || undefined);
    await until(
      async () => (await repo.find(conversation.id))?.turn?.delivering?.length === 0 || undefined,
    );

    // 结束：按产出清单再登记一遍，任务卡上是这一轮的全部成果
    fake.runs.set(
      runId,
      run(runId, {
        status: 'succeeded',
        outputs: [{ path: '海报-2.png', size: 1, sha256: 'b'.repeat(64) }],
        finishedAt: new Date().toISOString(),
      }),
    );
    fake.events.get(runId)!.push(event(7, 'turn_end', { reason: 'completed' }));
    await finished();
    expect(registered.at(-1)).toMatchObject({
      outputs: [{ path: '海报-2.png', size: 1, sha256: 'b'.repeat(64) }],
    });
    expect(taskCard()?.data).toMatchObject({ status: 'done', title: '画两张海报' });
    expect(
      cardFiles()
        .map((file) => file.path)
        .sort(),
    ).toEqual(['海报-2.png', '素材/海报-1.png']);
  });

  it('画布的任务列表：这个人私聊里的任务卡，新的在前，带上在哪个私聊', async () => {
    const first = (await send('画一只猫')).turn!.runId;
    Object.assign(activity, { tools: ['image.generate'] });
    await until(taskCard);
    fake.runs.set(first, run(first, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    await finished();
    const second = (await send('再画一只狗')).turn!.runId;
    await until(() => repo.messages.filter((m) => m.kind === 'task').length === 2 || undefined);
    const tasks = await dms.listTasks(OWNER);
    expect(tasks.map((t) => [t.runId, t.title, t.status, t.conversationId])).toEqual([
      [second, '再画一只狗', 'running', conversation.id],
      [first, '画一只猫', 'done', conversation.id],
    ]);
    expect(await dms.listTasks(randomUUID())).toEqual([]);
    fake.runs.set(
      second,
      run(second, { status: 'succeeded', finishedAt: new Date().toISOString() }),
    );
    await finished();
  });
});
