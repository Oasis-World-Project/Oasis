// 账号资料：改资料、按账号 ID 查人、头像。
import { describe, expect, it } from 'vitest';
import type { User } from '../src/repo/identity-repo.ts';
import { createProfileService } from '../src/service/profile-service.ts';
import { memoryRepo } from './memory-repo.ts';

const user = (n: number): User => ({
  id: `11111111-1111-4111-8111-00000000000${n}`,
  email: `u${n}@x.com`,
  createdAt: new Date(0),
  accountNo: `1000000${n}`,
  name: `用户000${n}`,
  bio: '',
  gender: '',
  region: '',
  avatarType: null,
  avatarVersion: 0,
});
const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');

function setup() {
  const memory = memoryRepo();
  memory.users.push(user(1), user(2));
  let at = 0;
  const profiles = createProfileService({ repo: memory.repo, now: () => at });
  return { profiles, me: user(1).id, other: user(2), tick: (ms: number) => (at += ms) };
}
const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'no-error',
    (err: { code: string }) => err.code,
  );

describe('账号资料', () => {
  it('改名字、签名、性别、地区；别人看到的资料里没有邮箱', async () => {
    const { profiles, me } = setup();
    const mine = await profiles.update(me, {
      name: '阿凯',
      bio: '周五见',
      gender: 'male',
      region: '新加坡',
    });
    expect(mine).toMatchObject({ name: '阿凯', bio: '周五见', email: 'u1@x.com' });
    const [seen] = await profiles.profiles([me, me]);
    expect(seen).toEqual({
      id: me,
      accountNo: '10000001',
      name: '阿凯',
      bio: '周五见',
      gender: 'male',
      region: '新加坡',
      avatarVersion: 0,
    });
  });

  it('按账号 ID 查人：没有这个号 404；一分钟最多查 20 次，过一分钟又能查', async () => {
    const { profiles, me, other, tick } = setup();
    expect(await profiles.lookup(me, other.accountNo)).toMatchObject({ id: other.id });
    expect(await codeOf(profiles.lookup(me, '99999999'))).toBe('user_not_found');
    for (let i = 0; i < 18; i += 1) await profiles.lookup(me, other.accountNo);
    expect(await codeOf(profiles.lookup(me, other.accountNo))).toBe('lookup_rate_limited');
    // 各人算各人的
    expect(await profiles.lookup(other.id, '10000001')).toMatchObject({ id: me });
    tick(61_000);
    expect(await profiles.lookup(me, other.accountNo)).toMatchObject({ id: other.id });
  });

  it('头像：只收真的图片、最多 200 KB；每换一次版本加一；去掉后读不到', async () => {
    const { profiles, me } = setup();
    expect(
      await codeOf(profiles.setAvatar(me, 'image/png', Buffer.from('<svg/>').toString('base64'))),
    ).toBe('avatar_invalid');
    expect(
      await codeOf(
        profiles.setAvatar(
          me,
          'image/png',
          Buffer.concat([PNG, Buffer.alloc(200_001)]).toString('base64'),
        ),
      ),
    ).toBe('avatar_too_large');
    expect((await profiles.setAvatar(me, 'image/png', PNG.toString('base64'))).avatarVersion).toBe(
      1,
    );
    expect(await profiles.avatar(me)).toEqual({ content: PNG, type: 'image/png' });
    // 去掉以后别人看到的是「没有头像」；再传一张，地址和第一张不一样（版本接着往上加）
    expect((await profiles.clearAvatar(me)).avatarVersion).toBe(0);
    expect(await codeOf(profiles.avatar(me))).toBe('avatar_not_found');
    expect((await profiles.setAvatar(me, 'image/png', PNG.toString('base64'))).avatarVersion).toBe(
      3,
    );
  });
});
