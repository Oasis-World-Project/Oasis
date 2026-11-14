// 「AI 们」页上的「只用国内模型」开关：点一下开、再点一下关，按账号记住（存在 agent）。
// 打开后国外厂商的 AI 暂停（聊天记录都在，关掉就能接着聊），各工具也只用国内厂商的型号。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { aiSettingsQuery, saveAiSettings } from '../api/queries.ts';

export function ModelScopeToggle() {
  const queryClient = useQueryClient();
  const settings = useQuery(aiSettingsQuery);
  const change = useMutation({
    mutationFn: saveAiSettings,
    onSuccess: (saved) => queryClient.setQueryData(aiSettingsQuery.queryKey, saved),
  });
  const on = settings.data?.domesticOnly ?? false;
  const failed = settings.isError || change.isError;
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={!settings.data || change.isPending}
      onClick={() => change.mutate({ domesticOnly: !on })}
      className="flex w-full items-center gap-3 rounded-card border-0 bg-glass-strong px-4 py-3 text-left text-ink shadow-edge-strong disabled:opacity-60"
    >
      <MapPin size={18} aria-hidden="true" />
      <span className="flex flex-1 flex-col">
        <span className="text-[14px] font-medium">只用国内模型</span>
        <span className="text-[12px] text-ink-muted">
          {failed
            ? '没连上，稍后再试'
            : on
              ? '国外厂商的 AI 先暂停（聊天记录都在），工具也只用国内的型号'
              : '所有模型都能用'}
        </span>
      </span>
      <span
        aria-hidden="true"
        className={`flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 shadow-edge-strong ${on ? 'justify-end bg-accent' : 'justify-start bg-glass-active'}`}
      >
        <span className={`size-4 rounded-full ${on ? 'bg-on-accent' : 'bg-solid'}`} />
      </span>
    </button>
  );
}
