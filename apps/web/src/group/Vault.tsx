// 群的金库：群里的 AI 花的钱都从这里出。页头的「金库」按钮、金库空了时输入框上面的提示、点开的窗
// （现在有多少、从我的钱包存入、每个人存了多少、叫 AI 花了多少）。照原型 ㉗。
import type { GroupSnapshot } from '@oasis/contracts/group';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ApiError } from '../api/client.ts';
import { depositToVault, vaultQuery, walletQuery } from '../api/queries.ts';
import { formatUsd } from '../ui/format.ts';
import { MemberAvatar } from './Members.tsx';
import { runsOf } from './people.ts';
import { useRoom, type Room } from './room.ts';

/** 一次存多少（美元） */
const AMOUNTS = [5, 10, 20];
const CARD = 'flex flex-col rounded-[28px] bg-glass-strong p-[18px] shadow-edge-strong';
const ALERT = 'shadow-[inset_0_0_0_1.5px_var(--oasis-accent)]';

/** 这个群的金库现在有多少（只有群有；有 AI 开工、做完都重新读一遍），和打开金库的窗 */
export function useVault(group: GroupSnapshot | null) {
  const id = group?.kind === 'group' ? group.id : '';
  const [shown, setShown] = useState(false);
  const queryClient = useQueryClient();
  const { data } = useQuery({ ...vaultQuery(id), enabled: Boolean(id), refetchInterval: 60_000 });
  const running = group?.ais.flatMap(runsOf).length ?? 0;
  useEffect(() => {
    if (id) void queryClient.invalidateQueries({ queryKey: ['vault', id] });
  }, [id, running, queryClient]);
  const availableMicro = data?.availableMicro;
  const vault = useMemo<Room['vault']>(
    () => (id ? { availableMicro, open: () => setShown(true) } : undefined),
    [id, availableMicro],
  );
  return { vault, shown: Boolean(id) && shown, close: () => setShown(false) };
}

/** 页头的「金库」按钮：现在有多少，点开是金库的窗 */
export function VaultButton() {
  const { vault } = useRoom();
  if (!vault) return null;
  const balance = vault.availableMicro === undefined ? '…' : formatUsd(vault.availableMicro);
  return (
    <button
      type="button"
      aria-label={`金库，现在有 ${balance}`}
      onClick={vault.open}
      className={`flex h-[42px] shrink-0 cursor-pointer items-center gap-2 rounded-full border-0 bg-glass-strong pl-3 pr-3.5 text-[13px] font-medium text-ink ${
        vault.availableMicro === 0 ? ALERT : 'shadow-edge-strong'
      }`}
    >
      <Database size={17} aria-hidden="true" />
      金库
      <span className="font-display font-normal tracking-[-0.02em]">{balance}</span>
    </button>
  );
}

/** 金库空了：输入框上面提示一句，旁边就能存 */
export function VaultEmpty() {
  const { vault } = useRoom();
  if (vault?.availableMicro !== 0) return null;
  return (
    <div
      role="status"
      className={`mb-2 flex flex-wrap items-center gap-3 rounded-[22px] bg-glass-active py-2.5 pl-4 pr-2.5 ${ALERT}`}
    >
      <span className="flex-[1_1_200px] text-[13.5px]">
        <span className="font-medium">金库空了。</span>存入后群里的 AI 才能用。
      </span>
      <button
        type="button"
        onClick={vault.open}
        className="h-9 cursor-pointer rounded-full border-0 bg-solid px-4 text-[13px] font-medium text-on-solid"
      >
        存入
      </button>
    </div>
  );
}

export function VaultDialog({ onClose }: { onClose: () => void }) {
  const { group } = useRoom();
  const queryClient = useQueryClient();
  const { data: vault } = useQuery(vaultQuery(group.id));
  const { data: wallet } = useQuery(walletQuery);
  const [amount, setAmount] = useState(10);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const deposit = async () => {
    setSaving(true);
    setError(undefined);
    try {
      const { queryKey } = vaultQuery(group.id);
      const next = await depositToVault(group.id, amount * 1_000_000);
      // 正在读的那一次是存之前的样子，别让它盖回来
      await queryClient.cancelQueries({ queryKey });
      queryClient.setQueryData(queryKey, next);
      void queryClient.invalidateQueries({ queryKey: ['wallet'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '没存进去，请稍后再试');
    } finally {
      setSaving(false);
    }
  };
  // 群里现在的人都列出来（没存过、没花过的是 $0.00）；存过钱、已经不在群里的人排在后面
  const inGroup = new Set(group.members.map((member) => member.userId));
  const gone = (vault?.members ?? []).filter((row) => !inGroup.has(row.userId));
  const people = [
    ...group.members.map((member) => ({
      member,
      ...(vault?.members.find((row) => row.userId === member.userId) ?? {
        depositedMicro: 0,
        spentMicro: 0,
      }),
    })),
    ...gone.map((row) => ({
      member: { userId: row.userId, displayName: '已不在群里的成员', avatarVersion: 0 },
      ...row,
    })),
  ];
  const balance = vault ? formatUsd(vault.availableMicro) : '…';
  // 放到页面最外层：聊天窗是毛玻璃，fixed 的东西在它里面会被框住
  return createPortal(
    <div
      className="fixed inset-0 z-40 flex items-start justify-center overflow-y-auto bg-veil px-4 py-9 backdrop-blur-[14px]"
      onPointerDown={(event) => event.target === event.currentTarget && onClose()}
    >
      <section
        role="dialog"
        aria-modal="true"
        aria-label="金库"
        className="box-border flex w-[720px] max-w-full flex-col gap-5 rounded-dialog bg-glass-active p-[26px] shadow-dialog"
      >
        <header className="flex items-start gap-3.5">
          <div className="min-w-0 flex-1">
            <h2 className="m-0 text-[30px] font-light leading-[1.2]">金库</h2>
            <p className="m-0 mt-1.5 text-[13px] text-ink-muted">
              群里的 AI
              花的钱都从这里出，包括云端沙箱。存进来就是群的；解散时剩下的按各人存入的比例退回。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-glass-strong text-ink shadow-edge-strong"
          >
            <X size={18} aria-hidden="true" />
          </button>
        </header>

        <div className="flex flex-wrap items-stretch gap-3.5">
          <div className={`${CARD} flex-[1_1_220px] gap-1.5`}>
            <span className="text-[12.5px] text-ink-muted">现在有</span>
            <span className="font-display text-[40px] leading-none tracking-[-0.03em]">
              {balance}
            </span>
            <span className="text-[12.5px] text-ink-muted">
              {!vault
                ? '正在读…'
                : vault.depositedMicro
                  ? `一共存入 ${formatUsd(vault.depositedMicro)}，花了 ${formatUsd(vault.spentMicro)}`
                  : '还没有人存入'}
            </span>
          </div>
          <form
            className={`${CARD} m-0 flex-[1_1_280px] gap-2.5`}
            onSubmit={(event) => {
              event.preventDefault();
              void deposit();
            }}
          >
            <span className="text-[12.5px] text-ink-muted">
              从我的钱包存入（钱包里有 {wallet ? formatUsd(wallet.availableMicro) : '…'}）
            </span>
            <div role="radiogroup" aria-label="存多少" className="flex flex-wrap gap-1.5">
              {AMOUNTS.map((value) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={amount === value}
                  onClick={() => setAmount(value)}
                  className={`h-11 min-w-16 cursor-pointer rounded-full border-0 px-3.5 font-display text-sm text-ink ${
                    amount === value
                      ? 'bg-on-solid font-medium shadow-[0_0_0_1.5px_var(--oasis-ink)]'
                      : 'bg-well'
                  }`}
                >
                  ${value}
                </button>
              ))}
            </div>
            <button
              type="submit"
              disabled={saving || !wallet || wallet.availableMicro < amount * 1_000_000}
              className="h-11 cursor-pointer rounded-full border-0 bg-solid text-sm font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
            >
              存入 ${amount}
            </button>
            {wallet && wallet.availableMicro < amount * 1_000_000 && (
              <span className="text-[12.5px] text-ink-muted">钱包里不够存这么多。</span>
            )}
            {error && (
              <span role="alert" className="text-[12.5px] text-accent">
                {error}
              </span>
            )}
          </form>
        </div>

        <section aria-label="每个人" className="flex flex-col gap-2">
          <h3 className="m-0 text-sm font-medium leading-[1.3]">每个人存了多少、叫 AI 花了多少</h3>
          <div
            role="table"
            aria-label="每个人的存入和花费"
            className="flex flex-col gap-1 text-[13.5px] tabular-nums"
          >
            {people.map(({ member, depositedMicro, spentMicro }) => (
              <div
                key={member.userId}
                role="row"
                className="flex items-center gap-3 rounded-[18px] bg-well px-3 py-2"
              >
                <MemberAvatar member={member} size={30} />
                <span role="cell" className="min-w-0 flex-1 truncate font-medium">
                  {member.displayName}
                </span>
                <span role="cell" className="w-[110px] shrink-0 text-right">
                  存入 {formatUsd(depositedMicro)}
                </span>
                <span role="cell" className="w-[110px] shrink-0 text-right text-ink-muted">
                  花了 {formatUsd(spentMicro)}
                </span>
              </div>
            ))}
          </div>
        </section>
      </section>
    </div>,
    document.body,
  );
}
