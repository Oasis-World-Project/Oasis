// identity：账号与登录（邮箱验证码）。新用户注册时经发件箱发出 identity.user.registered。
import { fileURLToPath } from 'node:url';
import { IDENTITY_STREAM } from '@oasis/contracts/events';
import {
  connectPostgresAndEventBus,
  ensureStream,
  startOutboxRelay,
  startService,
} from '@oasis/service-kit';
import { createSmtpSender } from './adapters/smtp-sender.ts';
import { registerRoutes } from './api/routes.ts';
import { identityEnv } from './config.ts';
import { createIdentityRepo } from './repo/identity-repo.ts';
import { createAuthService } from './service/auth-service.ts';

await startService({
  name: 'identity',
  env: identityEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { postgres, eventBus } = await connectPostgresAndEventBus(ctx);
    await ensureStream(eventBus.connection, IDENTITY_STREAM);
    const outbox = startOutboxRelay({
      pool: postgres.pool,
      connection: eventBus.connection,
      logger: ctx.logger,
    });
    return { postgres, eventBus, outbox };
  },
  routes: (app, { config, resources, name }) =>
    registerRoutes(
      app,
      createAuthService({
        repo: createIdentityRepo(resources.postgres.pool),
        sender: createSmtpSender({ smtpUrl: config.SMTP_URL, from: config.MAIL_FROM }),
        pepper: config.AUTH_CODE_PEPPER,
        sessionTtlDays: config.SESSION_TTL_DAYS,
        serviceName: name,
      }),
      { secure: config.COOKIE_SECURE, ttlDays: config.SESSION_TTL_DAYS },
    ),
});
