// 私聊里的一轮：让 AI 改画布里的成果；开新话题、删对话。
import { randomUUID } from 'node:crypto';
import type { HttpError } from '@oasis/service-kit';
import { describe, expect, it } from 'vitest';
import {
  OWNER,
  SESSION,
  fake,
  run,
  deletedUploads,
  uploadLookups,
  OLD_SESSION,
  PAGE,
  OLD_PAGE,
  POSTER,
  inCanvas,
  repo,
  dms,
  conversation,
  send,
  finished,
} from './support/turn-fixture.ts';

describe('让 AI 改画布里的成果', () => {
  const PREVIOUS = '7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a';
  /** 上一轮在 SESSION 这个会话里做完 */
  const continuing = () => {
    repo.conversations.get(conversation.id)!.lastRunId = PREVIOUS;
    fake.runs.set(PREVIOUS, run(PREVIOUS, { status: 'succeeded' }));
  };

  it('这个话题做的：就在工作目录里，告诉 AI 直接改 out/ 里的原文件，不拷文件', async () => {
    continuing();
    const result = await send('1. 标题改成蓝色', { artifacts: [PAGE] });
    expect(fake.starts[0]).toMatchObject({ continueFrom: PREVIOUS, materials: [] });
    expect(fake.starts[0]?.prompt).toBe(
      '1. 标题改成蓝色\n\n（要改的成果就在工作目录里，直接改：out/site/index.html）',
    );
    expect(result.messages[0]?.data).toEqual({
      artifacts: [{ id: PAGE, name: 'index.html', path: 'site/index.html' }],
      runId: fake.starts[0]?.runId,
    });
  });

  it('之前话题做的：连同网页用到的文件拷进 materials/canvas/<话题文件夹>/，改好的放进 out/；和用户发的文件一起', async () => {
    const photo = randomUUID();
    await send('照这张图改', { attachments: [photo], artifacts: [OLD_PAGE, POSTER] });
    const files = inCanvas.filter((a) => a.sessionId === OLD_SESSION);
    expect(fake.starts[0]?.materials).toEqual([
      { uploadId: photo, path: 'materials/照片.jpg' },
      ...files.map((a) => ({ artifactId: a.id, path: `materials/canvas/旧话题/${a.path}` })),
    ]);
    expect(fake.starts[0]?.prompt).toBe(
      [
        '照这张图改',
        '',
        '（随消息发来的文件，在工作目录里：materials/照片.jpg（2.0 MB））',
        '（要改的成果是之前的话题做的，已经连同它用到的文件拷进工作目录：materials/canvas/旧话题/web/index.html、materials/canvas/旧话题/poster.png；改好的放进 out/）',
      ].join('\n'),
    );
  });

  it('接不上原会话：这一轮开新会话，成果改成拷进来', async () => {
    continuing();
    fake.sessionGone = true;
    await send('标题改成蓝色', { artifacts: [PAGE] });
    expect(fake.starts).toHaveLength(2);
    expect(fake.starts[0]).toMatchObject({ continueFrom: PREVIOUS, materials: [] });
    expect(fake.starts[1]).not.toHaveProperty('continueFrom');
    expect(fake.starts[1]?.materials).toEqual(
      inCanvas
        .filter((a) => a.sessionId === SESSION)
        .map((a) => ({ artifactId: a.id, path: `materials/canvas/网页/${a.path}` })),
    );
    expect(fake.starts[1]?.prompt).toContain(
      'materials/canvas/网页/site/index.html；改好的放进 out/',
    );
  });

  it('成果不在了：整条消息不收，带的文件也不标成已用上', async () => {
    await expect(
      send('改一下', { attachments: [randomUUID()], artifacts: [randomUUID()] }),
    ).rejects.toMatchObject({ statusCode: 400, code: 'artifact_not_found' });
    expect(uploadLookups).toEqual([]);
    expect(repo.messages).toEqual([]);
    expect(fake.starts).toEqual([]);
  });
});

describe('开新话题、删对话', () => {
  it('开新话题：清掉 AI 的会话和工作目录（聊天记录留着），下一轮开新会话；一轮进行中不能开', async () => {
    const runId = (await send('你好')).turn!.runId;
    await expect(dms.newTopic(OWNER, conversation.id, 'r')).rejects.toMatchObject({
      code: 'turn_active',
    });
    fake.runs.set(runId, run(runId, { status: 'succeeded', finishedAt: new Date().toISOString() }));
    await finished();
    const divider = await dms.newTopic(OWNER, conversation.id, 'r');
    expect(divider).toMatchObject({ kind: 'topic', role: 'user' });
    expect(fake.purged).toEqual([`harness:${conversation.id}`]);
    expect(await repo.find(conversation.id)).toMatchObject({ lastRunId: null });
    await send('新的事');
    expect(fake.starts[1]).not.toHaveProperty('continueFrom');
    expect((await repo.find(conversation.id))?.turn?.title).toBe('新的事');
  });

  it('删对话：先取消正在进行的一轮，再清掉 AI 的工作目录、工具结果、画布成品和附件，消息全删', async () => {
    const file = { id: randomUUID() };
    const runId = (await send('看看这张图', { attachments: [file.id] })).turn!.runId;
    await dms.deleteDm(OWNER, conversation.id, 'r');
    expect(fake.cancels).toEqual([runId]);
    expect(fake.purged).toEqual([
      `harness:${conversation.id}`,
      `model-gateway:${conversation.id}`,
      `canvas:${conversation.id}`,
    ]);
    expect(deletedUploads).toEqual([[file.id]]);
    expect(await repo.find(conversation.id)).toBeUndefined();
    expect(repo.messages).toEqual([]);
    await expect(dms.listMessages(OWNER, conversation.id)).rejects.toMatchObject({
      statusCode: 404,
    } satisfies Partial<HttpError>);
  });
});
