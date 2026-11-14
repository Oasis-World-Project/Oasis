// 画布（照原型 ⑧）：AI 们交付的所有成果，按话题分组（一个私聊开新话题之前做的算一个话题），
// 最近有成果的话题在前。可以按类别筛选、搜索，也可以只看某个私聊的（?conversation=，任务卡上的「在画布里看」）。
// 每个话题可以回到它的私聊、打包下载。桌面端在这里设置同步到电脑的文件夹。
import type { ArtifactBody, ArtifactCategory } from '@oasis/contracts/canvas';
import { useQuery } from '@tanstack/react-query';
import { getRouteApi, Link } from '@tanstack/react-router';
import { Download, MessageCircle, Search, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { artifactsQuery, dmsQuery, topicArchiveUrl } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';
import { ArtifactCard, type Maker } from '../canvas/ArtifactCard.tsx';
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

const smallLink =
  'inline-flex h-9 items-center gap-1.5 rounded-full bg-glass-active px-3.5 text-[13px] text-ink no-underline shadow-edge-strong';

interface Topic {
  sessionId: string;
  topic: string;
  conversationId: string;
  items: ArtifactBody[];
}

export function CanvasPage() {
  const { conversation } = route.useSearch();
  const {
    data: artifacts,
    isPending,
    isError,
  } = useQuery(artifactsQuery(conversation ? { conversationId: conversation } : {}));
  const { data: dms = [] } = useQuery(dmsQuery);
  const models = useModelMap();
  const [category, setCategory] = useState<ArtifactCategory | 'all'>('all');
  const [search, setSearch] = useState('');

  /** 做成果的 AI：这个私聊的 AI */
  const makerOf = (conversationId: string): Maker | undefined => {
    const dm = dms.find((d) => d.id === conversationId);
    const model = dm?.modelKey ? models.get(dm.modelKey) : undefined;
    return dm && model ? { mono: model.mono, glow: model.glow, name: dm.title } : undefined;
  };

  const keyword = search.trim().toLowerCase();
  const matching = useMemo(() => {
    const all = artifacts ?? [];
    const apps = all.filter((item) => item.application);
    // 应用目录里的文件归在应用下面，不单独列
    const parentOf = (item: ArtifactBody) =>
      apps.find(
        (app) =>
          app.id !== item.id &&
          app.sessionId === item.sessionId &&
          item.path.startsWith(`${app.application!.root}/`),
      );
    return all.filter((item) => {
      if (parentOf(item)) return false;
      if (!keyword) return true;
      const members = item.application
        ? all.filter((file) => parentOf(file)?.id === item.id).map((file) => file.path)
        : [];
      return [item.name, item.topic, ...members].some((text) =>
        text.toLowerCase().includes(keyword),
      );
    });
  }, [artifacts, keyword]);
  const shown = category === 'all' ? matching : matching.filter((a) => a.category === category);
  // 按话题分组；列表本来就是新的在前，第一次出现的顺序就是最近有成果的顺序
  const topics = useMemo(() => {
    const groups = new Map<string, Topic>();
    for (const item of shown) {
      const group = groups.get(item.sessionId);
      if (group) group.items.push(item);
      else
        groups.set(item.sessionId, {
          sessionId: item.sessionId,
          topic: item.topic,
          conversationId: item.conversationId,
          items: [item],
        });
    }
    return [...groups.values()];
  }, [shown]);
  const conversationTitle = conversation
    ? dms.find((d) => d.id === conversation)?.title
    : undefined;

  return (
    <>
      <header className="flex flex-wrap items-end gap-4 px-1.5 pt-1">
        <div className="min-w-0 flex-1">
          <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">画布</h1>
          <p className="mb-0 mt-2 text-sm text-ink-muted">
            AI 们交付的成果，按话题放在一起。点开能预览、批注，让 AI 接着改。
          </p>
        </div>
        <label className="flex h-11 w-[260px] max-w-full items-center gap-2 rounded-full bg-glass-strong px-4 shadow-edge-strong">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
          <input
            type="search"
            aria-label="搜成果"
            placeholder="搜成果、话题"
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
      {artifacts && shown.length === 0 && (
        <EmptyHint>
          {artifacts.length === 0
            ? '还没有成果。在私聊里让 AI 做点东西，做好的文件会放到这里。'
            : keyword
              ? '没有匹配的成果。'
              : '这一类里还没有成果。'}
        </EmptyHint>
      )}
      {topics.map((topic) => (
        <section key={topic.sessionId} aria-label={topic.topic} className="flex flex-col gap-3">
          <header className="flex flex-wrap items-center gap-2 px-1.5">
            <h2 className="m-0 min-w-0 truncate text-base font-medium">{topic.topic}</h2>
            <span className="ml-auto flex items-center gap-1.5">
              <Link
                to="/dms/$conversationId"
                params={{ conversationId: topic.conversationId }}
                className={smallLink}
              >
                <MessageCircle size={14} aria-hidden="true" />
                回到私聊
              </Link>
              <a href={topicArchiveUrl(topic.sessionId)} download className={smallLink}>
                <Download size={14} aria-hidden="true" />
                打包下载
              </a>
            </span>
          </header>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-[18px]">
            {topic.items.map((artifact) => (
              <ArtifactCard
                key={artifact.id}
                artifact={artifact}
                maker={makerOf(artifact.conversationId)}
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
