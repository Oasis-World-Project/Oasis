// 真实沙箱镜像（OASIS_NATIVE_IMAGE）：每个用户一块的缓存卷跨会话还在、超过上限从最久没用的删起；
// 开工前执行项目里的 oasis-setup.sh，结果写成给 AI 的说明。
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createDockerApi, defaultDockerSocket, packFiles } from '@oasis/service-kit';
import { SANDBOX_PATHS } from '../src/adapter/dsh.ts';
import { createDockerExecutor } from '../src/executor/executor.ts';
import { setupNote } from '../src/service/run/setup.ts';

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE)('缓存卷和开工前的脚本（真实沙箱）', () => {
  it('缓存卷换一个会话还在；超了上限删最久没用的；oasis-setup.sh 的结果交给 AI', async () => {
    const docker = createDockerApi(defaultDockerSocket());
    const owner = randomUUID();
    const sessions = [randomUUID(), randomUUID()];
    const executor = (maxMb: number) =>
      createDockerExecutor({
        docker,
        image: process.env.OASIS_NATIVE_IMAGE!,
        network: 'none',
        cpus: 1,
        memoryMb: 1024,
        pidsLimit: 256,
        workdir: SANDBOX_PATHS.workdir,
        sessionsDir: SANDBOX_PATHS.sessions,
        cache: { dir: SANDBOX_PATHS.cache, maxMb },
      });
    const script = [
      'mkdir -p /cache/npm/old /cache/pip/new',
      'head -c 3000000 /dev/zero > /cache/npm/old/blob',
      'touch -a -d "2020-01-01" /cache/npm/old/blob',
      'echo kept > /cache/pip/new/marker',
      'echo SETUP_RAN in $(basename "$PWD")',
    ].join('\n');
    const start = async (index: number, maxMb: number) =>
      executor(maxMb).start({
        runId: randomUUID(),
        workspaceId: sessions[index]!,
        cacheId: owner,
        env: {},
        files: index
          ? []
          : [
              {
                dir: SANDBOX_PATHS.workdir,
                tar: await packFiles([
                  { path: 'shop/oasis-setup.sh', content: Buffer.from(script) },
                  { path: 'slow/oasis-setup.sh', content: Buffer.from('sleep 30') },
                ]),
              },
            ],
      });
    const first = await start(0, 100);
    try {
      const note = await setupNote(first, SANDBOX_PATHS.workdir, 2);
      expect(note).toContain('shop/oasis-setup.sh：退出码 0');
      expect(note).toContain('SETUP_RAN in shop');
      expect(note).toContain('slow/oasis-setup.sh：超过 2 秒被停下了');
    } finally {
      await first.destroy();
    }
    // 另一个会话、同一个人：缓存还在；这次上限 1 MB，最久没用的那一份被删掉，新的留着
    const second = await start(1, 1);
    try {
      const listing = await second.run!([
        'sh',
        '-c',
        'ls /cache/npm /cache/pip/new; cat /cache/pip/new/marker',
      ]);
      expect(listing).toContain('kept');
      expect(listing).not.toContain('old');
    } finally {
      await second.destroy();
      for (const id of sessions) await executor(1).purgeWorkspace(id);
      await docker.removeVolume(`oasis-cache-${owner}`);
    }
  }, 120_000);
});
