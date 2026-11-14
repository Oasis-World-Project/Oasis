// 任务卡：调用了生图、视频、配音这类工具，或交了文件的那一轮。进行中显示用时和花费（跟着消息每秒刷新），
// 可以停下；结束后写上结果、用时、花费和交出的成品，成品点开预览，也可以去画布看这个对话的全部成果。
import type { TaskCard as TaskData, TaskFile } from '@oasis/contracts/conversation';
import { Link } from '@tanstack/react-router';
import { Images } from 'lucide-react';
import { useEffect, useState } from 'react';
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
import { useChatActions } from './use-chat-actions.ts';

const STATUS: Record<TaskData['status'], { label: string; tone: 'muted' | 'accent' | 'solid' }> = {
  running: { label: '进行中', tone: 'accent' },
  done: { label: '已完成', tone: 'solid' },
  stopped: { label: '已停下', tone: 'muted' },
  failed: { label: '出错了', tone: 'accent' },
};

/** 用时：几小时几分、几分几秒 */
function elapsedText(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  if (minutes >= 60) return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
  return minutes ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

/** 进行中每秒走一次 */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);
  return now;
}

/** 预览一个成品；Word、PPT 用同一轮交出的同名 PDF 预览 */
const previewOf = (file: TaskFile, files: TaskFile[]): PreviewFile => {
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

export function TaskCard({ card, speaker }: { card: TaskData; speaker: Speaker }) {
  const actions = useChatActions();
  const running = card.status === 'running';
  const now = useNow(running);
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const ended = card.finishedAt ? Date.parse(card.finishedAt) : now;
  const status = STATUS[card.status];

  return (
    <CardFrame speaker={speaker} label="任务" glowing={running}>
      <CardHeading kind="任务" status={<StatusTag tone={status.tone}>{status.label}</StatusTag>} />
      <p className="m-0 text-[13px] text-ink-muted">
        用时 <span className="text-ink">{elapsedText(ended - Date.parse(card.startedAt))}</span> ·
        花费 <span className="font-display text-ink">{formatCost(card.spentMicro)}</span>
      </p>
      {card.files.length > 0 && (
        <ul aria-label="交出的成品" className="m-0 flex list-none flex-col gap-1.5 p-0">
          {card.files.map((file) => (
            <FileChip
              key={file.artifactId}
              file={previewOf(file, card.files)}
              onOpen={() => setPreview(previewOf(file, card.files))}
            />
          ))}
        </ul>
      )}
      {(card.files.length > 0 || running) && (
        <CardActions>
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
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </CardFrame>
  );
}
