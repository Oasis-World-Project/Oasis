import type { ConfigOf } from '@oasis/service-kit';
import { z } from 'zod';

/**
 * 经 gateway 对外开放的服务，以及各自上游地址的环境变量名。
 * harness 和 model-gateway 只供内部服务调用，不对外开放。
 */
export const PUBLIC_SERVICES = {
  identity: 'IDENTITY_URL',
  billing: 'BILLING_URL',
  agent: 'AGENT_URL',
  conversation: 'CONVERSATION_URL',
  task: 'TASK_URL',
  canvas: 'CANVAS_URL',
} as const;

export const gatewayEnv = {
  IDENTITY_URL: z.url(),
  BILLING_URL: z.url(),
  AGENT_URL: z.url(),
  CONVERSATION_URL: z.url(),
  TASK_URL: z.url(),
  CANVAS_URL: z.url(),
} satisfies Record<(typeof PUBLIC_SERVICES)[keyof typeof PUBLIC_SERVICES], z.ZodType>;

export type GatewayConfig = ConfigOf<typeof gatewayEnv>;
