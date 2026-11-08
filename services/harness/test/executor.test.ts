import { createDockerApi, defaultDockerSocket } from '@oasis/service-kit';
import { describe, expect, it, vi } from 'vitest';
import { createDockerExecutor } from '../src/executor/executor.ts';

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE)('实际镜像环境探测', () => {
  it('从实际二进制探测并按镜像摘要缓存，不宣称不存在的本地浏览器', async () => {
    const docker = createDockerApi(defaultDockerSocket());
    const executor = createDockerExecutor({
      docker: {
        ...docker,
        createContainer: (name, spec) =>
          docker.createContainer(name, {
            ...spec,
            Labels: {
              ...(spec.Labels as Record<string, string>),
              'oasis.component': 'harness-probe-test',
            },
          }),
      },
      image: process.env.OASIS_NATIVE_IMAGE!,
      network: 'none',
      cpus: 1,
      memoryMb: 2048,
      pidsLimit: 512,
      workdir: '/workspace',
    });
    const result = await executor.environment!();
    expect(result.capabilities).toEqual(
      expect.arrayContaining(['node', 'python', 'ffmpeg', 'libreoffice', 'pdf']),
    );
    expect(result.imageId).toMatch(/^sha256:/);
    expect(result.capabilities).not.toContain('browser');
    expect((await executor.environment!()).imageId).toBe(result.imageId);
    if (process.env.OASIS_NATIVE_IMAGE!.includes('sandbox-3d'))
      expect(result.capabilities).toContain('blender');
  }, 90000);
});

describe('Docker 接管停止证据', () => {
  it.each([true, false])('容器存在=%s：只报告匹配运行的实际停止时间', async (exists) => {
    const stopContainer = vi.fn(async () => undefined);
    const inspectContainer = vi.fn(async () => ({
      State: { Running: false, Paused: false, FinishedAt: '2026-11-04T01:00:00.000Z' },
      HostConfig: { NanoCpus: 2e9 },
    }));
    const executor = createDockerExecutor({
      docker: {
        ...createDockerApi(defaultDockerSocket()),
        listContainers: async () => [
          { Id: 'other', Labels: { 'oasis.run-id': 'other' } },
          ...(exists ? [{ Id: 'ours', Labels: { 'oasis.run-id': 'ours' } }] : []),
        ],
        stopContainer,
        inspectContainer,
      },
      image: 'oasis/test:1',
      network: 'none',
      cpus: 1,
      memoryMb: 1024,
      pidsLimit: 128,
      workdir: '/workspace',
    });
    const evidence = await executor.suspend!('ours');
    if (exists) {
      expect(evidence).toEqual({ endedAt: new Date('2026-11-04T01:00:00.000Z'), cores: 2 });
      expect(stopContainer.mock.calls).toEqual([['ours']]);
      expect(inspectContainer.mock.calls).toEqual([['ours']]);
    } else {
      expect(evidence).toBeUndefined();
      expect(stopContainer).not.toHaveBeenCalled();
      expect(inspectContainer).not.toHaveBeenCalled();
    }
  });
});
