// 换行分隔的 JSON-RPC 2.0 客户端（dsh SDK 协议的传输层）：每行一条消息；
// 有 id 和 method 是请求，只有 id 是响应，只有 method 是通知。不认识的行忽略。
import type { Readable, Writable } from 'node:stream';

export class JsonRpcError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.name = 'JsonRpcError';
    this.code = code;
  }
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout | undefined;
}

export function createJsonRpcClient(io: {
  input: Readable;
  output: Writable;
  onNotification: (method: string, params: unknown) => void;
}) {
  let nextId = 0;
  let closedError: Error | undefined;
  const pending = new Map<number, Pending>();
  let buffer = '';

  function settle(id: number, fn: (p: Pending) => void) {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimeout(entry.timer);
    fn(entry);
  }

  function handleLine(line: string) {
    let message: {
      id?: number;
      method?: string;
      params?: unknown;
      result?: unknown;
      error?: { code: number; message: string };
    };
    try {
      message = JSON.parse(line) as typeof message;
    } catch {
      return;
    }
    if (message.method !== undefined && message.id === undefined) {
      io.onNotification(message.method, message.params);
    } else if (message.method === undefined && typeof message.id === 'number') {
      const { error, result } = message;
      settle(message.id, (p) =>
        error ? p.reject(new JsonRpcError(error.code, error.message)) : p.resolve(result),
      );
    }
  }

  function fail(err: Error) {
    closedError ??= err;
    for (const id of [...pending.keys()]) settle(id, (p) => p.reject(closedError ?? err));
  }

  io.input.setEncoding('utf8');
  io.input.on('data', (chunk: string) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line) handleLine(line);
    }
  });
  io.input.on('end', () => fail(new Error('连接已关闭')));
  io.input.on('error', (err) => fail(err));

  return {
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
      if (closedError) return Promise.reject(closedError);
      const id = ++nextId;
      return new Promise<T>((resolve, reject) => {
        const timer = timeoutMs
          ? setTimeout(
              () => settle(id, (p) => p.reject(new Error(`${method} 超时（${timeoutMs}ms）`))),
              timeoutMs,
            )
          : undefined;
        pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
        io.output.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    /** 让所有未完成的请求以 err 失败（例如沙箱被销毁） */
    abort: (err: Error) => fail(err),
  };
}
