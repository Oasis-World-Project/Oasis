// AI 们（照原型 AiLibrary）：按类分页签。大语言模型能私聊、能进设置页换档位、起名字、定人格；
// 其他几类是 AI 们干活时调用的工具型号，只能看（写着哪个工具用它、排第几）。都来自型号清单。
// 「只用国内模型」开关也在这页。
import type { ModelEntry } from '@oasis/contracts/agent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { MessageCircle, Plus, Search, Settings2 } from 'lucide-react';
import { useState } from 'react';
import { ApiError } from '../api/client.ts';
import { createDm, dmsQuery, modelsQuery } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { ModelScopeToggle } from '../ui/ModelScopeToggle.tsx';
import { EmptyHint } from '../ui/Panel.tsx';

type Category = ModelEntry['category'];

const CATEGORIES: { id: Category; label: string; note: string }[] = [
  { id: 'llm', label: '大语言模型', note: '能私聊、能单独设置。设定会带进你和它的每一次对话。' },
  {
    id: 'image',
    label: '图像生成',
    note: '只能查看。AI 们干活要出图、改图时调用它们：先用第一个，用不了换下一个。',
  },
  {
    id: 'vision',
    label: '视觉理解',
    note: '只能查看。AI 们看截图、图表、视频和听录音时调用它们。',
  },
  { id: 'video', label: '视频生成', note: '只能查看。文生视频、图生视频时由 AI 们调用。' },
  { id: 'audio', label: '音频', note: '只能查看。配音、语音转文字、生成音乐时调用。' },
  {
    id: 'embedding',
    label: '向量',
    note: '只能查看。知识库开放后，检索资料靠它们；现在还没有接入。',
  },
  { id: '3d', label: '3D', note: '只能查看。把图片变成 3D 模型时调用。' },
  { id: 'other', label: '其他模型', note: '只能查看。决策模型 Jev 在幕后帮 AI 们做判断。' },
];

const chip = 'rounded-full bg-glass-active px-2.5 py-0.5 text-xs text-ink-muted';
const pill =
  'inline-flex h-[34px] items-center gap-1.5 rounded-full px-3 text-[12.5px] font-medium no-underline';

function ChatCard({
  model,
  onChat,
  busy,
}: {
  model: ModelEntry;
  onChat: () => void;
  busy: boolean;
}) {
  const named = model.profile.name;
  return (
    <article className="flex flex-col gap-3 rounded-card bg-glass-strong p-4 shadow-edge-strong">
      <div className="flex items-center gap-3">
        <AiAvatar mono={model.mono} glow={model.glow} size={44} glowing={!!named} />
        <div className="flex min-w-0 flex-col">
          <h3 className="m-0 truncate text-[15px] font-medium">{model.name}</h3>
          <span className="truncate text-xs text-ink-muted">{model.vendor}</span>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {model.tags.map((tag) => (
          <li key={tag} className={chip}>
            {tag}
          </li>
        ))}
      </ul>
      <div className="mt-auto flex items-center gap-2">
        <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-muted">
          {model.available
            ? `${named ? `你叫它${named}` : '默认设定'} · ${model.versionLabel}`
            : '即将接入'}
        </span>
        <button
          type="button"
          onClick={onChat}
          disabled={!model.available || busy}
          aria-label={`和 ${named ?? model.name} 私聊`}
          className={`${pill} border-0 bg-glass-active text-ink shadow-edge-strong disabled:cursor-not-allowed disabled:opacity-50`}
        >
          <MessageCircle size={14} aria-hidden="true" />
          私聊
        </button>
        {model.available && (
          <Link
            to="/ais/$key"
            params={{ key: model.key }}
            aria-label={`${model.name} 的设置`}
            className={`${pill} bg-solid text-on-solid`}
          >
            <Settings2 size={14} aria-hidden="true" />
            设置
          </Link>
        )}
      </div>
    </article>
  );
}

function ToolCard({ model }: { model: ModelEntry }) {
  return (
    <article className="flex flex-col gap-3 rounded-card bg-glass-strong p-4 shadow-edge-strong">
      <div className="flex items-center gap-3">
        <AiAvatar mono={model.mono} glow={model.glow} size={44} />
        <div className="flex min-w-0 flex-col">
          <h3 className="m-0 truncate text-[15px] font-medium">{model.name}</h3>
          <span className="truncate text-xs text-ink-muted">{model.vendor}</span>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {model.tags.map((tag) => (
          <li key={tag} className={chip}>
            {tag}
          </li>
        ))}
      </ul>
      {model.usage && <p className="m-0 mt-auto text-[12.5px] text-ink-muted">{model.usage}</p>}
    </article>
  );
}

export function AisPage() {
  const { data: models, isPending, error } = useQuery(modelsQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [category, setCategory] = useState<Category>('llm');
  const [search, setSearch] = useState('');
  const start = useMutation({
    mutationFn: createDm,
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
      await navigate({ to: '/dms/$conversationId', params: { conversationId: conversation.id } });
    },
  });
  const keyword = search.trim().toLowerCase();
  const all = models ?? [];
  const current = CATEGORIES.find((c) => c.id === category) ?? CATEGORIES[0]!;
  const shown = all.filter(
    (m) =>
      m.category === category &&
      (!keyword ||
        [m.name, m.vendor, m.profile.name ?? '', m.usage ?? '', ...m.tags].some((text) =>
          text.toLowerCase().includes(keyword),
        )),
  );

  return (
    <>
      <header className="flex flex-wrap items-end gap-3.5 px-1.5 pt-1">
        <div className="min-w-0 flex-[1_1_420px]">
          <h1 className="m-0 text-[38px] font-light leading-[1.15] tracking-[0.02em]">AI 们</h1>
          <p className="mb-0 mt-2 max-w-[640px] text-sm text-ink-muted">
            大语言模型能私聊，你可以给它们换档位、改名字、定人格，设定会带进每一次对话。其他几类模型是它们的工具，干活时由它们调用。
          </p>
        </div>
        <label className="flex h-11 w-[240px] max-w-full items-center gap-2 rounded-full bg-glass-strong px-4 shadow-edge-strong">
          <Search size={16} aria-hidden="true" className="shrink-0 text-ink-muted" />
          <input
            type="search"
            aria-label="搜模型"
            placeholder="搜模型或特点"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="min-w-0 flex-1 border-0 bg-transparent text-[14px] text-ink outline-none placeholder:text-ink-muted"
          />
        </label>
        <button
          type="button"
          disabled
          title="即将开放"
          className="inline-flex h-11 items-center gap-1.5 rounded-full border-0 bg-solid px-4 text-[14px] font-medium text-on-solid disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Plus size={16} aria-hidden="true" />
          接入自己的模型（即将开放）
        </button>
      </header>
      <ModelScopeToggle />

      <div
        role="tablist"
        aria-label="模型类别"
        className="glass flex max-w-full gap-0.5 self-start overflow-x-auto rounded-full p-1"
      >
        {CATEGORIES.map((c) => {
          const on = c.id === category;
          return (
            <button
              key={c.id}
              type="button"
              role="tab"
              aria-selected={on}
              onClick={() => setCategory(c.id)}
              className={`inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full border-0 px-4 text-[13.5px] text-ink ${
                on ? 'bg-glass-active font-medium shadow-raised' : 'bg-transparent'
              }`}
            >
              {c.label}
              <span className="font-display text-[11px] text-ink-muted">
                {all.filter((m) => m.category === c.id).length}
              </span>
            </button>
          );
        })}
      </div>
      <p className="m-0 px-2 text-[13px] text-ink-muted">{current.note}</p>

      {isPending && <EmptyHint>正在加载模型目录…</EmptyHint>}
      {error && (
        <EmptyHint>
          模型目录加载失败：{error instanceof ApiError ? error.message : '请刷新重试'}
        </EmptyHint>
      )}
      {start.error && (
        <p role="alert" className="m-0 px-1 text-sm text-accent">
          {start.error instanceof ApiError ? start.error.message : '没能开始私聊，请重试'}
        </p>
      )}
      {models && shown.length === 0 && (
        <EmptyHint>{keyword ? '没有匹配的模型。' : '这一类还没有接入的模型。'}</EmptyHint>
      )}
      <div
        role="tabpanel"
        aria-label={current.label}
        className="grid grid-cols-[repeat(auto-fill,minmax(250px,1fr))] gap-3.5"
      >
        {shown.map((model) =>
          model.category === 'llm' ? (
            <ChatCard
              key={model.key}
              model={model}
              busy={start.isPending}
              onChat={() => start.mutate(model.key)}
            />
          ) : (
            <ToolCard key={model.key} model={model} />
          ),
        )}
      </div>
    </>
  );
}
