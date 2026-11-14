// 显式指定已构建的镜像后验证真实 dsh：对话里的一轮怎么开始、怎么结束、下一轮怎么接着原会话。
// 假模型只在断网容器的回环接口运行，费用为 0。
import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { zstdCompressSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { connectAgent, guideFiles, runtimeFiles } from '../dsh.ts';

const FIRST = 'NATIVE_FIRST_TURN: 让 test/secondary 先核对一下，再写出 out/proof.txt。';
const SECOND = 'NATIVE_SECOND_TURN: 上一轮做了什么？';

async function runNative(
  options: {
    /** 上一轮留下的会话记录：有它就接着原会话做下一轮 */
    fixture?: Buffer;
    resume?: boolean;
    refused?: boolean;
    generation?: number;
    fault?: 'disconnect' | 'context-overflow' | 'attachment' | 'steer';
  } = {},
) {
  const image = process.env.OASIS_NATIVE_IMAGE!;
  const sessionId = 'root';
  if (!/^oasis\/[a-z0-9._-]+:[\w.-]+$/.test(image)) throw new Error('test image must use oasis/');
  const directory = await mkdtemp(join(tmpdir(), 'oasis-native-'));
  const name = `oasis-native-${randomUUID()}`;
  await mkdir(join(directory, 'evidence'));
  const models = ['deepseek/deepseek-v4.1-flash', 'test/secondary', 'test/tertiary'].map((id) => ({
    id,
    name: id,
    contextWindow: 1048576,
    maxTokens: id.startsWith('test/') ? 131072 : 943718,
    input: ['text', 'image'] as ('text' | 'image')[],
    reasoning: true,
  }));
  for (const file of runtimeFiles({ models, sessionId }))
    await writeFile(join(directory, file.path.split('/').at(-1)!), file.content);
  // 平台说明和技能：harness 每轮放进 dsh 的用户目录，假供应商从 guide/ 复制过去
  const guide = {
    rules: 'NATIVE_GUIDE_RULES: 交付的文件放进 out/。\n',
    device: '',
    skills: [
      { name: 'native-skill', description: 'NATIVE_SKILL_DESCRIPTION 测试', content: '# 测试' },
    ],
  };
  for (const file of guideFiles(guide, '你是测试助手。')) {
    const target = join(directory, 'guide', file.path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content);
  }
  if (options.fixture)
    await writeFile(join(directory, 'previous-session.jsonl.zstd'), options.fixture);
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
      `OASIS_NATIVE_MODE=${options.refused ? 'refuse' : options.resume ? 'resume' : 'fresh'}`,
      '--env',
      `OASIS_NATIVE_GENERATION=${options.generation ?? 4}`,
      '--env',
      `OASIS_NATIVE_FAULT=${options.fault ?? ''}`,
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
  let steerReady!: () => void;
  const steering = new Promise<void>((resolve) => {
    steerReady = resolve;
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr = (stderr + chunk.toString()).slice(-8000);
    if (stderr.includes('NATIVE_STEER_READY')) steerReady();
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
    await agent.prompt(options.resume ? SECOND : FIRST);
    if (options.fault === 'steer') {
      await steering;
      await agent.prompt('NATIVE_STEER_MESSAGE: 顺便把标题改短。');
    }
    expect(await agent.waitIdle(), stderr).toBeUndefined();
    await agent.shutdown();
    expect(await exited, stderr).toBe(0);
    expect(stderr).toContain('NATIVE_PROOF');
    expect(stderr).toContain('"policyCount":1');
    expect(nested).toBe(!options.resume);
    if (options.fault === 'context-overflow') {
      expect(stderr).toContain('"checkpointSeen":true');
      expect(stderr).toContain('"compactions":1');
      expect(stderr).toContain('"compactionSummaries":1');
      expect(stderr).toContain('"failedCompactions":0');
    }
    if (options.fault === 'attachment') expect(stderr).toContain('"attachmentRecovered":true');
    if (options.fault === 'steer') expect(stderr).toContain('"steerSeen":true');
    return await readFile(join(directory, 'evidence/session.jsonl.zstd'));
  } finally {
    clearTimeout(timer);
    agent.abort(new Error('acceptance finished'));
    spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
    await exited.catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
}

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE)('镜像里的 dsh 离线集成', () => {
  it(
    '新会话的一轮：读到平台说明和技能、按最高思考档调模型、跨模型子代理、实际写出文件、正常结束',
    () => runNative(),
    120_000,
  );
  it(
    '上下文溢出：原生自动压缩生成持久摘要，在同一轮里接着做完',
    () => runNative({ fault: 'context-overflow' }),
    120_000,
  );
  it(
    '原生 read_image 对象随会话存储完整恢复，独立附件服务能按原引用读取',
    () => runNative({ fault: 'attachment' }),
    120_000,
  );
  it('读模型回复时连接中断：同一轮里重试并做完', () => runNative({ fault: 'disconnect' }), 120_000);
  it(
    '模型调用在途时用户插话：挪到这一轮的下一步，模型看得到，这一轮照常结束',
    () => runNative({ fault: 'steer' }),
    120_000,
  );
  it('下一轮接着原会话：看得到上一轮的话和工具结果，不重发、不重做', async () => {
    const fixture = (await runNative())!;
    const resumed = (await runNative({ fixture, resume: true }))!;
    // 原会话记录只往后追加，前面的历史一个字节都不变
    expect(resumed.subarray(0, fixture.length)).toEqual(fixture);
  }, 240_000);
  it.each(['missing', 'corrupt', 'future'])(
    '%s 会话记录明确拒绝，不能新建空会话继续或调用模型',
    async (kind) => {
      let fixture: Buffer | undefined;
      if (kind === 'corrupt') fixture = Buffer.from('invalid compressed native archive');
      if (kind === 'future') {
        fixture = zstdCompressSync(
          Buffer.from(
            JSON.stringify({
              type: 'session',
              version: 999,
              id: 'root',
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
