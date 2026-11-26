import { useParams, useSearch } from '@tanstack/react-router';
import { ChatRoom } from '../group/ChatRoom.tsx';

/** 聊天页：群（/groups/$groupId）、和一个好友的私聊（/chats/$chatId）、和一个 AI 的私聊（/dms/$conversationId）同一页 */
export function ChatPage() {
  const { groupId, chatId, conversationId } = useParams({ strict: false }) as {
    groupId?: string;
    chatId?: string;
    conversationId?: string;
  };
  const { task } = useSearch({ strict: false }) as { task?: string };
  const id = groupId ?? chatId ?? conversationId ?? '';
  return (
    <ChatRoom
      key={id}
      id={id}
      kind={groupId ? 'group' : chatId ? 'direct' : 'dm'}
      {...(task ? { task } : {})}
    />
  );
}
