// 进度页上半部：这一轮的成果按类型分框（图片、视频、声音、文档、其他）。做好的点开预览（视频、声音直接放）；
// 还在做的长任务写已等多久、通常要多久，带大概进度；没做出来的写原因。素材打个标。
import type { TaskFile } from '@oasis/contracts/conversation';
import type { ReactNode } from 'react';
import { artifactContentUrl, runFileUrl } from '../api/queries.ts';
import { StepIcon } from './Process.tsx';
import { FileChip } from './FileChip.tsx';
import { baseName, type PreviewFile } from './files.ts';
import { OUTPUT_BOXES, type LongTask, type OutputItem, type OutputKind } from './run-progress.ts';
import { elapsedText, previewOf } from './TaskCard.tsx';

const heading = 'm-0 text-[13px] font-medium text-ink-muted';

/** 「素材」小标 */
function MaterialTag() {
  return (
    <span className="absolute left-2 top-2 rounded-full bg-glass-strong px-2 py-0.5 text-[11px] text-ink-muted backdrop-blur-md">
      素材
    </span>
  );
}

/** 还在做、没做出来的长任务：已等多久、通常要多久（按调用记录），大概进度；没做出来写原因 */
function TaskTile({ task, now }: { task: LongTask; now: number }) {
  const started = task.startedAt ? Date.parse(task.startedAt) : now;
  const waited = (task.finishedAt ? Date.parse(task.finishedAt) : now) - started;
  const running = task.status === 'running';
  const expected = task.expectSeconds ? task.expectSeconds * 1000 : undefined;
  const percent = expected ? Math.min(95, (waited / expected) * 100) : undefined;
  return (
    <article
      aria-label={task.label}
      className="flex min-w-0 flex-col gap-2 rounded-item bg-glass-active px-3 py-2.5 shadow-edge-strong"
    >
      <header className="flex items-start gap-2 text-[13px]">
        <span className="pt-1">
          <StepIcon status={task.status} />
        </span>
        <span className="min-w-0 flex-1 break-words font-medium">{task.label}</span>
      </header>
      <p className="m-0 text-[12px] text-ink-muted">
        {running ? '已等' : '用了'} {elapsedText(waited)}
        {expected ? ` · 通常约 ${elapsedText(expected)}` : ''}
      </p>
      {running && percent !== undefined && (
        <div
          role="progressbar"
          aria-label="大概进度"
          aria-valuenow={Math.round(percent)}
          className="h-1.5 overflow-hidden rounded-full bg-track"
        >
          <div
            className="h-full rounded-full bg-accent transition-[width]"
            style={{ width: `${percent}%` }}
          />
        </div>
      )}
      {task.detail && (
        <p className="m-0 whitespace-pre-wrap break-words text-[12px] text-accent">{task.detail}</p>
      )}
    </article>
  );
}

/** 一个做好的文件：图片显示缩略图，视频、声音直接放，别的是文件条；点开预览 */
function FileTile({
  item,
  file,
  onOpen,
}: {
  item: OutputItem;
  file: PreviewFile;
  onOpen: (file: PreviewFile) => void;
}) {
  const name = baseName(file.path);
  if (item.kind === 'image')
    return (
      <button
        type="button"
        onClick={() => onOpen(file)}
        aria-label={`预览 ${item.path ?? name}`}
        title={item.path}
        className="relative flex min-w-0 flex-col gap-1.5 rounded-item border-0 bg-glass-active p-2 text-left text-ink shadow-edge-strong"
      >
        <img src={file.url} alt="" className="h-[150px] w-full rounded-item object-cover" />
        {item.material && <MaterialTag />}
        <span className="truncate text-[12.5px]">{name}</span>
      </button>
    );
  if (item.kind === 'video')
    return (
      <figure className="relative m-0 flex min-w-0 flex-col gap-1.5 rounded-item bg-glass-active p-2 shadow-edge-strong">
        <video
          src={file.url}
          controls
          preload="metadata"
          aria-label={name}
          className="max-h-[320px] w-full rounded-item bg-solid"
        />
        {item.material && <MaterialTag />}
        <figcaption className="truncate text-[12.5px]">{name}</figcaption>
      </figure>
    );
  if (item.kind === 'audio')
    return (
      <figure className="m-0 flex min-w-0 flex-col gap-1.5 rounded-item bg-glass-active px-3 py-2 shadow-edge-strong">
        <figcaption className="flex items-center gap-2 text-[12.5px]">
          <span className="truncate">{name}</span>
          {item.material && <span className="text-[11px] text-ink-muted">素材</span>}
        </figcaption>
        <audio src={file.url} controls preload="none" aria-label={name} className="w-full" />
      </figure>
    );
  return <FileChip file={file} onOpen={() => onOpen(file)} />;
}

const GRID: Record<OutputKind, string> = {
  image: 'grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] items-start gap-3',
  video: 'grid grid-cols-[repeat(auto-fill,minmax(200px,1fr))] items-start gap-3',
  audio: 'grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] items-start gap-3',
  doc: 'm-0 flex max-w-[640px] list-none flex-col gap-1.5 p-0',
  other: 'm-0 flex max-w-[640px] list-none flex-col gap-1.5 p-0',
};

/** 文档和其他是文件条（列表），图片、视频、声音是格子 */
const listed = (kind: OutputKind) => kind === 'doc' || kind === 'other';

function Box({
  label,
  kind,
  count,
  children,
}: {
  label: string;
  kind: OutputKind;
  count: number;
  children: ReactNode;
}) {
  const List = listed(kind) ? 'ul' : 'div';
  return (
    <section
      aria-label={label}
      className="flex flex-col gap-2.5 rounded-card bg-glass-strong px-4 py-3 shadow-edge-strong"
    >
      <h3 className={heading}>
        {label} <span className="font-display text-[12px]">{count}</span>
      </h3>
      <List className={GRID[kind]}>{children}</List>
    </section>
  );
}

export function RunOutputs({
  items,
  files,
  conversationId,
  runId,
  now,
  onOpen,
}: {
  items: OutputItem[];
  /** 任务卡上登记进画布的成果（Word、PPT 用同名 PDF 预览） */
  files: TaskFile[];
  conversationId: string;
  runId: string;
  now: number;
  onOpen: (file: PreviewFile) => void;
}) {
  const fileOf = (item: OutputItem): PreviewFile => {
    const registered = files.find((f) => f.artifactId === item.artifactId);
    if (registered) return previewOf(registered, files);
    const url = item.artifactId
      ? artifactContentUrl(item.artifactId)
      : runFileUrl(conversationId, runId, item.live!.path, item.live!.version);
    return { path: item.path!, url, downloadUrl: url };
  };
  return (
    <section aria-label="成果" className="flex flex-col gap-2.5">
      <h2 className={heading}>成果</h2>
      {!items.length && (
        <p className="m-0 text-[13px] text-ink-muted">还没有成果，做好一个就放到这里。</p>
      )}
      {OUTPUT_BOXES.map(([kind, label]) => {
        const list = items.filter((item) => item.kind === kind);
        if (!list.length) return null;
        return (
          <Box key={kind} label={label} kind={kind} count={list.length}>
            {list.map((item) =>
              !item.task ? (
                <FileTile key={item.key} item={item} file={fileOf(item)} onOpen={onOpen} />
              ) : listed(kind) ? (
                <li key={item.key}>
                  <TaskTile task={item.task} now={now} />
                </li>
              ) : (
                <TaskTile key={item.key} task={item.task} now={now} />
              ),
            )}
          </Box>
        );
      })}
    </section>
  );
}
