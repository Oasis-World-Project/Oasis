// 画布里打开一个成果（外观照原型 ⑨⑩）：点阵底，左上返回 / 任务名 / 文件名，右上工作流、回到私聊、下载，
// 中间预览（图片、视频、音频、PDF、Markdown、文字、静态网页；其他格式提示下载）。批注和「发给 AI 修改」以后做。
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, Download, MessageCircle, Workflow } from 'lucide-react';
import {
  artifactContentUrl,
  artifactQuery,
  artifactsQuery,
  taskArchiveUrl,
} from '../api/queries.ts';
import { PreviewBody } from '../chat/FilePreview.tsx';
import { PreviewPlayer } from '../canvas/PreviewPlayer.tsx';
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
  const position = siblings.findIndex((item) => item.id === artifactId);
  const candidates = artifact
    ? siblings.filter(
        (item) =>
          item.path === artifact.path.replace(/\.pptx?$/i, '.pdf') &&
          item.taskId === artifact.taskId &&
          (!artifact.nodeId || item.nodeId === artifact.nodeId),
      )
    : [];
  const pdf = candidates.length === 1 ? candidates[0] : undefined;
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
            <a
              href={artifactContentUrl(artifact.id, true)}
              download={artifact.name}
              className={`${pill} bg-solid text-on-solid`}
            >
              <Download size={15} aria-hidden="true" />
              下载
            </a>
          </div>
        )}
      </div>

      <div className="mx-4 mb-4 min-h-0 flex-1 overflow-auto rounded-card bg-glass-active shadow-edge-strong">
        {isPending && <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>}
        {isError && <p className="m-0 p-6 text-sm text-accent">没找到这个成果。</p>}
        {artifact &&
          (artifact.application ? (
            <PreviewPlayer artifactId={artifact.id} />
          ) : (
            <PreviewBody
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
