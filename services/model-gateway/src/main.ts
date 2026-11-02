// model-gateway：所有模型调用（聊天、Jev 决策、沙箱里的 agent）的唯一出口，调用前冻结额度、调用后按实际花费结算。
import { fileURLToPath } from 'node:url';
import { MODEL_GATEWAY_STREAM, TASK_STREAM, TaskDeleted } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  createServiceClient,
  createObjectStore,
  type ObjectStore,
  ensureStream,
  startOutboxRelay,
  startEventConsumer,
  startService,
  type Logger,
  type ServiceResource,
} from '@oasis/service-kit';
import {
  createOpenRouterClient,
  type ModelPrice,
  type ProviderClient,
} from './adapters/openrouter.ts';
import { createAvatarLlmServer } from './api/avatar-server.ts';
import { registerRoutes } from './api/routes.ts';
import { modelGatewayEnv } from './config.ts';
import { createCallsRepo } from './repo/calls-repo.ts';
import { createAvatarSessionsRepo } from './repo/avatar-sessions-repo.ts';
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
import { createBrowserStackClient } from './adapters/browserstack.ts';
import { createRenderClient } from './adapters/runpod.ts';
import { createLiveAvatarClient } from './adapters/liveavatar.ts';
import { createAvatarCatalog } from './service/avatar-catalog.ts';
import { createAvatarService } from './service/avatar-service.ts';

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
let renderStaging: ObjectStore | undefined;
let toolService: ReturnType<typeof createToolService> | undefined;

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
    const staging =
      ctx.config.RENDER_PROFILE_VERIFIED && ctx.config.RENDER_STAGING_S3_ENDPOINT
        ? createObjectStore({
            endpoint: ctx.config.RENDER_STAGING_S3_ENDPOINT,
            region: ctx.config.RENDER_STAGING_S3_REGION,
            bucket: ctx.config.RENDER_STAGING_S3_BUCKET,
            accessKey: ctx.config.RENDER_STAGING_S3_ACCESS_KEY,
            secretKey: ctx.config.RENDER_STAGING_S3_SECRET_KEY,
          })
        : undefined;
    renderStaging = staging?.store;
    await ensureStream(eventBus.connection, MODEL_GATEWAY_STREAM);
    // 属于任务的调用结算后发 model-gateway.call.settled（task 累加花费）
    const outbox = startOutboxRelay({
      pool: postgres.pool,
      connection: eventBus.connection,
      logger: ctx.logger,
    });
    const taskDeleted = startEventConsumer({
      connection: eventBus.connection,
      stream: TASK_STREAM,
      durable: 'model-gateway-task-deleted',
      filterSubject: TaskDeleted.type,
      logger: ctx.logger,
      handle: async (envelope) => {
        if (!toolService) throw new Error('model-gateway 还没就绪');
        await toolService.purgeTask(TaskDeleted.data.parse(envelope.data).taskId);
      },
    });
    return {
      postgres,
      eventBus,
      outbox,
      taskDeleted,
      objects: objects.resource,
      priceBook: priceBook.resource,
      ...(staging ? { renderStaging: staging.resource } : {}),
    };
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
    const liveAvatar = createLiveAvatarClient({
      baseUrl: config.LIVEAVATAR_BASE_URL,
      apiKey: config.LIVEAVATAR_API_KEY,
    });
    const tools = createToolService({
      harness: createServiceClient('harness', config.HARNESS_URL, { timeoutMs: 65000 }),
      browserstack: createBrowserStackClient({
        username: config.BROWSERSTACK_USERNAME,
        accessKey: config.BROWSERSTACK_ACCESS_KEY,
        apiUrl: config.BROWSERSTACK_API_URL,
        hubUrl: config.BROWSERSTACK_HUB_URL,
        canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 30000 }),
      }),
      avatarCatalog: createAvatarCatalog(liveAvatar),
      render: createRenderClient({
        baseUrl: config.RUNPOD_BASE_URL,
        endpointId: config.RUNPOD_ENDPOINT_ID,
        apiKey: config.RUNPOD_API_KEY,
        verified: config.RENDER_PROFILE_VERIFIED,
        holdMicro: config.RENDER_HOLD_MICRO,
        metering: {
          microPerSecond: config.RENDER_PRICE_MICRO_PER_SECOND,
          startupCapSeconds: config.RENDER_STARTUP_ALLOWANCE_SECONDS,
          idleSeconds: config.RENDER_IDLE_SECONDS,
        },
        staging: renderStaging,
        archive: toolStore,
      }),
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
        geometryModels: config.TOOL_GEOMETRY_MODELS,
        geometryMicroPerGeneration: config.TOOL_GEOMETRY_MICRO_PER_GENERATION,
        musicMicroPerGeneration: config.TOOL_MUSIC_MICRO_PER_GENERATION,
      },
      logger,
    });
    toolService = tools;
    tools.start();
    app.addHook('onClose', () => tools.close());
    const chat = createChatService({ ...common, defaultMaxTokens: config.DEFAULT_MAX_TOKENS });
    const runKeys = createRunKeyService({ repo: createRunKeysRepo(resources.postgres.pool) });
    const avatars = createAvatarService({
      client: liveAvatar,
      runKeys,
      repo: createAvatarSessionsRepo(resources.postgres.pool),
      calls: callsRepo,
      meter,
      publicBaseUrl: config.AVATAR_PUBLIC_BASE_URL,
      model: config.AVATAR_MODEL,
      sandbox: config.AVATAR_SANDBOX,
      creditMicro: config.AVATAR_CREDIT_MICRO,
      sweepMs: config.AVATAR_SWEEP_MS,
      logger,
    });
    avatars.startSweeper();
    app.addHook('onClose', () => avatars.close());
    if (config.AVATAR_LLM_PORT > 0) {
      const avatarApp = createAvatarLlmServer({
        logger: logger.child({ component: 'avatar-llm' }),
        runKeys,
        chat,
        avatars,
        model: config.AVATAR_MODEL,
      });
      avatarApp
        .listen({ host: config.AVATAR_LLM_HOST, port: config.AVATAR_LLM_PORT })
        .then(() => logger.info({ port: config.AVATAR_LLM_PORT }, '数字人大模型入口已启动'))
        .catch((err: unknown) => logger.error({ err }, '数字人大模型入口没能启动'));
      app.addHook('onClose', () => avatarApp.close());
    }
    registerRoutes(app, {
      chat,
      decisions: createDecisionService(common),
      runKeys,
      avatars,
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
