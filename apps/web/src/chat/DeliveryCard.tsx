// 交付消息：做了什么、每样交付物的文件（点开预览、单独下载）、没完全满足的地方和过程中的提醒。
import type { DeliveryCard as DeliveryData } from '@oasis/contracts/conversation';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Images, MessageCircle, PencilLine } from 'lucide-react';
import { useState } from 'react';
import { AVATAR_SPEC_SUFFIX } from '@oasis/contracts/avatar';
import { artifactsQuery, taskFileUrl, taskQuery } from '../api/queries.ts';
import { RevisePanel } from '../canvas/RevisePanel.tsx';
import { formatCost } from '../ui/format.ts';
import { FileChip } from './FileChip.tsx';
import { FilePreview, type PreviewFile } from './FilePreview.tsx';
import {
  CardActions,
  CardButton,
  CardFrame,
  CardHeading,
  ItemList,
  StatusTag,
  type Speaker,
} from './parts.tsx';
import { RemovedNote } from './TaskCard.tsx';

type DeliveredFile = DeliveryData['files'][number];

/** 交付了数字人：显示形象和名字，直接去画布里和它对话（ADR 0013） */
function AvatarDeliveries({ taskId }: { taskId: string }) {
  // 交付消息可能比画布登记早一点到：没看到数字人就每 5 秒再取，最多一分钟
  const { data: artifacts = [] } = useQuery({
    ...artifactsQuery(taskId),
    refetchInterval: (query) =>
      query.state.data?.some((a) => a.avatar) || query.state.dataUpdateCount >= 12 ? false : 5000,
  });
  const avatars = artifacts.filter((a) => a.avatar);
  if (avatars.length === 0) return null;
  return (
    <ul className="m-0 flex list-none flex-col gap-2 p-0">
      {avatars.map((a) => (
        <li key={a.id} className="flex items-center gap-3 rounded-item bg-glass-active/60 p-2.5">
          {a.avatar?.avatarPreviewUrl ? (
            <img
              src={a.avatar.avatarPreviewUrl}
              alt=""
              className="size-14 shrink-0 rounded-item object-cover"
            />
          ) : null}
          <div className="min-w-0 flex-1">
            <p className="m-0 truncate text-sm font-medium">数字人「{a.avatar?.name}」</p>
            <p className="m-0 text-xs text-ink-muted">
              {a.avatar?.knowledge.length ?? 0} 条知识要点
              {a.avatar?.handoff ? '，会转人工' : ''}
            </p>
          </div>
          <Link
            to="/canvas/artifacts/$artifactId"
            params={{ artifactId: a.id }}
            className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-solid px-3.5 text-[13px] font-medium text-on-solid no-underline"
          >
            <MessageCircle size={15} aria-hidden="true" />
            和它对话
          </Link>
        </li>
      ))}
    </ul>
  );
}

/** 按交付物分组，保持交付物第一次出现的顺序 */
function groupByDeliverable(files: DeliveredFile[]) {
  const groups = new Map<string, DeliveredFile[]>();
  for (const file of files)
    groups.set(file.deliverable, [...(groups.get(file.deliverable) ?? []), file]);
  return [...groups.entries()];
}

export function DeliveryCard({ card, speaker }: { card: DeliveryData; speaker: Speaker }) {
  const [preview, setPreview] = useState<PreviewFile | null>(null);
  const [revising, setRevising] = useState(false);
  const { data: task } = useQuery({ ...taskQuery(card.taskId), enabled: !card.removed });
  const groups = groupByDeliverable(card.files);
  if (card.removed) {
    return (
      <CardFrame speaker={speaker} label={`交付：${card.title}`} dim>
        <CardHeading kind="交付" title={card.title} />
        <RemovedNote removed={card.removed} />
      </CardFrame>
    );
  }
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
          <StatusTag tone={card.unmet.length || card.unchecked?.length ? 'accent' : 'solid'}>
            {card.unmet.length
              ? '有几处没满足'
              : card.unchecked?.length
                ? '部分检查未完成'
                : '已交付'}
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
      {card.files.some((f) => f.path.endsWith(AVATAR_SPEC_SUFFIX)) && (
        <AvatarDeliveries taskId={card.taskId} />
      )}
      <ItemList title="没完全满足的地方" items={card.unmet} />
      <ItemList title="未完成的检查" items={card.unchecked ?? []} />
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
        <CardActions>
          <Link
            to="/canvas"
            search={{ task: card.taskId }}
            className="inline-flex h-10 items-center gap-1.5 rounded-full bg-solid px-4 text-[13.5px] font-medium text-on-solid no-underline"
          >
            <Images size={15} aria-hidden="true" />
            在画布里看
          </Link>
          {task?.status === 'succeeded' && (
            <CardButton onClick={() => setRevising(true)}>
              <PencilLine size={15} aria-hidden="true" />
              改一版
            </CardButton>
          )}
        </CardActions>
      )}
      {preview && <FilePreview file={preview} onClose={() => setPreview(null)} />}
      {revising && (
        <RevisePanel
          taskId={card.taskId}
          taskTitle={card.title}
          onClose={() => setRevising(false)}
        />
      )}
    </CardFrame>
  );
}
