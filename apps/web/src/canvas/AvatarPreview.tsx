// 数字人成果的实时对话（ADR 0013 §1、§4）：开始后连 LiveAvatar 的 LiveKit 房间，看形象、开麦克风说话或打字提问；
// 右边是对话记录，以及后台每一轮的记录（查了哪些资料、有没有转人工、模型多久出第一个字）；
// 底部显示已用时长和花费。点结束、关掉页面、LiveAvatar 那边结束都会通知后台结算。
import { AvatarSessionStarted, AvatarSessionView, type AvatarSpec } from '@oasis/contracts/avatar';
import { Room, RoomEvent, Track, type RemoteTrack } from 'livekit-client';
import { Hand, Mic, MicOff, Send, Square } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, apiVoid } from '../api/client.ts';
import { formatCost } from '../ui/format.ts';
import { asked, endReasonText, initialRoom, reduceEvent, type RoomState } from './avatar-room.ts';

type Phase = 'idle' | 'starting' | 'live' | 'ended';

const sessionPath = (id: string) => `/canvas/v1/avatar-sessions/${id}`;
const message = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`;
const clockText = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 关页面时也要通知后台结束（keepalive 让请求在页面卸载后还能发出去） */
function stopOnUnload(sessionId: string) {
  void fetch(`/api${sessionPath(sessionId)}/stop`, {
    method: 'POST',
    keepalive: true,
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  }).catch(() => {});
}

const button =
  'inline-flex items-center gap-1.5 rounded-full px-4 py-2 text-sm disabled:opacity-50';

export function AvatarPreview({ artifactId, spec }: { artifactId: string; spec: AvatarSpec }) {
  const [phase, setPhase] = useState<Phase>('idle');
  const [session, setSession] = useState<AvatarSessionStarted | null>(null);
  const [room, setRoom] = useState<RoomState>(initialRoom);
  const [view, setView] = useState<AvatarSessionView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mic, setMic] = useState<'on' | 'off' | 'denied'>('off');
  const [draft, setDraft] = useState('');
  const [now, setNow] = useState(() => Date.now());
  /** 结束的时刻：结束后时长停在这里 */
  const [endedAt, setEndedAt] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const live = useRef<Room | null>(null);
  const sessionRef = useRef<AvatarSessionStarted | null>(null);
  const roomRef = useRef(room);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  /** 结束：reason 是 LiveAvatar 先结束时它给的原因，用户自己点结束时不带 */
  const end = useCallback(async (reason?: string) => {
    const current = sessionRef.current;
    const lk = live.current;
    if (!lk && !current) return;
    live.current = null;
    setEndedAt((at) => at ?? Date.now());
    setPhase((p) => (p === 'idle' ? p : 'ended'));
    // 先通知后台结束、再断开房间：先断开的话 LiveAvatar 会记成「用户断线」
    if (current) {
      await apiVoid(`${sessionPath(current.sessionId)}/stop`, {
        method: 'POST',
        body: reason ? { reason } : {},
      }).catch(() => {});
    }
    await lk?.disconnect().catch(() => {});
  }, []);

  // LiveAvatar 那边结束了（到时长、太久不说话、断线）：这边也收尾
  useEffect(() => {
    if (room.ended && phase === 'live') void end(room.ended);
  }, [room.ended, phase, end]);

  // 离开页面：结束会话、断开房间
  useEffect(() => {
    const onHide = () => {
      if (live.current && sessionRef.current) stopOnUnload(sessionRef.current.sessionId);
    };
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      if (live.current && sessionRef.current) {
        stopOnUnload(sessionRef.current.sessionId);
        void live.current.disconnect();
        live.current = null;
      }
    };
  }, []);

  // 计时；过了最长时长 15 秒 LiveAvatar 还没结束的话，这边主动结束（兜底）
  useEffect(() => {
    if (phase !== 'live' || !session) return;
    const limit = Date.parse(session.startedAt) + (session.maxSeconds + 15) * 1000;
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t > limit) void end('MAX_DURATION_REACHED');
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, session, end]);

  // 后台记录：进行中每 3 秒取一次；结束后再取到结算完为止（最多一分钟）
  useEffect(() => {
    if (!session || phase === 'idle' || phase === 'starting') return;
    if (phase === 'ended' && view?.chargedMicro !== null && view?.chargedMicro !== undefined)
      return;
    let cancelled = false;
    let rounds = 0;
    const poll = async () => {
      rounds += 1;
      try {
        const next = await api(sessionPath(session.sessionId), AvatarSessionView);
        if (!cancelled) setView(next);
      } catch {
        // 取不到就下次再取
      }
    };
    void poll();
    const timer = setInterval(() => {
      if (phase === 'ended' && rounds >= 20) clearInterval(timer);
      else void poll();
    }, 3000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session, phase, view?.chargedMicro]);

  async function start() {
    setPhase('starting');
    setError(null);
    setRoom(initialRoom);
    setView(null);
    setEndedAt(null);
    let started: AvatarSessionStarted | null = null;
    try {
      started = await api(
        `/canvas/v1/artifacts/${artifactId}/avatar-sessions`,
        AvatarSessionStarted,
        {
          method: 'POST',
          body: {},
        },
      );
      sessionRef.current = started;
      setSession(started);
      setNow(Date.now());
      const lk = new Room({ adaptiveStream: true });
      live.current = lk;
      lk.on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
        if (track.kind === Track.Kind.Video && videoRef.current) track.attach(videoRef.current);
        if (track.kind === Track.Kind.Audio && audioRef.current) track.attach(audioRef.current);
      });
      lk.on(RoomEvent.DataReceived, (payload, _participant, _kind, topic) => {
        if (topic !== 'agent-response') return;
        try {
          const event = JSON.parse(new TextDecoder().decode(payload)) as object;
          setRoom((state) => reduceEvent(state, event, Date.now()));
        } catch {
          // 不是 JSON 的消息不管
        }
      });
      // 房间被对方断开（不是我们自己点的结束）
      lk.on(RoomEvent.Disconnected, () => {
        if (live.current === lk) void end(roomRef.current.ended ?? 'USER_DISCONNECTED');
      });
      await lk.connect(started.livekitUrl, started.livekitToken);
      setPhase('live');
      try {
        await lk.localParticipant.setMicrophoneEnabled(true);
        setMic('on');
      } catch {
        setMic('denied');
      }
    } catch (cause) {
      setError(message(cause));
      if (started) await end();
      else setPhase('idle');
    }
  }

  function publish(event: Record<string, string>) {
    const lk = live.current;
    if (!lk) return;
    const sessionId = roomRef.current.providerSessionId;
    const body = JSON.stringify({
      event_id: crypto.randomUUID(),
      ...(sessionId ? { session_id: sessionId } : {}),
      ...event,
    });
    void lk.localParticipant.publishData(new TextEncoder().encode(body), {
      reliable: true,
      topic: 'agent-control',
    });
  }

  function ask() {
    const text = draft.trim();
    if (!text || phase !== 'live') return;
    setRoom((state) => asked(state, text, Date.now()));
    publish({ event_type: 'avatar.speak_response', text });
    setDraft('');
  }

  async function toggleMic() {
    const lk = live.current;
    if (!lk || mic === 'denied') return;
    const next = mic !== 'on';
    try {
      await lk.localParticipant.setMicrophoneEnabled(next);
      setMic(next ? 'on' : 'off');
    } catch {
      setMic('denied');
    }
  }

  const startedAt = session ? Date.parse(session.startedAt) : now;
  const elapsed = session
    ? Math.min(session.maxSeconds, Math.max(0, ((endedAt ?? now) - startedAt) / 1000))
    : 0;
  const price = session?.pricePerMinuteMicro ?? 0;
  const estimate = elapsed > 0 ? Math.ceil(elapsed / 60) * price : 0;
  const charged = view?.chargedMicro ?? null;
  const turns = view?.turns ?? [];

  return (
    <div className="flex h-full min-h-[480px] flex-col gap-4 p-5 text-ink lg:flex-row">
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <div className="relative aspect-video w-full overflow-hidden rounded-card bg-track">
          <video
            ref={videoRef}
            autoPlay
            playsInline
            aria-label={`${spec.name}的画面`}
            className="h-full w-full object-contain"
          />
          <audio ref={audioRef} autoPlay className="hidden" />
          {phase !== 'live' && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center">
              {spec.avatarPreviewUrl && phase !== 'ended' && (
                <img
                  src={spec.avatarPreviewUrl}
                  alt={`${spec.name}的形象`}
                  className="max-h-[60%] rounded-card object-contain"
                />
              )}
              <p className="m-0 text-sm text-ink-muted">
                {phase === 'starting'
                  ? '正在连接数字人…（要几秒钟）'
                  : phase === 'ended'
                    ? endReasonText(room.ended ?? view?.endReason ?? 'USER_CLOSED')
                    : `点「开始对话」后可以直接说话，也可以打字提问`}
              </p>
            </div>
          )}
          {phase === 'live' && room.speaking && (
            <span className="absolute left-3 top-3 rounded-full bg-glass-active px-3 py-1 text-xs shadow-edge-strong">
              {room.speaking === 'avatar' ? `${spec.name}在说话` : '在听你说'}
            </span>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {phase === 'live' ? (
            <>
              <button
                type="button"
                className={`${button} bg-glass-active shadow-edge-strong`}
                onClick={() => void toggleMic()}
                disabled={mic === 'denied'}
                title={mic === 'denied' ? '浏览器没给麦克风权限，可以打字提问' : undefined}
              >
                {mic === 'on' ? <Mic size={16} /> : <MicOff size={16} />}
                {mic === 'on' ? '麦克风开着' : mic === 'denied' ? '没有麦克风权限' : '麦克风关着'}
              </button>
              <button
                type="button"
                className={`${button} bg-glass-active shadow-edge-strong`}
                onClick={() => publish({ event_type: 'avatar.interrupt' })}
              >
                <Hand size={16} />
                打断
              </button>
              <button
                type="button"
                className={`${button} bg-solid text-on-solid`}
                onClick={() => void end()}
              >
                <Square size={16} />
                结束对话
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${button} bg-solid text-on-solid`}
              disabled={phase === 'starting'}
              onClick={() => void start()}
            >
              {phase === 'ended' ? '再对话一次' : '开始对话'}
            </button>
          )}
          <span className="ml-auto text-xs text-ink-muted">
            {session
              ? session.sandbox
                ? `开发环境沙箱：免费，约 1 分钟自动结束`
                : `每分钟 ${formatCost(price)}，单次最长 ${clockText(session.maxSeconds)}`
              : `单次最长 ${spec.maxMinutes} 分钟，按实际用时计费`}
          </span>
        </div>

        {phase === 'live' && (
          <form
            className="flex gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              ask();
            }}
          >
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={500}
              placeholder="打字提问（不方便说话时用）"
              aria-label="打字提问"
              className="min-w-0 flex-1 rounded-full bg-glass-active px-4 py-2 text-sm shadow-edge-strong outline-none focus-visible:ring-2 focus-visible:ring-accent"
            />
            <button
              type="submit"
              className={`${button} bg-solid text-on-solid`}
              disabled={!draft.trim()}
            >
              <Send size={16} />
              发送
            </button>
          </form>
        )}

        {session && (
          <p className="m-0 text-xs text-ink-muted">
            已用 {clockText(elapsed)} / 最长 {clockText(session.maxSeconds)} ·{' '}
            {charged !== null
              ? `实际花费 ${formatCost(charged)}`
              : `约 ${formatCost(estimate)}（结束后按实际用量结算）`}
            {room.waits.length > 0 && ` · 上一轮等了 ${seconds(room.waits.at(-1) ?? 0)}开口`}
          </p>
        )}
        {error && (
          <p role="alert" className="m-0 text-sm text-accent">
            {error}
          </p>
        )}
      </section>

      <aside className="flex w-full flex-col gap-3 lg:w-[360px]">
        <section className="rounded-card bg-glass-active p-4 shadow-edge-strong">
          <h3 className="m-0 text-base font-medium">{spec.name}</h3>
          {spec.openingText && (
            <p className="m-0 mt-1 text-sm text-ink-muted">开场白：{spec.openingText}</p>
          )}
          <p className="m-0 mt-1 text-xs text-ink-muted">
            {spec.knowledge.length} 条知识要点
            {spec.handoff ? ` · 转人工：${spec.handoff.when}` : ''}
          </p>
        </section>

        <section
          aria-label="对话记录"
          className="flex max-h-[360px] min-h-[120px] flex-col gap-2 overflow-auto rounded-card bg-glass-active p-4 shadow-edge-strong"
        >
          {room.lines.length === 0 && (
            <p className="m-0 text-xs text-ink-muted">对话会显示在这里。</p>
          )}
          {room.lines.map((line) => (
            <p
              key={line.id}
              className={`m-0 text-sm ${line.who === 'user' ? 'self-end text-right' : ''}`}
            >
              <span className="text-xs text-ink-muted">
                {line.who === 'user' ? '你' : spec.name}：
              </span>
              {/* 逐字推送的顺序不可靠，说完、整句到了再显示 */}
              {line.pending ? <span className="text-ink-muted">（正在说…）</span> : line.text}
            </p>
          ))}
        </section>

        {turns.length > 0 && (
          <section
            aria-label="后台记录"
            className="rounded-card bg-glass-active p-4 shadow-edge-strong"
          >
            <h4 className="m-0 text-sm font-medium">后台记录</h4>
            <ol className="m-0 mt-2 flex flex-col gap-2 pl-5 text-xs">
              {turns.map((turn) => (
                <li key={turn.at}>
                  <span>{turn.question || '（没有听清）'}</span>
                  <span className="block text-ink-muted">
                    {turn.sources.length > 0 ? `查了：${turn.sources.join('、')}` : '没用到资料'}
                    {turn.handoff && ' · 触发转人工'}
                    {turn.firstTokenMs !== null &&
                      ` · 模型 ${seconds(turn.firstTokenMs)}出第一个字`}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        )}
      </aside>
    </div>
  );
}
