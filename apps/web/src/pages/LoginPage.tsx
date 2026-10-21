// 邮箱验证码登录。新邮箱第一次登录即注册，并获赠 $30 额度。
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useState, type FormEvent } from 'react';
import { ApiError } from '../api/client.ts';
import { meQuery, requestCode, verifyCode } from '../api/queries.ts';

const RESEND_SECONDS = 60;
const MAILBOX_URL: string | undefined = import.meta.env.VITE_DEV_MAILBOX_URL;

const INPUT =
  'h-12 w-full rounded-item border-0 bg-glass-active px-4 text-[15px] text-ink shadow-edge-strong outline-none placeholder:text-ink-muted focus-visible:outline-2 focus-visible:outline-accent';
const PRIMARY =
  'flex h-12 w-full items-center justify-center rounded-item border-0 bg-solid text-[15px] font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-55';

function messageOf(err: unknown): string {
  return err instanceof ApiError ? err.message : '出了点问题，请重试';
}

export function LoginPage() {
  const navigate = useNavigate();
  const { redirect } = useSearch({ from: '/login' });
  const queryClient = useQueryClient();
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState(0);

  useEffect(() => {
    if (cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown((s) => s - 1), 1_000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function sendCode(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await requestCode(email.trim());
      setStep('code');
      setCode('');
      setCooldown(RESEND_SECONDS);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function signIn(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user } = await verifyCode(email.trim(), code);
      queryClient.setQueryData(meQuery.queryKey, user);
      await navigate({ to: redirect ?? '/' });
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <div className="oasis-ground flex min-h-screen items-center justify-center p-6">
      <main className="glass flex w-full max-w-[400px] flex-col gap-6 rounded-panel p-8">
        <div className="flex flex-col gap-2">
          <span className="font-display text-[26px] font-medium leading-none tracking-[-0.02em]">
            oasis
          </span>
          <h1 className="m-0 mt-3 text-[28px] font-light">登录 Oasis</h1>
          <p className="m-0 text-sm text-ink-muted">
            {step === 'email'
              ? '用邮箱接收验证码登录。第一次登录会自动注册，并赠送 $30 额度。'
              : `验证码已发到 ${email.trim()}，10 分钟内有效。`}
          </p>
        </div>

        {step === 'email' ? (
          <form onSubmit={sendCode} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span>邮箱</span>
              <input
                type="email"
                required
                autoComplete="email"
                autoFocus
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
                className={INPUT}
              />
            </label>
            <button type="submit" disabled={busy || !email.trim()} className={PRIMARY}>
              {busy ? '正在发送…' : '获取验证码'}
            </button>
          </form>
        ) : (
          <form onSubmit={signIn} className="flex flex-col gap-3">
            <label className="flex flex-col gap-1.5 text-sm">
              <span>验证码</span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                autoFocus
                maxLength={6}
                pattern="\d{6}"
                required
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                placeholder="6 位数字"
                className={`${INPUT} font-display tracking-[0.4em] placeholder:font-sans placeholder:tracking-normal`}
              />
            </label>
            <button type="submit" disabled={busy || code.length !== 6} className={PRIMARY}>
              {busy ? '正在登录…' : '登录'}
            </button>
            <div className="flex items-center justify-between text-[13px]">
              <button
                type="button"
                onClick={() => setStep('email')}
                className="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-ink-muted underline underline-offset-4"
              >
                换个邮箱
              </button>
              <button
                type="button"
                disabled={cooldown > 0 || busy}
                onClick={() => void sendCode()}
                className="min-h-11 cursor-pointer border-0 bg-transparent px-0 text-ink underline underline-offset-4 disabled:cursor-not-allowed disabled:text-ink-muted disabled:no-underline"
              >
                {cooldown > 0 ? `${cooldown} 秒后可重新发送` : '重新发送'}
              </button>
            </div>
            {MAILBOX_URL && (
              <p className="m-0 rounded-card bg-glass-strong px-4 py-3 text-[12.5px] text-ink-muted">
                本地开发：验证码邮件在{' '}
                <a href={MAILBOX_URL} target="_blank" rel="noreferrer" className="text-ink">
                  Mailpit 收件箱
                </a>
                里查看。
              </p>
            )}
          </form>
        )}

        {error && (
          <p role="alert" className="m-0 text-sm text-accent">
            {error}
          </p>
        )}
      </main>
    </div>
  );
}
