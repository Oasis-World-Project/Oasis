// 画布里打开一个成果（外观照原型 ⑨⑩）：点阵底，左上返回 / 任务名 / 文件名，右上工作流、回到私聊、下载，
// 中间预览（图片、视频、音频、PDF、Markdown、文字、静态网页；其他格式提示下载）。
// 「发给 AI 修改」做出新版整体替换这一版，「删除」连同工作流一起删；底部「标注」圈画写批注，「批准」打记号（ADR 0012）。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, BadgeCheck, Download, MessageCircle, PencilLine, Workflow } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import {
  artifactContentUrl,
  artifactQuery,
  artifactsQuery,
  deleteTask,
  setApproval,
  SETTLED_STATUSES,
  taskArchiveUrl,
  tasksQuery,
} from '../api/queries.ts';
import type { RevisionParameter } from '@oasis/contracts/conversation';
import { ConfirmButton } from '../chat/parts.tsx';
import { ArtifactReview } from '../canvas/ArtifactReview.tsx';
import { PreviewPlayer } from '../canvas/PreviewPlayer.tsx';
import { RevisePanel } from '../canvas/RevisePanel.tsx';
import { pdfCompanion } from '../canvas/snapshots.ts';
import { formatBytes } from '../ui/format.ts';

const route = getRouteApi('/shell/canvas/artifacts/$artifactId');

const pill =
  'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium no-underline';

export function ArtifactPage() {
  const { artifactId } = route.useParams();
  const { data: artifact, isPending, isError } = useQuery(artifactQuery(artifactId));
  const { data: siblings = [] } = useQuery({
    ...artifactsQuery(artifact?.taskId),
    enabled: !!artifact,
  });
  const { data: tasks = [] } = useQuery(tasksQuery);
  // 这份成果正在修改：新版没结束之前不能再改、不能删
  const revising = artifact
    ? tasks.find((t) => t.revisionOf === artifact.taskId && !SETTLED_STATUSES.has(t.status))
    : undefined;
  const [reviseOpen, setReviseOpen] = useState(false);
  /** 从参数面板来的修改：参数随对话框一起发 */
  const [parameters, setParameters] = useState<RevisionParameter[]>([]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: (taskId: string) => deleteTask(taskId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
        queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey }),
      ]);
      await navigate({ to: '/canvas' });
    },
  });
  const position = siblings.findIndex((item) => item.id === artifactId);
  const pdf = artifact ? pdfCompanion(artifact, siblings) : undefined;
  const approve = useMutation({
    mutationFn: (approved: boolean) => setApproval(artifactId, approved),
    onSuccess: (body) => {
      queryClient.setQueryData(artifactQuery(artifactId).queryKey, body);
      void queryClient.invalidateQueries({ queryKey: ['artifacts'] });
    },
  });
  const appFiles = artifact?.application
    ? siblings.filter(
        (item) =>
          item.taskId === artifact.taskId &&
          item.nodeId === artifact.nodeId &&
          item.path.startsWith(`${artifact.application!.root}/`) &&
          item.id !== artifact.id,
      )
    : [];

  return (
    <section
      aria-label="成果"
      className="oasis-dots relative flex h-[calc(100vh-44px)] min-h-[560px] flex-col overflow-hidden rounded-panel bg-glass-strong shadow-[var(--oasis-glass-edge),var(--oasis-shadow-panel)]"
    >
      <div className="flex flex-wrap items-center gap-2 p-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <span className="flex min-w-0 items-center gap-2.5 rounded-full bg-glass-active py-1.5 pl-1.5 pr-4 shadow-edge-strong backdrop-blur-xl">
            <Link
              to="/canvas"
              aria-label="回到画布"
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-track text-ink"
            >
              <ArrowLeft size={16} aria-hidden="true" />
            </Link>
            {artifact && (
              <>
                <Link
                  to="/canvas"
                  search={{ task: artifact.taskId }}
                  className="min-w-0 truncate text-[13.5px] text-ink-muted no-underline hover:text-ink"
                >
                  {artifact.taskTitle}
                </Link>
                <span aria-hidden="true" className="text-ink-muted">
                  /
                </span>
                <h1 className="m-0 min-w-0 truncate text-[15px] font-medium">
                  {artifact.application ? artifact.application.root : artifact.name}
                </h1>
                <span className="shrink-0 text-[12px] text-ink-muted">
                  {formatBytes(artifact.size)}
                </span>
              </>
            )}
          </span>
        </div>
        {artifact && (
          <div className="flex flex-wrap items-center gap-1.5">
            {[-1, 1].map((offset) => {
              const sibling = position >= 0 ? siblings[position + offset] : undefined;
              return sibling ? (
                <Link
                  key={offset}
                  to="/canvas/artifacts/$artifactId"
                  params={{ artifactId: sibling.id }}
                  className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
                >
                  {offset < 0 ? '上一个' : '下一个'}
                </Link>
              ) : null;
            })}
            <a
              href={taskArchiveUrl(artifact.taskId)}
              download
              className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
            >
              打包下载
            </a>
            <Link
              to="/canvas/tasks/$taskId"
              params={{ taskId: artifact.taskId }}
              className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
            >
              <Workflow size={15} aria-hidden="true" />
              工作流
            </Link>
            {artifact.conversationId && (
              <Link
                to="/dms/$conversationId"
                params={{ conversationId: artifact.conversationId }}
                className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
              >
                <MessageCircle size={15} aria-hidden="true" />
                回到私聊
              </Link>
            )}
            <button
              type="button"
              aria-pressed={artifact.approvedAt !== null}
              onClick={() => approve.mutate(artifact.approvedAt === null)}
              disabled={approve.isPending}
              className={`${pill} border-0 ${artifact.approvedAt ? 'bg-solid text-on-solid' : 'bg-glass-active text-ink shadow-edge-strong'}`}
            >
              <BadgeCheck size={15} aria-hidden="true" />
              {artifact.approvedAt ? '已批准' : '批准'}
            </button>
            <a
              href={artifactContentUrl(artifact.id, true)}
              download={artifact.name}
              className={`${pill} bg-solid text-on-solid`}
            >
              <Download size={15} aria-hidden="true" />
              下载
            </a>
            {revising ? (
              <Link
                to="/canvas/tasks/$taskId"
                params={{ taskId: revising.id }}
                className={`${pill} bg-glass-active text-ink shadow-edge-strong`}
              >
                正在修改中…
              </Link>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => {
                    setParameters([]);
                    setReviseOpen(true);
                  }}
                  className={`${pill} border-0 bg-accent text-on-accent`}
                >
                  <PencilLine size={15} aria-hidden="true" />
                  发给 AI 修改
                </button>
                <ConfirmButton
                  label="删除"
                  question="连同工作流一起删，不能恢复，确定吗？"
                  confirmLabel="删除"
                  onConfirm={() => remove.mutate(artifact.taskId)}
                  disabled={remove.isPending}
                />
              </>
            )}
          </div>
        )}
      </div>
      {remove.isError && (
        <p role="alert" className="m-0 px-5 pb-2 text-[13px] text-accent">
          {remove.error instanceof ApiError ? remove.error.message : '没删掉，请重试'}
        </p>
      )}
      {artifact && reviseOpen && (
        <RevisePanel
          taskId={artifact.taskId}
          taskTitle={artifact.taskTitle}
          conversationId={artifact.conversationId}
          parameters={parameters}
          onClose={() => setReviseOpen(false)}
        />
      )}

      <div className="mx-4 mb-4 flex min-h-0 flex-1 flex-col">
        {isPending && <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>}
        {isError && <p className="m-0 p-6 text-sm text-accent">没找到这个成果。</p>}
        {artifact &&
          (artifact.application ? (
            <div className="min-h-0 flex-1 overflow-auto rounded-card bg-glass-active shadow-edge-strong">
              <PreviewPlayer artifactId={artifact.id} />
            </div>
          ) : (
            <ArtifactReview
              key={artifact.id}
              artifact={artifact}
              // 正在修改时不能再发起修改，参数面板也就不给
              {...(revising
                ? {}
                : {
                    onRevise: (next: RevisionParameter[]) => {
                      setParameters(next);
                      setReviseOpen(true);
                    },
                  })}
              file={{
                path: artifact.path,
                size: artifact.size,
                url: artifactContentUrl(artifact.id),
                downloadUrl: artifactContentUrl(artifact.id, true),
                modelPreview: !!artifact.modelPreview,
                ...(pdf ? { pdfUrl: artifactContentUrl(pdf.id) } : {}),
              }}
            />
          ))}
      </div>
      {appFiles.length > 0 && (
        <details className="mx-4 mb-3 rounded-card bg-glass-active px-4 py-2 text-sm">
          <summary className="cursor-pointer">查看应用文件（{appFiles.length + 1} 个）</summary>
          <ul className="max-h-48 overflow-auto pl-5">
            {appFiles.map((file) => (
              <li key={file.id}>
                <Link
                  to="/canvas/artifacts/$artifactId"
                  params={{ artifactId: file.id }}
                  className="text-ink"
                >
                  {file.path}
                </Link>
              </li>
            ))}
          </ul>
        </details>
      )}
      {artifact && (
        <p className="m-0 px-5 pb-3 text-[12px] text-ink-muted">
          交付物「{artifact.deliverable}」 · {new Date(artifact.createdAt).toLocaleString('zh-CN')}{' '}
          放进画布
        </p>
      )}
    </section>
  );
}
