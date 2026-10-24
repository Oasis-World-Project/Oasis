// 画布（照原型 ⑧）：AI 们交付的所有成果。按类别筛选、搜索，也可以只看某个任务的（?task=）。
// 桌面端在这里设置同步到电脑的文件夹（ADR 0007 §9–10）。
import type { ArtifactCategory } from '@oasis/contracts/canvas';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { artifactsQuery } from '../api/queries.ts';
import { ArtifactCard } from '../canvas/ArtifactCard.tsx';
import { DesktopSyncBar } from '../desktop/DesktopSync.tsx';
import { EmptyHint } from '../ui/Panel.tsx';
import { useSpeakers } from '../workflow/use-speakers.ts';

const route = getRouteApi('/shell/canvas');

const CATEGORIES: [ArtifactCategory | 'all', string][] = [
  ['all', '全部'],
  ['doc', '文档和图片'],
  ['media', '音频和视频'],
  ['threed', '3D 和实景'],
  ['app', '网页和应用'],
  ['data', '数据和其他'],
];

export function CanvasPage() {
  const { task } = route.useSearch();
  const { data: artifacts, isPending, isError } = useQuery(artifactsQuery(task));
  const speakers = useSpeakers();
  const [category, setCategory] = useState<ArtifactCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  const keyword = search.trim().toLowerCase();
  const matching = useMemo(
    () =>
      (artifacts ?? []).filter(
        (a) =>
          !keyword ||
          [a.name, a.taskTitle, a.deliverable].some((text) => text.toLowerCase().includes(keyword)),
      ),
    [artifacts, keyword],
  );
  const shown = category === 'all' ? matching : matching.filter((a) => a.category === category);
  const taskTitle = task ? artifacts?.[0]?.taskTitle : undefined;

  return (
    <>
      <header className="flex flex-wrap items-end gap-4 px-1.5 pt-1">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">画布</h1>
          <p className="mb-0 mt-2 text-sm text-ink-muted">
            AI 们做出来的东西都在这里，点开就能看。任务完成后，交付的成果会自动放进来。
          </p>
        </div>
        <label className="flex h-11 w-[260px] max-w-full items-center gap-2 rounded-full bg-glass-strong px-4 shadow-edge-strong">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
          <input
            type="search"
            aria-label="搜成果"
            placeholder="搜成果、任务"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
          />
        </label>
      </header>

      <DesktopSyncBar />

      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="成果类别">
        {CATEGORIES.map(([value, label]) => {
          const count =
            value === 'all' ? matching.length : matching.filter((a) => a.category === value).length;
          const on = category === value;
          return (
            <button
              key={value}
              type="button"
              aria-pressed={on}
              onClick={() => setCategory(value)}
              className={`inline-flex h-10 items-center gap-1.5 rounded-full border-0 px-4 text-[13.5px] text-ink ${
                on
                  ? 'bg-glass-active font-medium shadow-raised'
                  : 'bg-transparent hover:bg-glass-strong'
              }`}
            >
              {label}
              <span className="font-display text-[11px] text-ink-muted">{count}</span>
            </button>
          );
        })}
        {task && (
          <Link
            to="/canvas"
            search={{}}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-solid px-3.5 text-[13px] text-on-solid no-underline"
          >
            只看「{taskTitle ?? '这个任务'}」
            <X size={14} aria-label="看全部" />
          </Link>
        )}
      </div>

      {isPending && <p className="m-0 px-1 text-sm text-ink-muted">正在加载成果…</p>}
      {isError && <p className="m-0 px-1 text-sm text-accent">成果没能加载，稍后再试。</p>}
      {artifacts && shown.length === 0 && (
        <EmptyHint>
          {task
            ? '这个任务的成果正在放进画布，过几秒刷新看看。'
            : artifacts.length === 0
              ? '还没有成果。在私聊里发个任务，做完后交付的文件会出现在这里。'
              : '这一类里还没有成果。'}
        </EmptyHint>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[18px]">
        {shown.map((artifact) => (
          <ArtifactCard key={artifact.id} artifact={artifact} speakers={speakers} />
        ))}
      </div>
    </>
  );
}
