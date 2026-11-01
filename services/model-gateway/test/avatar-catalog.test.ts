import { describe, expect, it } from 'vitest';
import type { CatalogAvatar, LiveAvatarClient } from '../src/adapters/liveavatar.ts';
import { createAvatarCatalog } from '../src/service/avatar-catalog.ts';
import { fakeClient } from './avatar-fakes.ts';

const avatar = (name: string, custom = false): CatalogAvatar => ({
  id: `id-${name}`,
  name,
  previewUrl: `https://cdn.test/${encodeURIComponent(name)}.webp`,
  is1080p: true,
  portrait: /portrait/i.test(name),
  defaultVoice: 'Ann',
  custom,
});

function client(loads: { count: number }): LiveAvatarClient {
  return {
    ...fakeClient().client,
    listAvatars: async () => {
      loads.count += 1;
      return [
        avatar('Silas Customer Support'),
        avatar('Katya in Black Suit'),
        avatar('Katya in Black Suit (Portrait)'),
        avatar('我的二次元前台', true),
      ];
    },
    listVoices: async () => [
      { id: 'v1', name: 'Ann', language: 'en', gender: 'female' },
      { id: 'v2', name: 'Wolf', language: 'en', gender: 'male' },
    ],
  };
}

describe('avatar.catalog', () => {
  it('按关键词和横竖屏筛形象，用户自建的排前面；按性别筛声音；不花钱；列表缓存', async () => {
    const loads = { count: 0 };
    const catalog = createAvatarCatalog(client(loads));
    expect(catalog.entry()).toMatchObject({
      key: 'avatar.catalog',
      available: true,
      estimateMicro: 0,
    });

    const all = await catalog.run({});
    expect(all.costMicro).toBe(0);
    const data = all.data as { avatars: CatalogAvatar[]; voices: unknown[] };
    expect(data.avatars.map((a) => a.name)).toEqual([
      '我的二次元前台',
      'Silas Customer Support',
      'Katya in Black Suit',
    ]);
    expect(all.text).toContain('[用户自建] 我的二次元前台 | id-我的二次元前台');

    const portrait = await catalog.run({
      query: 'katya suit',
      orientation: 'portrait',
      gender: 'male',
    });
    expect((portrait.data as { avatars: CatalogAvatar[] }).avatars.map((a) => a.name)).toEqual([
      'Katya in Black Suit (Portrait)',
    ]);
    expect((portrait.data as { voices: { name: string }[] }).voices.map((v) => v.name)).toEqual([
      'Wolf',
    ]);
    expect(loads.count).toBe(1);
  });

  it('没配 Key 时不能用；参数不对时说清楚', async () => {
    const off = createAvatarCatalog({ ...client({ count: 0 }), configured: false });
    expect(off.entry().available).toBe(false);
    await expect(off.run({})).rejects.toMatchObject({ statusCode: 503 });
    const on = createAvatarCatalog(client({ count: 0 }));
    await expect(on.run({ orientation: 'sideways' })).rejects.toMatchObject({ statusCode: 400 });
  });
});
