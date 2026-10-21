// AI 们：14 个对话 AI 可以私聊；图像、视频等工具模型在后续版本列出（只能查看）。
import type { ModelEntry } from '@oasis/contracts/agent';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { MessageCircle } from 'lucide-react';
import { ApiError } from '../api/client.ts';
import { createDm, dmsQuery, modelsQuery } from '../api/queries.ts';
import { AiAvatar } from '../ui/Avatar.tsx';
import { PageHeader } from '../ui/PageHeader.tsx';
import { EmptyHint, Panel } from '../ui/Panel.tsx';

function ModelCard({
  model,
  onChat,
  busy,
}: {
  model: ModelEntry;
  onChat: () => void;
  busy: boolean;
}) {
  return (
    <article className="flex flex-col gap-3 rounded-card bg-glass-strong p-4 shadow-edge-strong">
      <div className="flex items-center gap-3">
        <AiAvatar mono={model.mono} glow={model.glow} size={44} glowing={model.available} />
        <div className="flex min-w-0 flex-col">
          <h3 className="m-0 text-[15px] font-medium">{model.name}</h3>
          <span className="truncate text-xs text-ink-muted">
            {model.versionLabel ?? model.vendor}
          </span>
        </div>
      </div>
      <ul className="m-0 flex list-none flex-wrap gap-1.5 p-0">
        {model.tags.map((tag) => (
          <li
            key={tag}
            className="rounded-full bg-glass-active px-2.5 py-0.5 text-xs text-ink-muted"
          >
            {tag}
          </li>
        ))}
      </ul>
      <button
        type="button"
        onClick={onChat}
        disabled={!model.available || busy}
        className="mt-auto flex h-10 items-center justify-center gap-1.5 rounded-item border-0 bg-solid text-[13px] font-medium text-on-solid disabled:cursor-not-allowed disabled:bg-glass-active disabled:text-ink-muted"
      >
        {model.available && <MessageCircle size={15} aria-hidden="true" />}
        {model.available ? `和 ${model.name} 私聊` : '即将接入'}
      </button>
    </article>
  );
}

export function AisPage() {
  const { data: models, isPending, error } = useQuery(modelsQuery);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const start = useMutation({
    mutationFn: createDm,
    onSuccess: async (conversation) => {
      await queryClient.invalidateQueries({ queryKey: dmsQuery.queryKey });
      await navigate({ to: '/dms/$conversationId', params: { conversationId: conversation.id } });
    },
  });
  const llms = (models ?? []).filter((m) => m.category === 'llm');

  return (
    <>
      <PageHeader
        title="AI 们"
        description="对话 AI 可以私聊、拉进群、单独设置；图像、视频等工具模型只能查看，由对话 AI 在干活时调用。"
      />
      <Panel title={`大语言模型${llms.length ? ` · ${llms.length}` : ''}`}>
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
        <div className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {llms.map((model) => (
            <ModelCard
              key={model.key}
              model={model}
              busy={start.isPending}
              onChat={() => start.mutate(model.key)}
            />
          ))}
        </div>
      </Panel>
      <Panel title="工具模型">
        <EmptyHint>
          图像生成、视觉理解、视频生成、音频、向量、3D、其他模型会在后续版本列出，由对话 AI
          在干活时调用。
        </EmptyHint>
      </Panel>
    </>
  );
}
