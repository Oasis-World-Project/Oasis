// 从对象存储边读边传一个文件：支持分段请求（Range → 206），视频、音频能拖动进度；
// 响应头带沙箱和 nosniff（ADR 0007 §2），?download=1 时让浏览器另存。
import { fileResponseHeaders, parseRange, type ObjectStore } from '@oasis/service-kit';
import type { FastifyReply, FastifyRequest } from 'fastify';

export async function sendStored(
  request: FastifyRequest,
  reply: FastifyReply,
  store: ObjectStore,
  file: { objectKey: string; size: number; contentType: string; name: string; download: boolean },
) {
  const headers = {
    ...fileResponseHeaders(file.contentType, file.name, file.download),
    'accept-ranges': 'bytes',
  };
  const range = parseRange(request.headers.range, file.size);
  if (range === 'unsatisfiable') {
    return reply
      .code(416)
      .headers({ ...headers, 'content-range': `bytes */${file.size}` })
      .send();
  }
  if (!range) {
    return reply
      .headers({ ...headers, 'content-length': String(file.size) })
      .send(await store.read(file.objectKey));
  }
  return reply
    .code(206)
    .headers({
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${file.size}`,
      'content-length': String(range.end - range.start + 1),
    })
    .send(await store.read(file.objectKey, range));
}
