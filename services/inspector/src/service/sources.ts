// 下载要检查的东西（ADR 0024）：只认配置里放行的对象存储地址——运行产出、用户素材由所属服务
// （harness、canvas）签发临时链接，inspector 不调这些服务，也不能被当成任意网址的代理。
import { Readable } from 'node:stream';
import { HttpError } from '@oasis/service-kit';

export function createSources(deps: { origins: string[]; timeoutMs: number }) {
  const allowed = new Set(deps.origins.map((origin) => new URL(origin).origin));
  return {
    /** 打开一个下载链接，返回内容流（调用方读完或丢弃）；链接过期、东西不在了是 404 */
    async open(url: string, signal?: AbortSignal): Promise<Readable> {
      const target = new URL(url);
      if (!allowed.has(target.origin))
        throw new HttpError(400, 'source_not_allowed', '只接受对象存储的临时下载链接');
      let response: Response;
      try {
        response = await fetch(target, {
          redirect: 'error',
          signal: AbortSignal.any([
            AbortSignal.timeout(deps.timeoutMs),
            ...(signal ? [signal] : []),
          ]),
        });
      } catch {
        signal?.throwIfAborted();
        throw new HttpError(
          502,
          'source_unavailable',
          '下载要检查的文件失败（对象存储连不上或超时）',
        );
      }
      if (response.status === 403 || response.status === 404) {
        await response.body?.cancel();
        throw new HttpError(404, 'source_not_found', '要检查的文件不在了，或下载链接已过期');
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new HttpError(
          502,
          'source_unavailable',
          `下载要检查的文件失败（${response.status}）`,
        );
      }
      return Readable.fromWeb(response.body);
    },
  };
}

export type Sources = ReturnType<typeof createSources>;
