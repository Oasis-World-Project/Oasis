// 任务卡：调用了生图、视频、配音这类工具，或交了文件的那一轮。顶上是任务名；进行中显示用时和花费（跟着消息
// 每秒刷新），可以停下、看进度；成品（做好一个进一个）点开预览，素材只说有几个；也可以去画布看这个对话的全部成果。
import type { TaskCard as TaskData, TaskFile } from '@oasis/contracts/conversation';
import { Link } from '@tanstack/react-router';
import { Activity, Images } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { artifactContentUrl } from '../api/queries.ts';
import { formatCost } from '../ui/format.ts';
import { FileChip } from './FileChip.tsx';
import { FilePreview, type PreviewFile } from './FilePreview.tsx';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { MATERIALS } from './run-progress.ts';
import { useChatActions } from './use-chat-actions.ts';

export const TASK_STATUS: Record<
  TaskData['status'],
  { label: string; tone: 'muted' | 'accent' | 'solid' }
> = {
  running: { label: '进行中', tone: 'accent' },
  done: { label: '已完成', tone: 'solid' },
  stopped: { label: '已停下', tone: 'muted' },
  failed: { label: '出错了', tone: 'accent' },
};

/** 用时：几小时几分、几分几秒 */
export function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/** 进行中每秒走一次 */
export function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** 预览一个成品；Word、PPT 用同一轮交出的同名 PDF 预览 */
export const previewOf = (file: TaskFile, files: TaskFile[]): PreviewFile => {
  const pdf = /\.(pptx?|docx?)$/i.test(file.path)
    ? files.find((f) => f.path === file.path.replace(/\.(pptx?|docx?)$/i, '.pdf'))
    : undefined;
  return {
    path: file.path,
    size: file.size,
    url: artifactContentUrl(file.artifactId),
    downloadUrl: artifactContentUrl(file.artifactId, true),
    ...(pdf ? { pdfUrl: artifactContentUrl(pdf.artifactId) } : {}),
  };
};

/** 任务卡上的一行：用时（进行中每秒走）和花费，后面可以接别的（如素材几个） */
export function TaskFacts({ card, children }: { card: TaskData; children?: ReactNode }) {
  const now = useNow(card.status === 'running');
  const ended = card.finishedAt ? Date.parse(card.finishedAt) : now;
  return (
    <p className="m-0 text-[13px] text-ink-muted">
      用时 <span className="text-ink">{elapsedText(ended - Date.parse(card.startedAt))}</span> ·
      花费 <span className="font-display text-ink">{formatCost(card.spentMicro)}</span>
      {children}
    </p>
  );
}

export function TaskCard({ card, speaker }: { card: TaskData; speaker: Speaker }) {
  const actions = useChatActions();
  const running = card.status === 'running';
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const status = TASK_STATUS[card.status];
  const finals = card.files.filter((file) => !file.path.startsWith(MATERIALS));
  const materials = card.files.length - finals.length;

  return (
    <CardFrame speaker={speaker} label="任务" glowing={running}>
      <CardHeading
        kind="任务"
        title={card.title}
        status={<StatusTag tone={status.tone}>{status.label}</StatusTag>}
      />
      <TaskFacts card={card}>{materials > 0 && ` · 素材 ${materials} 个`}</TaskFacts>
      {finals.length > 0 && (
        <ul aria-label="交出的成品" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {finals.map((file) => (
            <FileChip
              key={file.artifactId}
              file={previewOf(file, card.files)}
              onOpen={() => setPreview(previewOf(file, card.files))}
            />
          ))}
        </ul>
      )}
      <CardActions>
        <Link
          to="/canvas/runs/$runId"
          params={{ runId: card.runId }}
          search={{ conversation: actions.conversationId }}
          className="inline-flex h-10 items-center gap-1.5 rounded-full bg-glass-active px-4 text-[13.5px] text-ink no-underline shadow-edge-strong"
        >
          <Activity size={15} aria-hidden="true" />
          看进度
        </Link>
        {card.files.length > 0 && (
          <Link
            to="/canvas"
            search={{ conversation: actions.conversationId }}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
          >
            <Images size={15} aria-hidden="true" />
            在画布里看
          </Link>
        )}
        {running && actions.turnActive && (
          <CardButton onClick={() => void actions.stop()} disabled={actions.busy === 'stop'}>
            {actions.busy === 'stop' ? '正在停下…' : '停下'}
          </CardButton>
        )}
      </CardActions>
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </CardFrame>
  );
}
