// 发私聊消息：响应是 SSE 流（accepted → delta × N → done | error），逐个事件回调。
// 接需求时 done 可能连着来几条（问题卡、任务单卡），每条一个 done。
import { StreamEvent } from '@oasis/contracts/conversation';
import { apiFetch, ApiError } from './client.ts';

export async function sendMessage(
  conversationId: string,
  body: { content: string; asTask?: boolean; attachments?: string[] },
  onEvent: (event: StreamEvent) => void,
  replaceMessageId?: string,
  continuing = false,
): Promise<void> {
  const response = await apiFetch(
    `/conversation/v1/conversations/${conversationId}/messages${replaceMessageId ? `/${replaceMessageId}/reply` : ''}`,
    {
      method: 'POST',
      body: replaceMessageId
        ? continuing
          ? { continue: true }
          : body.content
            ? { content: body.content }
            : {}
        : body,
    },
  );
  if (!response.body)
    throw new ApiError(502, 'stream_interrupted', '没有收到回复，请重新读取历史消息');
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  let completed = false;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        if (!completed)
          throw new ApiError(
            0,
            'stream_interrupted',
            '连接中断，已发送的消息会从历史记录同步，请勿重复发送',
          );
        break;
      }
      pending += value.replaceAll('\r\n', '\n');
      for (let end = pending.indexOf('\n\n'); end >= 0; end = pending.indexOf('\n\n')) {
        const block = pending.slice(0, end);
        pending = pending.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart())
          .join('\n');
        if (data) {
          const event = StreamEvent.parse(JSON.parse(data));
          if (event.type === 'done' || event.type === 'error') completed = true;
          onEvent(event);
        }
      }
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(
      0,
      'stream_interrupted',
      '回复连接中断，已发送的消息会从历史记录同步，请勿重复发送',
    );
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
