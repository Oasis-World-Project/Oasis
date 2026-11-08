// 开容器的检查（解码、浏览器）同时最多开几个：多出来的排队，排队时间不计费；调用方断开就不再等。
export function createQueue(limit: number) {
  let active = 0;
  const waiting: (() => void)[] = [];
  return async <T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> => {
    while (active >= limit) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener('abort', wake);
          const index = waiting.indexOf(wake);
          if (index >= 0) waiting.splice(index, 1);
          resolve();
        };
        waiting.push(wake);
        signal?.addEventListener('abort', wake, { once: true });
      });
    }
    signal?.throwIfAborted();
    active++;
    try {
      return await work();
    } finally {
      active--;
      waiting.shift()?.();
    }
  };
}
