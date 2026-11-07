// 画布（照原型 ⑧）：AI 们交付的所有成果。按类别筛选、搜索，也可以只看某个任务的（?task=）。
// 桌面端在这里设置同步到电脑的文件夹（ADR 0007 §9–10）。任务卡片可以直接删除任务。
import type { ArtifactCategory } from '@oasis/contracts/canvas';
import type { TaskSummary } from '@oasis/contracts/task';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { ArrowUpRight, Search, Trash2, Workflow, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ApiError } from '../api/client.ts';
import { artifactsQuery, deleteTask, taskArchiveUrl, tasksQuery } from '../api/queries.ts';
import { ArtifactCard } from '../canvas/ArtifactCard.tsx';
import { RevisingTag } from '../chat/parts.tsx';
import { DesktopSyncBar } from '../desktop/DesktopSync.tsx';
import { EmptyHint } from '../ui/Panel.tsx';
import { formatCost } from '../ui/format.ts';
import { taskStatusOf } from '../workflow/rules.ts';
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

const ENDED: TaskSummary['status'][] = ['succeeded', 'failed', 'cancelled'];

/** 画布上的一张任务卡片：点开看工作流；删除要再确认，还在做的会先停下再删 */
function TaskTile({ task: t }: { task: TaskSummary }) {
  const queryClient = useQueryClient();
  const [asking, setAsking] = useState(false);
  const remove = useMutation({
    mutationFn: () => deleteTask(t.id),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: tasksQuery.queryKey }),
        queryClient.invalidateQueries({ queryKey: ['artifacts'] }),
      ]),
  });
  return (
    <article
      aria-label={t.title}
      className="flex min-w-0 flex-col gap-1 rounded-card bg-glass-strong p-4 text-ink shadow-edge-strong transition hover:bg-glass-active"
    >
      <Link
        to="/canvas/tasks/$taskId"
        params={{ taskId: t.id }}
        aria-label={`打开工作流：${t.title}`}
        className="flex min-w-0 flex-1 flex-col gap-3 text-ink no-underline"
      >
        <div className="flex items-center justify-between gap-2 text-[12px] text-ink-muted">
          <Workflow size={18} aria-hidden="true" />
          <span className="flex items-center gap-1.5">
            {t.revising && <RevisingTag />}
            <span className={taskStatusOf(t).tone === 'accent' ? 'text-accent' : ''}>
              {taskStatusOf(t).label}
            </span>
          </span>
        </div>
        <h3 className="m-0 line-clamp-2 text-[15px] font-medium leading-relaxed">{t.title}</h3>
        <p className="m-0 mt-auto text-[13px] text-ink-muted">
          {t.nodesDone}/{t.nodesTotal} 完成 · 已花 {formatCost(t.spentMicro)}
        </p>
        <span className="flex items-center justify-between text-[13px]">
          查看工作流
          <ArrowUpRight size={16} aria-hidden="true" />
        </span>
      </Link>
      {/* 删除：右下角一个图标；点了才在同一行问一句（2026-11-05 用户嫌原来的字多、还竖着排） */}
      <div className="-mb-1 flex h-9 items-center justify-end gap-1.5">
        {asking ? (
          <span
            role="group"
            aria-label={ENDED.includes(t.status) ? '彻底删除？' : '停下并彻底删除？'}
            className="flex items-center gap-1.5 whitespace-nowrap"
          >
            <span className="text-[12.5px] text-ink-muted">
              {ENDED.includes(t.status) ? '彻底删除？' : '停下并彻底删除？'}
            </span>
            <button
              type="button"
              disabled={remove.isPending}
              onClick={() => {
                setAsking(false);
                remove.mutate();
              }}
              className="h-8 rounded-full border-0 bg-accent px-3.5 text-[12.5px] font-medium text-on-accent disabled:opacity-50"
            >
              删除
            </button>
            <button
              type="button"
              onClick={() => setAsking(false)}
              className="h-8 rounded-full border-0 bg-transparent px-2 text-[12.5px] text-ink-muted"
            >
              取消
            </button>
          </span>
        ) : (
          <button
            type="button"
            aria-label="删除任务"
            title="删除任务"
            disabled={remove.isPending}
            onClick={() => setAsking(true)}
            className="flex size-8 items-center justify-center rounded-full border-0 bg-transparent text-ink-muted hover:bg-track hover:text-ink disabled:opacity-50"
          >
            <Trash2 size={15} aria-hidden="true" />
          </button>
        )}
      </div>
      {remove.isError && (
        <p role="alert" className="m-0 text-[13px] text-accent">
          {remove.error instanceof ApiError ? remove.error.message : '没删掉，请重试'}
        </p>
      )}
    </article>
  );
}

export function CanvasPage() {
  const { task } = route.useSearch();
  const { data: artifacts, isPending, isError } = useQuery(artifactsQuery(task));
  const tasks = useQuery({ ...tasksQuery, refetchInterval: 5_000 });
  const speakers = useSpeakers();
  const [category, setCategory] = useState<ArtifactCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  const keyword = search.trim().toLowerCase();
  const matching = useMemo(() => {
    const all = artifacts ?? [];
    const apps = all.filter((item) => item.application);
    const parentOf = (item: (typeof all)[number]) =>
      apps.find(
        (app) =>
          app.id !== item.id &&
          app.taskId === item.taskId &&
          app.nodeId === item.nodeId &&
          item.path.startsWith(`${app.application!.root}/`),
      );
    return all.filter((item) => {
      const parent = parentOf(item);
      if (parent) return false;
      if (!keyword) return true;
      const own = [item.name, item.taskTitle, item.deliverable];
      const members = item.application
        ? all.filter((file) => parentOf(file)?.id === item.id).map((file) => file.path)
        : [];
      return [...own, ...members].some((text) => text.toLowerCase().includes(keyword));
    });
  }, [artifacts, keyword]);
  const shown = category === 'all' ? matching : matching.filter((a) => a.category === category);
  const shownTasks = (tasks.data ?? []).filter(
    (t) => (!task || t.id === task) && (!keyword || t.title.toLowerCase().includes(keyword)),
  );
  const taskTitle = task
    ? (tasks.data?.find((t) => t.id === task)?.title ?? artifacts?.[0]?.taskTitle)
    : undefined;

  return (
    <>
      <header className="flex flex-wrap items-end gap-4 px-1.5 pt-1">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">画布</h1>
          <p className="mb-0 mt-2 text-sm text-ink-muted">
            从任务卡片进入工作流查看进度和检查结果。交付的成果也会放在这里。
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

      <section aria-label="任务工作流" className="flex flex-col gap-3">
        <h2 className="m-0 px-1.5 text-base font-medium">任务</h2>
        {tasks.isPending && <p className="m-0 text-sm text-ink-muted">正在加载任务…</p>}
        {tasks.isError && (
          <p role="alert" className="m-0 text-sm text-accent">
            任务没能加载。
            <button
              type="button"
              onClick={() => void tasks.refetch()}
              className="ml-2 rounded-full border-0 bg-glass-strong px-3 py-1 text-ink"
            >
              重试加载任务
            </button>
          </p>
        )}
        {tasks.isSuccess && shownTasks.length === 0 && (
          <p className="m-0 px-1.5 text-sm text-ink-muted">
            {keyword ? '没有匹配的任务。' : '还没有任务，在私聊里发布任务后可在这里查看工作流。'}
          </p>
        )}
        <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[18px]">
          {shownTasks.map((t) => (
            <TaskTile key={t.id} task={t} />
          ))}
        </div>
      </section>

      <h2 className="m-0 px-1.5 text-base font-medium">成果</h2>

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
          <a
            href={taskArchiveUrl(task)}
            download
            className="ml-auto inline-flex h-9 items-center rounded-full bg-glass-active px-3.5 text-[13px] text-ink no-underline shadow-edge-strong"
          >
            打包下载
          </a>
        )}
        {task && (
          <Link
            to="/canvas"
            search={{}}
            className="inline-flex h-9 items-center gap-1.5 rounded-full bg-solid px-3.5 text-[13px] text-on-solid no-underline"
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
            ? '这个任务还没有交付成果，可从上方任务卡片查看工作流。'
            : artifacts.length === 0
              ? '还没有交付成果。任务进度和检查结果可在上方工作流中查看。'
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
