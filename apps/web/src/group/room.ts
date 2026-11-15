// 群页里各块共用的东西：群现在的样子、我是谁、能做的操作。
import type { ModelEntry } from '@oasis/contracts/agent';
import type { Mention } from '@oasis/contracts/conversation';
import type { GroupSnapshot } from '@oasis/contracts/group';
import { createContext, useContext } from 'react';

export interface Room {
  group: GroupSnapshot;
  /** 我的用户 ID */
  me: string;
  /** 我是不是群主 */
  owner: boolean;
  models: Map<string, ModelEntry>;
  /** 推送连着没有 */
  online: boolean;
  /** 正在做一件事（改设置、加减 AI……） */
  busy: boolean;
  sending: boolean;
  /** 做一件事：出错写在页面上，返回做成了没有；返回群的新样子就并进来 */
  act: (work: () => Promise<GroupSnapshot | void>) => Promise<boolean>;
  /** 发一句话，返回发出去了没有 */
  send: (content: string, mentions: Mention[]) => Promise<boolean>;
  /** 在输入框里 @ 上谁（舞台卡片上的「@ 它」） */
  mention: (mention: Mention) => void;
}

export const RoomContext = createContext<Room | null>(null);

export function useRoom(): Room {
  const room = useContext(RoomContext);
  if (!room) throw new Error('useRoom 只能在群页里用');
  return room;
}

/** @ 的是谁，写成字：@Claude、@全体 AI、@阿杰 */
export function mentionText(room: Pick<Room, 'group' | 'models'>, mention: Mention): string {
  if (mention.kind === 'all') return '全体 AI';
  if (mention.kind === 'ai') {
    const model = room.models.get(mention.key);
    return model?.profile.name ?? model?.name ?? mention.key;
  }
  return room.group.members.find((m) => m.userId === mention.userId)?.displayName ?? '成员';
}
