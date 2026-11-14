// 成果测试共用的：假 harness（一轮的产出文件）、内存里的仓库和对象存储、画布服务和接口、登记请求。
// 每个测试前重来一遍（文件回到最初的两份，仓库清空）。
import { createHash } from 'node:crypto';
import type { RegisterRunArtifactsBody } from '@oasis/contracts/canvas';
import { OASIS_HEADERS } from '@oasis/contracts/common';
import { createService, createServiceClient, type ServiceClient } from '@oasis/service-kit';
import Fastify from 'fastify';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { registerRoutes } from '../src/api/routes.ts';
import { createArtifactService } from '../src/service/artifact-service.ts';
import { createUploadService } from '../src/service/upload-service.ts';
import { memoryArtifacts, memoryStore, memoryUploads } from './memory.ts';

export const KAI = '00000000-0000-4000-8000-000000000001';
export const MIA = '00000000-0000-4000-8000-000000000002';
/** 一个对话：话题 S1 里先后两轮 R1、R2；新话题 S2 里一轮 R3 */
export const CONVERSATION = '10000000-0000-4000-8000-000000000001';
export const OTHER_CONVERSATION = '10000000-0000-4000-8000-000000000002';
export const S1 = '20000000-0000-4000-8000-000000000001';
export const S2 = '20000000-0000-4000-8000-000000000002';
export const R1 = '30000000-0000-4000-8000-000000000001';
export const R2 = '30000000-0000-4000-8000-000000000002';
export const R3 = '30000000-0000-4000-8000-000000000003';
export const AVATAR_SESSION = '40000000-0000-4000-8000-000000000001';
/** 转给 model-gateway 的数字人会话请求 */
export const gatewayCalls: { method: string; path: string; headers?: object; body?: unknown }[] =
  [];

/** 话题工作区里 out/ 下的文件（后来的一轮可以改它们） */
export const files: Record<string, string> = {};
const initialFiles = {
  '首页文案.md': '# 山里的小木屋',
  'hero.png': 'png-bytes-0123456789',
};
export const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

/** 假 harness：一轮的产出文件；failFiles(n) 之后 n 次取文件会 500 */
export const fetched: string[] = [];
let fileFailures = 0;
export const failFiles = (times: number) => {
  fileFailures = times;
};
const harness = Fastify();
harness.get('/internal/runs/:runId/files/*', async (request, reply) => {
  const path = (request.params as { '*': string })['*'];
  fetched.push(path);
  if (fileFailures > 0) {
    fileFailures -= 1;
    return reply.code(500).send({ error: { code: 'x', message: 'x', requestId: 'r' } });
  }
  const content = files[path];
  if (content === undefined)
    return reply
      .code(404)
      .send({ error: { code: 'file_not_found', message: 'x', requestId: 'r' } });
  return reply
    .type('application/octet-stream')
    .header('x-oasis-file-sha256', sha256(content))
    .send(Buffer.from(content));
});
let harnessUrl = '';
beforeAll(async () => {
  harnessUrl = await harness.listen({ port: 0, host: '127.0.0.1' });
});
afterAll(() => harness.close());

export let repo: ReturnType<typeof memoryArtifacts>;
export let uploadRows: ReturnType<typeof memoryUploads>;
export let objects: ReturnType<typeof memoryStore>;
export let service: ReturnType<typeof createArtifactService>;
export let app: Awaited<ReturnType<typeof createService>>['app'];

beforeEach(async () => {
  for (const key of Object.keys(files)) delete files[key];
  Object.assign(files, initialFiles);
  fetched.length = 0;
  fileFailures = 0;
  gatewayCalls.length = 0;
  uploadRows = memoryUploads();
  repo = memoryArtifacts();
  const store = memoryStore();
  objects = store;
  service = createArtifactService({
    repo,
    uploads: uploadRows,
    store,
    harness: createServiceClient('harness', harnessUrl),
    logger: pino({ level: 'silent' }),
  });
  ({ app } = await createService(
    {
      name: 'canvas',
      env: {},
      routes: (instance) =>
        registerRoutes(
          instance,
          {
            uploads: createUploadService({
              repo: memoryUploads(),
              store,
            }),
            artifacts: service,
            store,
            inspector: {
              json: async () => ({ maxMicro: 500, maxMs: 60_000, idleMs: 20_000 }),
            } as unknown as ServiceClient,
            modelGateway: {
              json: async (
                method: string,
                path: string,
                options: { headers?: object; body?: unknown },
              ) => {
                gatewayCalls.push({ method, path, headers: options.headers, body: options.body });
                if (path === '/internal/avatar/sessions') {
                  return {
                    sessionId: AVATAR_SESSION,
                    livekitUrl: 'wss://room',
                    livekitToken: 'lk',
                    sandbox: true,
                    maxSeconds: 300,
                    pricePerMinuteMicro: 0,
                    startedAt: '2026-11-01T12:00:00.000Z',
                  };
                }
                return undefined;
              },
            } as unknown as ServiceClient,
          },
          { maxBytes: 1024 },
        ),
    },
    { PORT: '0', LOG_LEVEL: 'silent' },
  ));
});

/** 一轮结束时 conversation 发来的登记请求（产出清单带大小和摘要）；默认是话题 S1 的第一轮，交出两份文件 */
export const run = (
  runId: string,
  paths: string[] = ['首页文案.md', 'hero.png'],
  extra: Partial<RegisterRunArtifactsBody> = {},
): RegisterRunArtifactsBody => ({
  ownerId: KAI,
  conversationId: CONVERSATION,
  sessionId: S1,
  runId,
  task: '小木屋：首页?',
  models: ['deepseek/x'],
  outputs: paths.map((path) => ({
    path,
    size: Buffer.byteLength(files[path] ?? ''),
    sha256: sha256(files[path] ?? ''),
  })),
  ...extra,
});
/** 一轮进行中做好一个就登记：没有大小和摘要 */
export const live = (body: RegisterRunArtifactsBody): RegisterRunArtifactsBody => ({
  ...body,
  outputs: body.outputs.map(({ path }) => ({ path })),
});

export const get = (url: string, headers: Record<string, string> = {}, user = KAI) =>
  app.inject({ url, headers: { [OASIS_HEADERS.userId]: user, ...headers } });
