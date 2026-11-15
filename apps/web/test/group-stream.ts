// 测试用的假推送连接（EventSource）：测试自己往里送事件。
import { vi } from 'vitest';

export class Stream {
  static instances: Stream[] = [];
  readyState = 1;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  close = vi.fn();
  constructor(readonly url = '') {
    Stream.instances.push(this);
  }
  emit(value: unknown) {
    this.onmessage?.({ data: JSON.stringify(value) });
  }
  /** 服务端回了错误：连接彻底关了，浏览器不会再自己重连 */
  fail() {
    this.readyState = 2;
    this.onerror?.();
  }
}
