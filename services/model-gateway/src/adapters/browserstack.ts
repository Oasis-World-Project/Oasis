import { createHash } from 'node:crypto';
import { z } from 'zod';
import { UploadLookupResult } from '@oasis/contracts/canvas';
import { UiTestReport } from '@oasis/contracts/ui-test';
import { HttpError, type ServiceClient } from '@oasis/service-kit';

const selector = z.object({
  using: z.enum(['id', 'accessibility id', 'xpath']),
  value: z.string().min(1).max(500),
});
export const AndroidTestArgs = z.object({
  uploadId: z.uuid(),
  device: z.string().min(1).max(100),
  osVersion: z.string().min(1).max(20),
  steps: z
    .array(
      z.discriminatedUnion('action', [
        z.object({ action: z.literal('click'), selector }),
        z.object({ action: z.literal('fill'), selector, text: z.string().max(1000) }),
        z.object({ action: z.literal('visible'), selector }),
        z.object({ action: z.literal('text'), selector, text: z.string().min(1).max(1000) }),
        z.object({ action: z.literal('screenshot') }),
      ]),
    )
    .min(1)
    .max(10),
});
const Handle = AndroidTestArgs.extend({
  app: z.string().regex(/^bs:\/\/[a-f0-9]+$/),
  sha256: z.string(),
});
const Evidence = z.object({
  phase: z.enum(['creating', 'running', 'stopped']),
  sessionId: z
    .string()
    .regex(/^[a-zA-Z0-9-]+$/)
    .optional(),
  report: UiTestReport,
  screenshots: z.array(z.object({ name: z.string(), base64: z.string() })),
  startedAt: z.number(),
});
type Receipt = { saved?: unknown; save(value: unknown): Promise<void> };

/** 凭据只在网关；仅开启已核实的免费计划，不替用户购买套餐或猜测设备价格。 */
export function createBrowserStackClient(deps: {
  username?: string;
  accessKey?: string;
  apiUrl: string;
  hubUrl: string;
  canvas: ServiceClient;
  fetcher?: typeof fetch;
}) {
  const fetcher = deps.fetcher ?? fetch;
  const authorization = `Basic ${Buffer.from(`${deps.username ?? ''}:${deps.accessKey ?? ''}`).toString('base64')}`;
  async function request(
    base: string,
    path: string,
    method: string,
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const response = await fetcher(`${base.replace(/\/$/, '')}${path}`, {
      method,
      redirect: 'error',
      signal: AbortSignal.any([
        signal ?? new AbortController().signal,
        AbortSignal.timeout(path === '/session' ? 70000 : 10000),
      ]),
      headers: {
        authorization,
        ...(body instanceof FormData ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined
        ? {}
        : { body: body instanceof FormData ? body : JSON.stringify(body) }),
    });
    if (method === 'DELETE' && response.status === 404) {
      await response.body?.cancel();
      return {};
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new HttpError(502, 'device_provider_error', `云设备请求失败（${response.status}）`);
    }
    const parts: Uint8Array[] = [];
    let length = 0;
    if (response.body)
      for await (const part of response.body) {
        length += part.length;
        if (length > 8 * 1024 * 1024) throw new Error('云设备响应超过上限');
        parts.push(part);
      }
    const text = Buffer.concat(parts).toString('utf8');
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  const api = (path: string, method = 'GET', body?: unknown, signal?: AbortSignal) =>
    request(deps.apiUrl, `/app-automate${path}`, method, body, signal);
  async function free(signal?: AbortSignal) {
    const plan = await api('/plan.json', 'GET', undefined, signal);
    if (plan.automate_plan !== 'Free')
      throw new HttpError(503, 'device_plan_unverified', '仅支持已核实的 BrowserStack 免费计划');
  }
  async function cleanup(app: string) {
    await api(`/app/delete/${app.slice(5)}`, 'DELETE');
  }
  async function command(
    sessionId: string,
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ) {
    const result = await request(deps.hubUrl, `/session/${sessionId}${path}`, method, body, signal);
    const value = result.value;
    if (value && typeof value === 'object' && 'error' in value) throw new Error('云设备操作未通过');
    return value;
  }
  async function finish(
    handle: z.infer<typeof Handle>,
    evidence: z.infer<typeof Evidence>,
    receipt: Receipt,
  ) {
    if (evidence.sessionId && evidence.phase !== 'stopped') {
      await command(evidence.sessionId, '', 'DELETE');
      evidence.phase = 'stopped';
      await receipt.save(evidence);
    }
    await cleanup(handle.app);
    return {
      state: 'completed' as const,
      outcome: {
        text: evidence.report.passed
          ? 'Android 原生应用测试步骤通过。'
          : 'Android 原生应用测试未全部通过，请查看报告。',
        data: {
          report: evidence.report,
          sessionId: evidence.sessionId,
          inputSha256: handle.sha256,
        },
        files: [
          {
            name: 'android-check.json',
            mediaType: 'application/json',
            base64: Buffer.from(
              JSON.stringify({ ...evidence, inputSha256: handle.sha256 }),
            ).toString('base64'),
          },
          ...evidence.screenshots.map((image) => ({ ...image, mediaType: 'image/png' })),
        ],
        cost: { costMicro: 0, source: 'provider' as const },
      },
    };
  }
  return {
    configured: Boolean(deps.username && deps.accessKey),
    async start(raw: unknown, ownerId: string, signal: AbortSignal) {
      const args = AndroidTestArgs.parse(raw);
      await free(signal);
      const { uploads } = await deps.canvas.json('POST', '/internal/uploads/lookup', {
        body: { ownerId, ids: [args.uploadId] },
        schema: UploadLookupResult,
      });
      const file = uploads.find((item) => item.id === args.uploadId);
      if (
        !file ||
        !file.name.toLowerCase().endsWith('.apk') ||
        file.size > 25 * 1024 * 1024 ||
        !file.sha256
      )
        throw new HttpError(422, 'apk_invalid', '需要当前用户上传的、带摘要且不超过 25 MiB 的 APK');
      const response = await deps.canvas.stream('GET', `/internal/uploads/${file.id}/content`);
      if (!response.body) throw new Error('APK 内容为空');
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > file.size) throw new Error('APK 大小不匹配');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (
        size < 4 ||
        size !== file.size ||
        sha256 !== file.sha256 ||
        bytes.readUInt32LE(0) !== 0x04034b50
      )
        throw new Error('APK 内容校验失败');
      const form = new FormData();
      form.append('file', new Blob([bytes]), 'application.apk');
      const uploaded = await api('/upload', 'POST', form, signal);
      const app = z
        .string()
        .regex(/^bs:\/\/[a-f0-9]+$/)
        .parse(uploaded.app_url);
      return JSON.stringify({ ...args, app, sha256 });
    },
    async check(id: string, receipt: Receipt, signal: AbortSignal, cancel = false) {
      const handle = Handle.parse(JSON.parse(id));
      let evidence: z.infer<typeof Evidence>;
      if (receipt.saved) {
        evidence = Evidence.parse(receipt.saved);
        if (evidence.phase === 'creating') {
          // 创建响应丢失时禁止再开一台；设备由供应商 idleTimeout 兜底，保留人工核对状态。
          await cleanup(handle.app);
          return {
            state: 'uncertain' as const,
            error: '设备创建结果未确认，未重试；请核对 BrowserStack 会话，闲置超时 90 秒',
          };
        }
        if (evidence.phase === 'running') {
          evidence.report.passed = false;
          evidence.report.unchecked.push('测试被中断，未重复执行可能有副作用的步骤');
        }
        return finish(handle, evidence, receipt);
      }
      evidence = {
        phase: 'creating',
        report: {
          version: 1,
          target: 'android',
          passed: !cancel,
          steps: [],
          diagnostics: [],
          unchecked: [],
        },
        screenshots: [],
        startedAt: Date.now(),
      };
      if (cancel) {
        evidence.phase = 'stopped';
        evidence.report.unchecked.push('在启动设备前取消');
        await receipt.save(evidence);
        return finish(handle, evidence, receipt);
      }
      await free(signal);
      await receipt.save(evidence);
      const created = await request(
        deps.hubUrl,
        '/session',
        'POST',
        {
          capabilities: {
            alwaysMatch: {
              platformName: 'Android',
              'appium:automationName': 'UiAutomator2',
              'appium:deviceName': handle.device,
              'appium:platformVersion': handle.osVersion,
              'appium:app': handle.app,
              'bstack:options': {
                projectName: 'Oasis',
                sessionName: `Oasis ${handle.sha256.slice(0, 12)}`,
                idleTimeout: 90,
                video: false,
              },
            },
          },
        },
        signal,
      );
      const value = created.value as { sessionId?: string } | undefined;
      evidence.sessionId = z
        .string()
        .regex(/^[a-zA-Z0-9-]+$/)
        .parse(value?.sessionId ?? created.sessionId);
      evidence.phase = 'running';
      const deadline = Date.now() + 45000;
      try {
        await receipt.save(evidence);
        for (const [index, step] of handle.steps.entries()) {
          const result: z.infer<typeof UiTestReport>['steps'][number] = {
            index,
            action: step.action,
            status: 'unchecked',
          };
          evidence.report.steps.push(result);
          if (!evidence.report.passed || Date.now() > deadline) {
            evidence.report.passed = false;
            continue;
          }
          try {
            if (step.action !== 'screenshot') {
              const element = (await command(
                evidence.sessionId,
                '/element',
                'POST',
                step.selector,
                signal,
              )) as Record<string, string>;
              const elementId = encodeURIComponent(
                z.string().parse(element['element-6066-11e4-a52e-4f735466cecf'] ?? element.ELEMENT),
              );
              const path = `/element/${elementId}`;
              if (step.action === 'click')
                await command(evidence.sessionId, `${path}/click`, 'POST', {}, signal);
              if (step.action === 'fill') {
                await command(evidence.sessionId, `${path}/clear`, 'POST', {}, signal);
                await command(
                  evidence.sessionId,
                  `${path}/value`,
                  'POST',
                  { text: step.text },
                  signal,
                );
              }
              if (
                step.action === 'visible' &&
                (await command(
                  evidence.sessionId,
                  `${path}/displayed`,
                  'GET',
                  undefined,
                  signal,
                )) !== true
              )
                throw new Error('不可见');
              if (
                step.action === 'text' &&
                !String(
                  await command(evidence.sessionId, `${path}/text`, 'GET', undefined, signal),
                ).includes(step.text)
              )
                throw new Error('文本不匹配');
            }
            result.status = 'passed';
          } catch {
            result.status = 'failed';
            result.error = `第 ${index + 1} 步 ${step.action} 未通过`;
            evidence.report.passed = false;
          }
          if (step.action === 'screenshot' || result.status === 'failed') {
            try {
              const base64 = z
                .string()
                .max(2 * 1024 * 1024)
                .parse(await command(evidence.sessionId, '/screenshot', 'GET', undefined, signal));
              result.screenshot = `step-${index}.png`;
              evidence.screenshots.push({ name: result.screenshot, base64 });
            } catch {
              evidence.report.unchecked.push(`第 ${index + 1} 步截图未取得`);
            }
          }
        }
        if (!handle.steps.some((step) => ['visible', 'text'].includes(step.action)))
          evidence.report.unchecked.push('未提供业务断言');
        await receipt.save(evidence);
      } finally {
        await command(evidence.sessionId, '', 'DELETE');
        evidence.phase = 'stopped';
        await receipt.save(evidence);
      }
      return finish(handle, evidence, receipt);
    },
  };
}
export type BrowserStackClient = ReturnType<typeof createBrowserStackClient>;
