// 聊天页里各块共用的东西：这个房间（群、和好友的私聊、和 AI 的私聊）现在的样子、我是谁、能做的操作。
import type { ModelEntry } from '@oasis/contracts/agent';
import type { Mention } from '@oasis/contracts/conversation';
import type { GroupFile, GroupSnapshot } from '@oasis/contracts/group';
import { createContext, useContext } from 'react';
import type { RoomTask } from './workbench/tasks.ts';

/** 随一句话发的文件（已经传到 canvas 的 id）和引用的群文件（路径） */
export interface SendFiles {
  attachments?: string[];
  refs?: string[];
  /** 作为任务发到群里：没 @ 谁时挑最对口的 AI 出来负责 */
  task?: boolean;
}

/** 聊天里能对工作台做的事 */
export interface Bench {
  /** 工作台里的文件，新改的在前：群里是群文件，和 AI 的私聊里是任务交的成果（和好友的私聊没有） */
  files: GroupFile[];
  /** 工作台上的任务 */
  tasks: RoomTask[];
  /** 在工作台里打开一个群文件的预览 */
  openFile: (path: string) => void;
  /** 去工作台看任务；给了哪一个就弹出它的窗 */
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
  /** 重新读一遍：和 AI 的私聊的写接口（引导、停下、开新话题、点确认卡）不回房间的样子，做完读一遍 */
  refresh: () => Promise<void>;
  /** 发一句话（可以带文件、引用群文件），返回发出去了没有 */
  send: (content: string, mentions: Mention[], files?: SendFiles) => Promise<boolean>;
  bench: Bench;
  /** 在输入框里 @ 上谁（舞台卡片上的「@ 它」） */
  mention: (mention: Mention) => void;
  /** 光标回到输入框；给了提示就换成输入框里的提示（如「说说要改哪里」），发出去后清掉 */
  focus: (hint?: string) => void;
}

export const RoomContext = createContext<Room | null>(null);

/** 和 AI 的私聊里做一件事：调它自己的接口，做完重新读一遍 */
export const dmAct = (room: Pick<Room, 'act' | 'refresh'>, work: () => Promise<unknown>) =>
  room.act(async () => {
    await work();
    await room.refresh();
  });

export function useRoom(): Room {
  const room = useContext(RoomContext);
  if (!room) throw new Error('useRoom 只能在聊天页里用');
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
