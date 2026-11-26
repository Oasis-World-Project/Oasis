// 私聊的输入框：可以添加文件（也可以粘贴进来，拖进对话区由页面处理）。AI 正在做时照样能发——
// 发的话先排在输入框上面，这一轮做完接着做（点「引导」马上交给 AI）；这时旁边多一个停止按钮。
// 文件只能在一轮开始时交给 AI，所以一轮进行中不能带文件发送。有文件还在上传或上传失败时不能发送。
// 从队里拿回来改的话放回这里。
import { ArrowUp, Paperclip, Square } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react';
import { PendingFiles } from './Attachments.tsx';
import type { useAttachments } from './use-attachments.ts';

type Attachments = ReturnType<typeof useAttachments>;

export function Composer({
  locked,
  sending,
  hint,
  inputRef,
  attachments,
  onSend,
  textOnly = false,
  turnActive = false,
  onStop,
  stopping = false,
  restore = null,
  tools,
}: {
  locked: boolean;
  sending: boolean;
  /** 卡片要求的提示（如「说说要改哪里」）；发出去后清掉 */
  hint: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: Attachments;
  /** 发出去；返回 false 表示没发成，草稿要还回来 */
  onSend: (content: string) => Promise<boolean>;
  /** 群聊基础阶段只发文字，不显示文件入口。 */
  textOnly?: boolean;
  /** AI 正在做这一轮：发的话先排队，不能带文件 */
  turnActive?: boolean;
  onStop?: (() => void) | undefined;
  stopping?: boolean;
  /** 从队里拿回来改的话（每次是新的对象）：放回输入框，打了一半的接在后面 */
  restore?: { text: string } | null;
  /** 「添加文件」旁边的其他开关（私聊里是联网搜索） */
  tools?: ReactNode;
}) {
  const [draft, setDraft] = useState('');
  const [restored, setRestored] = useState(restore);
  if (restore !== restored) {
    setRestored(restore);
    if (restore)
      setDraft((current) => (current.trim() ? `${restore.text}\n${current}` : restore.text));
  }
  const picker = useRef<HTMLInputElement>(null);
  const hasFiles = attachments.files.length > 0;
  const blocked = attachments.uploading || attachments.failed || (turnActive && hasFiles);
  const canSend = !locked && !blocked && draft.trim() !== '';

  async function send() {
    const content = draft.trim();
    if (!canSend) return;
    setDraft('');
    if (!(await onSend(content))) setDraft(content);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法选字时按回车不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const placeholder = sending
    ? '发送中…'
    : turnActive
      ? 'AI 正在做，发的话先排着，做完接着做…'
      : (hint ?? (hasFiles ? '说说要拿这些文件做什么…' : '发消息…'));

  return (
    <>
      {attachments.notice && (
        <p role="alert" className="m-0 text-[13px] text-accent">
          {attachments.notice}
        </p>
      )}
      <div className="flex items-end gap-1 rounded-card bg-glass-active p-2 shadow-edge-strong">
        {!textOnly && (
          <button
            type="button"
            onClick={() => picker.current?.click()}
            disabled={locked || turnActive}
            aria-label="添加文件"
            title={turnActive ? '这一轮做完才能带文件' : '添加文件'}
            className="flex size-11 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-glass-strong hover:text-ink disabled:opacity-45"
          >
            <Paperclip size={18} aria-hidden="true" />
          </button>
        )}
        {tools}
        <input
          ref={picker}
          type="file"
          multiple
          hidden
          aria-label="选择文件"
          onChange={(event) => {
            attachments.add(event.target.files ?? []);
            event.target.value = '';
          }}
        />
        <div className="flex min-w-0 flex-1 flex-col pt-1">
          <PendingFiles files={attachments.files} onRemove={attachments.remove} />
          <textarea
            aria-label="消息"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
              if (textOnly) return;
              if (event.clipboardData.files.length > 0) {
                event.preventDefault();
                attachments.add(event.clipboardData.files);
              }
            }}
            ref={inputRef}
            autoFocus
            disabled={locked}
            placeholder={placeholder}
            className="field-sizing-content max-h-40 min-h-10 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-2 text-[14.5px] text-ink outline-none placeholder:text-ink-muted"
          />
        </div>
        {turnActive && onStop && (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label={stopping ? '正在停下' : '停下这一轮'}
            title="停下这一轮（已经做出来的会存下）"
            className="flex size-11 shrink-0 items-center justify-center rounded-full border-0 bg-solid text-on-solid disabled:cursor-not-allowed disabled:opacity-45"
          >
            <Square size={14} fill="currentColor" aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-label={turnActive ? '排队' : '发送'}
          title={turnActive ? '先排着，这一轮做完接着做' : undefined}
          className="flex size-11 shrink-0 items-center justify-center rounded-full border-0 bg-accent text-on-accent disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ArrowUp size={18} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      <p className="m-0 px-1 text-[11.5px] text-ink-muted">
        {attachments.uploading
          ? '文件传完就能发送'
          : attachments.failed
            ? '有文件没传上去，移除后再发送'
            : turnActive && hasFiles
              ? '这一轮做完才能带文件发送，或者先停下这一轮'
              : turnActive
                ? 'Enter 排队 · Shift + Enter 换行 · 排着的话点「引导」马上交给 AI'
                : textOnly
                  ? 'Enter 发送 · Shift + Enter 换行'
                  : 'Enter 发送 · Shift + Enter 换行 · 文件可以拖进来或粘贴'}
      </p>
    </>
  );
}
