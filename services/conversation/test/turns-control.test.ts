// 私聊里的一轮：插话、停止、出错、开不了、接不上原会话、服务重启后接着跟进。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  OWNER,
  SESSION,
  event,
  fake,
  run,
  activity,
  uploadLookups,
  PAGE,
  repo,
  turns,
  dms,
  conversation,
  restartTurns,
  send,
  steer,
  remove,
  until,
  finished,
  aiMessages,
} from './support/turn-fixture.ts';

describe('排队、插话、停止、出错', () => {
  it('一轮进行中再说的话先排队；点「引导」才送进这一轮，AI 看到它时才分段：之前说的留在插话前面，之后的写进插话后面的新消息', async () => {
    const runId = (await send('做个视频')).turn!.runId;
    const events = [
      event(0, 'user_message', { text: '做个视频' }),
      event(1, 'assistant_text', { text: '先写分镜' }),
    ];
    fake.events.set(runId, events);
    await until(() => (aiMessages()[0]?.content ? aiMessages()[0] : undefined));
    const queued = await send('改成竖屏');
    expect(queued.messages.map((m) => [m.role, m.content])).toEqual([['user', '改成竖屏']]);
    expect(queued.messages[0]?.data).toEqual({ pending: true });
    expect(fake.interjections).toEqual([]);
    const added = await steer('改成竖屏');
    expect(fake.interjections).toEqual([{ runId, text: '改成竖屏' }]);
    expect(added.messages.map((m) => [m.role, m.content])).toEqual([['user', '改成竖屏']]);
    expect(added.messages[0]?.data).toEqual({ runId, interjection: true });
    // AI 做完手上这一步才看到插话：在那之前说的还写在插话前面那条
    events.push(event(2, 'assistant_text', { text: '分镜写好了' }));
    await until(() => aiMessages()[0]?.content.includes('分镜写好了'));
    expect(aiMessages()).toHaveLength(1);
    events.push(
      event(3, 'user_message', { text: '改成竖屏', interjection: true }),
      event(4, 'assistant_text', { text: '好，改成竖屏' }),
    );
    await until(() => (aiMessages()[1]?.content ? aiMessages()[1] : undefined));
    expect(aiMessages()[0]).toMatchObject({ status: 'complete' });
    expect(repo.messages.map((m) => m.content)).toEqual([
      '做个视频',
      '先写分镜\n\n分镜写好了',
      '改成竖屏',
      '好，改成竖屏',
    ]);
    // 连着插两句、AI 一起看到：中间什么都没写的那条去掉，不留空白气泡
    for (const text of ['再快一点', '配上字幕']) {
      await send(text);
      await steer(text);
    }
    events.push(
      event(5, 'user_message', { text: '再快一点', interjection: true }),
      event(6, 'user_message', { text: '配上字幕', interjection: true }),
      event(7, 'assistant_text', { text: '都改好了' }),
    );
    await until(() => aiMessages().at(-1)?.content === '都改好了');
    expect(aiMessages().filter((m) => m.status === 'streaming')).toHaveLength(1);
    expect(repo.messages.map((m) => m.content)).toEqual([
      '做个视频',
      '先写分镜\n\n分镜写好了',
      '改成竖屏',
      '好，改成竖屏',
      '再快一点',
      '配上字幕',
      '都改好了',
    ]);
    // 带文件、带要改的成果的话要等这一轮做完（文件只在一轮开始时放进工作目录）
    for (const extra of [{ attachments: [randomUUID()] }, { artifacts: [PAGE] }])
      await expect(send('加这张图', extra)).rejects.toMatchObject({
        statusCode: 409,
        code: 'turn_active',
      });
    expect(uploadLookups).toEqual([]);
  });

  it('AI 看到插话时还没做完的一步挪进插话后面的那条，它的结果写在那边', async () => {
    const runId = (await send('做个视频')).turn!.runId;
    fake.events.set(runId, [
      event(1, 'assistant_text', { text: '先写分镜' }),
      event(2, 'tool_call', { callId: 'c1', name: 'bash', label: '生成分镜' }),
    ]);
    await until(() => (aiMessages()[0]?.data.parts as unknown[] | undefined)?.length === 2);
    await send('改成竖屏');
    await steer('改成竖屏');
    fake.events
      .get(runId)!
      .push(
        event(3, 'user_message', { text: '改成竖屏', interjection: true }),
        event(4, 'tool_result', { callId: 'c1', ok: true, text: 'ok' }),
      );
    const [before, after] = await until(() => {
      const parts = aiMessages()[1]?.data.parts as { status?: string }[] | undefined;
      return parts?.[0]?.status === 'done' ? aiMessages() : undefined;
    });
    expect(before?.data.parts).toEqual([{ type: 'text', text: '先写分镜' }]);
    expect(after?.data.parts).toEqual([
      {
        type: 'step',
        id: 'c1',
        tool: 'bash',
        label: '生成分镜',
        status: 'done',
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      },
    ]);
  });

  it('写进度和用户发话错开：发话占着锁时先不写，放开后写进那时正在写的那条；发话等一会儿就能拿到锁', async () => {
    const runId = (await send('做个视频')).turn!.runId;
    await repo.withLock('message', conversation.id, async () => {
      fake.events.set(runId, [event(1, 'assistant_text', { text: '先写分镜' })]);
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(aiMessages()[0]?.content).toBe('');
    });
    await until(() => aiMessages()[0]?.content === '先写分镜');
    // 锁被占着时发话、引导：等它放开再做，不报「正在处理」
    const hold = () =>
      repo.withLock(
        'message',
        conversation.id,
        () => new Promise((resolve) => setTimeout(resolve, 300)),
      );
    let held = hold();
    const added = await send('改成竖屏');
    await held;
    expect(added.messages[0]).toMatchObject({ content: '改成竖屏', data: { pending: true } });
    held = hold();
    const steered = await steer('改成竖屏');
    await held;
    expect(steered.messages[0]).toMatchObject({ data: { interjection: true } });
  });

  it('排着队的话：能删掉；引导的那句挪到聊天最后；这一轮做完，剩下的接着开下一轮，也挪到最后', async () => {
    const first = (await send('写首诗')).turn!.runId;
    const events = [event(0, 'user_message', { text: '写首诗' })];
    fake.events.set(first, events);
    for (const text of ['写春天', '要七言的', '算了不要了']) await send(text);
    await remove('算了不要了');
    expect(repo.messages.some((m) => m.content === '算了不要了')).toBe(false);
    await steer('要七言的');
    events.push(
      event(1, 'user_message', { text: '要七言的', interjection: true }),
      event(2, 'assistant_text', { text: '好，七言' }),
    );
    await until(() => aiMessages().find((m) => m.content === '好，七言'));
    // 已经交给 AI 的不在队里了：不能再引导；这一轮还在做，也删不了
    await expect(steer('要七言的')).rejects.toMatchObject({
      statusCode: 404,
      code: 'queued_message_not_found',
    });
    for (const said of ['要七言的', '写首诗'])
      await expect(remove(said)).rejects.toMatchObject({ statusCode: 409, code: 'turn_active' });
    fake.runs.set(first, run(first, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    const second = await until(() => (fake.starts.length === 2 ? fake.starts[1] : undefined));
    expect(second).toMatchObject({ prompt: '写春天', continueFrom: first });
    expect(repo.messages.find((m) => m.content === '写春天')?.data).toEqual({
      runId: second.runId,
    });
    // 聊天按交给 AI 的先后排：先发但后交给 AI 的「写春天」在「好，七言」后面
    expect(repo.messages.map((m) => [m.authorKind, m.content])).toEqual([
      ['user', '写首诗'],
      ['user', '要七言的'],
      ['ai', '好，七言'],
      ['user', '写春天'],
      ['ai', ''],
    ]);
  });

  it('这一轮在交接或收尾、引导送不进去：告诉用户，这句还排着，做完接着开下一轮', async () => {
    const first = (await send('写首诗')).turn!.runId;
    await send('要七言的');
    fake.interjectStatus = 409;
    await expect(steer('要七言的')).rejects.toMatchObject({
      statusCode: 409,
      code: 'turn_not_ready',
    });
    expect(repo.messages.find((m) => m.content === '要七言的')?.data).toEqual({ pending: true });
    fake.interjectStatus = 202;
    fake.runs.set(first, run(first, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    const second = await until(() => (fake.starts.length === 2 ? fake.starts[1] : undefined));
    expect(second).toMatchObject({ prompt: '要七言的', continueFrom: first });
    expect(fake.interjections).toEqual([]);
  });

  it('没有在进行的一轮时引导（比如收尾没接上）：用这句开一轮', async () => {
    await repo.insertMessage({
      conversationId: conversation.id,
      authorKind: 'user',
      authorId: OWNER,
      content: '接着写',
      status: 'complete',
      data: { pending: true },
    });
    const result = await steer('接着写');
    expect(fake.starts).toHaveLength(1);
    expect(fake.starts[0]).toMatchObject({ prompt: '接着写' });
    expect(result.turn?.runId).toBe(fake.starts[0]!.runId);
    expect(result.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('停止：这一轮停下，AI 消息标成已停下、步骤算没做完；任务卡写「已停下」', async () => {
    const runId = (await send('生成三张图')).turn!.runId;
    Object.assign(activity, { spentMicro: 5_000, tools: ['image.generate'] });
    fake.events.set(runId, [
      event(1, 'tool_call', { callId: 'c', name: 'bash', label: '生成图片：猫' }),
    ]);
    await until(() => repo.messages.find((m) => m.kind === 'task'));
    await dms.stop(OWNER, conversation.id);
    expect(fake.stops).toEqual([runId]);
    fake.runs.set(runId, run(runId, { status: 'stopped', error: '已停止' }));
    await finished();
    expect(aiMessages()[0]).toMatchObject({ status: 'complete', data: { stopped: true } });
    expect((aiMessages()[0]?.data.parts as { status: string }[])[0]).toMatchObject({
      status: 'failed',
      detail: '没做完',
    });
    expect(repo.messages.find((m) => m.kind === 'task')?.data).toMatchObject({ status: 'stopped' });
  });

  it('出错：AI 消息写清原因、说「继续」接着做（下一轮接着原会话）', async () => {
    const runId = (await send('做个表格')).turn!.runId;
    fake.runs.set(runId, run(runId, { status: 'failed', error: '上游 500' }));
    await finished();
    expect(aiMessages()[0]).toMatchObject({
      status: 'failed',
      error: '这一轮出错了：上游 500。说「继续」可以接着做',
    });
    await send('继续');
    expect(fake.starts[1]).toMatchObject({ prompt: '继续', continueFrom: runId });
  });

  it('开不了这一轮（如打开了「只用国内模型」、国外的 AI 暂停）：AI 消息写上原因，不留进行中的一轮', async () => {
    fake.startError = {
      status: 409,
      code: 'model_out_of_scope',
      message: '已打开「只用国内模型」',
    };
    const result = await send('你好');
    expect(result.turn).toBeNull();
    expect(result.messages[1]).toMatchObject({
      role: 'assistant',
      status: 'failed',
      error: '已打开「只用国内模型」',
    });
    expect((await repo.find(conversation.id))?.turn).toBeNull();
  });

  it('接不上原会话（工作目录不在了）：这一轮开新会话，并提示 AI 不记得之前的事', async () => {
    repo.conversations.get(conversation.id)!.lastRunId = SESSION;
    fake.sessionGone = true;
    const result = await send('接着改');
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[1]).not.toHaveProperty('continueFrom');
    expect(result.messages[1]?.data).toMatchObject({
      parts: [{ type: 'notice', text: expect.stringContaining('从头开始') }],
    });
  });

  it('开一轮交接的这一会儿 harness 里还没有它（这时刷新了私聊页）：接着等，不算没开成', async () => {
    const runId = (await send('你好')).turn!.runId;
    const handed = fake.runs.get(runId)!;
    fake.runs.delete(runId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(aiMessages()[0]).toMatchObject({ status: 'streaming' });
    fake.runs.set(runId, { ...handed, status: 'succeeded', finishedAt: new Date().toISOString() });
    await finished();
    expect(aiMessages()[0]).toMatchObject({ status: 'complete' });
  });

  it('harness 里没有这一轮（没开成就重启了）：过了交接的时间算出错收尾', async () => {
    const runId = (await send('你好')).turn!.runId;
    fake.runs.delete(runId);
    const stored = repo.conversations.get(conversation.id)!;
    stored.turn = { ...stored.turn!, startedAt: new Date(Date.now() - 2 * 60_000).toISOString() };
    await finished();
    expect(aiMessages()[0]).toMatchObject({ status: 'failed' });
  });

  it('服务重启后接着跟进没结束的轮', async () => {
    const runId = (await send('做个网页')).turn!.runId;
    await turns.close();
    fake.runs.set(runId, run(runId, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    await restartTurns().resumeAll();
    await finished();
    expect(aiMessages()[0]).toMatchObject({ status: 'complete' });
  });
});
