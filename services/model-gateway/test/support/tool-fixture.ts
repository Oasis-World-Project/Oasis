// 工具服务测试的公共部分：按 Key 和开关建工具服务、启动假服务、每个用例前重置，以及常用的调用帮手。
import { createServiceClient, type HttpError } from '@oasis/service-kit';
import { pino } from 'pino';
import { afterAll, beforeAll, beforeEach } from 'vitest';
import { createOpenRouterClient } from '../../src/adapters/openrouter.ts';
import { createFalClient } from '../../src/adapters/fal.ts';
import { createRenderClient } from '../../src/adapters/runpod.ts';
import { createHash } from 'node:crypto';
import { createTavilyClient } from '../../src/adapters/tavily.ts';
import { createMeter } from '../../src/service/metering.ts';
import { createModelScopeService } from '../../src/service/model-scope.ts';
import { createToolService } from '../../src/service/tool-service.ts';
import {
  knobs,
  PAYER,
  billingCalls,
  billing,
  upstream,
  fake,
  finished,
  recordedCalls,
  settled,
  noHistory,
  repo,
  jobRows,
  deletedTasks,
  jobs,
  mediaFiles,
  mediaStore,
} from './tool-fakes.ts';

export let tools: ReturnType<typeof createToolService>;
let urls = { billing: '', fake: '' };
export const falCalls: { url: string; input?: Record<string, unknown> }[] = [];
export const geometryImage = [
  {
    mediaType: 'image/png',
    base64: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(16)]).toString(
      'base64',
    ),
  },
];
export const stagingReads: string[] = [];
export const build = (
  tavilyKey: string | undefined,
  withMusic = false,
  withRender = false,
  fromHistory = true,
) => {
  const logger = pino({ level: 'silent' });
  return createToolService({
    estimateFromHistory: fromHistory,
    render: withRender
      ? createRenderClient({
          baseUrl: 'https://api.runpod.ai/v2',
          metering: { microPerSecond: 373, startupCapSeconds: 90, idleSeconds: 5 },
          endpointId: 'fixture',
          apiKey: 'not-real',
          verified: true,
          holdMicro: 1000000,
          archive: mediaStore,
          staging: {
            ...mediaStore,
            read: async (key) => {
              stagingReads.push(key);
              return mediaStore.read(key);
            },
            sign: async (key) => 'https://example.test/' + key,
          },
          fetcher: async (url, init) => {
            if (String(url).endsWith('/health'))
              return Response.json({
                jobs: { completed: 3, failed: 1, inProgress: knobs.renderBusy ? 1 : 0, inQueue: 0 },
                workers: { idle: 1, running: 0 },
              });
            if (knobs.renderStatusGone && String(url).includes('/status/'))
              return Response.json({ status: 404, detail: 'job not found' }, { status: 404 });
            if (String(url).includes('/cancel/'))
              return Response.json({ id: 'gpu-one', status: 'CANCELLED' });
            if (init?.method === 'POST') {
              knobs.renderSubmits++;
              if (knobs.renderSubmitLost) throw new Error('Lost POST response');
              const body = JSON.parse(String(init.body)) as { input: { transferId: string } };
              knobs.renderTransfer = body.input.transferId;
              return Response.json({ id: 'gpu-one' });
            }
            const artifact = (key: string) => ({
              size: mediaFiles.get(key)!.length,
              sha256: createHash('sha256').update(mediaFiles.get(key)!).digest('hex'),
            });
            const imageKey = `jobs/${knobs.renderTransfer}/image.png`,
              zipKey = `jobs/${knobs.renderTransfer}/project.zip`;
            mediaFiles.set(imageKey, Buffer.from('png-fixture'));
            mediaFiles.set(zipKey, Buffer.from('zip-fixture'));
            const output = {
              transferId: knobs.renderTransfer,
              artifacts: { image: artifact(imageKey), project: artifact(zipKey) },
              device: {
                gpuUsed: true,
                ...(knobs.renderExposure === undefined
                  ? {}
                  : {
                      exposureAdjustEv: knobs.renderExposure,
                      devices: [{ name: 'NVIDIA GeForce RTX 4090', type: 'CUDA' }],
                    }),
              },
              boundary: {
                filesystem: true,
                networkSocketsDenied: true,
                secretEnvironmentEmpty: true,
              },
            };
            return Response.json({
              status: knobs.renderStatus,
              delayTime: 120400,
              ...(knobs.renderReceiptMissing ? {} : { executionTime: 3172 }),
              ...(knobs.renderStatus === 'COMPLETED' ? { output } : {}),
            });
          },
        })
      : undefined,
    fal: withMusic
      ? createFalClient({
          baseUrl: 'https://queue.fal.run',
          apiKey: 'test',
          mediaHosts: ['fal.media'],
          fetcher: async (input, init) => {
            const url = String(input);
            const body = init?.body
              ? (JSON.parse(String(init.body)) as Record<string, unknown>)
              : undefined;
            falCalls.push({ url, input: body });
            if (init?.method === 'PUT') {
              if (knobs.geometryCancelCompleted)
                return Response.json({ status: 'ALREADY_COMPLETED' }, { status: 400 });
              knobs.geometryCancelled = true;
              return new Response(null, { status: 202 });
            }
            if (init?.method === 'POST') {
              if (knobs.falSubmitFails) throw new Error('connection lost');
              return Response.json({
                request_id: 'music-one',
                status_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/music-one/status',
                response_url: 'https://queue.fal.run/fal-ai/minimax-music/requests/music-one',
              });
            }
            if (url.endsWith('/status'))
              return Response.json({ status: knobs.geometryCancelled ? 'CANCELLED' : 'COMPLETED' });
            if (knobs.falResult && !url.includes('fal.media'))
              return Response.json(knobs.falResult, { status: knobs.falResultStatus });
            if (knobs.geometryMode) {
              if (!url.includes('fal.media'))
                return Response.json({ model_glb: { url: 'https://v3.fal.media/model.glb' } });
              const bytes = Buffer.alloc(24);
              bytes.write('glTF');
              bytes.writeUInt32LE(2, 4);
              bytes.writeUInt32LE(24, 8);
              bytes.writeUInt32LE(4, 12);
              bytes.writeUInt32LE(0x4e4f534a, 16);
              bytes.write('{}  ', 20);
              return new Response(knobs.geometryMalformed ? Buffer.from('invalid') : bytes);
            }
            if (url.includes('fal.media'))
              return new Response('ID3music', { headers: { 'content-type': 'audio/mpeg' } });
            return Response.json({ audio: { url: 'https://v3.fal.media/music.mp3' } });
          },
        })
      : undefined,
    openrouter: createOpenRouterClient({
      baseUrl: `${urls.fake}/api/v1`,
      decisionsUrl: `${urls.fake}/api/alpha/decisions`,
      apiKey: 'k',
    }),
    // 供应商目录里各型号能读什么：前两个只看图，第三个还能看视频、听音频
    inputsOf: (model) =>
      knobs.directory === false
        ? undefined
        : {
            'vision/first': ['text', 'image'],
            'vision/second': ['text', 'image'],
            'listen/first': ['text', 'image', 'video', 'audio'],
          }[model],
    tavily: createTavilyClient({ baseUrl: `${urls.fake}/tavily`, apiKey: tavilyKey }),
    meter: createMeter({ billing: createServiceClient('billing', urls.billing), repo, logger }),
    scope: createModelScopeService({
      repo: {
        domesticOnly: async () => knobs.domesticOnly,
        setDomesticOnly: async (_userId, domesticOnly) => {
          knobs.domesticOnly = domesticOnly;
        },
      },
      domesticVendors: ['bytedance-seed', 'alibaba'],
    }),
    jobs,
    store: mediaStore,
    jobTimeoutMs: 30 * 60_000,
    config: {
      // 最后一个没有对接过：目录不列
      musicModels: [
        'fal-ai/minimax-music/v2.6',
        'fal-ai/lyria3/pro',
        'google/lyria/v3',
        'fal-ai/ace-step-1.5',
        'someone/unknown-music',
      ],
      geometryModels: withMusic
        ? [
            'fal-ai/trellis-2',
            'fal-ai/hunyuan-3d/v3.1/pro/image-to-3d',
            'tripo3d/h3.1/image-to-3d',
            'fal-ai/pixal3d',
          ]
        : [],
      imageModels: ['bytedance-seed/seedream-4.5', 'openai/gpt-image-2'],
      inspectModels: ['vision/first', 'vision/second', 'listen/first'],
      inspectMaxTokens: 2048,
      fetchMaxBytes: 200_000,
      videoModels: ['alibaba/wan-2.7'],
      speechModels: ['bytedance-seed/seed-audio-1-0'],
      transcribeModels: ['openai/whisper-large-v3'],
      jevModel: 'typesafe/jev-1.14',
      decideChatModels: ['alibaba/judge-1'],
      tavilyCreditMicro: 8_000,
      speechMicroPerChar: 20,
    },
    logger,
  });
};
/** 换成按这些参数建的工具服务（别的文件不能直接给导入的 tools 赋值） */
export function useTools(...args: Parameters<typeof build>) {
  tools = build(...args);
}
beforeAll(async () => {
  urls = {
    billing: await billing.listen({ port: 0, host: '127.0.0.1' }),
    fake: await fake.listen({ port: 0, host: '127.0.0.1' }),
  };
});
afterAll(async () => {
  await billing.close();
  await fake.close();
});
beforeEach(() => {
  knobs.videoReject = null;
  knobs.typical = noHistory();
  knobs.renderReceiptMissing = false;
  knobs.renderBusy = false;
  knobs.renderStatusGone = false;
  knobs.renderExposure = undefined;
  stagingReads.length = 0;
  knobs.archiveFails = false;
  knobs.renderCleanupFails = false;
  recordedCalls.clear();
  knobs.renderSubmits = 0;
  knobs.renderStatus = 'COMPLETED';
  knobs.renderTransfer = '';
  knobs.renderSubmitLost = false;
  knobs.geometryMode = false;
  knobs.geometryMalformed = false;
  knobs.geometryCancelled = false;
  knobs.geometryCancelCompleted = false;
  billingCalls.length = 0;
  knobs.settleFails = false;
  knobs.renewFails = false;
  knobs.falSubmitFails = false;
  knobs.falResult = null;
  knobs.falResultStatus = 200;
  falCalls.length = 0;
  mediaFiles.clear();
  upstream.length = 0;
  finished.length = 0;
  settled.length = 0;
  knobs.domesticOnly = false;
  knobs.imageStatus = 200;
  knobs.imageRejections = 0;
  knobs.visionStatus = 200;
  knobs.judgeAnswer = '好的：{"type":"choice","choice":"标题B"}';
  knobs.directory = true;
  knobs.referenceLimit = 4;
  knobs.pageText = '# 正文';
  knobs.videoPolls = 0;
  knobs.videoEnd = 'completed';
  knobs.videoUsageCost = 0.5;
  knobs.videoFramesSupported = true;
  knobs.videoCentsPerSecond = '5';
  knobs.videoUsdTariff = true;
  jobRows.clear();
  deletedTasks.clear();
  knobs.resultDeleteFails = false;
  tools = build('tvly-k');
});

export const call = (key: string, args: Record<string, unknown>, taskId?: string) =>
  tools.call({
    caller: { payerId: PAYER, ...(taskId ? { taskId } : {}) },
    key,
    args,
    requestId: 'r',
    signal: new AbortController().signal,
  });

export const errorOf = (p: Promise<unknown>) =>
  p.then(
    () => undefined,
    (e: unknown) => e as HttpError,
  );

/** 交给 media.inspect 看的一张图（reference 加上种类） */
export const seen = {
  kind: 'image',
  mediaType: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=',
};

export const reference = {
  mediaType: 'image/png',
  base64:
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aO1sAAAAASUVORK5CYII=',
};
