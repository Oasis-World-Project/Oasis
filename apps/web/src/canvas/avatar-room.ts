// 数字人会话里 LiveAvatar 推来的事件（ADR 0013）→ 页面上的对话记录、谁在说话、每轮等了多久。纯函数，方便测试。
// 事件名见 LiveAvatar FULL 模式文档；实测还有逐字推送的 avatar.transcription.chunk。

interface Line {
  id: number;
  who: 'user' | 'avatar';
  text: string;
  /** 数字人这句话还在逐字推送 */
  pending: boolean;
}

export interface RoomState {
  lines: Line[];
  speaking: 'user' | 'avatar' | null;
  /** 每一轮从用户说完（或发出打字的问题）到数字人开口的毫秒数 */
  waits: number[];
  /** 正在等数字人开口：从这个时间算起 */
  waitingSince: number | null;
  /** LiveAvatar 的会话编号（发命令时带上） */
  providerSessionId: string | null;
  /** 会话结束的原因（LiveAvatar 的 end_reason） */
  ended: string | null;
  nextId: number;
}

export interface AgentEvent {
  event_type?: unknown;
  text?: unknown;
  session_id?: unknown;
  end_reason?: unknown;
}

export const initialRoom: RoomState = {
  lines: [],
  speaking: null,
  waits: [],
  waitingSince: null,
  providerSessionId: null,
  ended: null,
  nextId: 1,
};

function push(state: RoomState, who: Line['who'], text: string, pending: boolean): RoomState {
  return {
    ...state,
    lines: [...state.lines, { id: state.nextId, who, text, pending }],
    nextId: state.nextId + 1,
  };
}

function finishPending(state: RoomState, text?: string): RoomState {
  const last = state.lines.at(-1);
  if (last?.who !== 'avatar' || !last.pending) return state;
  return {
    ...state,
    lines: [...state.lines.slice(0, -1), { ...last, text: text ?? last.text, pending: false }],
  };
}

/** 用户打字提问：记一行，并开始计时 */
export function asked(state: RoomState, text: string, now: number): RoomState {
  return { ...push(state, 'user', text, false), waitingSince: now };
}

export function reduceEvent(state: RoomState, event: AgentEvent, now: number): RoomState {
  const text = typeof event.text === 'string' ? event.text.trim() : '';
  let next = state;
  if (!next.providerSessionId && typeof event.session_id === 'string') {
    next = { ...next, providerSessionId: event.session_id };
  }
  switch (event.event_type) {
    case 'user.speak_started':
      return { ...next, speaking: 'user' };
    case 'user.speak_ended':
      return { ...next, speaking: null, waitingSince: now };
    case 'user.transcription': {
      // 打字的问题 LiveAvatar 也会回推一遍，别记两次
      const last = next.lines.at(-1);
      if (!text || (last?.who === 'user' && last.text === text)) return next;
      return push(next, 'user', text, false);
    }
    case 'avatar.speak_started':
      return next.waitingSince === null
        ? { ...next, speaking: 'avatar' }
        : {
            ...next,
            speaking: 'avatar',
            waits: [...next.waits, Math.max(0, now - next.waitingSince)],
            waitingSince: null,
          };
    case 'avatar.transcription.chunk': {
      const last = next.lines.at(-1);
      if (last?.who === 'avatar' && last.pending) {
        return {
          ...next,
          lines: [...next.lines.slice(0, -1), { ...last, text: last.text + (event.text ?? '') }],
        };
      }
      return push(next, 'avatar', typeof event.text === 'string' ? event.text : '', true);
    }
    case 'avatar.transcription': {
      const last = next.lines.at(-1);
      if (last?.who === 'avatar' && last.pending) return finishPending(next, text || last.text);
      return text ? push(next, 'avatar', text, false) : next;
    }
    case 'avatar.speak_ended':
      return { ...finishPending(next), speaking: null };
    case 'session.stopped':
      return {
        ...finishPending(next),
        speaking: null,
        ended: typeof event.end_reason === 'string' ? event.end_reason : 'UNKNOWN',
      };
    default:
      return next;
  }
}

/** 会话结束原因 → 给人看的话 */
export function endReasonText(reason: string | null): string {
  switch (reason) {
    case 'USER_CLOSED':
      return '对话已结束';
    case 'MAX_DURATION_REACHED':
      return '到了单次最长时长，对话已结束';
    case 'IDLE_TIMEOUT':
      return '太久没说话，对话已结束';
    case 'NO_CREDITS':
      return '数字人服务的额度用完了';
    case 'USER_DISCONNECTED':
      return '连接断开了，对话已结束';
    default:
      return '对话已结束';
  }
}
