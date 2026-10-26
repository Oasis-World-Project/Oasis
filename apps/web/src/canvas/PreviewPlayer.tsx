import { useCallback, useEffect, useRef, useState } from 'react';
import {
  PreviewAudioBody,
  PreviewFrameBody,
  PreviewQuoteBody,
  PreviewSessionBody,
  type PreviewInputBody,
  type PreviewSessionBody as Session,
} from '@oasis/contracts/harness';
import { api, apiVoid } from '../api/client.ts';

const active = (session: Session | null) =>
  session?.status === 'running' || session?.status === 'starting';

export function PreviewPlayer({ artifactId }: { artifactId: string }) {
  const base = `/canvas/v1/artifacts/${artifactId}/preview`;
  const [session, setSession] = useState<Session | null>(null);
  const [quote, setQuote] = useState<{ maxMicro: number; maxMs: number; idleMs: number } | null>(
    null,
  );
  const [frame, setFrame] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [audioEnabled, setAudioEnabled] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const audioSource = useRef<MediaSource | null>(null);
  const audioUrl = useRef<string | null>(null);
  const sessionStatus = session?.status;
  const seq = useRef(-1);
  const lastMove = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      api(base, PreviewSessionBody.nullable()),
      api(`${base}/quote`, PreviewQuoteBody),
    ])
      .then(([current, price]) => {
        if (!cancelled) {
          setSession(current);
          setQuote(price);
        }
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      });
    return () => {
      cancelled = true;
    };
  }, [base]);

  useEffect(() => {
    if (sessionStatus !== 'starting' && sessionStatus !== 'running') return;
    let cancelled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState === 'hidden') {
        timeout = setTimeout(poll, 1000);
        return;
      }
      try {
        const current = await api(base, PreviewSessionBody.nullable());
        if (cancelled) return;
        setSession(current);
        if (!current || current.status !== 'running') {
          timeout = setTimeout(poll, 700);
          return;
        }
        const next = await api(`${base}/frame`, PreviewFrameBody);
        if (!cancelled && next.seq !== seq.current) {
          seq.current = next.seq;
          setFrame(`data:image/jpeg;base64,${next.jpegBase64}`);
        }
      } catch (cause) {
        if (!cancelled && !(cause instanceof Error && 'status' in cause && cause.status === 503))
          setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!cancelled) timeout = setTimeout(poll, 400);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timeout) clearTimeout(timeout);
    };
  }, [base, session?.id, sessionStatus]);

  useEffect(() => {
    if (!audioEnabled || sessionStatus !== 'running' || !audioSource.current) return;
    const source = audioSource.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let afterSeq = -1;
    let buffer: SourceBuffer | undefined;
    const queue: ArrayBuffer[] = [];
    const append = () => {
      if (!buffer || buffer.updating || queue.length === 0) return;
      if (buffer.buffered.length) {
        const start = buffer.buffered.start(0);
        const end = buffer.buffered.end(buffer.buffered.length - 1);
        if (end - start > 30) {
          buffer.remove(start, end - 20);
          return;
        }
      }
      try {
        buffer.appendBuffer(queue.shift()!);
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    const opened = () => {
      if (stopped) return;
      try {
        buffer = source.addSourceBuffer('audio/webm; codecs="opus"');
        buffer.mode = 'sequence';
        buffer.addEventListener('updateend', append);
        append();
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    source.addEventListener('sourceopen', opened);
    if (source.readyState === 'open') opened();
    const poll = async () => {
      try {
        const result = await api(`${base}/audio?afterSeq=${afterSeq}`, PreviewAudioBody);
        if (!stopped)
          for (const chunk of result.chunks) {
            afterSeq = chunk.seq;
            const binary = atob(chunk.webmBase64);
            const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
            const data = new ArrayBuffer(bytes.byteLength);
            new Uint8Array(data).set(bytes);
            queue.push(data);
            if (queue.length > 80) queue.shift();
          }
        append();
      } catch (cause) {
        if (!stopped) setError(cause instanceof Error ? cause.message : String(cause));
      }
      if (!stopped) timer = setTimeout(poll, 250);
    };
    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      source.removeEventListener('sourceopen', opened);
      buffer?.removeEventListener('updateend', append);
    };
  }, [audioEnabled, base, session?.id, sessionStatus]);

  const enableAudio = () => {
    if (!('MediaSource' in window) || !MediaSource.isTypeSupported('audio/webm; codecs="opus"')) {
      setError('当前播放器不支持作品的声音格式');
      return;
    }
    const player = audioRef.current;
    if (!player) return;
    if (!audioSource.current) {
      audioSource.current = new MediaSource();
      audioUrl.current = URL.createObjectURL(audioSource.current);
      player.src = audioUrl.current;
    }
    void player
      .play()
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)));
    setAudioEnabled(true);
  };

  const send = useCallback(
    (input: PreviewInputBody) => {
      void apiVoid(`${base}/input`, { method: 'POST', body: input }).catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : String(cause)),
      );
    },
    [base],
  );

  const pointer = (event: React.PointerEvent<HTMLDivElement>, action: 'move' | 'down' | 'up') => {
    if (action === 'move' && Date.now() - lastMove.current < 40) return;
    lastMove.current = Date.now();
    const rect = event.currentTarget.getBoundingClientRect();
    const x = Math.max(
      0,
      Math.min(1279, Math.round(((event.clientX - rect.left) * 1280) / rect.width)),
    );
    const y = Math.max(
      0,
      Math.min(719, Math.round(((event.clientY - rect.top) * 720) / rect.height)),
    );
    send({ kind: 'pointer', x, y, action });
    if (action === 'down') event.currentTarget.focus();
  };

  const mutate = async (method: 'POST' | 'DELETE') => {
    setBusy(true);
    setError(null);
    try {
      const next = await api(base, PreviewSessionBody, { method });
      setSession(next);
      if (method === 'DELETE') {
        setFrame(null);
        seq.current = -1;
        setAudioEnabled(false);
        audioRef.current?.pause();
        audioRef.current?.removeAttribute('src');
        if (audioUrl.current) URL.revokeObjectURL(audioUrl.current);
        audioSource.current = null;
        audioUrl.current = null;
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full min-h-[420px] flex-col gap-3 p-5 text-ink">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="m-0 text-base font-medium">独立预览</h2>
          <p className="m-0 mt-1 text-xs text-ink-muted">
            作品在隔离容器中运行；这里仅接收画面并转发输入。画面可能略有延迟。
          </p>
        </div>
        {active(session) ? (
          <button
            className="rounded-full bg-solid px-4 py-2 text-sm text-on-solid disabled:opacity-50"
            disabled={busy}
            onClick={() => void mutate('DELETE')}
          >
            停止预览
          </button>
        ) : (
          <button
            className="rounded-full bg-solid px-4 py-2 text-sm text-on-solid disabled:opacity-50"
            disabled={busy || !quote}
            onClick={() => void mutate('POST')}
          >
            {busy ? '正在启动…' : '启动预览'}
          </button>
        )}
      </div>
      {quote && (
        <p className="m-0 text-xs text-ink-muted">
          最多运行 {Math.ceil(quote.maxMs / 60_000)} 分钟；闲置 {Math.ceil(quote.idleMs / 60_000)}{' '}
          分钟无操作自动停止。最多预留 ${(quote.maxMicro / 1_000_000).toFixed(4)}
          ，按实际运行时间结算。
        </p>
      )}
      {error && (
        <p role="alert" className="m-0 text-sm text-accent">
          {error}
        </p>
      )}
      {session && (
        <p className="m-0 text-xs text-ink-muted">
          状态：{session.status} · 已结算{' '}
          {session.spentMicro === null
            ? '待结束'
            : `$${(session.spentMicro / 1_000_000).toFixed(4)}`}
          {session.error ? ` · ${session.error}` : ''}
        </p>
      )}
      {session?.status === 'running' && (
        <button
          type="button"
          className="self-start rounded-full bg-glass-active px-4 py-2 text-sm shadow-edge-strong"
          onClick={enableAudio}
        >
          {audioEnabled ? '声音已开启' : '开启声音'}
        </button>
      )}
      <audio ref={audioRef} className="hidden" aria-label="作品声音" />
      <div
        role="application"
        aria-label="作品远程画面"
        tabIndex={0}
        className="relative mx-auto aspect-video w-full max-w-[1280px] touch-none overflow-hidden rounded-card bg-track outline-none focus-visible:ring-2 focus-visible:ring-accent"
        onPointerMove={(event) => {
          if (session?.status === 'running') pointer(event, 'move');
        }}
        onPointerDown={(event) => {
          if (session?.status === 'running') pointer(event, 'down');
        }}
        onPointerUp={(event) => {
          if (session?.status === 'running') pointer(event, 'up');
        }}
        onKeyDown={(event) => {
          if (session?.status === 'running') {
            event.preventDefault();
            send({ kind: 'key', key: event.key, action: 'down' });
          }
        }}
        onKeyUp={(event) => {
          if (session?.status === 'running') {
            event.preventDefault();
            send({ kind: 'key', key: event.key, action: 'up' });
          }
        }}
        onWheel={(event) => {
          if (session?.status === 'running') {
            const rect = event.currentTarget.getBoundingClientRect();
            send({
              kind: 'scroll',
              x: Math.max(
                0,
                Math.min(1279, Math.round(((event.clientX - rect.left) * 1280) / rect.width)),
              ),
              y: Math.max(
                0,
                Math.min(719, Math.round(((event.clientY - rect.top) * 720) / rect.height)),
              ),
              deltaY: Math.max(-1000, Math.min(1000, Math.round(event.deltaY))),
            });
          }
        }}
      >
        {frame ? (
          <img
            src={frame}
            alt="作品运行画面"
            draggable={false}
            className="h-full w-full object-contain"
          />
        ) : (
          <span className="absolute inset-0 flex items-center justify-center text-sm text-ink-muted">
            {active(session) ? '正在准备画面…' : '启动后可在这里操作作品'}
          </span>
        )}
      </div>
    </div>
  );
}
