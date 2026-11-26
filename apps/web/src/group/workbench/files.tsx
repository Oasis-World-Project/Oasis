// 群文件在界面上几处都要用的东西：是谁做的（头像、名字）、卡片上的那句话、预览用的地址、
// 聊天里的文件胶囊。
import type { FileAuthor, GroupFile, GroupSnapshot } from '@oasis/contracts/group';
import { useEffect, useState } from 'react';
import { artifactContentUrl, groupFileUrl } from '../../api/queries.ts';
import { badgeOf, baseName } from '../../chat/files.ts';
import type { PreviewFile } from '../../chat/files.ts';
import { AiAvatar } from '../../ui/Avatar.tsx';
import { MemberAvatar } from '../Members.tsx';
import { aiLook, runsOf } from '../people.ts';
import { useRoom, type Room } from '../room.ts';

function authorName(room: Pick<Room, 'group' | 'models'>, author: FileAuthor): string {
  if (author.kind === 'ai') return aiLook(room.models, author.id).name;
  return room.group.members.find((m) => m.userId === author.id)?.displayName ?? '已退群的成员';
}

/** 文件是谁的：AI 是它的头像（正在改时身后发光），人是他的头像 */
export function AuthorAvatar({
  author,
  size,
  glowing = false,
}: {
  author: FileAuthor;
  size: number;
  glowing?: boolean;
}) {
  const { group, models } = useRoom();
  if (author.kind === 'ai') {
    const look = aiLook(models, author.id);
    return <AiAvatar mono={look.mono} glow={look.glow} size={size} glowing={glowing} />;
  }
  const member = group.members.find((m) => m.userId === author.id);
  return (
    <MemberAvatar
      member={{
        userId: author.id,
        displayName: member?.displayName ?? '成员',
        avatarVersion: member?.avatarVersion ?? 0,
      }}
      size={size}
    />
  );
}

/** 现在的时间，每半分钟走一次：「5 分钟前」这类字跟着变 */
export function useClock(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/** 多久以前：刚刚、5 分钟前、3 小时前、昨天、11月3日 */
function agoText(at: string, now: number): string {
  const date = new Date(at);
  const minutes = Math.floor((now - date.getTime()) / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} 小时前`;
  if (minutes < 48 * 60) return '昨天';
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

/** 这个文件现在是不是有 AI 正在改：交出这一版的那一轮还没结束 */
export const beingChanged = (room: Pick<Room, 'group'>, file: GroupFile) =>
  file.runId !== null &&
  room.group.ais.some((ai) => runsOf(ai).some((run) => run.runId === file.runId));

/** 文件卡片上的那句话：谁正在改；谁做的、谁改过；谁传的、多久以前 */
export function fileNote(room: Pick<Room, 'group' | 'models'>, file: GroupFile, now: number) {
  const made = authorName(room, file.madeBy);
  const changed = authorName(room, file.changedBy);
  if (beingChanged(room, file)) return `${changed} 正在改`;
  const origin = file.madeBy.kind === 'ai' ? `${made} 做的` : `${made} 传的`;
  const same = file.madeBy.kind === file.changedBy.kind && file.madeBy.id === file.changedBy.id;
  return same ? `${origin}，${agoText(file.updatedAt, now)}` : `${origin}，${changed} 改过`;
}

/**
 * 预览工作台里的一个文件：网页带上同一目录下它可能引用的文件；Word、PPT 用同名的 PDF 预览。
 * 群里读群文件；和 AI 的私聊里是任务交的成果，读画布里的那一份。
 */
export function previewOf(
  group: Pick<GroupSnapshot, 'id' | 'kind'>,
  file: GroupFile,
  files: GroupFile[],
): PreviewFile {
  const urlOf = (item: GroupFile, download?: boolean) =>
    group.kind === 'dm'
      ? artifactContentUrl(item.id, download)
      : groupFileUrl(group.id, item, download);
  const dir = file.path.slice(0, file.path.lastIndexOf('/') + 1);
  const pdf = /\.(pptx?|docx?)$/i.test(file.path)
    ? files.find((f) => f.path === file.path.replace(/\.(pptx?|docx?)$/i, '.pdf'))
    : undefined;
  return {
    path: file.path,
    size: file.size,
    url: urlOf(file),
    downloadUrl: urlOf(file, true),
    ...(pdf ? { pdfUrl: urlOf(pdf) } : {}),
    ...(/\.html?$/i.test(file.path)
      ? {
          assets: files
            .filter((f) => f.id !== file.id && f.path.startsWith(dir))
            .map((f) => ({ path: f.path, url: urlOf(f) })),
        }
      : {}),
  };
}

/** 文件胶囊（聊天里话带的文件、任务交的成果）：格式标记加文件名，点开在工作台预览；已经不在了的点不了。照原型 ② */
export function FilePill({ path, name }: { path: string; name?: string }) {
  const { bench } = useRoom();
  const file = bench.files.find((item) => item.path === path);
  const label = name ?? baseName(path);
  return (
    <button
      type="button"
      disabled={!file}
      title={file ? undefined : '这个文件已经不在了'}
      aria-label={file ? `在工作台打开 ${label}` : `${label}（已经不在了）`}
      onClick={() => bench.openFile(path)}
      className="flex h-[42px] max-w-full cursor-pointer items-center gap-2.5 self-start rounded-full border-0 bg-glass-active py-0 pl-1.5 pr-4 text-ink shadow-edge-strong disabled:cursor-not-allowed disabled:opacity-55"
    >
      <span
        aria-hidden="true"
        className="flex size-[30px] shrink-0 items-center justify-center rounded-full bg-solid font-display text-[9px] font-medium text-on-solid"
      >
        {badgeOf(path)}
      </span>
      <span className="min-w-0 truncate text-[13.5px] font-medium">{label}</span>
    </button>
  );
}
