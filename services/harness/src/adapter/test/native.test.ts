// 显式指定已构建的镜像后验证真实 DSH；假模型只在断网容器的回环接口运行，费用为 0。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { connectAgent, runtimeFiles } from '../dsh.ts';

it.skipIf(!process.env.OASIS_NATIVE_IMAGE)(
  '原生目标跨截断、多轮租约和跨模型子代理执行，实际写出文件才结束',
  async () => {
    const image = process.env.OASIS_NATIVE_IMAGE!;
    if (!/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(image)) throw new Error('test image must use oasis/');
    const directory = await mkdtemp(join(tmpdir(), 'oasis-native-'));
    const name = `oasis-native-${randomUUID()}`;
    const models = ['deepseek/deepseek-v4.1-flash', 'test/secondary', 'test/tertiary'].map(
      (id) => ({
        id,
        name: id,
        contextWindow: 1048576,
        maxTokens: id.startsWith('test/') ? 131072 : 943718,
        input: ['text', 'image'] as ('text' | 'image')[],
        reasoning: true,
      }),
    );
    for (const file of runtimeFiles({
      models,
      sessionId: 'root',
      objective: 'Write out/proof.txt using a delegated secondary model, then complete the goal.',
      goal: true,
      goalRoundWindow: 2,
    })) {
      await writeFile(join(directory, file.path.split('/').at(-1)!), file.content);
    }
    await writeFile(
      join(directory, 'provider.mjs'),
      await readFile(new URL('./native-provider.mjs', import.meta.url)),
    );
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        '--pull',
        'never',
        '-i',
        '--name',
        name,
        '--network',
        'none',
        '--memory',
        '2g',
        '--pids-limit',
        '512',
        '--mount',
        `type=bind,source=${directory},target=/workspace/in,readonly`,
        '--entrypoint',
        'node',
        image,
        '/workspace/in/provider.mjs',
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    const exited = new Promise<number | null>((resolve, reject) => {
      child.once('exit', resolve);
      child.once('error', reject);
    });
    let nested = false;
    const agent = connectAgent({
      stdin: child.stdin,
      stdout: child.stdout,
      sessionId: 'root',
      goal: true,
      onEvent: (event) => {
        if (event.data.status === 'subagent_started' && event.data.parentSessionId !== 'root')
          nested = true;
      },
    });
    const timer = setTimeout(() => {
      agent.abort(new Error('explicit offline acceptance timeout'));
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    }, 90_000);
    try {
      await agent.initialize('deepseek/deepseek-v4.1-flash', '/workspace');
      await agent.prompt('Carry out the current goal and mark it complete when verified.');
      expect(await agent.waitIdle(), stderr).toBeUndefined();
      await agent.shutdown();
      expect(await exited, stderr).toBe(0);
      expect(stderr).toContain('NATIVE_PROOF');
      expect(nested).toBe(true);
      expect(stderr).not.toContain('did not activate');
    } finally {
      clearTimeout(timer);
      agent.abort(new Error('acceptance finished'));
      spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
      await exited.catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
