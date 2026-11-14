// 一个 AI 的设置页（照原型 AiSettings）：用哪一档、名字、性别、人格描述、其他要它记住的，存好后从下一轮起
// 带进它的每一次私聊。技能和连接器、知识库、自己的音源、自带 Key 先把位置放上，标着「即将开放」。
import type { AiProfile, ModelEntry, ModelTier } from '@oasis/contracts/agent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getRouteApi, Link, useNavigate } from '@tanstack/react-router';
import { ChevronLeft, Mic, Play, Plus, Upload } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { ApiError } from '../api/client.ts';
import { createDm, dmsQuery, modelsQuery, saveAi } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { EmptyHint } from '../ui/Panel.tsx';

const route = getRouteApi('/shell/ais/$key');

const TIER_NAMES: Record<ModelTier, string> = {
  fast: '快速',
  balanced: '均衡',
  strong: '强力',
  max: '最强',
};
const VOICES = { male: '默认男声', female: '默认女声' } as const;
/** 每百万 token 的标价：两位小数，太便宜的多留一位 */
const usd = (price: number) => `$${price.toFixed(price > 0 && price < 0.1 ? 3 : 2)}`;
const NAME_MAX = 20;
const TEXT_MAX = 2000;

const field =
  'w-full rounded-[22px] border-0 bg-glass-active px-4 text-[14.5px] text-ink shadow-edge-strong outline-none';
const soon = 'rounded-full bg-glass-active px-2.5 py-0.5 text-[11.5px] text-ink-muted';

function Section({
  id,
  title,
  hint,
  badge,
  children,
}: {
  id: string;
  title: string;
  hint: string;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="glass flex flex-col gap-3 rounded-panel p-5">
      <div>
        <h2 id={id} className="m-0 flex items-center gap-2 text-base font-medium">
          {title}
          {badge && <span className={soon}>{badge}</span>}
        </h2>
        <p className="mb-0 mt-1 text-[12.5px] text-ink-muted">{hint}</p>
      </div>
      {children}
    </section>
  );
}

/** 去掉没填的项（没填的用系统默认） */
function cleaned(draft: Required<Record<keyof AiProfile, string>>): AiProfile {
  return {
    ...(draft.name.trim() ? { name: draft.name.trim() } : {}),
    ...(draft.gender === 'male' || draft.gender === 'female' ? { gender: draft.gender } : {}),
    ...(draft.persona.trim() ? { persona: draft.persona.trim() } : {}),
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
  };
}

const draftOf = (profile: AiProfile) => ({
  name: profile.name ?? '',
  gender: profile.gender ?? '',
  persona: profile.persona ?? '',
  notes: profile.notes ?? '',
});

const SKILL_TABS = [
  ['技能', '技能是一套写好的做事方法，比如按你的格式写周报。以后可以导入 SKILL.md 文件。'],
  ['MCP', '通过 MCP 连接你的外部工具，填服务器地址或启动命令即可。'],
  ['插件', '插件是打包好的一组能力，装上就能用。'],
  ['Hooks', 'Hook 在特定时刻自动执行，比如每次发消息前、每次生成文件后。'],
] as const;

function Form({ model }: { model: ModelEntry }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const firstTier = model.options[0]!.tier;
  const [tier, setTier] = useState<ModelTier>(model.tier ?? firstTier);
  const [draft, setDraft] = useState(() => draftOf(model.profile));
  const [skillTab, setSkillTab] = useState(0);
  const set = (key: keyof typeof draft) => (value: string) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const profile = cleaned(draft);
  const saved = draftOf(model.profile);
  const changes =
    (tier !== (model.tier ?? firstTier) ? 1 : 0) +
    (Object.keys(draft) as (keyof typeof draft)[]).filter((k) => draft[k].trim() !== saved[k])
      .length;
  const save = useMutation({
    mutationFn: () => saveAi(model.key, { tier, profile }),
    onSuccess: (entry) =>
      queryClient.setQueryData(modelsQuery.queryKey, (models) =>
        models?.map((m) => (m.key === entry.key ? entry : m)),
      ),
  });
  const chat = useMutation({
    mutationFn: () => createDm(model.key),
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
      await navigate({ to: '/dms/$conversationId', params: { conversationId: conversation.id } });
    },
  });
  const shownName = profile.name ?? model.name;
  const option = model.options.find((o) => o.tier === tier);
  const voice = profile.gender ? VOICES[profile.gender] : '声音没定';

  return (
    <>
      <header className="flex items-center gap-3 px-1.5 pt-1 text-[13.5px] text-ink-muted">
        <Link
          to="/ais"
          aria-label="回到 AI 们"
          className="flex size-[42px] items-center justify-center rounded-full bg-glass-strong text-ink shadow-edge-strong"
        >
          <ChevronLeft size={18} aria-hidden="true" />
        </Link>
        <span>AI 们</span>
        <span>/</span>
        <h1 className="m-0 text-[13.5px] font-medium text-ink">{model.name} 的设定</h1>
      </header>

      <div className="flex flex-wrap items-start gap-4">
        <aside
          aria-label="它现在的样子"
          className="glass sticky top-4 flex min-w-[260px] flex-[0_1_320px] flex-col items-center gap-3.5 rounded-panel px-5 pb-5 pt-6 text-center"
        >
          <AiAvatar mono={model.mono} glow={model.glow} size={96} glowing />
          <div>
            <div className="text-[32px] font-light leading-tight">{shownName}</div>
            <div className="mt-1.5 flex flex-wrap justify-center gap-1.5">
              <span className={soon}>{option?.label}</span>
              <span className={soon}>{voice}</span>
            </div>
          </div>
          {profile.persona && (
            <p className="m-0 rounded-[20px] bg-glass-active px-3.5 py-3 text-left text-[13px] leading-relaxed">
              “我是{shownName}。{profile.persona.split(/[。！？\n]/)[0]}。”
            </p>
          )}
          <div className="flex w-full gap-2">
            <button
              type="button"
              onClick={() => chat.mutate()}
              disabled={chat.isPending}
              className="h-[42px] flex-1 rounded-full border-0 bg-solid text-[14px] font-medium text-on-solid"
            >
              私聊
            </button>
            <button
              type="button"
              disabled
              title="以后开了语音能试听"
              className="inline-flex h-[42px] flex-1 items-center justify-center gap-1.5 rounded-full border-0 bg-glass-active text-[14px] font-medium text-ink-muted shadow-edge-strong"
            >
              <Play size={14} aria-hidden="true" />
              试听（即将开放）
            </button>
          </div>
          <p className="m-0 text-[12.5px] leading-relaxed text-ink-muted">
            这些设定从下一轮起带进它的每一次私聊；没填的地方用系统默认。
          </p>
          <button
            type="button"
            onClick={() => {
              setTier(firstTier);
              setDraft(draftOf({}));
            }}
            className="border-0 bg-transparent text-[13px] font-medium text-ink underline underline-offset-4"
          >
            全部恢复成系统默认
          </button>
        </aside>

        <div className="flex min-w-0 flex-[1_1_560px] flex-col gap-3.5 pb-24">
          <Section id="s-model" title="模型" hint="档位越高越强，也越贵。从下一轮起用新的。">
            <div role="radiogroup" aria-label="用哪一档" className="flex flex-col gap-1.5">
              {model.options.map((o) => {
                const on = o.tier === tier;
                return (
                  <button
                    key={o.tier}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => setTier(o.tier)}
                    className={`flex items-center gap-3 rounded-[20px] border-0 px-3.5 py-3 text-left text-ink ${
                      on ? 'bg-glass-active shadow-raised' : 'bg-glass-strong'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`size-[18px] shrink-0 rounded-full ${on ? 'border-[5px] border-accent' : 'border-[1.5px] border-ink-muted'} border-solid`}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="font-medium">{o.label}</span>
                      <span className="text-xs text-ink-muted">
                        每百万 token 输入 {usd(o.inputPrice)} · 输出 {usd(o.outputPrice)}
                        {o.note ? ` · ${o.note}` : ''}
                      </span>
                    </span>
                    <span className={soon}>{TIER_NAMES[o.tier]}</span>
                  </button>
                );
              })}
              <div className="flex items-center gap-3 rounded-[20px] bg-glass-strong px-3.5 py-3 text-ink-muted">
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="font-medium">用你自己的 Key 接入别的版本</span>
                  <span className="text-xs">费用由你自己的账户承担</span>
                </span>
                <span className={soon}>即将开放</span>
              </div>
            </div>
          </Section>

          <div className="flex flex-wrap gap-3.5">
            <div className="flex-[2_1_300px]">
              <Section id="s-name" title="名字" hint="问它叫什么，它会说自己叫这个名字。">
                <input
                  aria-labelledby="s-name"
                  value={draft.name}
                  maxLength={NAME_MAX}
                  placeholder={model.name}
                  onChange={(e) => set('name')(e.target.value)}
                  className={`${field} h-[46px]`}
                />
              </Section>
            </div>
            <div className="flex-[1_1_220px]">
              <Section id="s-gender" title="性别" hint="以后开了语音，决定它默认的声音。">
                <div
                  role="radiogroup"
                  aria-labelledby="s-gender"
                  className="flex gap-0.5 rounded-full bg-glass-active p-1"
                >
                  {(['male', 'female'] as const).map((g) => (
                    <button
                      key={g}
                      type="button"
                      role="radio"
                      aria-checked={draft.gender === g}
                      onClick={() => set('gender')(draft.gender === g ? '' : g)}
                      className={`h-[38px] flex-1 rounded-full border-0 text-[14px] text-ink ${
                        draft.gender === g
                          ? 'bg-glass-strong font-medium shadow-raised'
                          : 'bg-transparent'
                      }`}
                    >
                      {g === 'male' ? '男' : '女'}
                    </button>
                  ))}
                </div>
              </Section>
            </div>
          </div>

          <Section
            id="s-persona"
            title="人格描述"
            hint="用你自己的话写它的性格、说话方式、要记住的规矩。"
          >
            <textarea
              aria-labelledby="s-persona"
              rows={4}
              maxLength={TEXT_MAX}
              value={draft.persona}
              placeholder="比如：说话简短，爱用生活里的比喻。拿不准的事直说拿不准。"
              onChange={(e) => set('persona')(e.target.value)}
              className={`${field} resize-y py-3.5 leading-relaxed`}
            />
            <span className="self-end font-display text-[11px] text-ink-muted">
              {draft.persona.length} / {TEXT_MAX}
            </span>
          </Section>

          <Section
            id="s-skills"
            title="技能和连接器"
            hint="给它装上能力，或者连上你在用的工具。"
            badge="即将开放"
          >
            <div
              role="tablist"
              aria-label="能力类型"
              className="flex gap-0.5 self-start rounded-full bg-glass-active p-1"
            >
              {SKILL_TABS.map(([label], index) => (
                <button
                  key={label}
                  type="button"
                  role="tab"
                  aria-selected={index === skillTab}
                  onClick={() => setSkillTab(index)}
                  className={`h-[34px] rounded-full border-0 px-3.5 text-[13px] text-ink ${
                    index === skillTab
                      ? 'bg-glass-strong font-medium shadow-raised'
                      : 'bg-transparent'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
            <p className="m-0 text-[12.5px] text-ink-muted">{SKILL_TABS[skillTab]![1]}</p>
            <button
              type="button"
              disabled
              className="inline-flex h-[38px] items-center gap-1.5 self-start rounded-full border-0 bg-solid px-4 text-[13px] font-medium text-on-solid disabled:opacity-50"
            >
              <Plus size={15} aria-hidden="true" />
              添加{SKILL_TABS[skillTab]![0]}
            </button>
          </Section>

          <Section
            id="s-kb"
            title="知识库"
            hint="它回答前会先翻这里的资料。只有它能看到。"
            badge="即将开放"
          >
            <div className="flex flex-col items-center gap-1.5 rounded-[22px] bg-glass-strong p-5 text-ink-muted shadow-edge-strong">
              <Upload size={22} aria-hidden="true" />
              <span className="font-medium">拖进来，或点这里上传</span>
              <span className="text-xs">PDF、Word、Markdown、表格、网页链接都可以</span>
            </div>
          </Section>

          <Section id="s-voice" title="声音" hint="以后开了语音，它就用这个声音说话。">
            <div
              role="radiogroup"
              aria-label="声音"
              className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-2"
            >
              {(['male', 'female'] as const).map((g) => {
                const on = draft.gender === g;
                return (
                  <button
                    key={g}
                    type="button"
                    role="radio"
                    aria-checked={on}
                    onClick={() => set('gender')(g)}
                    className={`flex items-center gap-3 rounded-[20px] border-0 p-3 text-left text-ink ${
                      on ? 'bg-glass-active shadow-raised' : 'bg-glass-strong'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className={`flex size-9 shrink-0 items-center justify-center rounded-full ${on ? 'bg-solid text-on-solid' : 'bg-glass-active'}`}
                    >
                      <Play size={13} />
                    </span>
                    <span className="flex flex-col">
                      <span className="font-medium">{VOICES[g]}</span>
                      <span className="text-xs text-ink-muted">跟着性别走</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="flex items-center gap-3 rounded-[20px] bg-glass-strong px-4 py-3.5 text-ink-muted">
              <Mic size={20} aria-hidden="true" />
              <span className="flex flex-1 flex-col">
                <span className="font-medium">上传自己的音源</span>
                <span className="text-xs">WAV 或 MP3，10 到 60 秒的清晰人声</span>
              </span>
              <span className={soon}>即将开放</span>
            </div>
          </Section>

          <Section id="s-other" title="其他" hint="还有什么想让它记住的，都写在这里。">
            <textarea
              aria-labelledby="s-other"
              rows={3}
              maxLength={TEXT_MAX}
              value={draft.notes}
              placeholder="比如：回复别超过 5 行；写代码默认用 TypeScript；周末别催我。"
              onChange={(e) => set('notes')(e.target.value)}
              className={`${field} resize-y py-3.5 leading-relaxed`}
            />
          </Section>
        </div>
      </div>

      <div className="sticky bottom-4 z-10 flex items-center gap-2.5 self-end rounded-full bg-glass-strong py-2 pl-5 pr-2 shadow-raised backdrop-blur-xl">
        <span role="status" className="text-[13px] text-ink-muted">
          {save.isError && changes
            ? save.error instanceof ApiError
              ? save.error.message
              : '没存上，请重试'
            : changes
              ? `改了 ${changes} 处，还没保存`
              : '所有设定都已保存'}
        </span>
        <button
          type="button"
          disabled={!changes || save.isPending}
          onClick={() => {
            setTier(model.tier ?? firstTier);
            setDraft(draftOf(model.profile));
          }}
          className="h-11 rounded-full border-0 bg-transparent px-4 text-[14px] font-medium text-ink disabled:opacity-40"
        >
          放弃修改
        </button>
        <button
          type="button"
          disabled={!changes || save.isPending}
          onClick={() => save.mutate()}
          className="h-11 rounded-full border-0 bg-solid px-6 text-[14px] font-medium text-on-solid disabled:opacity-40"
        >
          {save.isPending ? '正在保存…' : '保存设定'}
        </button>
      </div>
    </>
  );
}

export function AiSettingsPage() {
  const { key } = route.useParams();
  const { data: models, isPending } = useQuery(modelsQuery);
  const model = models?.find((m) => m.key === key && m.category === 'llm' && m.available);
  if (isPending) return <EmptyHint>正在加载…</EmptyHint>;
  if (!model) return <EmptyHint>没有这个 AI，回「AI 们」看看。</EmptyHint>;
  // 存好后目录里的这个 AI 换成新的：表单按存好的重新开始
  return <Form key={`${model.tier}:${JSON.stringify(model.profile)}`} model={model} />;
}
