// 业务代码抛出的、带 HTTP 状态码的错误。统一错误处理会把它转成 ErrorBody：
// 4xx 原样给出 code 和 message；5xx 一律只回「服务内部错误」，细节只进日志。
import type { z } from 'zod';

export class HttpError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'HttpError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

/** 用 zod 校验外部输入（请求体、路径参数、上游响应），不通过就是 400。 */
export function parseWith<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.join('.') || '请求'}：${issue.message}`)
    .join('；');
  throw new HttpError(400, 'invalid_request', detail);
}
