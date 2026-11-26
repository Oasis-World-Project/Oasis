// 画布（照原型 ⑧）：AI 们做的成果，按任务放（任务是私聊里、自己当群主的群里用了生图、视频这类工具或交了文件的那一轮）。
// 一个任务一个小窗口：封面是几个成果的缩略图，写着任务名、状态、用时、花费、做它的 AI；点开进这个任务的页面
// 看全部成品和素材。最近的任务在前；有任务在做时定时刷新，做好一个就出现。可以按类别筛选、搜索，也可以只看
// 某个私聊的（?conversation=，任务卡上的「在画布里看」）。桌面端在这里设置同步到电脑的文件夹（按任务分文件夹）。
import type { ArtifactCategory } from '@oasis/contracts/canvas';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { artifactsQuery, dmsQuery, tasksQuery } from '../api/queries.ts';
import { groupTasks } from '../canvas/task-groups.ts';
import { useMakerOf } from '../canvas/TaskPanel.tsx';
import { TaskTile } from '../canvas/TaskTile.tsx';
import { useNow } from '../chat/task-status.ts';
import { DesktopSyncBar } from '../desktop/DesktopSync.tsx';
import { EmptyHint } from '../ui/Panel.tsx';

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
  const { conversation } = route.useSearch();
  const { data: tasks = [] } = useQuery(tasksQuery);
  const running = tasks.some((task) => task.status === 'running');
  const {
    data: artifacts,
    isPending,
    isError,
  } = useQuery({
    ...artifactsQuery(conversation ? { conversationId: conversation } : {}),
    // 有任务在做：做好一个就登记进画布，跟着刷新
    refetchInterval: running ? 3_000 : false,
  });
  const { data: dms = [] } = useQuery(dmsQuery);
  const makerOf = useMakerOf();
  const now = useNow(running);
  const [category, setCategory] = useState<ArtifactCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  const keyword = search.trim().toLowerCase();
  const { groups, matching } = useMemo(
    () => groupTasks({ artifacts: artifacts ?? [], tasks, category, keyword, conversation }),
    [artifacts, tasks, category, keyword, conversation],
  );
  const conversationTitle = conversation
    ? dms.find((d) => d.id === conversation)?.title
    : undefined;

  return (
    <>
      <header className="flex flex-wrap items-end gap-4 px-1.5 pt-1">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">画布</h1>
          <p className="mb-0 mt-2 text-sm text-ink-muted">
            AI 们做的成果，按任务放在一起。点开能预览，指出要改的地方让 AI 接着改。
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
        {conversation && (
          <Link
            to="/canvas"
            search={{}}
            className="ml-auto inline-flex h-9 items-center gap-1.5 rounded-full bg-solid px-3.5 text-[13px] text-on-solid no-underline"
          >
            只看「{conversationTitle ?? '这个私聊'}」
            <X size={14} aria-label="看全部" />
          </Link>
        )}
      </div>

      {isPending && <p className="m-0 px-1 text-sm text-ink-muted">正在加载成果…</p>}
      {isError && <p className="m-0 px-1 text-sm text-accent">成果没能加载，稍后再试。</p>}
      {artifacts && groups.length === 0 && (
        <EmptyHint>
          {artifacts.length === 0 && tasks.length === 0
            ? '还没有成果。在私聊或自己的群里让 AI 做点东西，做好的文件会放到这里。'
            : keyword
              ? '没有匹配的成果。'
              : '这一类里还没有成果。'}
        </EmptyHint>
      )}
      <div className="grid grid-cols-[repeat(auto-fill,minmax(260px,1fr))] gap-4">
        {groups.map((group) => (
          <TaskTile key={group.runId} group={group} maker={makerOf(group)} now={now} />
        ))}
      </div>
    </>
  );
}
