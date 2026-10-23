// 私聊的输入框：「＋」里作为任务发布、添加文件；文件也可以粘贴进来（拖进对话区由页面处理）。
// 有文件还在上传或上传失败时不能发送。
import { ArrowUp, ListChecks, Paperclip, Plus, X } from 'lucide-react';
import { useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { PendingFiles } from './Attachments.tsx';
import type { useAttachments } from './use-attachments.ts';

type Attachments = ReturnType<typeof useAttachments>;

function ComposerMenu({
  asTask,
  onToggleTask,
  onPickFiles,
  disabled,
}: {
  asTask: boolean;
  onToggleTask: () => void;
  onPickFiles: () => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const item =
    'flex items-center gap-2.5 rounded-item border-0 bg-transparent px-3 py-2.5 text-left text-ink hover:bg-glass-active';
  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        aria-label="更多发送方式"
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex size-11 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-glass-strong hover:text-ink disabled:opacity-45"
      >
        <Plus size={19} aria-hidden="true" />
      </button>
      {open && (
        <div
          role="menu"
          className="glass absolute bottom-12 left-0 z-10 flex w-56 flex-col rounded-card bg-glass-strong p-1.5"
        >
          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={asTask}
            onClick={() => {
              onToggleTask();
              setOpen(false);
            }}
            className={item}
          >
            <ListChecks size={17} aria-hidden="true" />
            <span className="flex flex-col">
              <span className="text-[14px] font-medium">作为任务发布</span>
              <span className="text-[12px] text-ink-muted">交给 AI 团队做出成果</span>
            </span>
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onPickFiles();
              setOpen(false);
            }}
            className={item}
          >
            <Paperclip size={17} aria-hidden="true" />
            <span className="flex flex-col">
              <span className="text-[14px] font-medium">添加文件</span>
              <span className="text-[12px] text-ink-muted">图片、文档、音视频都行</span>
            </span>
          </button>
        </div>
      )}
    </div>
  );
}

export function Composer({
  locked,
  sending,
  hint,
  inputRef,
  attachments,
  onSend,
}: {
  locked: boolean;
  sending: boolean;
  /** 卡片要求的提示（如「说说要改哪里」）；发出去后清掉 */
  hint: string | null;
  inputRef: RefObject<HTMLTextAreaElement | null>;
  attachments: Attachments;
  /** 发出去；返回 false 表示没发成，草稿要还回来 */
  onSend: (content: string, asTask: boolean) => Promise<boolean>;
}) {
  const [draft, setDraft] = useState('');
  const [asTask, setAsTask] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  const blocked = attachments.uploading || attachments.failed;
  const canSend = !locked && !blocked && draft.trim() !== '';

  async function send() {
    const content = draft.trim();
    if (!canSend) return;
    setDraft('');
    const ok = await onSend(content, asTask);
    if (ok) setAsTask(false);
    else setDraft(content);
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    // 中文输入法选字时按回车不发送
    if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  const placeholder = sending
    ? 'AI 正在回复…'
    : (hint ??
      (attachments.files.length > 0
        ? '说说要拿这些文件做什么…'
        : asTask
          ? '说说要交付什么，比如：给我的民宿写个官网首页'
          : '发消息…'));

  return (
    <>
      {attachments.notice && (
        <p role="alert" className="m-0 text-[13px] text-accent">
          {attachments.notice}
        </p>
      )}
      <div className="flex items-end gap-1 rounded-card bg-glass-active p-2 shadow-edge-strong">
        <ComposerMenu
          asTask={asTask}
          onToggleTask={() => setAsTask((v) => !v)}
          onPickFiles={() => picker.current?.click()}
          disabled={locked}
        />
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
          {asTask && (
            <span className="inline-flex items-center gap-1 self-start rounded-full bg-solid py-1 pl-2.5 pr-1 text-[12px] font-medium text-on-solid">
              任务
              <button
                type="button"
                onClick={() => setAsTask(false)}
                aria-label="不作为任务发布"
                className="flex size-4 items-center justify-center rounded-full border-0 bg-transparent p-0 text-on-solid"
              >
                <X size={12} aria-hidden="true" />
              </button>
            </span>
          )}
          <label htmlFor="dm-input" className="sr-only">
            消息
          </label>
          <textarea
            id="dm-input"
            rows={1}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(event) => {
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
        <button
          type="button"
          onClick={() => void send()}
          disabled={!canSend}
          aria-label={asTask ? '发布任务' : '发送'}
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
            : 'Enter 发送 · Shift + Enter 换行 · 文件可以拖进来或粘贴'}
      </p>
    </>
  );
}
