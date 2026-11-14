// 「AI 们」卡片上给一个 AI 换档位：快速（默认）/ 均衡 / 强力 / 最强，按账号记住（存在 agent），
// 下一轮起用新型号，聊天记录照旧。下面写着现在这档的标价和量过的说明。
import type { ModelEntry, ModelTier } from '@oasis/contracts/agent';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { chooseTier, modelsQuery } from '../api/queries.ts';

const TIER_NAMES: Record<ModelTier, string> = {
  fast: '快速',
  balanced: '均衡',
  strong: '强力',
  max: '最强',
};

const usd = (price: number) => `$${price.toFixed(2)}`;

export function TierPicker({ model }: { model: ModelEntry }) {
  const queryClient = useQueryClient();
  const change = useMutation({
    mutationFn: (tier: ModelTier) => chooseTier(model.key, tier),
    onSuccess: (entry) =>
      queryClient.setQueryData(modelsQuery.queryKey, (models) =>
        models?.map((m) => (m.key === entry.key ? entry : m)),
      ),
  });
  const current = model.options.find((option) => option.tier === model.tier);
  if (!current) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {model.options.length > 1 && (
        <div
          role="radiogroup"
          aria-label={`${model.name} 用哪一档`}
          className="flex gap-1 rounded-item bg-glass-active p-0.5"
        >
          {model.options.map((option) => {
            const on = option.tier === model.tier;
            return (
              <button
                key={option.tier}
                type="button"
                role="radio"
                aria-checked={on}
                title={option.label}
                disabled={change.isPending}
                onClick={() => !on && change.mutate(option.tier)}
                className={`h-7 flex-1 rounded-item border-0 text-xs disabled:cursor-wait ${on ? 'bg-solid font-medium text-on-solid' : 'bg-transparent text-ink-muted'}`}
              >
                {TIER_NAMES[option.tier]}
              </button>
            );
          })}
        </div>
      )}
      <p className="m-0 text-xs text-ink-muted">
        输入 {usd(current.inputPrice)} · 输出 {usd(current.outputPrice)} / 百万 token
        {current.note ? ` · ${current.note}` : ''}
      </p>
      {change.isError && (
        <p role="alert" className="m-0 text-xs text-accent">
          没换成，请重试
        </p>
      )}
    </div>
  );
}
