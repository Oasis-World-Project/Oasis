// billing：额度钱包。收到注册事件赠送 $30；model-gateway 调用前冻结、调用后按实际花费结算。
import { fileURLToPath } from 'node:url';
import { IDENTITY_STREAM, UserRegistered } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  startEventConsumer,
  startService,
  type ServiceResource,
} from '@oasis/service-kit';
import { registerRoutes } from './api/routes.ts';
import { billingEnv } from './config.ts';
import { createWalletRepo } from './repo/wallet-repo.ts';
import { createWalletService, type WalletService } from './service/wallet-service.ts';

/** 每分钟退回一次过期未结算的冻结。 */
function startHoldSweeper(
  wallets: WalletService,
  logger: { warn: (o: object, m: string) => void },
): ServiceResource {
  const timer = setInterval(() => {
    wallets.releaseExpired().catch((err: unknown) => logger.warn({ err }, '回收过期冻结失败'));
  }, 60_000);
  return { name: 'hold-sweeper', ready: async () => {}, close: async () => clearInterval(timer) };
}

let wallets: WalletService;

await startService({
  name: 'billing',
  env: billingEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    wallets = createWalletService({
      repo: createWalletRepo(postgres.pool),
      signupGrantMicro: ctx.config.SIGNUP_GRANT_MICRO,
      priceMultiplier: ctx.config.BILLING_PRICE_MULTIPLIER,
      holdTtlMs: ctx.config.HOLD_TTL_MS,
      logger: ctx.logger,
    });
    const signupGrants = startEventConsumer({
      connection: eventBus.connection,
      stream: IDENTITY_STREAM,
      durable: 'billing-signup-grant',
      filterSubject: UserRegistered.type,
      logger: ctx.logger,
      handle: async (envelope) => {
        const { userId } = UserRegistered.data.parse(envelope.data);
        await wallets.grantSignup(envelope.id, userId);
      },
    });
    return { postgres, eventBus, signupGrants, sweeper: startHoldSweeper(wallets, ctx.logger) };
  },
  routes: (app) => registerRoutes(app, wallets),
});
