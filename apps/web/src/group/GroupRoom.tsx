// 群页：整屏是这个群的光，左边聊天窗（群名、舞台、消息、输入框），右边工作台。照原型 ②。
import type { Mention } from '@oasis/contracts/conversation';
import { useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';
import { meQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { aiLook } from './people.ts';
import { addMention, RoomComposer } from './RoomComposer.tsx';
import { RoomHeader } from './RoomHeader.tsx';
import { RoomMessages } from './RoomMessages.tsx';
import { RoomContext, useRoom, type Room } from './room.ts';
import { Stage } from './Stage.tsx';
import { useGroupRoom } from './use-group-room.ts';

const WINDOW = 'glass-window box-border flex min-w-0 flex-col rounded-window';

/** 工作台收起时的窄条：在忙的 AI。群文件、预览、任务看板在之后的阶段做 */
function WorkbenchRail() {
  const { group, models } = useRoom();
  const busy = group.ais.filter((ai) => ai.runId);
  return (
    <section
      aria-label="工作台（收起）"
      className={`${WINDOW} w-[104px] shrink-0 items-center gap-[18px] py-[22px]`}
    >
      <button
        type="button"
        disabled
        aria-label="展开工作台"
        title="群文件和任务看板：即将开放"
        className="flex size-11 items-center justify-center rounded-full border-0 bg-bubble text-ink shadow-edge-bright disabled:cursor-not-allowed disabled:opacity-55"
      >
        <ChevronLeft size={18} strokeWidth={2} aria-hidden="true" />
      </button>
      <span className="text-[12.5px] font-medium tracking-[0.3em] [writing-mode:vertical-rl]">
        工作台
      </span>
      <span className="flex-1" />
      {busy.map((ai) => {
        const look = aiLook(models, ai.key);
        return <AiAvatar key={ai.key} mono={look.mono} glow={look.glow} size={40} glowing />;
      })}
      {busy.length > 0 && (
        <span className="text-center text-[11.5px] leading-[1.4] text-ink-muted">
          {busy.length} 个 AI
          <br />
          在忙
        </span>
      )}
    </section>
  );
}

export function GroupRoom({ id }: { id: string }) {
  const state = useGroupRoom(id);
  const { group, error } = state;
  const me = useQuery(meQuery);
  const models = useModelMap();
  const navigate = useNavigate();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const mention = useCallback((next: Mention) => {
    setMentions((list) => addMention(list, next));
  }, []);
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
          }
        : null,
    [group, myId, models, online, busy, sending, act, send, mention],
  );
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
          <section aria-label="聊天" className={`${WINDOW} relative flex-[1_1_560px]`}>
            <RoomHeader
              onLeft={() => {
                state.leave();
                void navigate({ to: '/groups' });
              }}
            >
              <Stage />
            </RoomHeader>
            {error && (
              <p role="alert" className="m-0 px-7 pb-1 text-[13px] text-accent">
                {error}
              </p>
            )}
            <RoomMessages hasOlder={state.hasOlder} onOlder={() => void state.loadOlder()} />
            <RoomComposer mentions={mentions} onMentions={setMentions} />
          </section>
          <WorkbenchRail />
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
