// model-gateway：所有模型调用（聊天、Jev 决策、沙箱里的 agent）的唯一出口，调用前冻结额度、调用后按实际花费结算。
import { fileURLToPath } from 'node:url';
import { MODEL_GATEWAY_STREAM } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  createObjectStore,
  type ObjectStore,
  ensureStream,
  startOutboxRelay,
  startService,
  type Logger,
  type ServiceResource,
} from '@oasis/service-kit';
import {
  createOpenRouterClient,
  type ModelPrice,
  type ProviderClient,
} from './adapters/openrouter.ts';
import { registerRoutes } from './api/routes.ts';
import { modelGatewayEnv } from './config.ts';
import { createCallsRepo } from './repo/calls-repo.ts';
import { createRunKeysRepo } from './repo/run-keys-repo.ts';
import { createToolJobsRepo } from './repo/tool-jobs-repo.ts';
import { createChatService } from './service/chat-service.ts';
import { createComputeService } from './service/compute-service.ts';
import { createDecisionService } from './service/decision-service.ts';
import { createMeter } from './service/metering.ts';
import { createRunKeyService } from './service/run-key-service.ts';
import { createToolService } from './service/tool-service.ts';
import { createTavilyClient } from './adapters/tavily.ts';
import { createFalClient } from './adapters/fal.ts';

/** 定时刷新价格表；拉取失败时保留上一版，1 分钟后重试。 */
function startPriceBook(provider: ProviderClient, refreshMs: number, logger: Logger) {
  let prices = new Map<string, ModelPrice>();
  let timer: NodeJS.Timeout | undefined;
  const refresh = async () => {
    try {
      prices = await provider.listPrices();
      logger.info({ models: prices.size }, '价格表已更新');
      timer = setTimeout(refresh, refreshMs);
    } catch (err) {
      logger.warn({ err }, '价格表拉取失败，1 分钟后重试');
      timer = setTimeout(refresh, 60_000);
    }
  };
  void refresh();
  const resource: ServiceResource = {
    name: 'price-book',
    ready: async () => {},
    close: async () => clearTimeout(timer),
  };
  return { resource, current: () => prices };
}

let priceBook: ReturnType<typeof startPriceBook>;
let provider: ProviderClient;
let toolStore: ObjectStore;

await startService({
  name: 'model-gateway',
  env: modelGatewayEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    provider = createOpenRouterClient({
      baseUrl: ctx.config.OPENROUTER_BASE_URL,
      decisionsUrl: ctx.config.OPENROUTER_DECISIONS_URL,
      apiKey: ctx.config.OPENROUTER_API_KEY,
    });
    if (!provider.configured) ctx.logger.warn('没有配置 OPENROUTER_API_KEY：模型调用会返回 503');
    priceBook = startPriceBook(provider, ctx.config.PRICING_REFRESH_MS, ctx.logger);
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    const objects = createObjectStore({
      endpoint: ctx.config.S3_ENDPOINT,
      region: ctx.config.S3_REGION,
      accessKey: ctx.config.S3_ACCESS_KEY,
      secretKey: ctx.config.S3_SECRET_KEY,
      bucket: ctx.config.S3_BUCKET,
      multipartMaxAgeMs: ctx.config.S3_MULTIPART_MAX_AGE_MS,
      logger: ctx.logger,
    });
    await objects.ensureBucket();
    toolStore = objects.store;
    await ensureStream(eventBus.connection, MODEL_GATEWAY_STREAM);
    // 属于任务的调用结算后发 model-gateway.call.settled（task 累加花费）
    const outbox = startOutboxRelay({
      pool: postgres.pool,
      connection: eventBus.connection,
      logger: ctx.logger,
    });
    return { postgres, eventBus, outbox, objects: objects.resource, priceBook: priceBook.resource };
  },
  routes: (app, { config, resources, logger }) => {
    const callsRepo = createCallsRepo(resources.postgres.pool);
    const meter = createMeter({
      billing: createServiceClient('billing', config.BILLING_URL, { timeoutMs: 5_000 }),
      repo: callsRepo,
      logger,
    });
    const common = {
      provider,
      meter,
      prices: priceBook.current,
      fallbackHoldMicro: config.FALLBACK_HOLD_MICRO,
    };
    const tools = createToolService({
      openrouter: provider,
      fal: createFalClient({
        baseUrl: config.FAL_BASE_URL,
        apiKey: config.FAL_API_KEY,
        mediaHosts: config.FAL_MEDIA_HOSTS,
      }),
      store: toolStore,
      resultMaxBytes: config.TOOL_RESULT_MAX_BYTES,
      retentionMs: config.TOOL_RESULT_RETENTION_MS,
      submitTimeoutMs: config.TOOL_SUBMIT_TIMEOUT_MS,
      tavily: createTavilyClient({
        baseUrl: config.TAVILY_BASE_URL,
        apiKey: config.TAVILY_API_KEY,
      }),
      meter,
      jobs: createToolJobsRepo(resources.postgres.pool),
      jobTimeoutMs: config.TOOL_JOB_TIMEOUT_MS,
      config: {
        imageModels: config.TOOL_IMAGE_MODELS,
        visionModels: config.TOOL_VISION_MODELS,
        visionMaxTokens: config.TOOL_VISION_MAX_TOKENS,
        fetchMaxBytes: config.TOOL_FETCH_MAX_BYTES,
        speechModels: config.TOOL_SPEECH_MODELS,
        transcribeModels: config.TOOL_TRANSCRIBE_MODELS,
        videoModels: config.TOOL_VIDEO_MODELS,
        jevModel: config.TOOL_JEV_MODEL,
        tavilyCreditMicro: config.TAVILY_CREDIT_MICRO,
        speechMicroPerChar: config.TOOL_SPEECH_MICRO_PER_CHAR,
        musicModels: config.TOOL_MUSIC_MODELS,
        musicMicroPerGeneration: config.TOOL_MUSIC_MICRO_PER_GENERATION,
      },
      logger,
    });
    tools.start();
    app.addHook('onClose', () => tools.close());
    registerRoutes(app, {
      chat: createChatService({ ...common, defaultMaxTokens: config.DEFAULT_MAX_TOKENS }),
      decisions: createDecisionService(common),
      runKeys: createRunKeyService({ repo: createRunKeysRepo(resources.postgres.pool) }),
      tools,
      compute: createComputeService({
        meter,
        repo: callsRepo,
        pricePerCoreHourMicro: config.COMPUTE_PRICE_MICRO_PER_CORE_HOUR,
      }),
      unavailableModels: meter.regionBlockedModels,
    });
  },
});
