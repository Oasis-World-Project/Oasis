// 一个任务的页面里的任务框（画布上点开一个任务）：框顶是任务名、状态、开始时间、用时、花费、做它的 AI，
// 可以看过程（在做时是看进度）、回到私聊、打包下载；框里分「成品」「素材」两排，素材小一号。
// 群里的任务（只有群主的画布里有）写着来自哪个群：看过程去群的工作台，回到群；做完的可以删掉。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Activity, Download, MessageCircle } from 'lucide-react';
import { ApiError } from '../api/client.ts';
import { deleteGroupTask, dmsQuery, taskArchiveUrl, tasksQuery } from '../api/queries.ts';
import { aiName, useModelMap } from '../api/use-model-map.ts';
import { ConfirmButton, StatusTag } from '../chat/parts.tsx';
import { elapsedText, TASK_STATUS } from '../chat/TaskCard.tsx';
import { aiLook } from '../group/people.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatCost } from '../ui/format.ts';
import { ArtifactCard } from './ArtifactCard.tsx';
import type { TaskGroup } from './task-groups.ts';

/** 做这个任务的 AI：头像字母、光色和名字 */
export interface Maker {
  mono: string;
  glow: string;
  name: string;
}

/** 做任务的 AI：任务所在私聊的 AI（名字用用户给它起的）；群里的任务是任务卡上写的那个 AI */
export function useMakerOf(): (group: TaskGroup) => Maker | undefined {
  const { data: dms = [] } = useQuery(dmsQuery);
  const models = useModelMap();
  return (group) => {
    const key = group.task?.group?.key;
    if (key) return aiLook(models, key);
    const dm = dms.find((d) => d.id === group.conversationId);
    const model = dm?.modelKey ? models.get(dm.modelKey) : undefined;
    return dm && model
      ? { mono: model.mono, glow: model.glow, name: aiName(models, dm) }
      : undefined;
  };
}

const button =
  'inline-flex h-9 items-center gap-1.5 rounded-full bg-glass-active px-3.5 text-[13px] text-ink no-underline shadow-edge-strong';
const label = 'm-0 text-[12.5px] font-medium text-ink-muted';

export const when = (at: number) =>
  new Date(at).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });

export function TaskPanel({ group, maker, now }: { group: TaskGroup; maker?: Maker; now: number }) {
  const { task } = group;
  const running = task?.status === 'running';
  const status = task ? TASK_STATUS[task.status] : undefined;
  const count = group.finals.length + group.materials.length;
  /** 群里的任务：哪个群 */
  const from = task?.group;
  const client = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation({
    mutationFn: () => deleteGroupTask(from!.id, group.runId),
    onSuccess: async () => {
      await Promise.all([
        client.invalidateQueries({ queryKey: tasksQuery.queryKey }),
        client.invalidateQueries({ queryKey: ['artifacts'] }),
      ]);
      await navigate({ to: '/canvas', search: {} });
    },
  });
  const processButton = running ? `${button} bg-accent text-on-accent` : button;
  const process = (
    <>
      <Activity size={14} aria-hidden="true" />
      {running ? '看进度' : '看过程'}
    </>
  );
  return (
    <section aria-label={group.title} className="glass flex flex-col gap-4 rounded-panel px-5 py-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <h2 className="m-0 truncate text-[17px] font-medium">{group.title}</h2>
          <p className="m-0 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-muted">
            {status && <StatusTag tone={status.tone}>{status.label}</StatusTag>}
            {task && <span>{when(Date.parse(task.startedAt))}</span>}
            {task && (
              <span>
                · 用时{' '}
                {elapsedText(
                  (task.finishedAt ? Date.parse(task.finishedAt) : now) -
                    Date.parse(task.startedAt),
                )}
              </span>
            )}
            {task && (
              <span>
                · 花费 <span className="font-display text-ink">{formatCost(task.spentMicro)}</span>
              </span>
            )}
            {maker && (
              <span className="inline-flex items-center gap-1.5">
                · <AiAvatar mono={maker.mono} glow={maker.glow} size={20} glowing={running} />
                <span>{maker.name}</span>
              </span>
            )}
            {from && <span>· 来自群：{from.title}</span>}
          </p>
          {remove.isError && (
            <p role="alert" className="m-0 text-[12.5px] text-accent">
              {remove.error instanceof ApiError ? remove.error.message : '没删掉，稍后再试。'}
            </p>
          )}
        </div>
        <span className="flex flex-wrap items-center gap-1.5">
          {from ? (
            <Link
              to="/groups/$groupId"
              params={{ groupId: from.id }}
              search={{ task: group.runId }}
              className={processButton}
            >
              {process}
            </Link>
          ) : (
            <Link
              to="/canvas/runs/$runId"
              params={{ runId: group.runId }}
              search={{ conversation: group.conversationId }}
              className={processButton}
            >
              {process}
            </Link>
          )}
          {from ? (
            <Link to="/groups/$groupId" params={{ groupId: from.id }} className={button}>
              <MessageCircle size={14} aria-hidden="true" />
              回到群
            </Link>
          ) : (
            <Link
              to="/dms/$conversationId"
              params={{ conversationId: group.conversationId }}
              className={button}
            >
              <MessageCircle size={14} aria-hidden="true" />
              回到私聊
            </Link>
          )}
          {count > 0 && (
            <a href={taskArchiveUrl(group.runId)} download className={button}>
              <Download size={14} aria-hidden="true" />
              打包下载
            </a>
          )}
          {from && !running && (
            <ConfirmButton
              label="删除"
              question="连它交的文件一起删？聊天记录留着"
              confirmLabel="删掉"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate()}
            />
          )}
        </span>
      </header>
      {group.finals.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <h3 className={label}>成品</h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4">
            {group.finals.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} />
            ))}
          </div>
        </div>
      )}
      {group.materials.length > 0 && (
        <div className="flex flex-col gap-2.5">
          <h3 className={label}>
            素材 <span className="font-display text-[12px]">{group.materials.length}</span>
          </h3>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
            {group.materials.map((artifact) => (
              <ArtifactCard key={artifact.id} artifact={artifact} compact />
            ))}
          </div>
        </div>
      )}
      {count === 0 && (
        <p className="m-0 text-[13px] text-ink-muted">
          {running ? '还在做，做好一个就放到这里。' : '这个任务没有留下成果。'}
        </p>
      )}
    </section>
  );
}
