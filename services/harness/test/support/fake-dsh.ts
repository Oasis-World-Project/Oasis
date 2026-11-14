// 运行服务测试用的假 dsh SDK 运行时：说同样的 JSON-RPC。
import type { PassThrough } from 'node:stream';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 假 dsh 收到的其他方法（initialize、session/resume、shutdown） */
export const methods: string[] = [];

/**
 * 每条用户消息处理成一轮：回一句 "收到：<内容>"；内容含 FAIL 时这一轮以模型错误结束；含 SLOW 时
 * 这一轮要很久。
 */
export function fakeDsh(stdin: PassThrough, stdout: PassThrough) {
  const queue: string[] = [];
  const waiters: (() => void)[] = [];
  let busy = false;
  let sessionId = '';
  const send = (msg: unknown) => stdout.write(`${JSON.stringify(msg)}\n`);
  const event = (type: string, data: unknown) =>
    send({ jsonrpc: '2.0', method: 'session.event', params: { sessionId, event: { type, data } } });
  async function drain() {
    if (busy) return;
    busy = true;
    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'running' } });
    while (queue.length > 0) {
      const text = queue.shift() ?? '';
      event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] });
      event('user/message', {
        source: { kind: 'runtime' },
        content: [{ type: 'text', text: 'ctx' }],
      });
      await sleep(text.includes('SLOW') ? 5_000 : 20);
      if (text.includes('FAIL')) {
        event('turn/end', { reason: { kind: 'error', error: { message: '上游 500' } } });
      } else if (text.includes('TRUNCATED')) {
        event('turn/end', { reason: { kind: 'max-tokens' } });
      } else if (text.includes('NO_END')) {
        // session/wait 返回空闲，但没有正常结束通知。
      } else {
        event('assistant/message', {
          message: { content: [{ type: 'text', text: `收到：${text}` }] },
        });
        event('turn/end', { reason: { kind: 'completed' } });
      }
    }
    busy = false;
    send({ jsonrpc: '2.0', method: 'session.status', params: { sessionId, status: 'idle' } });
    waiters.splice(0).forEach((resolve) => resolve());
  }
  let buffer = '';
  stdin.setEncoding('utf8');
  stdin.on('data', (chunk: string) => {
    buffer += chunk;
    let i;
    while ((i = buffer.indexOf('\n')) >= 0) {
      const req = JSON.parse(buffer.slice(0, i)) as {
        id: number;
        method: string;
        params: { sessionId?: string; contentBlocks?: { text: string }[] };
      };
      buffer = buffer.slice(i + 1);
      if (req.method === 'session/prompt') {
        sessionId = req.params.sessionId ?? '';
        queue.push(req.params.contentBlocks?.[0]?.text ?? '');
        send({ jsonrpc: '2.0', id: req.id, result: { messageId: 'm' } });
        void drain();
      } else if (req.method === 'session/wait') {
        if (!busy && queue.length === 0) send({ jsonrpc: '2.0', id: req.id, result: {} });
        else waiters.push(() => send({ jsonrpc: '2.0', id: req.id, result: {} }));
      } else {
        methods.push(req.method);
        send({ jsonrpc: '2.0', id: req.id, result: {} });
      }
    }
  });
}
