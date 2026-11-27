// 聊天页：群、和一个好友的私聊、和一个 AI 的私聊是同一页。左边聊天窗（页头、消息、输入框），右边工作台
// （收起、展开、拉宽；和好友的私聊没有）。整屏是这个群的光。点开一个任务弹出它的窗。照原型 ②。
import type { Mention } from '@oasis/contracts/conversation';
import { useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState, type DragEvent } from 'react';
import { meQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { useAttachments } from '../chat/use-attachments.ts';
import { ChatActionsContext } from '../chat/use-chat-actions.ts';
import { actionsFor } from './ai-actions.ts';
import { addMention, RoomComposer } from './RoomComposer.tsx';
import { RoomHeader } from './RoomHeader.tsx';
import { RoomMessages } from './RoomMessages.tsx';
import { RoomContext, type Bench, type Room } from './room.ts';
import { Stage } from './Stage.tsx';
import { useGroupRoom } from './use-group-room.ts';
import { useVault, VaultDialog } from './Vault.tsx';
import { TaskDialog } from './workbench/TaskDialog.tsx';
import { useWorkbench } from './workbench/use-workbench.ts';
import { Workbench } from './workbench/Workbench.tsx';

const WINDOW = 'glass-window box-border flex min-w-0 flex-col rounded-window';
/** 聊天窗的宽度跟着工作台变：收起时最宽，拉宽工作台时收窄（照原型的三种比例） */
const CHAT_WIDTH = {
  collapsed: 'flex-[1_1_560px]',
  open: 'flex-[1.1_1_480px]',
  wide: 'max-w-[500px] flex-[1_1_380px]',
};

type Kind = 'group' | 'direct' | 'dm';
/** 这个房间不在了时写在页面上的话，和回哪去 */
const GONE: Record<Kind, { text: string; back: '/groups' | '/dms' }> = {
  group: { text: '这个群已解散，或你已不在群里。', back: '/groups' },
  direct: { text: '这个聊天不在了：你们已经不是好友。', back: '/dms' },
  dm: { text: '这段私聊已经删掉了。', back: '/dms' },
};

export function ChatRoom({
  id,
  kind = 'group',
  task,
}: {
  id: string;
  /** 从哪个入口进来的：还没连上时页面上的话按它写 */
  kind?: Kind;
  /** 进来就在工作台里展开这个任务的过程（从画布的「看过程」来） */
  task?: string;
}) {
  const state = useGroupRoom(id, GONE[kind].text);
  const { group, error } = state;
  const me = useQuery(meQuery);
  const models = useModelMap();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mentions, setMentions] = useState<Mention[]>([]);
  const mention = useCallback((next: Mention) => {
    setMentions((list) => addMention(list, next));
  }, []);
  /** 输入框里引用着的群文件（路径） */
  const [refs, setRefs] = useState<string[]>([]);
  const workbench = useWorkbench(group, task);
  const { files, tasks, openFile, openTasks } = workbench;
  const bench = useMemo<Bench>(
    () => ({
      files,
      tasks,
      openFile,
      openTasks,
      quote: (path) => setRefs((list) => (list.includes(path) ? list : [...list, path])),
    }),
    [files, tasks, openFile, openTasks],
  );
  const focused = tasks.find((item) => item.runId === workbench.focus);
  const { vault, ...vaultWindow } = useVault(group);
  const myId = me.data?.id;
  const { online, busy, sending, act, send } = state;
  const input = useRef<HTMLTextAreaElement>(null);
  /** 卡片要求的提示（如「说说要改哪里」）：显示在输入框里，发出去后清掉 */
  const [hint, setHint] = useState<string | null>(null);
  const focus = useCallback((next?: string) => {
    setHint(next ?? null);
    input.current?.focus();
  }, []);
  /** 重新读一遍；私聊的列表、额度跟着变（发了话、开了新话题、换了地方） */
  const { refresh: reload } = state;
  const refresh = useCallback(async () => {
    // 读不回来不要紧：推送还连着，下一份照样会到
    await reload().catch(() => undefined);
    void queryClient.invalidateQueries({ queryKey: ['dms'] });
    void queryClient.invalidateQueries({ queryKey: ['wallet'] });
  }, [reload, queryClient]);
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
            refresh,
            send,
            mention,
            focus,
            bench,
            vault,
          }
        : null,
    [group, myId, models, online, busy, sending, act, refresh, send, mention, focus, bench, vault],
  );
  const scene = group?.kind ?? kind;
  // 和 AI 的私聊只有它一个 AI：输入框上面排着队的话、问卷的回答、「继续」都是对它说
  const dmActions = useMemo(
    () =>
      room && room.group.kind === 'dm' ? actionsFor(room, room.group.ais[0]?.key ?? '') : null,
    [room],
  );

  // 文件拖进聊天窗就加到要发的文件里
  const attachments = useAttachments();
  const [dragging, setDragging] = useState(false);
  const hasFiles = (event: DragEvent) => event.dataTransfer.types.includes('Files');
  const dropProps = {
    onDragOver: (event: DragEvent) => {
      if (!hasFiles(event) || sending) return;
      event.preventDefault();
      setDragging(true);
    },
    onDragLeave: (event: DragEvent) => {
      if (event.currentTarget === event.target) setDragging(false);
    },
    onDrop: (event: DragEvent) => {
      if (!hasFiles(event) || sending) return;
      event.preventDefault();
      setDragging(false);
      attachments.add(event.dataTransfer.files);
    },
  };

  const chat = room && (
    <section
      aria-label="聊天"
      className={`${WINDOW} relative ${CHAT_WIDTH[scene === 'direct' ? 'collapsed' : workbench.mode]} ${
        dragging ? 'outline-2 -outline-offset-8 outline-dashed outline-accent' : ''
      }`}
      {...dropProps}
    >
      <RoomHeader
        onLeft={() => {
          state.leave();
          void queryClient.invalidateQueries({ queryKey: ['dms'] });
          void navigate({ to: GONE[scene].back });
        }}
      >
        {scene === 'group' && <Stage />}
      </RoomHeader>
      {error && (
        <p role="alert" className="m-0 px-7 pb-1 text-[13px] text-accent">
          {error}
        </p>
      )}
      <RoomMessages hasOlder={state.hasOlder} onOlder={() => void state.loadOlder()} />
      <RoomComposer
        inputRef={input}
        hint={hint}
        onSent={() => setHint(null)}
        attachments={attachments}
        mentions={mentions}
        onMentions={setMentions}
        refs={refs}
        onRefs={setRefs}
      />
    </section>
  );
  return (
    <div className="-mx-1 -mt-2 flex min-h-0 flex-1 gap-[18px]">
      {/* 整屏换成这个群的光：铺在最底下，侧栏的玻璃透出来的也是它 */}
      <div
        aria-hidden="true"
        data-light={group?.options.light ?? 'coral'}
        className="oasis-room fixed inset-0 -z-10"
      />
      {room ? (
        <RoomContext.Provider value={room}>
          {dmActions ? (
            <ChatActionsContext.Provider value={dmActions}>{chat}</ChatActionsContext.Provider>
          ) : (
            chat
          )}
          {scene !== 'direct' && <Workbench bench={workbench} />}
          {vaultWindow.shown && <VaultDialog onClose={vaultWindow.close} />}
          {focused && (
            <TaskDialog
              task={focused}
              onClose={() => workbench.setFocus(undefined)}
              onFile={openFile}
            />
          )}
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
