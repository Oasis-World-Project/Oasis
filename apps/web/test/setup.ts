import { cleanup } from '@testing-library/react';
import { afterEach, beforeEach, vi } from 'vitest';

// jsdom 没有实现滚动；页面里的自动滚动在测试中什么也不做
window.scrollTo = () => undefined;
Element.prototype.scrollIntoView = () => undefined;
Element.prototype.scrollTo = () => undefined;

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

/**
 * 假的推送连接（jsdom 没有 EventSource）：连上就读一遍这个房间（GET …/groups/:id，由假后端应答），之后每四分之一秒
 * 再读一遍，读到的当成一份推送给页面。要自己往里送事件的测试换成 group-stream.ts 的 Stream。
 */
class PollingSource {
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly url: string) {
    queueMicrotask(() => void this.poll());
    this.timer = setInterval(() => void this.poll(), 250);
  }
  private async poll() {
    try {
      const response = await fetch(this.url.replace(/\/events(\?.*)?$/, ''));
      if (this.readyState !== 1) return;
      if (!response.ok) this.onerror?.();
      else
        this.onmessage?.({
          data: JSON.stringify({ type: 'snapshot', snapshot: await response.json() }),
        });
    } catch {
      this.onerror?.();
    }
  }
  close() {
    this.readyState = 2;
    clearInterval(this.timer);
  }
}
beforeEach(() => {
  vi.stubGlobal('EventSource', PollingSource);
});
