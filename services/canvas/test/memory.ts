// 测试用的内存版对象存储和成果仓库。
import { Readable } from 'node:stream';
import { checkedParts, type ObjectStore } from '@oasis/service-kit';
import type { Upload, UploadsRepo } from '../src/repo/uploads-repo.ts';
import type { Artifact, ArtifactsRepo } from '../src/repo/artifacts-repo.ts';

export function memoryStore(): ObjectStore & {
  objects: Map<string, { body: Buffer; type: string }>;
} {
  const objects = new Map<string, { body: Buffer; type: string }>();
  return {
    objects,
    sign: async (key, method, expiresIn) =>
      `http://s3.test/oasis-canvas/${key}?method=${method}&expires=${expiresIn}`,
    delete: async (key) => {
      objects.delete(key);
    },
    putStream: async (key, source, type, limits) => {
      const iterator = checkedParts(source, limits);
      const chunks: Buffer[] = [];
      for (;;) {
        const part = await iterator.next();
        if (part.done) {
          objects.set(key, { body: Buffer.concat(chunks), type });
          return part.value;
        }
        chunks.push(part.value);
      }
    },
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
      rows.push({
        annotations: [],
        approvedAt: null,
        ...artifact,
        createdAt: new Date((clock += 1000)),
      });
      return true;
    },
    async setReview(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (row) Object.assign(row, patch);
      return row;
    },
    async replaceContent(id, patch) {
      const row = rows.find((r) => r.id === id);
      if (row)
        Object.assign(row, patch, { annotations: [], approvedAt: null, createdAt: new Date() });
    },
    find: async (id) => rows.find((r) => r.id === id),
    async setAvatar(id, spec) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.avatarSpec = spec;
        row.category = 'app';
      }
    },
    async setApplication(id, spec) {
      const row = rows.find((r) => r.id === id);
      if (row) {
        row.appSpec = spec;
        row.category = 'app';
      }
    },
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
    async removeRows(artifactIds) {
      const kept = rows.filter((r) => !artifactIds.includes(r.id));
      rows.length = 0;
      rows.push(...kept);
    },
  };
}

export function memoryUploads(): UploadsRepo & { rows: Map<string, Upload> } {
  const rows = new Map<string, Upload>();
  return {
    rows,
    async insert(upload) {
      const row = { claimedAt: null, ...upload, createdAt: new Date() };
      rows.set(row.id, row);
      return row;
    },
    find: async (id) => rows.get(id),
    findOwned: async (ownerId, ids) =>
      [...rows.values()].filter(
        (row) => row.ownerId === ownerId && row.state === 'ready' && ids.includes(row.id),
      ),
    async complete(id, info) {
      const row = rows.get(id)!;
      Object.assign(row, info, { state: 'ready' });
      return row;
    },
    async remove(id) {
      rows.delete(id);
    },
    stale: async (before) =>
      [...rows.values()].filter((row) => row.state === 'uploading' && row.createdAt < before),
    async claim(ownerId, ids) {
      for (const id of ids) {
        const row = rows.get(id);
        if (row && row.ownerId === ownerId && !row.claimedAt) row.claimedAt = new Date();
      }
    },
    unclaimed: async (before) =>
      [...rows.values()].filter(
        (row) => row.state === 'ready' && !row.claimedAt && row.createdAt < before,
      ),
  };
}
