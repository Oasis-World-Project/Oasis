import type { ModelEntry } from '@oasis/contracts/agent';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { modelsQuery } from './queries.ts';

/** 按 key 查模型（头像字母、光色、版本名、用户给它起的名字），模型目录很少变，缓存 10 分钟。 */
export function useModelMap(): Map<string, ModelEntry> {
  const { data } = useQuery(modelsQuery);
  return useMemo(() => new Map((data ?? []).map((model) => [model.key, model])), [data]);
}

/** 私聊里这个 AI 叫什么：用户在设置里给它起了名字就用这个，不然是私聊的标题（AI 的名字） */
export function aiName(
  models: Map<string, ModelEntry>,
  dm: { title: string; modelKey?: string | null | undefined },
): string {
  return (dm.modelKey ? models.get(dm.modelKey)?.profile.name : undefined) ?? dm.title;
}
