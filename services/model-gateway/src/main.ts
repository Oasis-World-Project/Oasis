// model-gateway：所有模型调用（聊天、Jev 决策、沙箱里的 agent）的唯一出口，调用前冻结额度、调用后按实际花费结算。
import { fileURLToPath } from 'node:url';
import {
  connectPostgresAndEventBus,
  createServiceClient,
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
import { createChatService } from './service/chat-service.ts';
import { createDecisionService } from './service/decision-service.ts';
import { createMeter } from './service/metering.ts';
import { createRunKeyService } from './service/run-key-service.ts';

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
    return { ...(await connectPostgresAndEventBus(ctx)), priceBook: priceBook.resource };
  },
  routes: (app, { config, resources, logger }) => {
    const meter = createMeter({
      billing: createServiceClient('billing', config.BILLING_URL, { timeoutMs: 5_000 }),
      repo: createCallsRepo(resources.postgres.pool),
      logger,
    });
    const common = {
      provider,
      meter,
      prices: priceBook.current,
      fallbackHoldMicro: config.FALLBACK_HOLD_MICRO,
    };
    registerRoutes(app, {
      chat: createChatService({ ...common, defaultMaxTokens: config.DEFAULT_MAX_TOKENS }),
      decisions: createDecisionService(common),
      runKeys: createRunKeyService({ repo: createRunKeysRepo(resources.postgres.pool) }),
    });
  },
});
