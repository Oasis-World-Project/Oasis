// 加好友：输入对方的账号 ID → 看到是谁 → 写一句验证消息 → 发申请，对方同意后成为好友。
import type { PublicProfile } from '@oasis/contracts/identity';
import { useQueryClient } from '@tanstack/react-query';
import { X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { avatarUrl, lookupUser, requestFriend } from '../api/queries.ts';
import { PersonAvatar } from '../ui/Avatar.tsx';

const FIELD =
  'h-11 min-w-0 rounded-full border-0 bg-glass-active px-[18px] text-[15px] text-ink shadow-edge-strong';
const SOLID =
  'h-11 cursor-pointer rounded-full border-0 bg-solid px-5 text-sm font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-45';

export function AddFriendDialog({ me, onClose }: { me: string; onClose: () => void }) {
  const client = useQueryClient();
  const [accountNo, setAccountNo] = useState('');
  const [found, setFound] = useState<PublicProfile | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  /** 做一件事：同一时间只做一件，出错写在弹窗里 */
  async function run(work: () => Promise<void>, fallback: string) {
    setBusy(true);
    setError('');
    try {
      await work();
    } catch (err) {
      setError(err instanceof Error ? err.message : fallback);
    } finally {
      setBusy(false);
    }
  }
  const find = (event: FormEvent) => {
    event.preventDefault();
    setFound(null);
    setDone('');
    void run(async () => setFound(await lookupUser(accountNo.trim())), '没找到这个账号');
  };
  const request = (target: PublicProfile) =>
    run(async () => {
      const { status } = await requestFriend(target.id, message.trim());
      await client.invalidateQueries({ queryKey: ['friends'] });
      setDone(
        status === 'friends' ? '对方也加过你，你们已经是好友了。' : '申请发出去了，等对方同意。',
      );
    }, '没发出去，请重试');

  return (
    <div
      className="fixed inset-0 z-40 box-border flex items-start justify-center overflow-y-auto bg-veil px-4 py-9 backdrop-blur-[14px]"
      onKeyDown={(event) => {
        if (event.key === 'Escape') onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="加好友"
        className="glass-pop box-border flex w-[440px] max-w-full flex-col gap-4 rounded-dialog p-[26px] shadow-dialog"
      >
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <h2 className="m-0 text-2xl font-light">加好友</h2>
            <p className="mb-0 mt-1 text-[13px] text-ink-muted">
              输入对方的账号 ID（8 位数字，在「我」页里能看到自己的）。
            </p>
          </div>
          <button
            type="button"
            aria-label="关闭"
            onClick={onClose}
            className="flex size-10 shrink-0 cursor-pointer items-center justify-center rounded-full border-0 bg-glass-active text-ink shadow-edge-strong"
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
        <form onSubmit={find} className="flex gap-2">
          <input
            aria-label="账号 ID"
            className={`${FIELD} flex-1`}
            value={accountNo}
            inputMode="numeric"
            maxLength={8}
            placeholder="比如：38602741"
            autoFocus
            onChange={(event) => setAccountNo(event.target.value.replace(/\D/g, ''))}
          />
          <button className={SOLID} disabled={busy || accountNo.length !== 8}>
            查找
          </button>
        </form>
        {found && (
          <div className="flex flex-col gap-3 rounded-card bg-glass-strong p-4 shadow-edge-strong">
            <div className="flex items-center gap-3">
              <PersonAvatar
                label={found.name}
                size={48}
                src={avatarUrl(found.id, found.avatarVersion)}
              />
              <div className="min-w-0 flex-1">
                <p className="m-0 truncate text-base font-medium">{found.name}</p>
                <p className="m-0 truncate text-xs text-ink-muted">
                  {[`ID ${found.accountNo}`, found.region, found.bio].filter(Boolean).join(' · ')}
                </p>
              </div>
            </div>
            {found.id === me ? (
              <p className="m-0 text-[13px] text-ink-muted">这是你自己。</p>
            ) : done ? (
              <p role="status" className="m-0 text-[13px]">
                {done}
              </p>
            ) : (
              <>
                <input
                  aria-label="验证消息"
                  className={FIELD}
                  value={message}
                  maxLength={60}
                  placeholder="写一句验证消息（可以不写）"
                  onChange={(event) => setMessage(event.target.value)}
                />
                <button
                  type="button"
                  className={`${SOLID} self-start`}
                  disabled={busy}
                  onClick={() => void request(found)}
                >
                  加为好友
                </button>
              </>
            )}
          </div>
        )}
        {error && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
