// 「＋」菜单里的「只用国内模型」开关（ADR 0027）：点一下开、再点一下关，按账号记住。
// 打开后这个账号的 AI 团队不用国外厂商的模型和工具型号；关着时所有模型都能用。
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MapPin } from 'lucide-react';
import { modelScopeQuery, setModelScope, workflowOptionsQuery } from '../api/queries.ts';

export function ModelScopeToggle({ className }: { className: string }) {
  const queryClient = useQueryClient();
  const scope = useQuery(modelScopeQuery);
  const change = useMutation({
    mutationFn: setModelScope,
    onSuccess: (saved) => {
      queryClient.setQueryData(modelScopeQuery.queryKey, saved);
      // 编辑节点时能选的模型和工具跟着变
      void queryClient.invalidateQueries({ queryKey: workflowOptionsQuery.queryKey });
    },
  });
  const on = scope.data?.domesticOnly ?? false;
  const failed = scope.isError || change.isError;
  return (
    <button
      type="button"
      role="menuitemcheckbox"
      aria-checked={on}
      disabled={!scope.data || change.isPending}
      onClick={() => change.mutate({ domesticOnly: !on })}
      className={`${className} disabled:opacity-60`}
    >
      <MapPin size={17} aria-hidden="true" />
      <span className="flex flex-1 flex-col">
        <span className="text-[14px] font-medium">只用国内模型</span>
        <span className="text-[12px] text-ink-muted">
          {failed ? '没连上，稍后再试' : on ? '不用国外厂商的模型' : '所有模型都能用'}
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
