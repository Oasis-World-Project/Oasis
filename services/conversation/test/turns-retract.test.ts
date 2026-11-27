// 删掉我的最后一句（编辑也是先删）：这句话、AI 对它的回复、随它发的文件真删除，AI 的记忆退回这句话之前
//（harness 撤回那一轮），之后接着它之前的那一轮；任务卡和成果留着。不是最后一句、派到云端的、一轮还在做、
// 之前的记忆没存下来的删不了。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  conversation,
  deletedUploads,
  event,
  fake,
  remove,
  repo,
  run,
  send,
  until,
} from './support/turn-fixture.ts';

/** 说一句、等 AI 回完这一轮 */
async function turn(text: string, reply: string, extra: Parameters<typeof send>[1] = {}) {
  const runId = (await send(text, extra)).turn!.runId;
  fake.events.set(runId, [event(1, 'assistant_text', { text: reply })]);
  fake.runs.set(
    runId,
    run(runId, {
      conversationId: conversation.id,
      status: 'succeeded',
      finishedAt: new Date().toISOString(),
    }),
  );
  await until(async () => ((await repo.find(conversation.id))?.turn ? undefined : true));
  return runId;
}
const said = () => repo.messages.map((m) => m.content);

describe('删掉我的最后一句', () => {
  it('这句话、AI 的回复、随它发的文件一起删；撤回那一轮，下一句接着它之前的那一轮', async () => {
    const first = await turn('暗号是青柠', '记住了');
    const photo = randomUUID();
    const second = await turn('把暗号写进文件', '写好了', { attachments: [photo] });
    expect((await repo.find(conversation.id))?.lastRunId).toBe(second);

    fake.undoTo = first;
    await remove('把暗号写进文件');
    expect(fake.undone).toEqual([second]);
    expect(said()).toEqual(['暗号是青柠', '记住了']);
    expect(deletedUploads).toEqual([[photo]]);
    expect((await repo.find(conversation.id))?.lastRunId).toBe(first);

    await send('暗号是什么');
    expect(fake.starts.at(-1)).toMatchObject({ continueFrom: first });
  });

  it('删的是这份会话的第一句：下一句开新会话', async () => {
    await turn('做个网页', '做好了');
    await remove('做个网页');
    expect(said()).toEqual([]);
    expect((await repo.find(conversation.id))?.lastRunId).toBeNull();
    await send('重新说');
    expect(fake.starts.at(-1)).not.toHaveProperty('continueFrom');
  });

  it('删不了的：不是最后一句、派到云端的、之前的记忆没存下来的——什么都不动', async () => {
    await turn('第一句', '好');
    const second = await turn('第二句', '好的');
    await expect(remove('第一句')).rejects.toMatchObject({ statusCode: 409, code: 'not_last' });

    fake.undoError = { status: 409, code: 'session_version_gone', message: '没存下来' };
    await expect(remove('第二句')).rejects.toMatchObject({
      statusCode: 409,
      code: 'session_version_gone',
    });
    expect(said()).toEqual(['第一句', '好', '第二句', '好的']);
    expect((await repo.find(conversation.id))?.lastRunId).toBe(second);

    fake.undoError = undefined;
    await send('另外做一张海报', { task: true });
    await expect(remove('另外做一张海报')).rejects.toMatchObject({
      statusCode: 409,
      code: 'not_retractable',
    });
  });

  it('云端任务说的话不算 AI 对这句话的回复：留着', async () => {
    const first = await turn('第一句', '好');
    const cloud = String((await send('做一张海报', { task: true })).messages.at(-1)?.data.runId);
    await turn('第二句', '好的');
    fake.events.set(cloud, [event(1, 'assistant_text', { text: '海报在做了' })]);
    await until(() => repo.messages.find((m) => m.content === '海报在做了'));

    fake.undoTo = first;
    await expect(remove('做一张海报')).rejects.toMatchObject({ code: 'not_retractable' });
    await remove('第二句');
    expect(said()).toEqual(['第一句', '好', '做一张海报', '海报在做了']);
  });
});
