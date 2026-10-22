// 服务之间的同步调用。地址来自配置（Compose DNS / K8s Service），不硬编码。
// 对方返回 4xx：原样抛出它的 code 和 message。
// 对方返回 5xx：状态统一成 502（503 保留，表示暂时不可用）；带了标准错误体时保留它的 code，方便调用方给出准确提示。
// 连不上：抛 503 upstream_unavailable。
import { ErrorBody, OASIS_HEADERS } from '@oasis/contracts/common';
import type { z } from 'zod';
import { HttpError } from './http-error.ts';

interface RequestOptions<T> {
  body?: unknown;
  headers?: Record<string, string>;
  requestId?: string;
  schema?: z.ZodType<T>;
  signal?: AbortSignal;
}

export interface ServiceClient {
  /** 发 JSON 请求并校验响应；没有正文的成功响应（204、空的 202 等）返回 undefined。 */
  json<T>(method: string, path: string, options?: RequestOptions<T>): Promise<T>;
  /** 拿到原始 Response（流式响应用），非 2xx 同样抛 HttpError。 */
  stream(method: string, path: string, options?: RequestOptions<never>): Promise<Response>;
}

async function toHttpError(target: string, response: Response): Promise<HttpError> {
  const parsed = ErrorBody.safeParse(await response.json().catch(() => null));
  if (response.status < 500 && parsed.success) {
    return new HttpError(response.status, parsed.data.error.code, parsed.data.error.message);
  }
  const status = response.status === 503 ? 503 : 502;
  return parsed.success
    ? new HttpError(status, parsed.data.error.code, parsed.data.error.message)
    : new HttpError(status, 'upstream_error', `${target} 返回 ${response.status}`);
}

export function createServiceClient(
  target: string,
  baseUrl: string,
  { timeoutMs = 10_000 }: { timeoutMs?: number } = {},
): ServiceClient {
  async function send(
    method: string,
    path: string,
    options: RequestOptions<unknown>,
    timeout: boolean,
  ) {
    const headers: Record<string, string> = { ...options.headers };
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (options.requestId) headers[OASIS_HEADERS.requestId] = options.requestId;
    const signals = [options.signal, timeout ? AbortSignal.timeout(timeoutMs) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    let response: Response;
    try {
      response = await fetch(new URL(path, baseUrl), {
        method,
        headers,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
        signal: signals.length ? AbortSignal.any(signals) : undefined,
      });
    } catch {
      throw new HttpError(503, 'upstream_unavailable', `${target} 暂时不可用`);
    }
    if (!response.ok) throw await toHttpError(target, response);
    return response;
  }

  return {
    async json<T>(method: string, path: string, options: RequestOptions<T> = {}): Promise<T> {
      const response = await send(method, path, options, true);
      // 204，或者 202 这类成功但没有正文的响应，都返回 undefined
      const text = response.status === 204 ? '' : await response.text();
      if (text === '') return undefined as T;
      const data: unknown = JSON.parse(text);
      if (!options.schema) return data as T;
      const parsed = options.schema.safeParse(data);
      if (!parsed.success)
        throw new HttpError(502, 'upstream_error', `${target} 返回的数据格式不对`);
      return parsed.data;
    },
    // 流式响应可能持续很久，不加总超时，由调用方用 signal 控制
    stream: (method, path, options = {}) => send(method, path, options, false),
  };
}
