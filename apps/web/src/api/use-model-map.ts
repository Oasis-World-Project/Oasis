import type { ModelEntry } from '@oasis/contracts/agent';
import { useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';
import { modelsQuery } from './queries.ts';

/** 按 key 查模型（头像字母、光色、版本名），模型目录很少变，缓存 10 分钟。 */
export function useModelMap(): Map<string, ModelEntry> {
  const { data } = useQuery(modelsQuery);
  return useMemo(() => new Map((data ?? []).map((model) => [model.key, model])), [data]);
}
