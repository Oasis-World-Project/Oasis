// 画布上的一张成果卡片（照原型 ⑧）：缩略图（图片、视频直接显示，其他按类型画个示意）、名字、大小和日期。
// 放在任务框里（做它的 AI 写在任务框上）；素材用小一号的。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { Link } from '@tanstack/react-router';
import { Box, Globe, Music, Play, Table, UserRound } from 'lucide-react';
import { useState } from 'react';
import { artifactContentUrl } from '../api/queries.ts';
import { badgeOf, previewKindOf } from '../chat/files.ts';
import { formatBytes } from '../ui/format.ts';

/** 一页纸：标题线 + 几行字（文档、PDF、文字） */
function Paper({ label }: { label: string }) {
  return (
    <span className="absolute left-[22%] top-[14%] flex h-full w-[56%] flex-col gap-[7px] rounded-xl bg-glass-active p-4 shadow-raised">
      <span className="flex items-center gap-2">
        <span className="h-[7px] flex-1 rounded bg-ink" />
        <span className="font-display text-[9px] font-medium text-ink-muted">{label}</span>
      </span>
      {[100, 92, 96, 60, 88].map((w) => (
        <span key={w} className="h-1 rounded bg-track" style={{ width: `${w}%` }} />
      ))}
    </span>
  );
}

function Thumb({ artifact }: { artifact: ArtifactBody }) {
  const [posterFailed, setPosterFailed] = useState(false);
  if (artifact.modelPreview?.posterId && !posterFailed)
    return (
      <img
        src={`/api/canvas/v1/artifacts/${artifact.id}/model-poster`}
        alt=""
        loading="lazy"
        onError={() => setPosterFailed(true)}
        className="size-full object-cover"
      />
    );
  if (artifact.avatar)
    return artifact.avatar.avatarPreviewUrl && !posterFailed ? (
      <img
        src={artifact.avatar.avatarPreviewUrl}
        alt=""
        loading="lazy"
        onError={() => setPosterFailed(true)}
        className="size-full object-cover"
      />
    ) : (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
        <UserRound size={34} aria-hidden="true" />
        <span className="text-xs">数字人</span>
      </span>
    );
  if (artifact.application)
    return (
      <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
        <Globe size={34} aria-hidden="true" />
        <span className="text-xs">可运行应用</span>
      </span>
    );
  const url = artifactContentUrl(artifact.id);
  const kind = previewKindOf(artifact.path);
  if (kind === 'image') {
    return <img src={url} alt="" loading="lazy" className="size-full object-cover" />;
  }
  if (kind === 'video') {
    return (
      <>
        {/* #t=0.1：只取第一帧当封面 */}
        <video
          src={`${url}#t=0.1`}
          preload="metadata"
          muted
          playsInline
          className="size-full object-cover"
        />
        <span className="absolute left-1/2 top-1/2 flex size-12 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-glass-strong text-ink backdrop-blur-md">
          <Play size={18} aria-hidden="true" />
        </span>
      </>
    );
  }
  if (kind === 'audio') {
    return (
      <span className="absolute inset-x-6 inset-y-8 flex items-center gap-[3px]">
        <Music size={20} aria-hidden="true" className="mr-2 shrink-0 text-ink-muted" />
        {[30, 55, 80, 45, 95, 60, 35, 70, 50, 85, 40, 65, 30, 75, 55, 45, 90, 35].map((h, i) => (
          <span key={i} className="flex-1 rounded-full bg-accent/70" style={{ height: `${h}%` }} />
        ))}
      </span>
    );
  }
  if (kind === 'page') {
    return (
      <span className="absolute inset-x-[12%] top-[16%] flex h-full flex-col overflow-hidden rounded-xl bg-glass-active shadow-raised">
        <span className="flex h-6 items-center gap-1 bg-track px-2.5">
          {[0, 1, 2].map((i) => (
            <span key={i} className="size-1.5 rounded-full bg-ink-muted/40" />
          ))}
        </span>
        <span className="flex flex-1 items-center justify-center text-ink-muted">
          <Globe size={28} aria-hidden="true" />
        </span>
      </span>
    );
  }
  if (kind === 'text' || kind === 'pdf' || artifact.category === 'doc') {
    return <Paper label={badgeOf(artifact.path)} />;
  }
  const Icon = artifact.category === 'threed' ? Box : Table;
  return (
    <span className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-ink-muted">
      <Icon size={32} aria-hidden="true" />
      <span className="font-display text-[11px] font-medium">{badgeOf(artifact.path)}</span>
    </span>
  );
}

/** compact：小一号（任务框里的素材） */
export function ArtifactCard({
  artifact,
  compact = false,
}: {
  artifact: ArtifactBody;
  compact?: boolean;
}) {
  return (
    <article
      className={`glass flex min-w-0 flex-col ${
        compact ? 'gap-2 rounded-[22px] p-2 pb-2.5' : 'gap-3 rounded-[30px] p-2.5 pb-3.5'
      }`}
    >
      <Link
        to="/canvas/artifacts/$artifactId"
        params={{ artifactId: artifact.id }}
        aria-label={`打开 ${artifact.application ? artifact.application.root : artifact.name}`}
        className={`relative block overflow-hidden bg-glass-strong oasis-dots ${
          compact ? 'h-[112px] rounded-[16px]' : 'h-[168px] rounded-[22px]'
        }`}
      >
        <Thumb artifact={artifact} />
        {artifact.annotations.length > 0 && (
          <span className="absolute right-2 top-2 rounded-full bg-accent px-2 py-0.5 text-[11px] font-medium text-on-accent">
            批注 {artifact.annotations.length}
          </span>
        )}
      </Link>
      <div className={`flex min-w-0 flex-col gap-0.5 ${compact ? 'px-1' : 'px-2'}`}>
        <h3 className={`m-0 truncate font-medium ${compact ? 'text-[12.5px]' : 'text-[14.5px]'}`}>
          {artifact.application ? artifact.application.root : artifact.name}
        </h3>
        <span className={`truncate text-ink-muted ${compact ? 'text-[11px]' : 'text-[12px]'}`}>
          {formatBytes(artifact.size)} · {new Date(artifact.createdAt).toLocaleDateString('zh-CN')}
        </span>
      </div>
    </article>
  );
}
