// 前端只和 gateway 打交道：所有请求都走同源的 /api（开发时由 Vite 转发），会话 Cookie 由浏览器自动带上。
import { ErrorBody } from '@oasis/contracts/common';
import type { z } from 'zod';

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function toApiError(response: Response): Promise<ApiError> {
  const parsed = ErrorBody.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? new ApiError(response.status, parsed.data.error.code, parsed.data.error.message)
    : new ApiError(response.status, 'http_error', `请求失败（${response.status}）`);
}

interface RequestInit {
  method?: string;
  body?: unknown;
  signal?: AbortSignal;
  /** 普通 JSON 读取的截止；长任务/流式接口不使用默认读取截止。 */
  timeoutMs?: number;
}

export function isConnectionError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 0 || error.status >= 500);
}

export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`/api${path}`, {
      method: init.method ?? 'GET',
      credentials: 'same-origin',
      headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: init.signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(0, 'network_error', '连不上服务器，请检查网络或服务是否已启动');
  }
  if (!response.ok) throw await toApiError(response);
  return response;
}

export async function api<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
): Promise<T> {
  const timeoutMs = init.timeoutMs ?? ((init.method ?? 'GET') === 'GET' ? 15_000 : undefined);
  const deadline = timeoutMs === undefined ? undefined : AbortSignal.timeout(timeoutMs);
  const signal = deadline
    ? AbortSignal.any(init.signal ? [init.signal, deadline] : [deadline])
    : init.signal;
  try {
    const response = await apiFetch(path, { ...init, signal });
    return schema.parse(await response.json());
  } catch (error) {
    if (init.signal?.aborted) throw init.signal.reason;
    if (deadline?.aborted)
      throw new ApiError(0, 'request_timeout', '读取超时，服务恢复后会重新连接');
    if (error instanceof TypeError)
      throw new ApiError(0, 'network_error', '读取连接中断，服务恢复后会重新连接');
    throw error;
  }
}

export async function apiVoid(path: string, init?: RequestInit): Promise<void> {
  await apiFetch(path, init);
}
