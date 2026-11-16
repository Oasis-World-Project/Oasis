// 群页：整屏是这个群的光，左边聊天窗（群名、舞台、消息、输入框），右边工作台（收起、展开、拉宽）。照原型 ②。
// 和一个好友的私聊也是这一页：没有舞台和工作台，页头是对方。
import type { Mention } from '@oasis/contracts/conversation';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { meQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { addMention, RoomComposer } from './RoomComposer.tsx';
import { RoomHeader } from './RoomHeader.tsx';
import { RoomMessages } from './RoomMessages.tsx';
import { RoomContext, type Bench, type Room } from './room.ts';
import { Stage } from './Stage.tsx';
import { useGroupRoom } from './use-group-room.ts';
import { useWorkbench } from './workbench/use-workbench.ts';
import { Workbench } from './workbench/Workbench.tsx';

const WINDOW = 'glass-window box-border flex min-w-0 flex-col rounded-window';
/** 聊天窗的宽度跟着工作台变：收起时最宽，拉宽工作台时收窄（照原型的三种比例） */
const CHAT_WIDTH = {
  collapsed: 'flex-[1_1_560px]',
  open: 'flex-[1.1_1_480px]',
  wide: 'max-w-[500px] flex-[1_1_380px]',
};

/** 好友不再是好友时，两人的私聊就不在了 */
const CHAT_GONE = '这个聊天不在了：你们已经不是好友。';

export function GroupRoom({ id, chat = false }: { id: string; chat?: boolean }) {
  const state = useGroupRoom(id, chat ? CHAT_GONE : undefined);
  const { group, error } = state;
  const me = useQuery(meQuery);
  const models = useModelMap();
  const navigate = useNavigate();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const mention = useCallback((next: Mention) => {
    setMentions((list) => addMention(list, next));
  }, []);
  /** 输入框里引用着的群文件（路径） */
  const [refs, setRefs] = useState<string[]>([]);
  const workbench = useWorkbench(group);
  const { files, openFile, openTasks } = workbench;
  const bench = useMemo<Bench>(
    () => ({
      files,
      openFile,
      openTasks,
      quote: (path) => setRefs((list) => (list.includes(path) ? list : [...list, path])),
    }),
    [files, openFile, openTasks],
  );
  const myId = me.data?.id;
  const { online, busy, sending, act, send } = state;
  const room = useMemo<Room | null>(
    () =>
      group && myId
        ? {
            group,
            me: myId,
            owner: group.ownerId === myId,
            models,
            online,
            busy,
            sending,
            act,
            send,
            mention,
            bench,
          }
        : null,
    [group, myId, models, online, busy, sending, act, send, mention, bench],
  );
  const direct = group?.kind === 'direct';
  return (
    <div className="-mx-1 -mt-2 flex h-[calc(100vh-36px)] min-h-[560px] gap-[18px]">
      {/* 整屏换成这个群的光：铺在最底下，侧栏的玻璃透出来的也是它 */}
      <div
        aria-hidden="true"
        data-light={group?.options.light ?? 'coral'}
        className="oasis-room fixed inset-0 -z-10"
      />
      {room ? (
        <RoomContext.Provider value={room}>
          <section
            aria-label="聊天"
            className={`${WINDOW} relative ${CHAT_WIDTH[direct ? 'collapsed' : workbench.mode]}`}
          >
            <RoomHeader
              onLeft={() => {
                state.leave();
                void navigate({ to: '/groups' });
              }}
            >
              {!direct && <Stage />}
            </RoomHeader>
            {error && (
              <p role="alert" className="m-0 px-7 pb-1 text-[13px] text-accent">
                {error}
              </p>
            )}
            <RoomMessages hasOlder={state.hasOlder} onOlder={() => void state.loadOlder()} />
            <RoomComposer
              mentions={mentions}
              onMentions={setMentions}
              refs={refs}
              onRefs={setRefs}
            />
          </section>
          {!direct && <Workbench bench={workbench} />}
        </RoomContext.Provider>
      ) : (
        <section
          aria-label="聊天"
          className={`${WINDOW} flex-1 items-center justify-center gap-3 p-8 text-sm text-ink-muted`}
        >
          {error ? (
            <p role="alert" className="m-0 text-accent">
              {error}
            </p>
          ) : (
            <p className="m-0">连接中…</p>
          )}
        </section>
      )}
    </div>
  );
}
