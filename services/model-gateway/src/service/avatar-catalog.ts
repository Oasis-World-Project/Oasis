// 工具 avatar.catalog（ADR 0013 §3）：给做数字人的节点查能用的形象和声音。只读、不花钱，不走计量。
// 公共形象有好几百个，按关键词和横竖屏筛，每次最多返回 60 个；列表缓存 10 分钟。
import type { ToolEntry, ToolResult } from '@oasis/contracts/model-gateway';
import { HttpError } from '@oasis/service-kit';
import { z } from 'zod';
import type { CatalogAvatar, CatalogVoice, LiveAvatarClient } from '../adapters/liveavatar.ts';

export const AVATAR_CATALOG_TOOL = 'avatar.catalog';
const CACHE_MS = 10 * 60_000;
const MAX_AVATARS = 60;

const Args = z.object({
  /** 形象名字里的关键词（英文，如 Customer Support、Suit、Doctor、Teacher） */
  query: z.string().trim().max(60).optional(),
  orientation: z.enum(['landscape', 'portrait', 'any']).default('landscape'),
  /** 声音的性别 */
  gender: z.enum(['male', 'female', 'any']).default('any'),
});

export function createAvatarCatalog(client: LiveAvatarClient, now: () => number = Date.now) {
  let cache: { at: number; avatars: CatalogAvatar[]; voices: CatalogVoice[] } | undefined;

  async function load() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    const [avatars, voices] = await Promise.all([client.listAvatars(), client.listVoices()]);
    cache = { at: now(), avatars, voices };
    return cache;
  }

  return {
    entry(): ToolEntry {
      return {
        key: AVATAR_CATALOG_TOOL,
        name: '数字人形象和声音',
        description:
          '列出实时数字人能用的形象（公共形象和用户在 LiveAvatar 后台自建的）和声音，写数字人配置文件时用来挑 avatarId、voiceId 和预览图。不花钱。',
        usage:
          'oasis-tool avatar.catalog [--query "Customer Support"] [--orientation landscape|portrait|any] [--gender female|male|any]',
        unit: '次',
        estimateMicro: 0,
        long: false,
        available: client.configured,
        models: [],
        defaultModel: null,
        rates: [],
      };
    },

    async run(rawArgs: Record<string, unknown>): Promise<ToolResult> {
      if (!client.configured) {
        throw new HttpError(503, 'tool_unavailable', '数字人服务还没有配置好，现在用不了');
      }
      const parsed = Args.safeParse(rawArgs);
      if (!parsed.success) {
        throw new HttpError(400, 'invalid_tool_args', '参数不对：query、orientation、gender');
      }
      const args = parsed.data;
      let catalog: Awaited<ReturnType<typeof load>>;
      try {
        catalog = await load();
      } catch {
        throw new HttpError(502, 'tool_provider_error', '数字人服务暂时连不上，请稍后再试');
      }
      const words = (args.query ?? '').toLowerCase().split(/\s+/).filter(Boolean);
      const matched = catalog.avatars.filter(
        (a) =>
          (args.orientation === 'any' || a.portrait === (args.orientation === 'portrait')) &&
          words.every((w) => a.name.toLowerCase().includes(w)),
      );
      // 用户自建的排在前面
      matched.sort((a, b) => Number(b.custom) - Number(a.custom));
      const avatars = matched.slice(0, MAX_AVATARS);
      const voices = catalog.voices.filter(
        (v) => args.gender === 'any' || v.gender === args.gender,
      );
      const text = [
        `形象：符合条件的 ${matched.length} 个${matched.length > avatars.length ? `，这里列前 ${avatars.length} 个（加 --query 缩小范围）` : ''}。每行：名字 | avatarId | 预览图 | 默认声音`,
        ...avatars.map(
          (a) =>
            `${a.custom ? '[用户自建] ' : ''}${a.name} | ${a.id} | ${a.previewUrl ?? '-'} | ${a.defaultVoice ?? '-'}${a.is1080p ? ' | 1080p' : ''}`,
        ),
        '',
        `声音：${voices.length} 个。每行：名字 | voiceId | 性别。都能说多种语言（标的是原始语言）；不填 voiceId 时用形象的默认声音。`,
        ...voices.map((v) => `${v.name} | ${v.id} | ${v.gender ?? '-'}`),
      ].join('\n');
      return {
        tool: AVATAR_CATALOG_TOOL,
        text,
        data: { avatars, voices },
        files: [],
        costMicro: 0,
      };
    },
  };
}

export type AvatarCatalog = ReturnType<typeof createAvatarCatalog>;
