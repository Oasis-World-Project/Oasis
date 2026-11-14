// 私聊右上角「在哪干活」：云端沙箱，或你的电脑（在桌面版里选项目文件夹）；AI 在你电脑上能做到哪一步、
// 要做超出的事时怎么办，花钱的工具要不要先问你。下一轮起生效；换了地方从新话题开始（AI 的记忆在原来那边）。
import type { ConversationBody, MessageList, SetupBody } from '@oasis/contracts/conversation';
import type { DesktopDevice } from '@oasis/contracts/desktop';
import { defaultPermissions, type Permissions, type Workplace } from '@oasis/contracts/harness';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Cloud, Laptop } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, saveSetup } from '../api/queries.ts';
import { desktop } from '../desktop/sync.ts';

interface Option<T extends string> {
  value: T;
  label: string;
  hint: string;
  disabled?: boolean;
}

const ACCESS: Option<Permissions['access']>[] = [
  { value: 'read', label: '只读', hint: '只看文件、跑不改东西的命令' },
  { value: 'project', label: '可改项目文件夹', hint: '只改这个文件夹里的文件' },
  { value: 'full', label: '完全访问', hint: '电脑上的文件都能改，命令不受限制' },
];
const BEYOND: Option<Permissions['beyond']>[] = [
  { value: 'ask', label: '问我', hint: '在聊天里出确认卡，你点了允许才做' },
  { value: 'allow', label: '直接允许', hint: '不问，直接做' },
  { value: 'deny', label: '不做', hint: '超出的事一律不做' },
];
const PAID: Option<Permissions['paidTools']>[] = [
  { value: 'ask', label: '问我', hint: '生图、视频、配音这类花钱的工具，用之前先问你' },
  { value: 'allow', label: '不问', hint: '要用就用，花费记在任务卡上' },
];

const sameWorkplace = (a: Workplace, b: Workplace) =>
  a.kind === 'cloud'
    ? b.kind === 'cloud'
    : b.kind === 'device' && a.deviceId === b.deviceId && a.folder === b.folder;

/** 换地方时权限用那边的默认（花钱的工具问不问照旧） */
const moveTo = (workplace: Workplace, current: SetupBody): SetupBody => ({
  workplace,
  permissions:
    current.workplace.kind === workplace.kind
      ? current.permissions
      : { ...defaultPermissions(workplace), paidTools: current.permissions.paidTools },
});

export function DmSetup({
  conversation,
  turnActive,
}: {
  conversation: ConversationBody;
  turnActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
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
  const onDevice = conversation.workplace.kind === 'device';
  const Icon = onDevice ? Laptop : Cloud;
  return (
    <div ref={box} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="dialog"
        title="在哪干活、AI 的权限"
        onClick={() => setOpen((value) => !value)}
        className="flex h-9 items-center gap-1.5 rounded-full border-0 bg-transparent px-3 text-[12.5px] text-ink-muted hover:bg-track hover:text-ink"
      >
        <Icon size={15} aria-hidden="true" />
        {onDevice ? '我的电脑' : '云端'}
      </button>
      {open && (
        <SetupPanel
          conversation={conversation}
          turnActive={turnActive}
          onDone={() => setOpen(false)}
        />
      )}
    </div>
  );
}

function SetupPanel({
  conversation,
  turnActive,
  onDone,
}: {
  conversation: ConversationBody;
  turnActive: boolean;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const bridge = desktop();
  const [draft, setDraft] = useState<SetupBody>({
    workplace: conversation.workplace,
    permissions: conversation.permissions,
  });
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // 这台电脑（桌面版里）的设备号和连接情况：选的文件夹在不在这台电脑上、它能不能接活
  const device = useQuery({
    queryKey: ['desktop-device'],
    queryFn: () => bridge!.deviceStatus!(),
    enabled: Boolean(bridge?.deviceStatus),
    refetchInterval: 3_000,
  });
  const save = useMutation({
    mutationFn: () => saveSetup(conversation.id, draft),
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
      onDone();
    },
  });

  const moved = !sameWorkplace(draft.workplace, conversation.workplace);
  const changed =
    moved || JSON.stringify(draft.permissions) !== JSON.stringify(conversation.permissions);
  const place = draft.workplace;
  const set = (patch: Partial<Permissions>) =>
    setDraft((current) => ({ ...current, permissions: { ...current.permissions, ...patch } }));

  async function pickFolder() {
    setPicking(true);
    setPickError(null);
    try {
      const picked = await bridge?.chooseProjectFolder?.();
      if (picked) setDraft((current) => moveTo({ kind: 'device', ...picked }, current));
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
      aria-label="在哪干活、AI 的权限"
      className="absolute right-0 top-full z-20 mt-2 flex w-[340px] flex-col gap-4 rounded-card bg-glass-active p-4 text-left shadow-raised backdrop-blur-md"
    >
      <Choice
        label="在哪干活"
        options={[
          { value: 'cloud', label: '云端沙箱', hint: '在 Oasis 的云端沙箱里做，碰不到你的电脑' },
          {
            value: 'device',
            label: '我的电脑',
            hint: '在你电脑上的一个项目文件夹里做；那台电脑要开着 Oasis 桌面版',
            // 浏览器里选不了电脑上的文件夹
            disabled: !bridge?.chooseProjectFolder && place.kind !== 'device',
          },
        ]}
        value={place.kind}
        disabled={picking}
        onChange={(kind) =>
          kind === 'cloud'
            ? setDraft((current) => moveTo({ kind: 'cloud' }, current))
            : void pickFolder()
        }
      />
      {place.kind === 'device' && (
        <div className="flex flex-col gap-1 text-xs text-ink-muted">
          <span className="break-all text-[12.5px] text-ink">{place.folder}</span>
          <DeviceNote
            deviceId={place.deviceId}
            device={device.data}
            inDesktop={Boolean(bridge?.chooseProjectFolder)}
          />
          {bridge?.chooseProjectFolder && (
            <button
              type="button"
              disabled={picking}
              onClick={() => void pickFolder()}
              className="self-start rounded-full border-0 bg-transparent p-0 text-xs text-accent disabled:opacity-50"
            >
              换个文件夹
            </button>
          )}
        </div>
      )}
      {pickError && (
        <p role="alert" className="m-0 -mt-2 text-xs text-accent">
          {pickError}
        </p>
      )}
      {place.kind === 'cloud' && !bridge?.chooseProjectFolder && (
        <p className="m-0 -mt-2 text-xs text-ink-muted">
          要在你的电脑上做，在 Oasis 桌面版里打开这个私聊再选文件夹。
        </p>
      )}
      {place.kind === 'device' && (
        <Choice
          label="AI 能做到哪一步"
          options={ACCESS}
          value={draft.permissions.access}
          onChange={(access) => set({ access })}
        />
      )}
      {place.kind === 'device' && draft.permissions.access !== 'full' && (
        <Choice
          label="要做超出的事时"
          options={BEYOND}
          value={draft.permissions.beyond}
          onChange={(beyond) => set({ beyond })}
        />
      )}
      <Choice
        label="花钱的工具"
        options={PAID}
        value={draft.permissions.paidTools}
        onChange={(paidTools) => set({ paidTools })}
      />
      {changed && (
        <p className="m-0 text-xs text-ink-muted">
          {!moved
            ? '下一轮起生效。'
            : turnActive
              ? '这一轮做完才能换地方。'
              : '换了地方会开新话题：AI 会忘掉之前聊的（聊天记录和成果都还在）。'}
        </p>
      )}
      {save.isError && (
        <p role="alert" className="m-0 text-xs text-accent">
          {save.error instanceof ApiError ? save.error.message : '没存上，请重试'}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onDone}
          className="h-8 rounded-full border-0 bg-transparent px-3 text-[12.5px] text-ink-muted"
        >
          取消
        </button>
        <button
          type="button"
          disabled={!changed || save.isPending || (moved && turnActive)}
          onClick={() => save.mutate()}
          className="h-8 rounded-full border-0 bg-accent px-4 text-[12.5px] font-medium text-on-accent disabled:opacity-45"
        >
          保存
        </button>
      </div>
    </div>
  );
}

/** 选的文件夹在哪台电脑上、那台电脑能不能接活 */
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

function Choice<T extends string>({
  label,
  options,
  value,
  disabled,
  onChange,
}: {
  label: string;
  options: Option<T>[];
  value: T;
  disabled?: boolean;
  onChange: (value: T) => void;
}) {
  const current = options.find((option) => option.value === value);
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[12.5px] font-medium text-ink">{label}</span>
      <div
        role="radiogroup"
        aria-label={label}
        className="flex gap-1 rounded-item bg-glass-strong p-0.5"
      >
        {options.map((option) => {
          const on = option.value === value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={on}
              disabled={disabled || option.disabled}
              title={option.disabled ? option.hint : undefined}
              onClick={() => !on && onChange(option.value)}
              className={`h-7 flex-1 rounded-item border-0 text-xs disabled:opacity-50 ${on ? 'bg-solid font-medium text-on-solid' : 'bg-transparent text-ink-muted'}`}
            >
              {option.label}
            </button>
          );
        })}
      </div>
      {current && <p className="m-0 text-xs text-ink-muted">{current.hint}</p>}
    </div>
  );
}
