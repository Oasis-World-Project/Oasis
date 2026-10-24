// 画布里打开一个成果（外观照原型 ⑨⑩）：点阵底，左上返回 / 任务名 / 文件名，右上工作流、回到私聊、下载，
// 中间预览（图片、视频、音频、PDF、Markdown、文字、静态网页；其他格式提示下载）。批注和「发给 AI 修改」以后做。
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, Download, MessageCircle, Workflow } from 'lucide-react';
import { artifactContentUrl, artifactQuery } from '../api/queries.ts';
import { PreviewBody } from '../chat/FilePreview.tsx';
import { formatBytes } from '../ui/format.ts';

const route = getRouteApi('/shell/canvas/artifacts/$artifactId');

const pill =
  'inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-4 text-[13.5px] font-medium no-underline';

export function ArtifactPage() {
  const { artifactId } = route.useParams();
  const { data: artifact, isPending, isError } = useQuery(artifactQuery(artifactId));

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
                <h1 className="m-0 min-w-0 truncate text-[15px] font-medium">{artifact.name}</h1>
                <span className="shrink-0 text-[12px] text-ink-muted">
                  {formatBytes(artifact.size)}
                </span>
              </>
            )}
          </span>
        </div>
        {artifact && (
          <div className="flex flex-wrap items-center gap-1.5">
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
        {artifact && (
          <PreviewBody
            file={{
              path: artifact.path,
              size: artifact.size,
              url: artifactContentUrl(artifact.id),
              downloadUrl: artifactContentUrl(artifact.id, true),
            }}
          />
        )}
      </div>
      {artifact && (
        <p className="m-0 px-5 pb-3 text-[12px] text-ink-muted">
          交付物「{artifact.deliverable}」 · {new Date(artifact.createdAt).toLocaleString('zh-CN')}{' '}
          放进画布
        </p>
      )}
    </section>
  );
}
