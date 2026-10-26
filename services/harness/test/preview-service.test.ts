import { pino } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { ServiceClient } from '@oasis/service-kit';
import type { PreviewExecutor } from '../src/executor/preview-executor.ts';
import type { PreviewRepo, PreviewRow } from '../src/repo/preview-repo.ts';
import { createPreviewService } from '../src/service/preview-service.ts';

const access = {
  artifactId: '00000000-0000-4000-8000-000000000001',
  ownerId: '00000000-0000-4000-8000-000000000002',
  taskId: '00000000-0000-4000-8000-000000000003',
};

function fixture() {
  const rows = new Map<string, PreviewRow>();
  const repo: PreviewRepo = {
    async insert(value) {
      if (
        [...rows.values()].some(
          (row) =>
            row.ownerId === value.ownerId &&
            ['starting', 'running', 'stopping'].includes(row.status),
        )
      )
        return false;
      rows.set(value.id, {
        ...value,
        status: 'starting',
        containerId: null,
        computeCallId: null,
        heldMicro: 0,
        spentMicro: null,
        startedAt: null,
        lastInputAt: null,
        stoppedAt: null,
        error: null,
        createdAt: new Date(),
      });
      return true;
    },
    async latest(artifactId, ownerId) {
      return [...rows.values()]
        .reverse()
        .find((row) => row.artifactId === artifactId && row.ownerId === ownerId);
    },
    async active(ownerId) {
      return [...rows.values()].find(
        (row) =>
          row.ownerId === ownerId && ['starting', 'running', 'stopping'].includes(row.status),
      );
    },
    async update(id, patch) {
      Object.assign(rows.get(id)!, patch);
    },
    async unfinished() {
      return [...rows.values()].filter((row) =>
        ['starting', 'running', 'stopping'].includes(row.status),
      );
    },
  };
  const destroy = vi.fn(async () => undefined);
  const start = vi.fn(async () => ({
    id: 'container-1',
    frame: () => ({ seq: 1, jpegBase64: 'AA==' }),
    input: vi.fn(),
    ready: async () => undefined,
    destroy,
  }));
  const executor = {
    check: vi.fn(async () => undefined),
    start,
    destroy,
    removeOrphans: vi.fn(async () => 0),
  } as unknown as PreviewExecutor;
  const canvas = {
    json: vi.fn(async () => ({
      spec: { version: 1, kind: 'static', root: 'site', entry: 'index.html' },
      files: [
        { path: 'oasis-app.json', contentBase64: 'e30=' },
        { path: 'index.html', contentBase64: 'PGgxPk9LPC9oMT4=' },
      ],
    })),
  } as unknown as ServiceClient;
  const modelGateway = {
    json: vi.fn(async (method: string, path: string) => {
      if (path.startsWith('/internal/v1/compute/quote')) return { maxMicro: 500 };
      if (method === 'POST' && path === '/internal/v1/compute')
        return { callId: '00000000-0000-4000-8000-000000000004', heldMicro: 500 };
      if (method === 'GET') return { status: 'succeeded', chargedMicro: 25 };
      return undefined;
    }),
  } as unknown as ServiceClient;
  const service = createPreviewService({
    repo,
    executor,
    canvas,
    modelGateway,
    logger: pino({ level: 'silent' }),
    cpus: 2,
    maxMs: 60_000,
    idleMs: 20_000,
  });
  return { rows, service, start, destroy, modelGateway, executor };
}

describe('私有预览生命周期', () => {
  it('重复启动同一会话，停止后结算一次并可重开', async () => {
    const { service, start, destroy, modelGateway } = fixture();
    try {
      const first = await service.start(access);
      expect(first.status).toBe('running');
      expect(first.heldMicro).toBe(500);
      expect((await service.start(access)).id).toBe(first.id);
      expect(start).toHaveBeenCalledTimes(1);
      expect((await service.frame(access)).seq).toBe(1);
      const stopped = await service.stop(access);
      expect(stopped.spentMicro).toBe(25);
      expect((await service.stop(access)).id).toBe(first.id);
      expect(destroy).toHaveBeenCalledTimes(1);
      expect(
        vi
          .mocked(modelGateway.json)
          .mock.calls.filter(
            ([method, path]) => method === 'POST' && String(path).endsWith('/settle'),
          ),
      ).toHaveLength(1);
      expect((await service.start(access)).id).not.toBe(first.id);
    } finally {
      await service.close();
    }
  });
  it('重启回收活动容器，结算后清理孤儿容器', async () => {
    const { service, executor } = fixture();
    await service.start(access);
    await service.recover();
    expect((await service.current(access))?.status).toBe('stopped');
    expect(executor.removeOrphans).toHaveBeenCalledTimes(1);
    await service.close();
  });
});
