// 账号的资料（名字、头像……）在 identity。群的推送每秒一份，不能每次都去问：取来的在内存里留一会儿。
import { ProfileList, type PublicProfile } from '@oasis/contracts/identity';
import { HttpError, type Logger, type ServiceClient } from '@oasis/service-kit';

/** 取来的资料用多久：账号改了名字、换了头像，最晚这么久以后群里看到 */
const TTL_MS = 30_000;
/** 内存里最多留多少人的 */
const KEEP = 5_000;
/** identity 一次最多给多少人的 */
const PAGE = 200;

export function createProfiles(deps: {
  identity: ServiceClient;
  logger: Logger;
  /** 第一次取到一个人、或者他改了名字时：让他在各个群里记着的名字跟着改 */
  onName?: (profile: PublicProfile) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { profile: PublicProfile; at: number }>();

  async function refresh(ids: string[], requestId: string | undefined) {
    for (let from = 0; from < ids.length; from += PAGE) {
      const { profiles } = await deps.identity.json('POST', '/internal/profiles', {
        body: { ids: ids.slice(from, from + PAGE) },
        schema: ProfileList,
        ...(requestId ? { requestId } : {}),
      });
      for (const profile of profiles) {
        const before = cache.get(profile.id)?.profile.name;
        cache.delete(profile.id);
        cache.set(profile.id, { profile, at: now() });
        if (before !== profile.name)
          await deps
            .onName?.(profile)
            .catch((err: unknown) => deps.logger.warn({ err }, '没能把账号的新名字记进群里'));
      }
    }
    // 留得太多了：最早放进来的先去掉
    for (const id of cache.keys()) {
      if (cache.size <= KEEP) break;
      cache.delete(id);
    }
  }

  /** 这些人的资料。identity 一时不通就用手上旧的；取不到的人不在结果里 */
  async function get(ids: string[], requestId?: string): Promise<Map<string, PublicProfile>> {
    const wanted = [...new Set(ids)];
    const stale = wanted.filter((id) => (cache.get(id)?.at ?? -Infinity) + TTL_MS <= now());
    if (stale.length)
      await refresh(stale, requestId).catch((err: unknown) =>
        deps.logger.warn({ err }, '取账号资料失败，先用手上的'),
      );
    return new Map(
      wanted.flatMap((id) => {
        const hit = cache.get(id);
        return hit ? [[id, hit.profile] as const] : [];
      }),
    );
  }

  return {
    get,
    /** 一个人的资料；没有这个人就 404 */
    async one(id: string, requestId?: string): Promise<PublicProfile> {
      const profile = (await get([id], requestId)).get(id);
      if (!profile) throw new HttpError(404, 'user_not_found', '没有这个人');
      return profile;
    },
  };
}
export type Profiles = ReturnType<typeof createProfiles>;
