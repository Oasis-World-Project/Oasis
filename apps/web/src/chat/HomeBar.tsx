// 这段私聊在哪干活、动手前问不问。在哪干活是固定的——桌面版里是这段对话的文件夹（没选过就在「文档\Oasis」
// 下按对话名建一个），网页上是云端——这里只是写明；点开能看到完整路径、这台电脑连没连上，桌面版里也能
// 换个文件夹（AI 的记忆在原来那边，换了从新话题开始）。
// 手动 / 自动只在你的电脑上分：手动是出文件夹的事、花钱的工具先问你，自动是什么都不问；下一轮起生效。
import type { ConversationBody, MessageList, SetupBody } from '@oasis/contracts/conversation';
import type { DesktopDevice, DesktopProjectFolder } from '@oasis/contracts/desktop';
import { defaultPermissions, type Permissions } from '@oasis/contracts/harness';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Laptop } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, saveSetup } from '../api/queries.ts';
import { desktop } from '../desktop/sync.ts';

const MODES: { value: Permissions['mode']; label: string; hint: string }[] = [
  {
    value: 'manual',
    label: '手动',
    hint: '改这个文件夹里的文件不问；出文件夹的事、花钱的工具先问你',
  },
  { value: 'auto', label: '自动', hint: '什么都不问，出文件夹的事也直接做' },
];

/** 文件夹路径的最后一段（Windows 和别的系统的写法都认） */
const folderName = (folder: string) => folder.split(/[\\/]/).filter(Boolean).at(-1) ?? folder;

/** 存设置；换了地方时聊天里多一条分隔 */
function useSaveSetup(conversation: ConversationBody) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (setup: SetupBody) => saveSetup(conversation.id, setup),
    onSuccess: ({ conversation: saved, message }) => {
      queryClient.setQueryData(dmsQuery.queryKey, (dms) =>
        dms?.map((dm) => (dm.id === saved.id ? saved : dm)),
      );
      if (message)
        queryClient.setQueryData(
          messagesQuery(conversation.id).queryKey,
          (old: MessageList | undefined) =>
            old ? { ...old, messages: [...old.messages, message] } : old,
        );
    },
  });
}

/** 搬到电脑上的这个文件夹：权限用电脑上的默认，联网搜索开没开照旧 */
const homeAt = (folder: DesktopProjectFolder, current: ConversationBody): SetupBody => {
  const workplace = { kind: 'device' as const, ...folder };
  return {
    workplace,
    permissions: {
      ...defaultPermissions(workplace),
      ...(current.permissions.web === undefined ? {} : { web: current.permissions.web }),
    },
  };
};

export function HomeBar({
  conversation,
  name,
  turnActive,
}: {
  conversation: ConversationBody;
  /** 对话名（AI 的名字）：没选过文件夹时按它建一个 */
  name: string;
  turnActive: boolean;
}) {
  const bridge = desktop();
  const save = useSaveSetup(conversation);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const place = conversation.workplace;
  const fresh = place.kind === 'cloud' && conversation.lastMessageAt === null && !conversation.turn;

  // 桌面版里一段还没说过话的对话：家就在这台电脑上，按对话名在「文档\Oasis」下建好文件夹
  const settled = useRef<string | null>(null);
  const { mutate } = save;
  useEffect(() => {
    if (!fresh || !bridge?.defaultProjectFolder || settled.current === conversation.id) return;
    settled.current = conversation.id;
    void bridge
      .defaultProjectFolder(name)
      .then((folder) => mutate(homeAt(folder, conversation)))
      .catch(() => {
        settled.current = null;
      });
  }, [fresh, bridge, conversation, name, mutate]);

  // 点面板外面或按 Esc 收起
  useEffect(() => {
    if (!open) return;
    const close = (event: Event) => {
      if (
        event instanceof KeyboardEvent
          ? event.key === 'Escape'
          : !box.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('pointerdown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const Icon = place.kind === 'device' ? Laptop : Cloud;
  const label = place.kind === 'device' ? `我的电脑 · ${folderName(place.folder)}` : '云端';
  return (
    <div ref={box} className="relative flex items-center gap-1.5">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="这段对话在哪干活"
        onClick={() => setOpen((value) => !value)}
        className="flex h-8 max-w-[240px] items-center gap-1.5 rounded-full border-0 bg-transparent px-2.5 text-[12.5px] text-ink-muted hover:bg-track hover:text-ink"
      >
        <Icon size={15} aria-hidden="true" className="shrink-0" />
        <span className="truncate">{label}</span>
      </button>
      {place.kind === 'device' && (
        <div
          role="radiogroup"
          aria-label="动手前问不问"
          className="flex gap-0.5 rounded-full bg-track p-[3px]"
        >
          {MODES.map((mode) => {
            const on = conversation.permissions.mode === mode.value;
            return (
              <button
                key={mode.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={`${mode.hint}（下一轮起生效）`}
                disabled={save.isPending}
                onClick={() =>
                  !on &&
                  save.mutate({
                    workplace: place,
                    permissions: { ...conversation.permissions, mode: mode.value },
                  })
                }
                className={`h-[26px] rounded-full border-0 px-3 text-[12.5px] ${on ? 'bg-glass-active font-medium text-ink shadow-edge' : 'bg-transparent text-ink-muted'}`}
              >
                {mode.label}
              </button>
            );
          })}
        </div>
      )}
      {open && (
        <HomePanel
          conversation={conversation}
          turnActive={turnActive}
          saving={save.isPending}
          error={save.error}
          onMove={(folder) =>
            save.mutate(homeAt(folder, conversation), { onSuccess: () => setOpen(false) })
          }
        />
      )}
    </div>
  );
}

function HomePanel({
  conversation,
  turnActive,
  saving,
  error,
  onMove,
}: {
  conversation: ConversationBody;
  turnActive: boolean;
  saving: boolean;
  error: unknown;
  onMove: (folder: DesktopProjectFolder) => void;
}) {
  const bridge = desktop();
  const place = conversation.workplace;
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // 这台电脑（桌面版里）的设备号和连接情况：文件夹在不在这台电脑上、它能不能接活
  const device = useQuery({
    queryKey: ['desktop-device'],
    queryFn: () => bridge!.deviceStatus!(),
    enabled: Boolean(bridge?.deviceStatus),
    refetchInterval: 3_000,
  });

  async function pickFolder() {
    setPicking(true);
    setPickError(null);
    try {
      const picked = await bridge?.chooseProjectFolder?.();
      if (picked && !(place.kind === 'device' && picked.folder === place.folder)) onMove(picked);
    } catch (err) {
      // 桌面版主进程的报错前面带着「Error invoking remote method …」，只留后面给人看的
      setPickError(
        err instanceof Error
          ? err.message.replace(/^Error invoking remote method '[^']*': (Error: )?/, '')
          : '没选成，请重试',
      );
    } finally {
      setPicking(false);
    }
  }

  return (
    <div
      role="dialog"
      aria-label="这段对话在哪干活"
      className="absolute right-0 top-full z-20 mt-2 flex w-[340px] flex-col gap-2 rounded-card bg-glass-active p-4 text-left text-xs text-ink-muted shadow-raised backdrop-blur-md"
    >
      {place.kind === 'device' ? (
        <>
          <span className="break-all text-[12.5px] text-ink">{place.folder}</span>
          <DeviceNote
            deviceId={place.deviceId}
            device={device.data}
            inDesktop={Boolean(bridge?.chooseProjectFolder)}
          />
        </>
      ) : (
        <span>
          {bridge?.chooseProjectFolder
            ? '这段对话在 Oasis 的云端沙箱里做，碰不到你的电脑。'
            : '这段对话在 Oasis 的云端沙箱里做，碰不到你的电脑。要在自己电脑上做，用 Oasis 桌面版。'}
        </span>
      )}
      {bridge?.chooseProjectFolder && (
        <>
          <button
            type="button"
            disabled={picking || saving || turnActive}
            onClick={() => void pickFolder()}
            className="self-start rounded-full border-0 bg-transparent p-0 text-xs text-accent disabled:opacity-50"
          >
            {place.kind === 'device' ? '换个文件夹' : '改到我的电脑上做'}
          </button>
          <span>
            {turnActive
              ? '这一轮做完才能换。'
              : '换了会开新话题：AI 会忘掉之前聊的（聊天记录和成果都还在）。'}
          </span>
        </>
      )}
      {(pickError !== null || error !== null) && (
        <p role="alert" className="m-0 text-xs text-accent">
          {pickError ?? (error instanceof ApiError ? error.message : '没存上，请重试')}
        </p>
      )}
    </div>
  );
}

/** 文件夹在哪台电脑上、那台电脑能不能接活 */
function DeviceNote({
  deviceId,
  device,
  inDesktop,
}: {
  deviceId: string;
  device: DesktopDevice | undefined;
  inDesktop: boolean;
}) {
  if (!inDesktop || !device)
    return <span>在那台电脑上开着 Oasis 桌面版（登录同一个账号）才能干活。</span>;
  if (device.deviceId !== deviceId)
    return <span>这个文件夹在另一台电脑上：那台电脑要开着 Oasis 桌面版。</span>;
  if (device.problem) return <span className="text-accent">{device.problem}</span>;
  return (
    <span>
      {device.connected ? '这台电脑已连上，可以干活。' : '这台电脑还没连上 Oasis，正在重连…'}
    </span>
  );
}
