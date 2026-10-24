// 节点上显示谁在干活：供应商型号（如 deepseek/deepseek-v4.1-flash）→ 模型目录里的头像字母和光色。
import type { NodeBody } from '@oasis/contracts/task';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';
import { workflowOptionsQuery } from '../api/queries.ts';
import { useModelMap } from '../api/use-model-map.ts';

export interface Speaker {
  mono: string;
  glow: string;
  name: string;
}

/** 目录里找不到的型号：取供应商名的前两个字母 */
function fallback(providerModel: string): Speaker {
  const vendor = providerModel.split('/')[0] ?? providerModel;
  return {
    mono: vendor.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || 'AI',
    glow: 'var(--oasis-glow-4)',
    name: providerModel,
  };
}

export function useSpeakers() {
  const models = useModelMap();
  const { data: options } = useQuery(workflowOptionsQuery);
  const byProvider = useMemo(
    () => new Map((options?.models ?? []).map((m) => [m.providerModel, m])),
    [options],
  );

  const speakerOf = useCallback(
    (providerModel: string): Speaker => {
      const entry = byProvider.get(providerModel);
      const model = entry ? models.get(entry.key) : undefined;
      if (!entry || !model) return fallback(providerModel);
      return { mono: model.mono, glow: model.glow, name: entry.name };
    },
    [byProvider, models],
  );

  /** 干活节点是它的模型；讨论节点是每位参与者 */
  const speakersOf = useCallback(
    (node: NodeBody): Speaker[] =>
      node.discussion
        ? node.discussion.participants.map((p) => ({ ...speakerOf(p.model), name: p.name }))
        : [speakerOf(node.model)],
    [speakerOf],
  );

  const toolName = useCallback(
    (key: string) => options?.tools.find((t) => t.key === key)?.name ?? key,
    [options],
  );

  return { speakerOf, speakersOf, toolName, options };
}
