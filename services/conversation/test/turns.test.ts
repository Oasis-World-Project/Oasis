// 私聊里的一轮：事件写进 AI 的消息；发消息开一轮，跟进到结束（登记成品、任务卡、花费）。
import { randomUUID } from 'node:crypto';
import { applyEvents, settleSteps } from '../src/service/turn-parts.ts';
import { describe, expect, it } from 'vitest';
import {
  OWNER,
  SESSION,
  ARTIFACT,
  event,
  fake,
  run,
  spend,
  registered,
  scope,
  repo,
  conversation,
  send,
  until,
  finished,
  aiMessages,
} from './support/turn-fixture.ts';

describe('AI 消息怎么写', () => {
  it('说的话、做的步骤（结果）、待办、服务恢复的提示；空白的话和子任务的事件不写', () => {
    const segment = applyEvents({ parts: [] }, [
      event(0, 'user_message', { text: '做个网页' }),
      event(1, 'assistant_text', { text: '好，先写页面' }),
      event(2, 'assistant_text', { text: '  \n' }),
      event(3, 'tool_call', { callId: 'c1', name: 'write', label: '写文件 out/index.html' }),
      event(4, 'tool_call', { callId: 'c2', name: 'bash', label: '运行命令：npm test' }),
      event(5, 'tool_result', { callId: 'c1', ok: true, text: 'ok' }),
      event(6, 'tool_result', { callId: 'c2', ok: false, error: '测试没过' }),
      event(7, 'todos', { items: [{ text: '写页面', status: 'doing' }] }),
      event(8, 'tool_call', { callId: 's1', name: 'bash', label: 'x', parentSessionId: 'p' }),
      event(9, 'status', { status: 'recovering' }),
      event(10, 'status', { status: 'idle' }),
    ]);
    expect(segment).toEqual({
      parts: [
        { type: 'text', text: '好，先写页面' },
        { type: 'step', id: 'c1', tool: 'write', label: '写文件 out/index.html', status: 'done' },
        {
          type: 'step',
          id: 'c2',
          tool: 'bash',
          label: '运行命令：npm test',
          status: 'failed',
          detail: '测试没过',
        },
        { type: 'notice', text: '服务恢复了，接着做' },
      ],
      todos: [{ text: '写页面', status: 'doing' }],
    });
    // 结束时还没做完的步骤：正常做完算完成，停下、出错算没做完
    const running = applyEvents({ parts: [] }, [
      event(0, 'tool_call', { callId: 'c', name: 'bash', label: '运行命令：sleep' }),
    ]);
    expect(settleSteps(running, true).parts[0]).toMatchObject({ status: 'done' });
    expect(settleSteps(running, false).parts[0]).toMatchObject({
      status: 'failed',
      detail: '没做完',
    });
  });
});

describe('开一轮、跟进到结束', () => {
  it('发消息开一轮：型号、人设、「只用国内模型」、附件放进 materials/（同名加序号）、接着上一轮的会话', async () => {
    scope.domesticOnly = true;
    repo.conversations.get(conversation.id)!.lastRunId = SESSION;
    const files = [
      { id: randomUUID(), name: '照片.jpg', size: 2 * 1024 * 1024, contentType: 'image/jpeg' },
      { id: randomUUID(), name: '照片.jpg', size: 2 * 1024 * 1024, contentType: 'image/jpeg' },
    ];
    const result = await send('照着这两张图做海报', { attachments: files.map((f) => f.id) });
    expect(fake.starts[0]).toMatchObject({
      payerId: OWNER,
      conversationId: conversation.id,
      model: 'deepseek/deepseek-v4.1-flash',
      persona: '你是 DeepSeek',
      domesticOnly: true,
      continueFrom: SESSION,
      materials: [
        { uploadId: files[0]!.id, path: 'materials/照片.jpg' },
        { uploadId: files[1]!.id, path: 'materials/2-照片.jpg' },
      ],
    });
    expect(fake.starts[0]?.prompt).toBe(
      '照着这两张图做海报\n\n（随消息发来的文件，在工作目录里：materials/照片.jpg（2.0 MB）、materials/2-照片.jpg（2.0 MB））',
    );
    const runId = String(fake.starts[0]?.runId);
    expect(result.turn).toMatchObject({ runId });
    expect(result.messages.map((m) => [m.role, m.status, m.data])).toEqual([
      ['user', 'complete', { attachments: files, runId }],
      ['assistant', 'streaming', { runId, parts: [] }],
    ]);
    expect((await repo.find(conversation.id))?.topic).toBe('照着这两张图做海报');
  });

  it('跟进：AI 说的话和步骤写进消息；做完把成品登记进画布、出任务卡，写上花费；下一轮接着这一轮的会话', async () => {
    const { turn } = await send('做一个小网页');
    const runId = turn!.runId;
    fake.events.set(runId, [
      event(0, 'user_message', { text: '做一个小网页' }),
      event(1, 'assistant_text', { text: '好的，我来写' }),
      event(2, 'tool_call', { callId: 'c1', name: 'write', label: '写文件 out/site/index.html' }),
    ]);
    await until(() => (aiMessages()[0]?.content === '好的，我来写' ? aiMessages()[0] : undefined));
    expect(aiMessages()[0]?.data.parts).toEqual([
      { type: 'text', text: '好的，我来写' },
      {
        type: 'step',
        id: 'c1',
        tool: 'write',
        label: '写文件 out/site/index.html',
        status: 'running',
      },
    ]);
    fake.events
      .get(runId)!
      .push(
        event(3, 'tool_result', { callId: 'c1', ok: true }),
        event(4, 'assistant_text', { text: '做好了' }),
        event(5, 'turn_end', { reason: 'completed' }),
      );
    Object.assign(spend, { spentMicro: 12_345, tools: ['web.search'] });
    fake.runs.set(
      runId,
      run(runId, {
        status: 'succeeded',
        outputs: [{ path: 'site/index.html', size: 120, sha256: 'a'.repeat(64) }],
        finishedAt: new Date().toISOString(),
      }),
    );
    await finished();
    expect(registered).toEqual([
      {
        ownerId: OWNER,
        conversationId: conversation.id,
        sessionId: SESSION,
        runId,
        topic: '做一个小网页',
        models: ['deepseek/deepseek-v4.1-flash'],
        outputs: [{ path: 'site/index.html', size: 120, sha256: 'a'.repeat(64) }],
      },
    ]);
    expect(aiMessages()[0]).toMatchObject({
      status: 'complete',
      content: '好的，我来写\n\n做好了',
      data: { runId, spentMicro: 12_345 },
    });
    const card = repo.messages.find((m) => m.kind === 'task');
    expect(card?.data).toMatchObject({
      runId,
      status: 'done',
      spentMicro: 12_345,
      files: [
        {
          artifactId: ARTIFACT,
          name: 'index.html',
          path: 'site/index.html',
          size: 120,
          category: 'app',
        },
      ],
    });
    expect(await repo.find(conversation.id)).toMatchObject({ turn: null, lastRunId: runId });
    // 下一轮接着这一轮的会话做
    await send('标题改大一点');
    expect(fake.starts[1]).toMatchObject({ continueFrom: runId });
  });

  it('只是聊天：没交文件、没用做东西的工具，就没有任务卡；进行中用了生图就先出「进行中」的任务卡', async () => {
    const chat = (await send('你好')).turn!.runId;
    fake.runs.set(chat, run(chat, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    await finished();
    expect(repo.messages.some((m) => m.kind === 'task')).toBe(false);
    expect(registered).toEqual([]);

    const task = (await send('画一只猫')).turn!.runId;
    Object.assign(spend, { spentMicro: 40_000, tools: ['image.generate'] });
    const card = await until(() => repo.messages.find((m) => m.kind === 'task'));
    expect(card.data).toMatchObject({
      runId: task,
      status: 'running',
      spentMicro: 40_000,
      files: [],
    });
    fake.runs.set(task, run(task, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    await finished();
    expect(repo.messages.filter((m) => m.kind === 'task')).toHaveLength(1);
    expect(repo.messages.find((m) => m.kind === 'task')?.data).toMatchObject({ status: 'done' });
  });
});
