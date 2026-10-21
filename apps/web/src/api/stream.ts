// 发私聊消息：响应是 SSE 流（accepted → delta × N → done | error），逐个事件回调。
import { StreamEvent } from '@oasis/contracts/conversation';
import { apiFetch } from './client.ts';

export async function sendMessage(
  conversationId: string,
  content: string,
  onEvent: (event: StreamEvent) => void,
): Promise<void> {
  const response = await apiFetch(`/conversation/v1/conversations/${conversationId}/messages`, {
    method: 'POST',
    body: { content },
  });
  const reader = response.body!.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += value.replaceAll('\r\n', '\n');
    for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
      const block = pending.slice(0, end);
      pending = pending.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) onEvent(StreamEvent.parse(JSON.parse(data)));
    }
  }
}
