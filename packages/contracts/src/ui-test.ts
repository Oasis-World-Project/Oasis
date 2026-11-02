import { z } from 'zod';

const selector = z.string().min(1).max(500);
/** 可重跑的声明式步骤；不接受 JavaScript、Shell 或任意驱动命令。 */
export const BrowserTestStep = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('navigate'),
    path: z
      .string()
      .max(1000)
      .regex(/^\/(?!\/)/),
  }),
  z.object({ action: z.literal('click'), selector }),
  z.object({ action: z.literal('fill'), selector, text: z.string().max(2000) }),
  z.object({ action: z.literal('press'), selector, key: z.string().min(1).max(40) }),
  z.object({ action: z.literal('visible'), selector }),
  z.object({ action: z.literal('text'), selector, text: z.string().min(1).max(2000) }),
  z.object({ action: z.literal('count'), selector, count: z.number().int().min(0).max(1000) }),
  z.object({ action: z.literal('screenshot') }),
]);
export const BrowserTestPlan = z.object({
  version: z.literal(1),
  steps: z.array(BrowserTestStep).min(1).max(20),
});
export type BrowserTestPlan = z.infer<typeof BrowserTestPlan>;
export const WebsiteTestArgs = z.object({ url: z.url().max(2000), plan: BrowserTestPlan });

export const UiTestReport = z.object({
  version: z.literal(1),
  target: z.enum(['application', 'website', 'android']),
  passed: z.boolean(),
  steps: z
    .array(
      z.object({
        index: z.number().int().nonnegative(),
        action: z.string().max(30),
        status: z.enum(['passed', 'failed', 'unchecked']),
        error: z.string().max(500).optional(),
        screenshot: z.string().max(100).optional(),
      }),
    )
    .max(20),
  diagnostics: z.array(z.string().max(500)).max(20),
  unchecked: z.array(z.string().max(500)).max(20),
});
export type UiTestReport = z.infer<typeof UiTestReport>;

/** 截图仅从受信控制协议返回，由服务端验证大小、计算摘要并归档。 */
export const BrowserTestResult = z.object({
  report: UiTestReport,
  screenshots: z
    .array(
      z.object({
        name: z.string().regex(/^step-\d+\.jpg$/),
        base64: z.string().max(2 * 1024 * 1024),
      }),
    )
    .max(20),
});
export type BrowserTestResult = z.infer<typeof BrowserTestResult>;
