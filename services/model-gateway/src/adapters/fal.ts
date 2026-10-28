// fal 的队列和媒体下载只在能力网关内使用，队列凭据不随媒体请求发送。
import { z } from 'zod';

const Handle = z.object({
  request_id: z.string().min(1),
  status_url: z.url(),
  response_url: z.url(),
  cancel_url: z.url().optional(),
});
export function createFalClient(options: {
  baseUrl: string;
  apiKey?: string;
  mediaHosts: string[];
  fetcher?: typeof fetch;
}) {
  const request = options.fetcher ?? fetch;
  const base = options.baseUrl.replace(/\/$/, '');
  function queueUrl(value: string) {
    const url = new URL(value);
    const configured = new URL(base);
    if (
      url.origin !== configured.origin ||
      url.username ||
      url.password ||
      !url.pathname.startsWith(`${configured.pathname.replace(/\/$/, '')}/`)
    )
      throw new Error('fal 队列地址不安全');
    return url.href;
  }
  const get = (url: string) =>
    request(queueUrl(url), {
      headers: { authorization: `Key ${options.apiKey ?? ''}` },
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
    });
  return {
    configured: Boolean(options.apiKey),
    submit(
      model: string,
      input: Record<string, unknown>,
      signal: AbortSignal,
      policy?: { noRetry: boolean },
    ) {
      if (!/^[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(model))
        throw new Error('fal 模型名不合格');
      return request(`${base}/${model}`, {
        method: 'POST',
        headers: {
          authorization: `Key ${options.apiKey ?? ''}`,
          'content-type': 'application/json',
          ...(policy?.noRetry ? { 'x-fal-no-retry': '1' } : {}),
        },
        body: JSON.stringify(input),
        signal,
        redirect: 'error',
      });
    },
    handle(value: unknown) {
      const handle = Handle.parse(value);
      queueUrl(handle.status_url);
      queueUrl(handle.response_url);
      if (handle.cancel_url) queueUrl(handle.cancel_url);
      return JSON.stringify(handle);
    },
    async status(serialized: string) {
      const handle = Handle.parse(JSON.parse(serialized));
      return get(handle.status_url);
    },
    async result(serialized: string) {
      const handle = Handle.parse(JSON.parse(serialized));
      return get(handle.response_url);
    },
    async cancel(serialized: string) {
      const handle = Handle.parse(JSON.parse(serialized));
      const url = queueUrl(handle.cancel_url ?? `${handle.response_url}/cancel`);
      return request(url, {
        method: 'PUT',
        headers: { authorization: `Key ${options.apiKey ?? ''}` },
        redirect: 'error',
        signal: AbortSignal.timeout(20_000),
      });
    },
    async media(value: string): Promise<Response> {
      let url = new URL(value);
      for (let hop = 0; hop <= 3; hop++) {
        if (
          url.protocol !== 'https:' ||
          url.username ||
          url.password ||
          (url.port && url.port !== '443') ||
          !options.mediaHosts.some(
            (host) => url.hostname === host || url.hostname.endsWith(`.${host}`),
          )
        )
          throw new Error('fal 媒体地址不在放行范围');
        const response = await request(url.href, {
          redirect: 'manual',
          signal: AbortSignal.timeout(120_000),
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          await response.body?.cancel();
          if (!location) throw new Error('fal 媒体重定向没有目标');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok) throw new Error(`fal 媒体下载失败：${response.status}`);
        return response;
      }
      throw new Error('fal 媒体重定向过多');
    },
  };
}
export type FalClient = ReturnType<typeof createFalClient>;
