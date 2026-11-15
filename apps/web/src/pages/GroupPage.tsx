import { useParams } from '@tanstack/react-router';
import { GroupRoom } from '../group/GroupRoom.tsx';

/** 群页，也是和一个好友的私聊页（/chats/$chatId）：同一套消息和推送 */
export function GroupPage() {
  const { groupId, chatId } = useParams({ strict: false }) as { groupId?: string; chatId?: string };
  const id = groupId ?? chatId ?? '';
  return <GroupRoom key={id} id={id} chat={groupId === undefined} />;
}
