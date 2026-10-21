import { createServiceClient, type ServiceDefinition } from '@oasis/service-kit';
import { registerAuth } from './api/auth.ts';
import { registerProxies } from './api/proxy.ts';
import { gatewayEnv } from './config.ts';

export const gatewayService: ServiceDefinition<typeof gatewayEnv> = {
  name: 'gateway',
  env: gatewayEnv,
  routes: async (app, { config }) => {
    registerAuth(app, {
      identity: createServiceClient('identity', config.IDENTITY_URL, { timeoutMs: 3_000 }),
      allowedOrigins: config.GATEWAY_ALLOWED_ORIGINS,
      cacheTtlMs: config.SESSION_CACHE_TTL_MS,
    });
    await registerProxies(app, config);
  },
};
