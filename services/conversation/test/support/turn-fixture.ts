// 私聊一轮的测试共用：假 harness（开一轮、事件、插话、停止）、假 agent / model-gateway / canvas，
// 每个测试前换一个新的内存库、turns 和私聊服务。
import { randomUUID } from 'node:crypto';
import type { RunEventBody, RunBody } from '@oasis/contracts/harness';
import { createServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import type { Conversation } from '../../src/repo/conversation-repo.ts';
import { createDmService } from '../../src/service/dm-service.ts';
import { createTurns } from '../../src/service/turns.ts';
import { memoryRepo } from '../memory-repo.ts';
import { afterAll, afterEach, beforeAll, beforeEach } from 'vitest';

export const OWNER = '7d0c2f1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f';
export const SESSION = '5a5a5a5a-5a5a-4a5a-8a5a-5a5a5a5a5a5a';
export const ARTIFACT = '6b6b6b6b-6b6b-4b6b-8b6b-6b6b6b6b6b6b';
export const event = (seq: number, kind: RunEventBody['kind'], data: Record<string, unknown>) => ({
  seq,
  kind,
  data,
  createdAt: new Date().toISOString(),
});

/** 假 harness：开一轮、运行状态和事件由测试摆好 */
export const harness = Fastify();
export const fake = {
  starts: [] as Record<string, unknown>[],
  startError: undefined as { status: number; code: string; message: string } | undefined,
  /** 第一次开一轮时接不上原会话 */
  sessionGone: false,
  runs: new Map<string, RunBody>(),
  events: new Map<string, ReturnType<typeof event>[]>(),
  interjections: [] as { runId: string; text: string }[],
  interjectStatus: 202,
  stops: [] as string[],
  cancels: [] as string[],
  purged: [] as string[],
};
export const run = (id: string, patch: Partial<RunBody> = {}): RunBody => ({
  id,
  payerId: OWNER,
  conversationId: null,
  sessionId: SESSION,
  model: 'deepseek/deepseek-v4.1-flash',
  status: 'running',
  resumable: true,
  error: null,
  outputs: [],
  summary: null,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  finishedAt: null,
  ...patch,
});
export const fail = (status: number, code: string, message: string) => ({
  error: { code, message, requestId: 'r' },
  status,
});
harness.post('/internal/runs', async (request, reply) => {
  const body = request.body as Record<string, unknown>;
  fake.starts.push(body);
  if (fake.sessionGone && body.continueFrom) {
    fake.sessionGone = false;
    return reply.code(409).send(fail(409, 'workspace_unavailable', '原会话的工作目录已经不在了'));
  }
  if (fake.startError)
    return reply
      .code(fake.startError.status)
      .send(fail(fake.startError.status, fake.startError.code, fake.startError.message));
  const id = String(body.runId);
  fake.runs.set(id, run(id, { conversationId: String(body.conversationId) }));
  return reply.code(202).send(fake.runs.get(id));
});
harness.get('/internal/runs/:id', async (request, reply) => {
  const found = fake.runs.get((request.params as { id: string }).id);
  return found ?? reply.code(404).send(fail(404, 'run_not_found', '没有这次运行'));
});
/** 这一轮工作目录里的文件：out/ 下的有，别的没有 */
harness.get('/internal/runs/:id/workspace/*', async (request, reply) => {
  const path = (request.params as { '*': string })['*'];
  if (!path.startsWith('out/'))
    return reply.code(404).send(fail(404, 'file_not_found', '没有这个文件'));
  return reply.type('image/png').send(Buffer.from(`png:${path}`));
});
harness.get('/internal/runs/:id/events', async (request) => {
  const { after } = request.query as { after: string };
  const list = fake.events.get((request.params as { id: string }).id) ?? [];
  return { events: list.filter((e) => e.seq > Number(after)) };
});
harness.post('/internal/runs/:id/messages', async (request, reply) => {
  const runId = (request.params as { id: string }).id;
  if (fake.interjectStatus !== 202)
    return reply.code(fake.interjectStatus).send(fail(409, 'run_not_active', '这一轮已经结束'));
  fake.interjections.push({ runId, text: (request.body as { text: string }).text });
  return reply.code(202).send();
});
harness.post('/internal/runs/:id/stop', async (request, reply) => {
  fake.stops.push((request.params as { id: string }).id);
  return reply.code(202).send();
});
harness.post('/internal/runs/:id/cancel', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  fake.cancels.push(id);
  const found = fake.runs.get(id);
  if (found) found.status = 'cancelled';
  return reply.code(202).send();
});
harness.post('/internal/conversations/:id/purge', async (request, reply) => {
  fake.purged.push(`harness:${(request.params as { id: string }).id}`);
  return reply.code(204).send();
});

/** 假 agent、model-gateway、canvas */
export const others = Fastify();
export const spend = { spentMicro: 0, tools: [] as string[] };
export const registered: Record<string, unknown>[] = [];
export const deletedUploads: string[][] = [];
/** 「只用国内模型」：测试里改 */
export const scope = { domesticOnly: false };
others.get('/internal/models/:key/route', async (request) => ({
  key: (request.params as { key: string }).key,
  name: 'DeepSeek',
  providerModel: 'deepseek/deepseek-v4.1-flash',
  systemPrompt: '你是 DeepSeek',
  domesticOnly: scope.domesticOnly,
}));
others.get('/internal/v1/runs/:id/spend', async () => spend);
/** 工具目录：生图通常 30 秒（点名 x/slow 的 90 秒） */
others.get('/internal/v1/tools', async () => ({
  tools: [
    {
      key: 'image.generate',
      name: '生成图片',
      description: '',
      usage: '',
      unit: '张',
      estimateMicro: 1,
      long: false,
      available: true,
      models: ['x/fast', 'x/slow'],
      defaultModel: 'x/fast',
      rates: [
        { model: 'x/fast', costMicro: 1, seconds: 30, basis: 'history' },
        { model: 'x/slow', costMicro: 1, seconds: 90, basis: 'history' },
      ],
    },
  ],
}));
others.post('/internal/conversations/:id/purge', async (request, reply) => {
  const body = request.body as { ownerId?: string };
  fake.purged.push(
    `${body.ownerId ? 'canvas' : 'model-gateway'}:${(request.params as { id: string }).id}`,
  );
  return reply.code(204).send();
});
others.post('/internal/artifacts/runs', async (request) => {
  registered.push(request.body as Record<string, unknown>);
  const body = request.body as { conversationId: string; runId: string; topic: string };
  return {
    artifacts: [
      {
        sha256: 'a'.repeat(64),
        id: ARTIFACT,
        name: 'index.html',
        path: 'site/index.html',
        size: 120,
        contentType: 'text/html',
        category: 'app',
        application: null,
        avatar: null,
        conversationId: body.conversationId,
        sessionId: SESSION,
        topic: body.topic,
        runId: body.runId,
        models: [],
        syncPath: 'x/site/index.html',
        replacesSha256: null,
        annotations: [],
        approvedAt: null,
        createdAt: new Date().toISOString(),
      },
    ],
  };
});
/** 核对过的上传文件（核对时会被标成已用上） */
export const uploadLookups: string[][] = [];
others.post('/internal/uploads/lookup', async (request) => {
  const { ids } = request.body as { ids: string[] };
  uploadLookups.push(ids);
  return {
    uploads: ids.map((id) => ({
      id,
      name: '照片.jpg',
      size: 2 * 1024 * 1024,
      contentType: 'image/jpeg',
      createdAt: new Date().toISOString(),
    })),
  };
});

/** 画布里的成果：这个话题（SESSION）做的网页和它的图，之前话题（OLD_SESSION）做的网页、它的图和一张海报 */
export const OLD_SESSION = '5b5b5b5b-5b5b-4b5b-8b5b-5b5b5b5b5b5b';
export const PAGE = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c61';
export const OLD_PAGE = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c62';
export const POSTER = '6c6c6c6c-6c6c-4c6c-8c6c-6c6c6c6c6c63';
export const canvasFile = (id: string, sessionId: string, topicDir: string, path: string) => ({
  id,
  name: path.split('/').at(-1)!,
  path,
  size: 10,
  contentType: 'application/octet-stream',
  category: 'data',
  conversationId: randomUUID(),
  sessionId,
  topic: topicDir,
  runId: randomUUID(),
  models: [],
  syncPath: `${topicDir}/${path}`,
  createdAt: new Date().toISOString(),
});
export const inCanvas = [
  canvasFile(PAGE, SESSION, '网页', 'site/index.html'),
  canvasFile(randomUUID(), SESSION, '网页', 'site/hero.png'),
  canvasFile(OLD_PAGE, OLD_SESSION, '旧话题', 'web/index.html'),
  canvasFile(randomUUID(), OLD_SESSION, '旧话题', 'web/hero.png'),
  canvasFile(POSTER, OLD_SESSION, '旧话题', 'poster.png'),
];
// 网页带上它所在目录里的文件（canvas 的规则见 artifact-service 的 lookup）
export const dirOf = (path: string) => path.slice(0, path.lastIndexOf('/') + 1);
others.post('/internal/artifacts/lookup', async (request, reply) => {
  const { ids, withFiles } = request.body as { ids: string[]; withFiles?: boolean };
  const found = ids.map((id) => inCanvas.find((a) => a.id === id));
  if (found.some((a) => !a))
    return reply.code(404).send(fail(404, 'artifact_not_found', '有成果找不到了'));
  return {
    artifacts: found,
    files: withFiles
      ? inCanvas.filter((file) =>
          found.some((a) =>
            a!.path.endsWith('.html')
              ? file.sessionId === a!.sessionId && file.path.startsWith(dirOf(a!.path))
              : file.id === a!.id,
          ),
        )
      : [],
  };
});
others.post('/internal/uploads/delete', async (request) => {
  deletedUploads.push((request.body as { ids: string[] }).ids);
  return { deleted: 1 };
});

export let harnessUrl = '';
export let othersUrl = '';
beforeAll(async () => {
  harnessUrl = await harness.listen({ port: 0, host: '127.0.0.1' });
  othersUrl = await others.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(async () => {
  await harness.close();
  await others.close();
});

export let repo: ReturnType<typeof memoryRepo>;
export let turns: ReturnType<typeof createTurns>;
export let dms: ReturnType<typeof createDmService>;
export let conversation: Conversation;

export const client = (name: string, url: string) => createServiceClient(name, url);
export const makeTurns = () =>
  createTurns({
    repo,
    agent: client('agent', othersUrl),
    harness: client('harness', harnessUrl),
    canvas: client('canvas', othersUrl),
    modelGateway: client('model-gateway', othersUrl),
    logger: pino({ level: 'silent' }),
    pollMs: 20,
    spendMs: 20,
  });
/** 模拟 conversation 重启：之前的 turns 已经 close，换一个新的接着跟进 */
export const restartTurns = () => {
  turns = makeTurns();
  return turns;
};

beforeEach(async () => {
  Object.assign(fake, {
    starts: [],
    startError: undefined,
    sessionGone: false,
    runs: new Map(),
    events: new Map(),
    interjections: [],
    interjectStatus: 202,
    stops: [],
    cancels: [],
    purged: [],
  });
  Object.assign(spend, { spentMicro: 0, tools: [] });
  registered.length = 0;
  deletedUploads.length = 0;
  uploadLookups.length = 0;
  scope.domesticOnly = false;
  repo = memoryRepo();
  turns = makeTurns();
  dms = createDmService({
    repo,
    agent: client('agent', othersUrl),
    harness: client('harness', harnessUrl),
    canvas: client('canvas', othersUrl),
    modelGateway: client('model-gateway', othersUrl),
    turns,
    logger: pino({ level: 'silent' }),
  });
  conversation = await repo.upsertDm(OWNER, 'deepseek', 'DeepSeek');
});
afterEach(() => turns.close());

export const send = (
  content: string,
  extra: { attachments?: string[]; artifacts?: string[] } = {},
) =>
  dms.sendMessage({
    ownerId: OWNER,
    conversationId: conversation.id,
    content,
    attachments: extra.attachments ?? [],
    artifacts: extra.artifacts ?? [],
    requestId: 'r',
  });
/** 等到条件成立（跟进在后台跑） */
export async function until<T>(
  read: () => T | undefined | Promise<T | undefined>,
  ms = 3000,
): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('等不到');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
export const finished = () => until(async () => !(await repo.find(conversation.id))?.turn);
export const aiMessages = () =>
  repo.messages.filter((m) => m.authorKind === 'ai' && m.kind === 'text');
