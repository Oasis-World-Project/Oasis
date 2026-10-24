// 交付消息：做了什么、每样交付物的文件（点开预览、单独下载）、没完全满足的地方和过程中的提醒。
// 提醒消息：任务需要处理或没能完成；任务还在等处理时，直接在这里也能选。
import type {
  DeliveryCard as DeliveryData,
  NoticeCard as NoticeData,
} from '@oasis/contracts/conversation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Images } from 'lucide-react';
import { useState } from 'react';
import { taskFileUrl, taskQuery } from '../api/queries.ts';
import { formatCost } from '../ui/format.ts';
import { FileChip } from './FileChip.tsx';
import { FilePreview, type PreviewFile } from './FilePreview.tsx';
import { CardFrame, CardHeading, ItemList, StatusTag, type Speaker } from './parts.tsx';
import { TaskDecisions } from './TaskCard.tsx';

type DeliveredFile = DeliveryData['files'][number];

/** 按交付物分组，保持交付物第一次出现的顺序 */
function groupByDeliverable(files: DeliveredFile[]) {
  const groups = new Map<string, DeliveredFile[]>();
  for (const file of files)
    groups.set(file.deliverable, [...(groups.get(file.deliverable) ?? []), file]);
  return [...groups.entries()];
}

export function DeliveryCard({ card, speaker }: { card: DeliveryData; speaker: Speaker }) {
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const { data: task } = useQuery(taskQuery(card.taskId));
  const groups = groupByDeliverable(card.files);
  const toPreview = (file: DeliveredFile): PreviewFile => ({
    path: file.path,
    size: file.size,
    url: taskFileUrl(card.taskId, file.nodeId, file.path),
    downloadUrl: taskFileUrl(card.taskId, file.nodeId, file.path, true),
  });

  return (
    <CardFrame speaker={speaker} label={`交付：${card.title}`}>
      <CardHeading
        kind="交付"
        title={card.title}
        status={
          <StatusTag tone={card.unmet.length ? 'accent' : 'solid'}>
            {card.unmet.length ? '有几处没满足' : '已完成'}
          </StatusTag>
        }
      />
      {groups.length === 0 && <p className="m-0 text-sm text-ink-muted">这次没有交出文件。</p>}
      {groups.map(([deliverable, files]) => (
        <div key={deliverable} className="flex flex-col gap-1.5">
          <h4 className="m-0 text-[12.5px] font-medium text-ink-muted">{deliverable}</h4>
          <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
            {files.map((file) => (
              <FileChip
                key={`${file.nodeId}/${file.path}`}
                file={toPreview(file)}
                onOpen={() => setPreview(toPreview(file))}
              />
            ))}
          </ul>
        </div>
      ))}
      <ItemList title="没完全满足的地方" items={card.unmet} />
      {card.warnings.length > 0 && (
        <details className="rounded-item bg-glass-active/60 px-3.5 py-2.5">
          <summary className="cursor-pointer text-[13px] text-ink-muted">
            过程中的提醒（{card.warnings.length} 条）
          </summary>
          <div className="pt-2">
            <ItemList items={card.warnings} />
          </div>
        </details>
      )}
      {task && (
        <p className="m-0 text-[13px] text-ink-muted">
          一共花了 <span className="font-display text-ink">{formatCost(task.spentMicro)}</span>
        </p>
      )}
      {groups.length > 0 && (
        <Link
          to="/canvas"
          search={{ task: card.taskId }}
          className="inline-flex h-10 items-center gap-1.5 self-start rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
        >
          <Images size={15} aria-hidden="true" />
          在画布里看
        </Link>
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
    </CardFrame>
  );
}

export function NoticeCard({ card, speaker }: { card: NoticeData; speaker: Speaker }) {
  const { data: task } = useQuery(taskQuery(card.taskId));
  // 已经处理过了（任务不在等处理），这条提醒只留文字
  const pending = task?.status === 'needs_attention';
  return (
    <CardFrame
      speaker={speaker}
      label="任务提醒"
      dim={!pending && card.status === 'needs_attention'}
    >
      <CardHeading
        kind={card.status === 'failed' ? '任务没能完成' : '任务需要你处理'}
        title={task?.title}
        status={pending ? <StatusTag tone="accent">等你决定</StatusTag> : undefined}
      />
      {pending && task ? (
        <TaskDecisions task={task} />
      ) : (
        <p className="m-0 text-[14px] leading-relaxed">{card.message}</p>
      )}
    </CardFrame>
  );
}
