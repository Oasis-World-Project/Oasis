import { useParams } from '@tanstack/react-router';
import { GroupRoom } from '../group/GroupRoom.tsx';

export function GroupPage() {
  const { groupId } = useParams({ strict: false }) as { groupId: string };
  return <GroupRoom key={groupId} id={groupId} />;
}
