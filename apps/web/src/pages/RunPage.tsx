// 一轮的进度页（任务卡上点「看进度」、画布上任务框里点「看过程」打开）：顶上是任务名和主 AI 卡——状态、
// 正在做的一步、待办、用时、花费，在做时可以停下、点要你确认的卡；上半部是成果，按类型分框（图片、视频、
// 声音、文档、其他，还在做的长任务带大概进度）；下半部是过程，AI 每说一句话一段，连成一条线。
// 数据就是私聊的消息：有一轮在做时每秒刷新，和私聊页同一份；做完以后成果在画布里，过程一直留着。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, Images, LoaderCircle } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { dmsQuery, messagesQuery, stopTurn } from '../api/queries.ts';
import { aiName, useModelMap } from '../api/use-model-map.ts';
import { Todos } from '../chat/Process.tsx';
import { ConfirmationCards } from '../chat/ConfirmationCards.tsx';
import { FilePreview } from '../chat/FilePreview.tsx';
import type { PreviewFile } from '../chat/files.ts';
import { StatusTag, type Speaker } from '../chat/parts.tsx';
import { runProgress, type RunProgress } from '../chat/run-progress.ts';
import { RunOutputs } from '../chat/RunOutputs.tsx';
import { RunStages } from '../chat/RunStages.tsx';
import { elapsedText, taskStatus, useNow } from '../chat/TaskCard.tsx';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';

const route = getRouteApi('/shell/canvas/runs/$runId');

const iconLink =
  'flex size-10 shrink-0 items-center justify-center rounded-full bg-glass-active text-ink no-underline shadow-edge-strong';

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
  const live = messages.data?.turn?.runId === runId;
  const card = progress.card;

  return (
    <section
      aria-label="这一轮的进度"
      className="glass flex flex-1 flex-col gap-5 rounded-panel px-6 py-5"
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
        <div className="flex min-w-0 flex-1 flex-col">
          <h1 className="m-0 truncate text-[18px] font-medium">
            {progress.found ? progress.title : '这一轮的进度'}
          </h1>
          <span className="truncate text-xs text-ink-muted">
            {dm ? aiName(models, dm) : '私聊'}
            {progress.startedAt &&
              ` · ${new Date(progress.startedAt).toLocaleString('zh-CN', {
                month: 'numeric',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit',
              })} 开始`}
          </span>
        </div>
        {card && card.files.length > 0 && (
          <Link
            to="/canvas"
            search={{ conversation: conversationId }}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
          >
            <Images size={15} aria-hidden="true" />
            在画布里看
          </Link>
        )}
      </header>

      {messages.isPending && <p className="m-0 text-sm text-ink-muted">正在加载…</p>}
      {messages.isError && (
        <p role="alert" className="m-0 text-sm text-accent">
          {messages.error instanceof ApiError ? messages.error.message : '读不到这一轮，请刷新'}
        </p>
      )}
      {messages.isSuccess && !progress.found && (
        <p className="m-0 text-sm text-ink-muted">这个私聊里没有这一轮（可能已经删掉了）。</p>
      )}

      {progress.found && (
        <>
          <LeadCard
            progress={progress}
            speaker={speaker}
            now={now}
            canStop={live}
            stopping={stop.isPending}
            onStop={() => stop.mutate()}
          />
          {stop.isError && (
            <p role="alert" className="m-0 text-[13px] text-accent">
              {stop.error instanceof ApiError ? stop.error.message : '没停下来，请重试'}
            </p>
          )}
          {live && messages.data?.turn && (
            <ConfirmationCards
              conversationId={conversationId}
              cards={messages.data.turn.confirmations}
              messages={messages.data.messages}
              onDecided={() =>
                void queryClient.invalidateQueries({
                  queryKey: messagesQuery(conversationId).queryKey,
                })
              }
            />
          )}
          <RunOutputs
            items={progress.outputs}
            files={card?.files ?? []}
            conversationId={conversationId}
            runId={runId}
            now={now}
            onOpen={setPreview}
          />
          <RunStages stages={progress.stages} now={now} />
        </>
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </section>
  );
}

/** 主 AI 卡：状态、正在做的一步、用时、花费、待办；在做时可以停下；出错了写原因 */
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
  const status = taskStatus({ status: progress.status, revision: progress.card?.revision });
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
        {progress.error && (
          <p role="alert" className="m-0 text-[13px] text-accent">
            {progress.error}
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
