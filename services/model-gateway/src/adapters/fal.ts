// fal 的队列和媒体下载只在能力网关内使用，队列凭据不随媒体请求发送。
import { z } from 'zod';

/** 提交时记进任务号的：用的哪个型号、这次按标价多少钱（fal 不按调用回报花费，取结果时照这个记账） */
const Memo = z.object({ model: z.string().min(1), micro: z.number().int().positive() });
const Handle = z.object({
  request_id: z.string().min(1),
  status_url: z.url(),
  response_url: z.url(),
  cancel_url: z.url().optional(),
  memo: Memo.optional(),
});
export function createFalClient(options: {
  baseUrl: string;
  apiKey?: string;
  mediaHosts: string[];
  /** 下载媒体时每 windowMs 毫秒至少要收到 minBytes 字节，不到就掐断 */
  mediaFlow?: { windowMs: number; minBytes: number };
  fetcher?: typeof fetch;
}) {
  const request = options.fetcher ?? fetch;
  const flow = options.mediaFlow ?? { windowMs: 15_000, minBytes: 512 * 1024 };
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
    handle(value: unknown, memo: z.infer<typeof Memo>) {
      const handle = Handle.omit({ memo: true }).parse(value);
      queueUrl(handle.status_url);
      queueUrl(handle.response_url);
      if (handle.cancel_url) queueUrl(handle.cancel_url);
      return JSON.stringify({ ...handle, memo });
    },
    /** 提交时记下的型号和价钱；任务号里还没有这一项的旧任务返回 undefined */
    memo(serialized: string) {
      return Handle.parse(JSON.parse(serialized)).memo;
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
        // 不设总时限（几十 MB 的 GLB 要下一阵子），按速度判断：从发出请求起每 windowMs 看一次，这一段
        // 收到的不到 minBytes 就掐断，调用方下次查进度时重新下载。2026-11-11 实测：结果刚出来时的
        // 第一次下载常常只有约 9 KiB/s（10 MB 要 18 分钟），掐掉重下 8 秒就完；原来是等满 120 秒才重下。
        const stalled = new AbortController();
        let received = 0;
        const watch = setInterval(() => {
          if (received < flow.minBytes) stalled.abort(new Error('fal 媒体下载太慢，已中断'));
          received = 0;
        }, flow.windowMs);
        const response = await request(url.href, {
          redirect: 'manual',
          signal: stalled.signal,
        }).catch((error: unknown) => {
          clearInterval(watch);
          throw error;
        });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          clearInterval(watch);
          await response.body?.cancel();
          if (!location) throw new Error('fal 媒体重定向没有目标');
          url = new URL(location, url);
          continue;
        }
        if (!response.ok || !response.body) {
          clearInterval(watch);
          if (!response.ok) throw new Error(`fal 媒体下载失败：${response.status}`);
          return response;
        }
        const source = response.body.getReader();
        const counted = new ReadableStream<Uint8Array>({
          async pull(controller) {
            try {
              const { done, value } = await source.read();
              if (done) {
                clearInterval(watch);
                return controller.close();
              }
              received += value.byteLength;
              controller.enqueue(value);
            } catch (error) {
              clearInterval(watch);
              controller.error(error);
            }
          },
          cancel(reason) {
            clearInterval(watch);
            return source.cancel(reason);
          },
        });
        return new Response(counted, { status: response.status, headers: response.headers });
      }
      throw new Error('fal 媒体重定向过多');
    },
  };
}
export type FalClient = ReturnType<typeof createFalClient>;
