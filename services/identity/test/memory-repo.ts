// 内存版仓库：登录和资料的测试共用。
import type { EmailCode, IdentityRepo, User } from '../src/repo/identity-repo.ts';

/** 内存版仓库：只实现这些测试用到的行为。 */
export function memoryRepo() {
  const codes: EmailCode[] = [];
  const users: User[] = [];
  const sessions = new Map<string, { userId: string; expiresAt: Date; lastSeenAt: Date }>();
  const events: unknown[] = [];
  const avatars = new Map<string, { content: Buffer; type: string }>();
  const lookups = new Map<string, number[]>();
  let seq = 0;
  const repo: IdentityRepo = {
    recentCodes: async (email, since) =>
      codes
        .filter((c) => c.email === email && c.createdAt > since)
        .sort((a, b) => +b.createdAt - +a.createdAt),
    insertCode: async ({ email, codeHash, expiresAt }) => {
      const id = `00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`;
      codes.push({
        id,
        email,
        codeHash,
        expiresAt,
        attempts: 0,
        consumedAt: null,
        createdAt: new Date(now),
      });
      return id;
    },
    deleteCode: async (id) =>
      void codes.splice(
        codes.findIndex((c) => c.id === id),
        1,
      ),
    latestActiveCode: async (email, at) =>
      codes
        .filter((c) => c.email === email && !c.consumedAt && c.expiresAt > at)
        .sort((a, b) => +b.createdAt - +a.createdAt)[0],
    addAttempt: async (id) => void (codes.find((c) => c.id === id)!.attempts += 1),
    consumeCodeAndSignIn: async ({ codeId, email, session, registeredEvent }) => {
      const code = codes.find((c) => c.id === codeId)!;
      if (code.consumedAt) return undefined;
      code.consumedAt = new Date(now);
      let user = users.find((u) => u.email === email);
      const isNewUser = !user;
      if (!user) {
        user = {
          id: `11111111-1111-4111-8111-${String(users.length + 1).padStart(12, '0')}`,
          email,
          createdAt: new Date(now),
          accountNo: String(10000001 + users.length),
          name: `用户${String(users.length + 1).padStart(4, '0')}`,
          bio: '',
          gender: '',
          region: '',
          avatarType: null,
          avatarVersion: 0,
        };
        users.push(user);
        events.push(registeredEvent(user.id, user.createdAt));
      }
      sessions.set(session.tokenHash, {
        userId: user.id,
        expiresAt: session.expiresAt,
        lastSeenAt: new Date(now),
      });
      return { user, isNewUser };
    },
    findUser: async (id) => users.find((u) => u.id === id),
    findSession: async (tokenHash, at) => {
      const s = sessions.get(tokenHash);
      return s && s.expiresAt > at ? { userId: s.userId, lastSeenAt: s.lastSeenAt } : undefined;
    },
    takeLookup: async (userId, at, since, limit) => {
      const recent = (lookups.get(userId) ?? []).filter((t) => t > since.getTime());
      if (recent.length >= limit) return false;
      lookups.set(userId, [...recent, at.getTime()]);
      return true;
    },
    findByAccountNo: async (accountNo) => users.find((u) => u.accountNo === accountNo),
    findUsers: async (ids) => users.filter((u) => ids.includes(u.id)),
    updateProfile: async (id, profile) => {
      const user = users.find((u) => u.id === id);
      return user && Object.assign(user, profile);
    },
    setAvatar: async (id, avatar) => {
      const user = users.find((u) => u.id === id);
      if (!user) return undefined;
      if (avatar) avatars.set(id, avatar);
      else avatars.delete(id);
      user.avatarType = avatar?.type ?? null;
      user.avatarVersion += 1;
      return user;
    },
    avatar: async (id) => avatars.get(id),
    touchSession: async () => undefined,
    deleteSession: async (tokenHash) => void sessions.delete(tokenHash),
  };
  let now = Date.parse('2026-10-22T00:00:00Z');
  return { repo, users, events, advance: (ms: number) => (now += ms), now: () => new Date(now) };
}
