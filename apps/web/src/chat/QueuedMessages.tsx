// 输入框上面排着队的话（照 Codex）：AI 干活时发的话先排着，这一轮做完接着做。
// 每句可以「引导」（现在交给 AI，它做完手上这一步就看到）、改（从队里拿回输入框）或删掉。
import type { MessageBody } from '@oasis/contracts/conversation';
import { CornerDownRight, Pencil, Trash2 } from 'lucide-react';
import { useChatActions } from './use-chat-actions.ts';

const ICON_BUTTON =
  'flex size-8 shrink-0 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-glass-active hover:text-ink disabled:opacity-45';

/** 按钮的名字里只放这句的开头 */
const short = (text: string) => (text.length > 30 ? `${text.slice(0, 30)}…` : text);

export function QueuedMessages({
  messages,
  onEdit,
}: {
  messages: MessageBody[];
  /** 从队里拿回来的话：放回输入框接着改 */
  onEdit: (content: string) => void;
}) {
  const actions = useChatActions();
  if (messages.length === 0) return null;
  const busy = actions.busy !== null;
  // 先从队里删掉（免得这一轮做完时被交出去），删掉了再放回输入框
  const edit = async (message: MessageBody) => {
    if (await actions.unqueue(message.id)) onEdit(message.content);
  };
  return (
    <section
      aria-label="排着队的话"
      className="flex flex-col gap-0.5 rounded-card bg-glass-strong px-2 py-1.5 shadow-edge-strong"
    >
      <p className="m-0 px-2 pt-0.5 text-[11.5px] text-ink-muted">
        {actions.turnActive
          ? '排着队 · 这一轮做完接着做，点「引导」现在就交给 AI'
          : '排着队 · 马上接着做'}
      </p>
      <ul className="m-0 flex list-none flex-col p-0">
        {messages.map((message) => (
          <li key={message.id} className="flex items-center gap-1.5 rounded-item px-2 py-1">
            <CornerDownRight size={14} className="shrink-0 text-ink-muted" aria-hidden="true" />
            <span
              className="min-w-0 flex-1 truncate text-[13.5px] text-ink"
              title={message.content}
            >
              {message.content}
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void actions.steer(message.id)}
              aria-label={`引导：${short(message.content)}`}
              title="现在交给 AI：它做完手上这一步就看到"
              className="h-8 shrink-0 rounded-full border-0 bg-glass-active px-3 text-[12.5px] text-ink shadow-edge-strong hover:bg-accent hover:text-on-accent disabled:opacity-45"
            >
              引导
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void edit(message)}
              aria-label={`改：${short(message.content)}`}
              title="拿回输入框改一改"
              className={ICON_BUTTON}
            >
              <Pencil size={14} aria-hidden="true" />
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void actions.unqueue(message.id)}
              aria-label={`删掉：${short(message.content)}`}
              title="删掉这句"
              className={ICON_BUTTON}
            >
              <Trash2 size={14} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
