// 真的在 E2B 上开一个沙箱，验证执行器：起 dsh 握手、放文件、列清单、取文件、歇下再叫醒、收掉后工作目录
// 还在、删会话。平时跳过；要跑：先 pnpm sandbox:e2b 建好模板，再带上 OASIS_E2B_TEST=1 和 E2B_API_KEY
// （模板名不是默认的就给 E2B_TEMPLATE）。模型地址指向沙箱里一个没人听的端口，不花钱。
import { randomUUID } from 'node:crypto';
import { onlyFile, packFiles } from '@oasis/service-kit';
import pino from 'pino';
import { describe, expect, it } from 'vitest';
import {
  connectAgent,
  guideFiles,
  runtimeFiles,
  SANDBOX_PATHS,
  sandboxEnv,
} from '../src/adapter/dsh.ts';
import { createE2bExecutor } from '../src/executor/e2b.ts';

describe.skipIf(!process.env.OASIS_E2B_TEST)('E2B 上的沙箱（真的开一个）', () => {
  it('起 dsh、文件进出、歇下叫醒、收掉后接着用、删会话', async () => {
    const executor = createE2bExecutor({
      apiKey: process.env.E2B_API_KEY!,
      template: process.env.E2B_TEMPLATE ?? 'oasis-harness-sandbox',
      timeoutMs: 300_000,
      allowOut: [],
      workdir: SANDBOX_PATHS.workdir,
      logger: pino({ level: 'silent' }),
    });
    const session = randomUUID();
    const model = 'test/primary';
    const models = [
      {
        id: model,
        name: model,
        contextWindow: 1048576,
        maxTokens: 131072,
        input: ['text'] as 'text'[],
        reasoning: false,
      },
    ];
    const spec = (restore: boolean) => ({
      runId: randomUUID(),
      workspaceId: session,
      restore,
      env: sandboxEnv({
        runKey: 'oasis_run_test',
        model,
        place: {
          modelBaseUrl: 'http://127.0.0.1:9/v1',
          packages: {
            egressProxy: undefined,
            npmRegistry: 'https://registry.npmjs.org/',
            pipIndexUrl: 'https://pypi.org/simple',
          },
        },
      }),
      files: [] as { dir: string; tar: Buffer }[],
    });
    const fresh = spec(false);
    fresh.files = [
      {
        dir: SANDBOX_PATHS.workdir,
        tar: await packFiles([
          ...runtimeFiles({ models, sessionId: session }),
          { path: 'out/成果.md', content: Buffer.from('# 成果') },
        ]),
      },
      {
        dir: SANDBOX_PATHS.dshHome,
        tar: await packFiles(guideFiles({ rules: '# 测试\n', device: '', skills: [] }, '')),
      },
    ];
    try {
      expect(await executor.workspaceExists(session)).toBe(false);
      const sandbox = await executor.start(fresh);
      let stderr = '';
      sandbox.stderr.on('data', (text: Buffer) => (stderr += String(text)));
      const agent = connectAgent({
        stdin: sandbox.stdin,
        stdout: sandbox.stdout,
        sessionId: session,
        onEvent: () => undefined,
      });
      await agent.initialize(model, SANDBOX_PATHS.workdir).catch((err: unknown) => {
        throw new Error(`dsh 握手失败：${String(err)}；stderr：${stderr.slice(-800)}`);
      });

      // 放文件、跑命令、列清单、取文件
      await sandbox.put(
        SANDBOX_PATHS.workdir,
        await packFiles([{ path: 'materials/照片.txt', content: Buffer.from('photo') }]),
      );
      expect(await sandbox.run!(['sh', '-c', 'cat materials/照片.txt; id -un; exit 3'])).toBe(
        'photonode\n',
      );
      await expect(sandbox.exec(['false'])).rejects.toThrow(/退出码 1/);
      const listed = await executor.listWorkspace!(session, SANDBOX_PATHS.outputs);
      expect(listed.map((f) => [f.path, f.size])).toContainEqual(['成果.md', 8]);
      const read = await executor.readWorkspace(session, `${SANDBOX_PATHS.outputs}/成果.md`);
      const file = await onlyFile(read!, 1024);
      expect(Buffer.concat(await file.content.toArray()).toString()).toBe('# 成果');
      expect(
        await executor.readWorkspace(session, `${SANDBOX_PATHS.outputs}/没有.md`),
      ).toBeUndefined();

      // 歇下再叫醒：还是那个 dsh，能接着收话（模型连不上，这一轮以出错结束）
      await sandbox.sleep!();
      await sandbox.wake!();
      expect(agent.alive()).toBe(true);
      await agent.prompt('在吗');
      expect(typeof (await agent.waitIdle())).toBe('string');

      // 收掉：dsh 结束，沙箱暂停，工作目录还在；下一轮在同一个沙箱里重起
      await sandbox.destroy();
      expect(agent.alive()).toBe(false);
      expect(await executor.workspaceExists(session)).toBe(true);
      const again = await executor.start(spec(true));
      expect(again.id).toBe(sandbox.id);
      expect(await again.run!(['cat', 'out/成果.md'])).toBe('# 成果');
      await again.destroy();
    } finally {
      await executor.purgeWorkspace(session);
    }
    expect(await executor.workspaceExists(session)).toBe(false);
  }, 600_000);
});
