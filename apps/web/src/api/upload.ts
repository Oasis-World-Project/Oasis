// 上传素材到 canvas（ADR 0007 §3）：请求体就是文件本身。用 XHR 是为了拿到上传进度（fetch 拿不到）。
import { UploadBody } from '@oasis/contracts/canvas';
import { ErrorBody } from '@oasis/contracts/common';
import { ApiError } from './client.ts';

/** 和 canvas 的默认上限一致；超过的不用传上去再被拒 */
export const UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

export const uploadUrl = (id: string, download = false) =>
  `/api/canvas/v1/uploads/${id}${download ? '?download=1' : ''}`;

export function uploadFile(
  file: File,
  onProgress: (fraction: number) => void,
  signal?: AbortSignal,
): Promise<UploadBody> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/canvas/v1/uploads?name=${encodeURIComponent(file.name)}`);
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        // 不是 JSON（比如网关的 413 页面），按状态码报错
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        const parsed = UploadBody.safeParse(body);
        if (parsed.success) resolve(parsed.data);
        else reject(new ApiError(xhr.status, 'bad_response', '上传结果看不懂，请重试'));
        return;
      }
      const error = ErrorBody.safeParse(body);
      reject(
        error.success
          ? new ApiError(xhr.status, error.data.error.code, error.data.error.message)
          : new ApiError(
              xhr.status,
              'http_error',
              xhr.status === 413 ? '文件太大了' : `上传失败（${xhr.status}）`,
            ),
      );
    };
    xhr.onerror = () =>
      reject(new ApiError(0, 'network_error', '连不上服务器，请检查网络或服务是否已启动'));
    xhr.onabort = () => reject(new DOMException('上传已取消', 'AbortError'));
    signal?.addEventListener('abort', () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}
