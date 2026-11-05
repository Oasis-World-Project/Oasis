// 画布里打开一个成果（外观照原型 ⑨⑩）：点阵底；顶栏只有返回、批注、下载三个图标（2026-11-04 精简）。
// 中间预览（图片、视频、音频、PDF、Markdown、文字、网页；其他格式提示下载）。网页和静态应用在本机隔离框里直接运行（ADR 0009 §17），
// 带后端的应用走平台容器预览。批注面板里「发给 AI 团队修改」，直接交给 AI 团队在原任务里接着改（ADR 0012）。
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowLeft, Download, LoaderCircle, PencilLine, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import {
  artifactContentUrl,
  artifactQuery,
  artifactsQuery,
  SETTLED_STATUSES,
  taskArchiveUrl,
  tasksQuery,
} from '../api/queries.ts';
import type { RevisionParameter } from '@oasis/contracts/task';
import { ArtifactReview } from '../canvas/ArtifactReview.tsx';
import { AvatarPreview } from '../canvas/AvatarPreview.tsx';
import { ParameterPanel } from '../canvas/ParameterPanel.tsx';
import { AVATAR_FIELDS, type Values } from '../canvas/parameters.ts';
import { LivePreview } from '../canvas/LivePreview.tsx';
import { PreviewPlayer } from '../canvas/PreviewPlayer.tsx';
import { RevisePanel } from '../canvas/RevisePanel.tsx';
import { pdfCompanion } from '../canvas/snapshots.ts';

const route = getRouteApi('/shell/canvas/artifacts/$artifactId');

/** 顶栏的圆形图标按钮：不带字，悬停时显示说明 */
const icon =
  'flex size-10 items-center justify-center rounded-full bg-glass-active text-ink no-underline shadow-edge-strong';

export function ArtifactPage() {
  const { artifactId } = route.useParams();
  const { data: artifact, isPending, isError } = useQuery(artifactQuery(artifactId));
  const { data: siblings = [] } = useQuery({
    ...artifactsQuery(artifact?.taskId),
    enabled: !!artifact,
  });
  const { data: tasks = [] } = useQuery(tasksQuery);
  // 这份成果正在修改：原任务又跑起来了（ADR 0012，在原任务里接着改），或旧式修订任务还没结束；改完之前不能再改
  const ownTask = artifact ? tasks.find((t) => t.id === artifact.taskId) : undefined;
  const revising = artifact
    ? (tasks.find((t) => t.revisionOf === artifact.taskId && !SETTLED_STATUSES.has(t.status)) ??
      (ownTask && !SETTLED_STATUSES.has(ownTask.status) ? ownTask : undefined))
    : undefined;
  const [reviseOpen, setReviseOpen] = useState(false);
  /** 从参数面板来的修改：参数随对话框一起发 */
  const [parameters, setParameters] = useState<RevisionParameter[]>([]);
  // 数字人的参数面板（ADR 0013）
  const [avatarParams, setAvatarParams] = useState(false);
  const [avatarValues, setAvatarValues] = useState<Values>({});
  /** 静态应用在本机框里加载不全时，用户可改用平台容器预览 */
  const [containerFor, setContainerFor] = useState<string | null>(null);
  const container = containerFor === artifactId;
  const pdf = artifact ? pdfCompanion(artifact, siblings) : undefined;
  /** 顶栏的批注开关；换一个成果时自动关掉 */
  const [annotatingFor, setAnnotatingFor] = useState<string | null>(null);
  const annotating = annotatingFor === artifactId;
  const setAnnotating = (on: boolean) => setAnnotatingFor(on ? artifactId : null);
  // 数字人是实时对话，不批注；其余成果（含运行中的网页和应用）都能批注
  const canAnnotate = !!artifact && !artifact.avatar;
  const appFiles = artifact?.application
    ? siblings.filter(
        (item) =>
          item.taskId === artifact.taskId &&
          item.nodeId === artifact.nodeId &&
          item.path.startsWith(`${artifact.application!.root}/`) &&
          item.id !== artifact.id,
      )
    : [];

  // 同一节点交出的文件：网页按相对地址引用它们（图片、脚本、样式等）
  const nodeFiles = artifact
    ? siblings.filter((item) => item.taskId === artifact.taskId && item.nodeId === artifact.nodeId)
    : [];
  const assets = nodeFiles.map((item) => ({ path: item.path, url: artifactContentUrl(item.id) }));
  const staticApp = artifact?.application?.kind === 'static' ? artifact.application : undefined;
  const appEntry = staticApp
    ? nodeFiles.find((item) => item.path === `${staticApp.root}/${staticApp.entry}`)
    : undefined;
  // 单独打开静态应用里的网页时，以 / 开头的地址仍按应用根目录算
  const pageRoot = nodeFiles.find(
    (item) =>
      item.application?.kind === 'static' && artifact?.path.startsWith(`${item.application.root}/`),
  )?.application?.root;

  return (
    <section
      aria-label="成果"
      className="oasis-dots relative flex h-[calc(100vh-44px)] min-h-[560px] flex-col overflow-hidden rounded-panel bg-glass-strong shadow-[var(--oasis-glass-edge),var(--oasis-shadow-panel)]"
    >
      <div className="flex items-center gap-2 p-4">
        <div className="flex min-w-0 flex-1 items-center gap-2.5">
          <Link to="/canvas" aria-label="回到画布" title="回到画布" className={`${icon} shrink-0`}>
            <ArrowLeft size={17} aria-hidden="true" />
          </Link>
          {artifact && (
            <h1 className="m-0 min-w-0 truncate text-[15px] font-medium">
              {artifact.taskTitle}
              <span className="ml-2 text-[13px] font-normal text-ink-muted">
                {artifact.application ? artifact.application.root : artifact.name}
              </span>
            </h1>
          )}
        </div>
        {artifact && (
          <div className="flex shrink-0 items-center gap-2">
            {revising ? (
              <Link
                to="/canvas/tasks/$taskId"
                params={{ taskId: revising.id }}
                aria-label="正在修改，看进度"
                title="正在修改，点开看进度"
                className={icon}
              >
                <LoaderCircle size={17} aria-hidden="true" className="animate-spin" />
              </Link>
            ) : (
              canAnnotate && (
                <button
                  type="button"
                  aria-label="批注"
                  title="批注"
                  aria-pressed={annotating}
                  onClick={() => setAnnotating(!annotating)}
                  className={`${icon} border-0 ${annotating ? 'bg-accent text-on-accent' : ''}`}
                >
                  <PencilLine size={17} aria-hidden="true" />
                </button>
              )
            )}
            <a
              href={
                artifact.application
                  ? taskArchiveUrl(artifact.taskId)
                  : artifactContentUrl(artifact.id, true)
              }
              download={artifact.application ? true : artifact.name}
              aria-label="下载"
              title={artifact.application ? '下载整个应用' : '下载'}
              className={`${icon} bg-solid text-on-solid`}
            >
              <Download size={17} aria-hidden="true" />
            </a>
          </div>
        )}
      </div>
      {artifact && reviseOpen && (
        <RevisePanel
          taskId={artifact.taskId}
          taskTitle={artifact.taskTitle}
          parameters={parameters}
          onClose={() => setReviseOpen(false)}
        />
      )}

      <div className="mx-4 mb-4 flex min-h-0 flex-1 flex-col">
        {isPending && <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>}
        {isError && <p className="m-0 p-6 text-sm text-accent">没找到这个成果。</p>}
        {artifact &&
          (artifact.avatar ? (
            <div className="flex min-h-0 flex-1 gap-3">
              <div className="relative min-h-0 flex-1 overflow-auto rounded-card bg-glass-active shadow-edge-strong">
                {!revising && !avatarParams && (
                  <button
                    type="button"
                    onClick={() => setAvatarParams(true)}
                    className="absolute right-4 top-4 z-10 inline-flex h-9 items-center gap-1.5 rounded-full bg-glass-active px-3.5 text-[13px] shadow-edge-strong"
                  >
                    <SlidersHorizontal size={15} aria-hidden="true" />
                    参数
                  </button>
                )}
                <AvatarPreview artifactId={artifact.id} spec={artifact.avatar} />
              </div>
              {avatarParams && !revising && (
                <ParameterPanel
                  file={artifact.name}
                  fields={AVATAR_FIELDS}
                  values={avatarValues}
                  onChange={setAvatarValues}
                  onRevise={(next) => {
                    setParameters(next);
                    setAvatarParams(false);
                    setReviseOpen(true);
                  }}
                  onClose={() => setAvatarParams(false)}
                  previewable={[]}
                />
              )}
            </div>
          ) : (
            <ArtifactReview
              key={artifact.id}
              artifact={artifact}
              annotating={annotating && !revising}
              onAnnotating={setAnnotating}
              {...(artifact.application
                ? {
                    live:
                      appEntry && staticApp && !container ? (
                        <LivePreview
                          key={appEntry.id}
                          file={{ path: appEntry.path, url: artifactContentUrl(appEntry.id) }}
                          name={staticApp.root}
                          root={staticApp.root}
                          assets={assets}
                          onFallback={() => setContainerFor(artifactId)}
                        />
                      ) : (
                        <PreviewPlayer artifactId={artifact.id} />
                      ),
                  }
                : {})}
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
                assets,
                ...(pageRoot ? { root: pageRoot } : {}),
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
