// 打包下载：几份成果按给的路径打成 ZIP，边读边传（不整个读进内存）；路径不安全、超过上限的拒绝。
import { once } from 'node:events';
import { PassThrough } from 'node:stream';
import { Zip, ZipPassThrough } from 'fflate';
import { HttpError, type ObjectStore } from '@oasis/service-kit';
import type { Artifact } from '../repo/artifacts-repo.ts';

export interface ArchiveLimits {
  bytes: number;
  files: number;
}

/** 打包：entryOf 给每份成果在包里的路径 */
export function zipArtifacts(
  store: ObjectStore,
  rows: Artifact[],
  entryOf: (row: Artifact) => string,
  limits: ArchiveLimits,
): PassThrough {
  if (rows.length > limits.files || rows.reduce((n, row) => n + row.size, 0) > limits.bytes)
    throw new HttpError(413, 'archive_size', '成果超过打包上限，请分别下载');
  const seen = new Set<string>();
  for (const row of rows) {
    const name = entryOf(row);
    if (
      !name ||
      name.includes('\\') ||
      name.startsWith('/') ||
      name
        .split('/')
        // eslint-disable-next-line no-control-regex
        .some((p) => !p || p === '.' || p === '..' || /[:\u0000-\u001f]/.test(p)) ||
      seen.has(name.toLowerCase())
    )
      throw new HttpError(422, 'archive_path', '成果目录异常，不能安全打包');
    seen.add(name.toLowerCase());
  }
  const content = new PassThrough();
  const cancel = new AbortController();
  const zip = new Zip((error, bytes, final) => {
    if (error) content.destroy(error);
    else {
      content.write(bytes);
      if (final) content.end();
    }
  });
  content.on('close', () => {
    cancel.abort();
    zip.terminate();
  });
  void (async () => {
    let total = 0;
    for (const row of rows) {
      if (content.destroyed) return;
      const file = new ZipPassThrough(entryOf(row));
      zip.add(file);
      const source = await store.read(row.objectKey);
      let size = 0;
      try {
        for await (const chunk of source) {
          const bytes = Buffer.from(chunk as Uint8Array);
          size += bytes.length;
          total += bytes.length;
          if (size > row.size || total > limits.bytes) throw new Error('成果内容大小不一致');
          file.push(bytes);
          if (content.writableNeedDrain) await once(content, 'drain', { signal: cancel.signal });
          if (content.destroyed) return;
        }
        if (size !== row.size) throw new Error('成果内容大小不一致');
        file.push(new Uint8Array(), true);
      } finally {
        source.destroy();
      }
    }
    zip.end();
  })().catch((error: unknown) =>
    content.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return content;
}
