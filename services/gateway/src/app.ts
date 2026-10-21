import type { ServiceDefinition } from '@oasis/service-kit';
import { registerProxies } from './api/proxy.ts';
import { gatewayEnv } from './config.ts';

export const gatewayService: ServiceDefinition<typeof gatewayEnv> = {
  name: 'gateway',
  env: gatewayEnv,
  routes: (app, { config }) => registerProxies(app, config),
};
