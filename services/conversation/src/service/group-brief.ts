// 群里的席位开一轮前带上的东西：群文件里它还没拿到的（group-files.ts），和群里各个 AI 用的是什么型号
// （它要不要把一部分活交给别的 AI，得知道对方是谁；只写事实，不写谁强谁弱）。
import { ModelRoute } from '@oasis/contracts/agent';
import type { Logger, ServiceClient } from '@oasis/service-kit';
import type { Conversation } from '../repo/conversation-repo.ts';
import type { GroupSeats } from '../repo/group-seats.ts';
import type { GroupFiles } from './group-files.ts';
import type { SeatBrief } from './group-hearing.ts';

/** 型号多久重新问一次 */
const CACHE_MS = 60_000;

export function createGroupBrief(deps: {
  files: Pick<GroupFiles, 'attach'>;
  seats: GroupSeats;
  agent: ServiceClient;
  logger: Logger;
}) {
  const models = new Map<string, { at: number; model: string }>();
  /** 群主给这个 AI 选的型号；问不到返回 undefined（这次不写它） */
  async function modelOf(ownerId: string, key: string): Promise<string | undefined> {
    const id = `${ownerId}:${key}`;
    const cached = models.get(id);
    if (cached && Date.now() - cached.at < CACHE_MS) return cached.model;
    try {
      const route = await deps.agent.json(
        'GET',
        `/internal/models/${encodeURIComponent(key)}/route?userId=${ownerId}`,
        { schema: ModelRoute },
      );
      models.set(id, { at: Date.now(), model: route.providerModel });
      return route.providerModel;
    } catch (err) {
      deps.logger.debug({ err, key }, '没问到这个 AI 的型号');
      return undefined;
    }
  }
  return {
    async attach(seat: Conversation, brief: SeatBrief): Promise<SeatBrief> {
      const withFiles = await deps.files.attach(seat, brief);
      if (!seat.parentId) return withFiles;
      const lines = await Promise.all(
        (await deps.seats.list(seat.parentId)).map(async (ai) => {
          const model = await modelOf(seat.ownerId, ai.model_key);
          return model ? `${ai.title} 用的是 ${model}` : undefined;
        }),
      );
      const known = lines.filter((line) => line !== undefined);
      return known.length
        ? { ...withFiles, persona: `${withFiles.persona}\n- 各 AI 的型号：${known.join('；')}` }
        : withFiles;
    },
  };
}
