// Docker attach 提供流；传输与错误类型直接复用精确版本的官方协议。
import type { Readable, Writable } from 'node:stream';
import { JsonRpcLineTransport, JsonRpcResponseError } from '@deepseek-ai/dsh-sdk-protocol';
export { JsonRpcResponseError as JsonRpcError };
export function createJsonRpcClient(io: {
  input: Readable;
  output: Writable;
  onNotification: (method: string, params: unknown) => void;
  onClose?: (error: Error) => void;
}) {
  const transport = new JsonRpcLineTransport(io.input, io.output);
  const abort = new AbortController();
  let closed: Error | undefined;
  const fail = (error: Error) => {
    if (closed) return;
    closed ??= error;
    abort.abort(closed);
    transport.close();
    io.onClose?.(closed);
  };
  io.output.on('error', fail);
  io.input.on('end', () => fail(new Error('JSON-RPC input closed')));
  io.input.on('error', fail);
  transport.onNotification(io.onNotification);
  transport.start();
  return {
    request<T>(method: string, params?: object, timeoutMs?: number): Promise<T> {
      if (closed) return Promise.reject(closed);
      const signal = timeoutMs
        ? AbortSignal.any([abort.signal, AbortSignal.timeout(timeoutMs)])
        : abort.signal;
      return transport.request(method, params ?? {}, signal) as Promise<T>;
    },
    abort(error: Error) {
      fail(error);
    },
  };
}
