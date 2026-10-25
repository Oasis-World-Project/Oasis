import { FilePreviewBody } from '@oasis/contracts/canvas';

/** 不依赖服务器声明的 Content-Length，在读取中执行上限并及时取消。 */
export async function readPreviewFile(
  url: string,
  signal: AbortSignal,
  maxBytes: number,
): Promise<Uint8Array> {
  // 文件只允许走现有鉴权下载通路，不接受外部地址。
  if (!url.startsWith('/api/')) throw new Error('文件地址无效');
  const response = await fetch(url, { credentials: 'same-origin', signal });
  if (!response.ok) throw new Error('文件没能打开');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('文件内容为空');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.length;
      if (size > maxBytes) throw new Error('文件超过预览大小上限，请下载查看');
      chunks.push(chunk.value);
    }
  } finally {
    await reader.cancel();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export async function convertPreview(
  url: string,
  name: string,
  signal: AbortSignal,
): Promise<FilePreviewBody> {
  const content = await readPreviewFile(url, signal, 20 * 1024 * 1024);
  const response = await fetch(`/api/canvas/v1/previews?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    credentials: 'same-origin',
    signal,
    headers: { 'content-type': 'application/octet-stream' },
    body: new Blob([content as Uint8Array<ArrayBuffer>]),
  });
  if (!response.ok) throw new Error('文件转换失败或超过安全解析上限，请下载查看');
  return FilePreviewBody.parse(await response.json());
}
