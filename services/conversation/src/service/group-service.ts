import { createHash, randomBytes } from 'node:crypto';
import type { GroupRepo } from '../repo/group-repo.ts';

const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export function createGroupService(repo: GroupRepo) {
  return {
    list: repo.list,
    create: repo.create,
    get: repo.get,
    send: repo.send,
    remove: repo.remove,
    destroy: repo.destroy,
    revoke: repo.revoke,
    preview: (token: string) => repo.preview(hash(token)),
    redeem: (userId: string, token: string, displayName: string) =>
      repo.redeem(userId, hash(token), displayName),
    async invite(userId: string, id: string) {
      const token = randomBytes(32).toString('hex'),
        expiresAt = new Date(Date.now() + 24 * 3600000);
      await repo.invite(userId, id, hash(token), expiresAt);
      return { token, expiresAt: expiresAt.toISOString() };
    },
  };
}
export type GroupService = ReturnType<typeof createGroupService>;
