// 群页里各块共用的东西：群现在的样子、我是谁、能做的操作。
import type { ModelEntry } from '@oasis/contracts/agent';
import type { Mention } from '@oasis/contracts/conversation';
import type { GroupFile, GroupSnapshot } from '@oasis/contracts/group';
import { createContext, useContext } from 'react';

/** 随一句话发的文件（已经传到 canvas 的 id）和引用的群文件（路径） */
export interface SendFiles {
  attachments?: string[];
  refs?: string[];
  /** 作为任务发到群里：没 @ 谁时挑最对口的 AI 出来负责 */
  task?: boolean;
}

/** 聊天里能对工作台做的事 */
export interface Bench {
  /** 群文件，新改的在前（和好友的私聊没有） */
  files: GroupFile[];
  /** 在工作台里打开一个群文件的预览 */
  openFile: (path: string) => void;
  /** 去工作台看任务；给了哪一轮就展开它的过程 */
  openTasks: (runId?: string) => void;
  /** 把一个群文件引用进输入框 */
  quote: (path: string) => void;
}

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
  /** 发一句话（可以带文件、引用群文件），返回发出去了没有 */
  send: (content: string, mentions: Mention[], files?: SendFiles) => Promise<boolean>;
  bench: Bench;
  /** 在输入框里 @ 上谁（舞台卡片上的「@ 它」） */
  mention: (mention: Mention) => void;
}

export const RoomContext = createContext<Room | null>(null);

export function useRoom(): Room {
  const room = useContext(RoomContext);
  if (!room) throw new Error('useRoom 只能在群页里用');
  return room;
}

/** 人传的文件在群文件里的路径：就是文件名，去掉目录分隔和换行（和服务端同一个规则） */
export function uploadPath(name: string): string {
  const safe = name.replace(/[\\/\r\n]/g, '_').trim();
  return safe === '' || safe === '.' || safe === '..' ? '_' : safe;
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
