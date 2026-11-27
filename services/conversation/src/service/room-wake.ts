// 房间里的消息变了就叫醒这个房间开着的推送（group-routes.ts 的推送循环），不用等它下一次自己去查。
// 只在这个进程里叫：没经过这里的改动（别人发的话、改设置），推送照旧隔一会儿自己查到。
import { setTimeout as delay } from 'node:timers/promises';

export function createRoomWake() {
  const waiting = new Map<string, Set<() => void>>();
  return {
    /** 这个房间的消息变了 */
    wake(roomId: string): void {
      for (const resolve of [...(waiting.get(roomId) ?? [])]) resolve();
    },
    /** 等到这个房间变了，或过了 ms（signal 中止时抛错，和 timers 的 delay 一样） */
    async wait(roomId: string, ms: number, signal: AbortSignal): Promise<void> {
      const waiters = waiting.get(roomId) ?? new Set<() => void>();
      waiting.set(roomId, waiters);
      let woken: () => void = () => undefined;
      const timer = new AbortController();
      const stop = () => timer.abort();
      signal.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([
          new Promise<void>((resolve) => {
            woken = resolve;
            waiters.add(resolve);
          }),
          // 被叫醒后这个定时器跟着取消，取消时的报错不用管
          delay(ms, undefined, { signal: timer.signal }).catch(() => undefined),
        ]);
        signal.throwIfAborted();
      } finally {
        timer.abort();
        signal.removeEventListener('abort', stop);
        waiters.delete(woken);
        if (!waiters.size) waiting.delete(roomId);
      }
    },
  };
}

export type RoomWake = ReturnType<typeof createRoomWake>;
