// 画布上的一张成果卡片（照原型 ⑧）：缩略图（图片、视频直接显示，其他按类型画个示意）、名字、来自哪个任务、做它的 AI。
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { Link } from '@tanstack/react-router';
import { Box, Globe, Music, Play, Table } from 'lucide-react';
import { artifactContentUrl } from '../api/queries.ts';
import { badgeOf, previewKindOf } from '../chat/files.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { formatBytes } from '../ui/format.ts';
import type { useSpeakers } from '../workflow/use-speakers.ts';

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

export function ArtifactCard({
  artifact,
  speakers,
}: {
  artifact: ArtifactBody;
  speakers: ReturnType<typeof useSpeakers>;
}) {
  const who = artifact.models.map((m) => speakers.speakerOf(m));
  return (
    <article className="glass flex min-w-0 flex-col gap-3 rounded-[30px] p-2.5 pb-3.5">
      <Link
        to="/canvas/artifacts/$artifactId"
        params={{ artifactId: artifact.id }}
        aria-label={`打开 ${artifact.name}`}
        className="relative block h-[168px] overflow-hidden rounded-[22px] bg-glass-strong oasis-dots"
      >
        <Thumb artifact={artifact} />
      </Link>
      <div className="flex min-w-0 flex-col gap-0.5 px-2">
        <h3 className="m-0 truncate text-[14.5px] font-medium">{artifact.name}</h3>
        <span className="truncate text-[12px] text-ink-muted">
          {artifact.taskTitle} · {artifact.deliverable} · {formatBytes(artifact.size)}
        </span>
      </div>
      <div className="flex items-center gap-1.5 px-2">
        <span
          className="relative flex h-6"
          style={{ width: 24 + (Math.min(who.length, 4) - 1) * 20 }}
        >
          {who.slice(0, 4).map((s, i) => (
            <span key={`${s.name}-${i}`} className="absolute top-0" style={{ left: i * 20 }}>
              <AiAvatar mono={s.mono} glow={s.glow} size={24} />
            </span>
          ))}
        </span>
        <span className="truncate text-[12px] text-ink-muted">
          {who.map((s) => s.name).join('、')}
        </span>
      </div>
    </article>
  );
}
