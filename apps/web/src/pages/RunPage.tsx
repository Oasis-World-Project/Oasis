// 一轮的进度页（任务卡上点「看进度」打开）：最上面是主 AI 卡——状态、正在做的一步、待办、用时、花费，
// 在做时可以停下、点要你确认的卡；生图、视频这类长任务一张张卡并排（已等多久、通常要多久、做出的图和声音；几段先交后
// 一起等的按任务号一段一张）；下面按发生的顺序是说的话、做的步骤（折叠）和插话；最后在做时是这一轮
// 做出的文件（点开预览），做完后是交出的成品。数据就是私聊的消息：有一轮在做时每秒刷新，和私聊页同一份。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, Images, Info, LoaderCircle } from 'lucide-react';
import { Fragment, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, runFileUrl, stopTurn } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { groupParts, StepIcon, Steps, Todos } from '../chat/AiMessage.tsx';
import { splitBlocks } from '../chat/blocks.ts';
import { ConfirmationCards } from '../chat/ConfirmationCards.tsx';
import { FileChip } from '../chat/FileChip.tsx';
import { FilePreview } from '../chat/FilePreview.tsx';
import { badgeOf, baseName, previewKindOf, type PreviewFile } from '../chat/files.ts';
import { Markdown } from '../chat/Markdown.tsx';
import { StatusTag, type Speaker } from '../chat/parts.tsx';
import {
  runProgress,
  type LongTask,
  type RunFile,
  type RunProgress,
  type TextMessage,
} from '../chat/run-progress.ts';
import { elapsedText, previewOf, TASK_STATUS, useNow } from '../chat/TaskCard.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';

const route = getRouteApi('/shell/canvas/runs/$runId');

const iconLink =
  'flex size-10 shrink-0 items-center justify-center rounded-full bg-glass-active text-ink no-underline shadow-edge-strong';
const heading = 'm-0 text-[13px] font-medium text-ink-muted';

export function RunPage() {
  const { runId } = route.useParams();
  const { conversation } = route.useSearch();
  if (!conversation)
    return (
      <section aria-label="这一轮的进度" className="glass rounded-panel p-8 text-sm text-ink-muted">
        不知道这一轮在哪个私聊里。请从私聊里任务卡上的「看进度」打开。
      </section>
    );
  return <RunView runId={runId} conversationId={conversation} />;
}

function RunView({ runId, conversationId }: { runId: string; conversationId: string }) {
  const queryClient = useQueryClient();
  const messages = useQuery(messagesQuery(conversationId));
  const { data: dms } = useQuery(dmsQuery);
  const models = useModelMap();
  const dm = dms?.find((item) => item.id === conversationId);
  const model = dm?.modelKey ? models.get(dm.modelKey) : undefined;
  const speaker = { mono: model?.mono ?? 'AI', glow: model?.glow ?? 'var(--oasis-accent)' };
  const progress = runProgress(messages.data, runId);
  const now = useNow(progress.status === 'running');
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const stop = useMutation({
    mutationFn: () => stopTurn(conversationId),
    onSettled: () =>
      queryClient.invalidateQueries({ queryKey: messagesQuery(conversationId).queryKey }),
  });
  const fileOf = (file: RunFile): PreviewFile => {
    const url = runFileUrl(conversationId, runId, file.path, file.version);
    return { path: file.path, url, downloadUrl: url };
  };
  const opening = progress.messages.find((m) => m.role === 'user');
  const card = progress.card;

  return (
    <section
      aria-label="这一轮的进度"
      className="glass flex min-h-[calc(100vh-44px)] flex-col gap-5 rounded-panel px-6 py-5"
    >
      <header className="flex items-center gap-3">
        <Link
          to="/dms/$conversationId"
          params={{ conversationId }}
          aria-label="回到私聊"
          title="回到私聊"
          className={iconLink}
        >
          <ArrowLeft size={17} aria-hidden="true" />
        </Link>
        <div className="flex min-w-0 flex-col">
          <h1 className="m-0 text-[17px] font-medium">这一轮的进度</h1>
          {opening && (
            <span className="truncate text-xs text-ink-muted">
              {opening.content.split('\n')[0]}
            </span>
          )}
        </div>
      </header>

      {messages.isPending && <p className="m-0 text-sm text-ink-muted">正在加载…</p>}
      {messages.isError && (
        <p role="alert" className="m-0 text-sm text-accent">
          {messages.error instanceof ApiError ? messages.error.message : '读不到这一轮，请刷新'}
        </p>
      )}
      {messages.isSuccess && progress.messages.length === 0 && (
        <p className="m-0 text-sm text-ink-muted">这个私聊里没有这一轮（可能已经删掉了）。</p>
      )}

      {progress.messages.length > 0 && (
        <>
          <LeadCard
            progress={progress}
            speaker={speaker}
            now={now}
            canStop={messages.data?.turn?.runId === runId}
            stopping={stop.isPending}
            onStop={() => stop.mutate()}
          />
          {stop.isError && (
            <p role="alert" className="m-0 text-[13px] text-accent">
              {stop.error instanceof ApiError ? stop.error.message : '没停下来，请重试'}
            </p>
          )}
          {messages.data?.turn?.runId === runId && (
            <ConfirmationCards
              conversationId={conversationId}
              cards={messages.data.turn.confirmations}
              messages={messages.data.messages}
            />
          )}

          {progress.longTasks.length > 0 && (
            <section aria-label="长任务" className="flex flex-col gap-2.5">
              <h2 className={heading}>生图、视频这类长任务</h2>
              <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] items-start gap-3">
                {progress.longTasks.map((task) => (
                  <LongTaskCard
                    key={task.key}
                    task={task}
                    now={now}
                    files={task.files.map(fileOf)}
                    onOpen={setPreview}
                  />
                ))}
              </div>
            </section>
          )}

          <section aria-label="经过" className="flex flex-col gap-2.5">
            <h2 className={heading}>经过</h2>
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {progress.messages.map((message) => (
                <TimelineItem key={message.id} message={message} first={message === opening} />
              ))}
            </ol>
          </section>

          {progress.files.length > 0 && (
            <section aria-label="做出的文件" className="flex flex-col gap-2.5">
              <h2 className={heading}>这一轮做出的文件</h2>
              <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(150px,1fr))] items-start gap-3 p-0">
                {progress.files.map((file) => (
                  <Thumb key={file.path} file={fileOf(file)} onOpen={setPreview} />
                ))}
              </ul>
            </section>
          )}

          {((card && card.files.length > 0) || progress.gone > 0) && (
            <section aria-label="成品" className="flex flex-col gap-2.5">
              <h2 className={heading}>交出的成品</h2>
              {progress.gone > 0 && (
                <p className="m-0 text-[12.5px] text-ink-muted">
                  中间做出的 {progress.gone} 个文件不在成品里，这一轮结束后就看不到了。
                </p>
              )}
              {card && card.files.length > 0 && (
                <>
                  <ul className="m-0 flex max-w-[560px] list-none flex-col gap-1.5 p-0">
                    {card.files.map((file) => (
                      <FileChip
                        key={file.artifactId}
                        file={previewOf(file, card.files)}
                        onOpen={() => setPreview(previewOf(file, card.files))}
                      />
                    ))}
                  </ul>
                  <Link
                    to="/canvas"
                    search={{ conversation: conversationId }}
                    className="inline-flex h-10 w-fit items-center gap-1.5 rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
                  >
                    <Images size={15} aria-hidden="true" />
                    在画布里看
                  </Link>
                </>
              )}
            </section>
          )}
        </>
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

/** 主 AI 卡：状态、正在做的一步、用时、花费、待办；在做时可以停下 */
function LeadCard({
  progress,
  speaker,
  now,
  canStop,
  stopping,
  onStop,
}: {
  progress: RunProgress;
  speaker: Speaker;
  now: number;
  canStop: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  const running = progress.status === 'running';
  const status = TASK_STATUS[progress.status];
  const started = progress.startedAt ? Date.parse(progress.startedAt) : now;
  const ended = progress.finishedAt ? Date.parse(progress.finishedAt) : now;
  return (
    <section
      aria-label="主 AI"
      className="flex items-start gap-3 rounded-card bg-glass-strong px-5 py-4 shadow-edge-strong"
    >
      <AiAvatar mono={speaker.mono} glow={speaker.glow} size={40} glowing={running} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2.5">
          <StatusTag tone={status.tone}>{status.label}</StatusTag>
          <span className="text-[13px] text-ink-muted">
            用时 <span className="text-ink">{elapsedText(ended - started)}</span> · 花费{' '}
            <span className="font-display text-ink">{formatCost(progress.spentMicro)}</span>
          </span>
        </div>
        {running && (
          <p className="m-0 flex items-center gap-2 text-[14px]">
            <LoaderCircle size={14} aria-hidden="true" className="animate-spin text-accent" />
            <span className="min-w-0 truncate">{progress.current?.label ?? '正在想…'}</span>
          </p>
        )}
        {progress.todos.length > 0 && <Todos items={progress.todos} live={running} />}
      </div>
      {running && canStop && (
        <button
          type="button"
          onClick={onStop}
          disabled={stopping}
          className="h-10 shrink-0 rounded-full border-0 bg-glass-active px-4 text-[13.5px] text-ink shadow-edge-strong disabled:opacity-45"
        >
          {stopping ? '正在停下…' : '停下'}
        </button>
      )}
    </section>
  );
}

/** 一个长任务：在做时已等多久、通常要多久（按调用记录）；做完后放出做出的图、视频、声音 */
function LongTaskCard({
  task,
  now,
  files,
  onOpen,
}: {
  task: LongTask;
  now: number;
  files: PreviewFile[];
  onOpen: (file: PreviewFile) => void;
}) {
  const started = task.startedAt ? Date.parse(task.startedAt) : now;
  const waited = (task.finishedAt ? Date.parse(task.finishedAt) : now) - started;
  const running = task.status === 'running';
  const expected = task.expectSeconds ? task.expectSeconds * 1000 : undefined;
  return (
    <article
      aria-label={task.label}
      className="flex flex-col gap-2 rounded-card bg-glass-strong px-4 py-3 shadow-edge-strong"
    >
      <header className="flex items-start gap-2 text-[13.5px]">
        <span className="pt-1">
          <StepIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1 break-words font-medium">{task.label}</span>
      </header>
      <p className="m-0 text-[12.5px] text-ink-muted">
        {running ? '已等' : '用了'} {elapsedText(waited)}
        {expected ? ` · 通常约 ${elapsedText(expected)}` : ''}
      </p>
      {running && expected && (
        <div
          role="progressbar"
          aria-label="大概进度"
          aria-valuenow={Math.round(Math.min(95, (waited / expected) * 100))}
          className="h-1.5 overflow-hidden rounded-full bg-track"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${Math.min(95, (waited / expected) * 100)}%` }}
          />
        </div>
      )}
      {task.detail && (
        <p className="m-0 whitespace-pre-wrap break-words text-[12px] text-accent">{task.detail}</p>
      )}
      {files.map((file) => {
        const kind = previewKindOf(file.path);
        if (kind === 'video')
          return (
            <video
              key={file.path}
              src={file.url}
              controls
              preload="metadata"
              aria-label={baseName(file.path)}
              className="w-full rounded-item"
            />
          );
        if (kind === 'audio')
          return (
            <audio
              key={file.path}
              src={file.url}
              controls
              preload="none"
              aria-label={baseName(file.path)}
              className="w-full"
            />
          );
        return <Thumb key={file.path} file={file} onOpen={onOpen} as="div" />;
      })}
    </article>
  );
}

/** 一个做出的文件：图片显示缩略图，别的显示格式；点开预览 */
function Thumb({
  file,
  onOpen,
  as = 'li',
}: {
  file: PreviewFile;
  onOpen: (file: PreviewFile) => void;
  as?: 'li' | 'div';
}) {
  const Wrapper = as;
  const name = baseName(file.path);
  return (
    <Wrapper className="min-w-0">
      <button
        type="button"
        onClick={() => onOpen(file)}
        aria-label={`预览 ${file.path}`}
        title={file.path}
        className="flex w-full flex-col gap-1.5 rounded-item border-0 bg-glass-active p-2 text-left text-ink shadow-edge-strong"
      >
        {previewKindOf(file.path) === 'image' ? (
          <img src={file.url} alt="" className="aspect-video w-full rounded-item object-cover" />
        ) : (
          <span
            aria-hidden="true"
            className="flex aspect-video w-full items-center justify-center rounded-item bg-solid font-display text-[13px] font-medium text-on-solid"
          >
            {badgeOf(file.path)}
          </span>
        )}
        <span className="truncate text-[12.5px]">{name}</span>
      </button>
    </Wrapper>
  );
}

/** 经过里的一条：用户的话（开头那句、插话），或 AI 的一段（说的话、折叠的步骤、提示、结局） */
function TimelineItem({ message, first }: { message: TextMessage; first: boolean }) {
  if (message.role === 'user')
    return (
      <li className="flex flex-col gap-1 self-end rounded-card bg-solid px-4 py-2.5 text-[14px] text-on-solid">
        <span className="text-[11.5px] opacity-70">
          {first ? '你说' : message.data.pending ? '你说（留到下一轮）' : '插话'}
        </span>
        <span className="whitespace-pre-wrap break-words">{message.content}</span>
      </li>
    );
  return (
    <li className="flex max-w-[80%] flex-col gap-2 text-[14px] leading-relaxed">
      {groupParts(message.data.parts ?? []).map((group, index) => (
        <Fragment key={index}>
          {group.kind === 'steps' ? (
            <Steps steps={group.steps} />
          ) : group.kind === 'notice' ? (
            <p className="m-0 flex items-center gap-1.5 text-[12.5px] text-ink-muted">
              <Info size={13} aria-hidden="true" />
              {group.text}
            </p>
          ) : (
            splitBlocks(group.text).map((block, at) =>
              block.kind === 'text' ? (
                <div
                  key={at}
                  className="rounded-card bg-glass-strong px-4 py-2.5 shadow-edge-strong [overflow-wrap:anywhere]"
                >
                  <Markdown source={block.text} />
                </div>
              ) : (
                <p key={at} className="m-0 text-[12.5px] text-ink-muted">
                  {block.kind === 'questions'
                    ? '（这里有几道题，在私聊里答）'
                    : '（这里有一份任务单，在私聊里看）'}
                </p>
              ),
            )
          )}
        </Fragment>
      ))}
      {message.status === 'failed' && (
        <p role="alert" className="m-0 text-[13px] text-accent">
          {message.error ?? '这一轮出错了'}
        </p>
      )}
      {message.data.stopped && <span className="text-[12.5px] text-ink-muted">已停下</span>}
    </li>
  );
}
