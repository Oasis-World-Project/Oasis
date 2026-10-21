// 从请求里读 gateway 写入的可信头。服务只信任这些头，因为 gateway 会丢弃客户端伪造的 x-oasis-*。
import { OASIS_HEADERS } from '@oasis/contracts/common';
import type { FastifyRequest } from 'fastify';
import { HttpError } from './http-error.ts';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readUuidHeader(request: FastifyRequest, header: string): string | undefined {
  const value = request.headers[header];
  return typeof value === 'string' && UUID.test(value) ? value : undefined;
}

/** 当前登录用户；没有就是 401。 */
export function requireUserId(request: FastifyRequest): string {
  const userId = readUuidHeader(request, OASIS_HEADERS.userId);
  if (!userId) throw new HttpError(401, 'unauthenticated', '请先登录');
  return userId;
}

/** 这次模型调用的付费人；内部接口用。 */
export function requirePayerId(request: FastifyRequest): string {
  const payerId = readUuidHeader(request, OASIS_HEADERS.payerId);
  if (!payerId) throw new HttpError(400, 'missing_payer', '缺少付费人');
  return payerId;
}

/** 从 Cookie 请求头里取某个 Cookie 的值。 */
export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name)
      return decodeURIComponent(part.slice(index + 1).trim());
  }
  return undefined;
}
