// 测试用的内存版对象存储和成果仓库。
import { Readable } from 'node:stream';
import type { ObjectStore } from '@oasis/service-kit';
import type { Artifact, ArtifactsRepo } from '../src/repo/artifacts-repo.ts';

export function memoryStore(): ObjectStore & {
  objects: Map<string, { body: Buffer; type: string }>;
} {
  const objects = new Map<string, { body: Buffer; type: string }>();
  return {
    objects,
    put: async (key, body, type) => {
      objects.set(key, { body, type });
    },
    get: async (key) => {
      const found = objects.get(key);
      if (!found) throw new Error('missing');
      return found.body;
    },
    read: async (key, range) => {
      const found = objects.get(key);
      if (!found) throw new Error('missing');
      return Readable.from([range ? found.body.subarray(range.start, range.end + 1) : found.body]);
    },
  };
}

export function memoryArtifacts(): ArtifactsRepo & { rows: Artifact[] } {
  const rows: Artifact[] = [];
  let clock = Date.parse('2026-10-24T08:00:00Z');
  return {
    rows,
    async insert(artifact) {
      if (
        rows.some(
          (r) =>
            r.taskId === artifact.taskId &&
            r.nodeId === artifact.nodeId &&
            r.path === artifact.path,
        )
      )
        return false;
      if (rows.some((r) => r.ownerId === artifact.ownerId && r.syncPath === artifact.syncPath))
        throw new Error('sync_path 重复');
      rows.push({ ...artifact, createdAt: new Date((clock += 1000)) });
      return true;
    },
    find: async (id) => rows.find((r) => r.id === id),
    list: async (ownerId, filter, limit) =>
      rows
        .filter(
          (r) =>
            r.ownerId === ownerId &&
            (!filter.category || r.category === filter.category) &&
            (!filter.taskId || r.taskId === filter.taskId),
        )
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, limit),
    listByTask: async (taskId) => rows.filter((r) => r.taskId === taskId),
    syncDirs: async (ownerId, exceptTaskId) => [
      ...new Set(
        rows
          .filter((r) => r.ownerId === ownerId && r.taskId !== exceptTaskId)
          .map((r) => r.syncPath.split('/')[0] ?? ''),
      ),
    ],
  };
}
