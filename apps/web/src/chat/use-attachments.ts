// 输入框里待发送的文件：选中就开始上传；全部传完才能发送，发送后清空（ADR 0007 §5）。
import { MAX_ATTACHMENTS } from '@oasis/contracts/conversation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { UPLOAD_MAX_BYTES, uploadFile } from '../api/upload.ts';
import { formatBytes } from '../ui/format.ts';

export interface PendingFile {
  key: string;
  name: string;
  size: number;
  /** 0–1 */
  progress: number;
  status: 'uploading' | 'done' | 'failed';
  uploadId?: string;
  error?: string;
}

export function useAttachments() {
  const [files, setFiles] = useState<PendingFile[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const controllers = useRef(new Map<string, AbortController>());
  const seq = useRef(0);

  const patch = useCallback(
    (key: string, change: Partial<PendingFile>) =>
      setFiles((list) => list.map((f) => (f.key === key ? { ...f, ...change } : f))),
    [],
  );

  const add = useCallback(
    (picked: Iterable<File>) => {
      const incoming = [...picked];
      if (incoming.length === 0) return;
      const room = MAX_ATTACHMENTS - files.length;
      const tooBig = incoming.filter((f) => f.size > UPLOAD_MAX_BYTES);
      const accepted = incoming
        .filter((f) => f.size <= UPLOAD_MAX_BYTES)
        .slice(0, Math.max(0, room));
      const problems = [
        tooBig.length > 0 &&
          `${tooBig.map((f) => f.name).join('、')} 超过 ${formatBytes(UPLOAD_MAX_BYTES)}，没有添加`,
        incoming.length - tooBig.length > accepted.length &&
          `一条消息最多带 ${MAX_ATTACHMENTS} 个文件`,
      ].filter(Boolean);
      setNotice(problems.length ? problems.join('；') : null);

      for (const file of accepted) {
        seq.current += 1;
        const key = `f${seq.current}`;
        const controller = new AbortController();
        controllers.current.set(key, controller);
        setFiles((list) => [
          ...list,
          { key, name: file.name, size: file.size, progress: 0, status: 'uploading' },
        ]);
        uploadFile(file, (progress) => patch(key, { progress }), controller.signal)
          .then((upload) => patch(key, { status: 'done', progress: 1, uploadId: upload.id }))
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            patch(key, {
              status: 'failed',
              error: err instanceof ApiError ? err.message : '上传失败了',
            });
          })
          .finally(() => controllers.current.delete(key));
      }
    },
    [files.length, patch],
  );

  const remove = useCallback((key: string) => {
    controllers.current.get(key)?.abort();
    setFiles((list) => list.filter((f) => f.key !== key));
  }, []);

  /** 发出去之后清空（这时都已经传完了） */
  const clear = useCallback(() => {
    setFiles([]);
    setNotice(null);
  }, []);

  // 离开页面时停掉还在传的
  useEffect(() => {
    const running = controllers.current;
    return () => running.forEach((c) => c.abort());
  }, []);

  return {
    files,
    notice,
    add,
    remove,
    clear,
    uploading: files.some((f) => f.status === 'uploading'),
    failed: files.some((f) => f.status === 'failed'),
    ids: files.flatMap((f) => (f.status === 'done' && f.uploadId ? [f.uploadId] : [])),
  };
}
