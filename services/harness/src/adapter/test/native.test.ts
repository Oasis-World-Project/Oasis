// 显式指定已构建的镜像后验证真实 DSH；假模型只在断网容器的回环接口运行，费用为 0。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectAgent, runtimeFiles } from '../dsh.ts';

async function runNative(
  options: {
    fixture?: Buffer;
    resume?: boolean;
    refused?: boolean;
    additionalModel?: boolean;
    generation?: number;
    recovering?: boolean;
    bootstrap?: boolean;
    networkFault?: boolean;
    contextOverflow?: boolean;
    attachmentRoundTrip?: boolean;
  } = {},
) {
  const image = process.env.OASIS_NATIVE_IMAGE!;
  const sessionId = options.recovering ? 'root' : options.resume ? 'legacy-root' : 'root';
  if (!/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(image)) throw new Error('test image must use oasis/');
  const directory = await mkdtemp(join(tmpdir(), 'oasis-native-'));
  const name = `oasis-native-${randomUUID()}`;
  await mkdir(join(directory, 'evidence'));
  const models = [
    'deepseek/deepseek-v4.1-flash',
    'test/secondary',
    'test/tertiary',
    ...(options.additionalModel ? ['test/unapproved'] : []),
  ].map((id) => ({
    id,
    name: id,
    contextWindow: 1048576,
    maxTokens: id.startsWith('test/') ? 131072 : 943718,
    input: ['text', 'image'] as ('text' | 'image')[],
    reasoning: true,
  }));
  for (const file of runtimeFiles({
    models,
    sessionId,
    objective: 'Write out/proof.txt using a delegated secondary model, then complete the goal.',
    goal: true,
    goalRoundWindow: 2,
    recovering: options.recovering,
  })) {
    await writeFile(join(directory, file.path.split('/').at(-1)!), file.content);
  }
  if (options.fixture)
    await writeFile(join(directory, 'legacy-session.jsonl.zstd'), options.fixture);
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
      '--env',
      `OASIS_NATIVE_MODE=${options.recovering && !options.bootstrap ? 'recover' : options.refused ? 'refuse' : options.resume ? 'resume' : 'fresh'}`,
      '--env',
      `OASIS_NATIVE_GENERATION=${options.generation ?? 4}`,
      '--env',
      `OASIS_NATIVE_FAULT=${options.networkFault ? 'disconnect' : options.contextOverflow ? 'context-overflow' : options.attachmentRoundTrip ? 'attachment' : ''}`,
      '--memory',
      '2g',
      '--pids-limit',
      '512',
      '--mount',
      `type=bind,source=${directory},target=/workspace/in,readonly`,
      '--mount',
      `type=bind,source=${join(directory, 'evidence')},target=/workspace/evidence`,
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
    sessionId,
    goal: true,
    onEvent: (event) => {
      if (event.data.status === 'subagent_started' && event.data.parentSessionId !== sessionId)
        nested = true;
    },
  });
  const timer = setTimeout(() => {
    agent.abort(new Error('explicit offline acceptance timeout'));
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  }, 90_000);
  try {
    await agent.initialize('deepseek/deepseek-v4.1-flash', '/workspace');
    if (options.refused) {
      await expect(agent.resume()).rejects.toThrow();
      await agent.shutdown();
      expect(await exited, stderr).toBe(0);
      expect(stderr).toContain('NATIVE_REFUSED 0');
      return;
    }
    if (options.resume) await agent.resume();
    if (!options.recovering || options.bootstrap)
      await agent.prompt('Carry out the current goal and mark it complete when verified.');
    expect(await agent.waitIdle(), stderr).toBeUndefined();
    await agent.shutdown();
    expect(await exited, stderr).toBe(0);
    expect(stderr).toContain('NATIVE_PROOF');
    expect(stderr).toContain('"policyCount":1');
    expect(stderr).not.toContain('test/unapproved');
    expect(nested).toBe(!options.recovering || Boolean(options.bootstrap));
    if (options.recovering && !options.bootstrap) expect(stderr).toContain('"rootCalls":0');
    expect(stderr).not.toContain('did not activate');
    if (options.contextOverflow) {
      expect(stderr).toContain('"checkpointSeen":true');
      expect(stderr).toContain('"compactions":1');
      expect(stderr).toContain('"compactionSummaries":1');
      expect(stderr).toContain('"failedCompactions":0');
    }
    if (options.attachmentRoundTrip) expect(stderr).toContain('"attachmentRecovered":true');
    return await readFile(join(directory, 'evidence/session.jsonl.zstd'));
  } finally {
    clearTimeout(timer);
    agent.abort(new Error('acceptance finished'));
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    await exited.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE)('精确版本 DSH 离线集成', () => {
  it('原生目标跨截断、多轮租约和跨模型子代理执行，实际写出文件才结束', () => runNative(), 120_000);
  it(
    'Oasis profile 保留原生自动压缩：上下文溢出后生成持久摘要，并在同一目标继续完成',
    () => runNative({ contextOverflow: true }),
    120_000,
  );
  it(
    '原生 read_image 对象随 sessions 快照完整恢复，独立附件服务能按原引用读取',
    () => runNative({ attachmentRoundTrip: true }),
    120_000,
  );
  it(
    '原生供应商读取到真实连接中断时，保留同一目标重试并完成',
    () => runNative({ networkFault: true }),
    120_000,
  );
  it(
    '控制进程在原生会话创建前退出，原子请求可以首次执行而不会误判为恢复损坏',
    () => runNative({ recovering: true, bootstrap: true }),
    120_000,
  );
  it('已完成目标在接管时不创建新目标、不重发用户任务、不调用模型', async () => {
    const fixture = await runNative();
    await runNative({ fixture, resume: true, recovering: true });
  }, 120_000);
  it.each(['completed', 'truncated'])(
    'rc.2 的 %s 归档恢复原身份、历史、文件和跨模型能力',
    async (ending) => {
      const fixture = await readFile(
        new URL('./fixtures/legacy-' + ending + '.jsonl.zstd', import.meta.url),
      );
      const resumed = (await runNative({ resume: true, fixture }))!;
      expect(resumed.subarray(0, fixture.length)).toEqual(fixture);
      // 已恢复的会话再次恢复：目录新增型号也不能扩大已经记录的授权。
      await runNative({ resume: true, fixture: resumed, additionalModel: true });
      expect(
        await readFile(new URL('./fixtures/legacy-' + ending + '.jsonl.zstd', import.meta.url)),
      ).toEqual(fixture);
    },
    120_000,
  );
  it.each(['missing', 'corrupt', 'future'])(
    '%s 归档明确拒绝，不能新建空会话继续或调用模型',
    async (kind) => {
      let fixture: Buffer | undefined;
      if (kind === 'corrupt') fixture = Buffer.from('invalid compressed native archive');
      if (kind === 'future') {
        fixture = zstdCompressSync(
          Buffer.from(
            JSON.stringify({
              type: 'session',
              version: 999,
              id: 'legacy-root',
              createdAt: 1,
              cwd: '/workspace',
              isSeeded: false,
              delegationDepth: 0,
            }) + '\n',
          ),
        );
      }
      await runNative({
        resume: true,
        refused: true,
        fixture,
        ...(kind === 'future' ? { generation: 999 } : {}),
      });
    },
    120_000,
  );
});
