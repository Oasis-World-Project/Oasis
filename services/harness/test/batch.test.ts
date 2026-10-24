import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBatch } from '../sandbox/batch.ts';

describe('JSONL 批次持久化与费用边界', () => {
  let dir: string;
  let source: string;
  let output: string;
  const hash = (value: string) => createHash('sha256').update(value).digest('hex');
  const reply = (costMicro = 10) => ({
    choices: [{ message: { content: '生成结果' } }],
    oasis: { costMicro },
  });
  const rows = (count: number) =>
    Array.from({ length: count }, (_, i) => ({ id: String(i), prompt: `生成样本 ${i}` }));
  async function input(values: unknown[]) {
    await writeFile(source, values.map((row) => JSON.stringify(row)).join('\n'));
  }
  const run = (
    request: Parameters<typeof runBatch>[0]['request'],
    args: Record<string, unknown> = {},
    signal?: AbortSignal,
    kind = 'text.batch',
  ) => runBatch({ kind, args: { in: source, ...args }, out: output, request, signal });
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'oasis-batch-'));
    source = join(dir, 'input.jsonl');
    output = join(dir, 'out', 'result.jsonl');
    vi.spyOn(process, 'cwd').mockReturnValue(dir);
    vi.stubEnv('OASIS_MODEL', 'test/model');
    await input(rows(5));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await rm(dir, { recursive: true, force: true });
  });

  it('限制并发，逐行带入预算，输出按输入顺序；恢复无需原文件且不重复调用', async () => {
    let active = 0;
    let peak = 0;
    const request = vi.fn(async (_path: string, init?: RequestInit) => {
      active++;
      peak = Math.max(peak, active);
      expect(JSON.parse(String(init?.body))).toMatchObject({
        model: 'test/model',
        max_cost_micro: 200_000,
        stream: false,
      });
      await new Promise((resolve) => setTimeout(resolve, 5));
      active--;
      return reply();
    });
    expect(await run(request, { concurrency: '2' })).toMatchObject({ completed: 5, costMicro: 50 });
    expect(peak).toBe(2);
    const results = (await readFile(output, 'utf8'))
      .trim()
      .split('\n')
      .map((row) => JSON.parse(row));
    expect(results.map((row) => row.id)).toEqual(['0', '1', '2', '3', '4']);
    await rm(source);
    expect(await run(request, { in: undefined, resume: 'true' })).toMatchObject({ completed: 5 });
    expect(request).toHaveBeenCalledTimes(5);
    expect(await readdir(join(dir, 'out'))).toEqual(['.oasis-batches', 'result.jsonl']);
  });

  it('总预算在派发前预留，按真实费用释放余量；不足一行时停止', async () => {
    const request = vi.fn(async () => reply(30));
    expect(await run(request, { budget_micro: '150', row_budget_micro: '100' })).toEqual({
      completed: 2,
      failed: 0,
      uncertain: 0,
      pending: 3,
      costMicro: 60,
    });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('停止只阻止新派发；保存在途结果后可继续剩余行', async () => {
    const controller = new AbortController();
    const request = vi.fn(async () => {
      controller.abort();
      return reply();
    });
    expect(await run(request, { concurrency: '1' }, controller.signal)).toMatchObject({
      completed: 1,
      pending: 4,
    });
    expect(await run(request, { resume: 'true' })).toMatchObject({ completed: 5, pending: 0 });
    expect(request).toHaveBeenCalledTimes(5);
  });

  it('超时或响应不完整保留整行预留费用并标记不确定，恢复不重发', async () => {
    await input(rows(2));
    const request = vi
      .fn()
      .mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValueOnce({});
    expect(await run(request)).toMatchObject({ uncertain: 2, costMicro: 400_000 });
    expect(await run(request, { resume: 'true' })).toMatchObject({ uncertain: 2 });
    expect(request).toHaveBeenCalledTimes(2);
  });

  it('模拟进程硬停：新容器接管旧锁，将 started 转为不确定而不重发', async () => {
    const controller = new AbortController();
    controller.abort();
    const request = vi.fn(async () => reply());
    await run(request, {}, controller.signal);
    const checkpoint = join(dir, 'out', '.oasis-batches', hash('result.jsonl'));
    await writeFile(
      join(checkpoint, `${hash('0')}.json`),
      JSON.stringify({ id: '0', status: 'started', costMicro: 200_000 }),
    );
    await mkdir(join(checkpoint, 'lock'));
    await writeFile(
      join(checkpoint, 'lock', 'owner.json'),
      JSON.stringify({ host: 'old-container', pid: 1 }),
    );
    expect(await run(request, { resume: 'true' })).toMatchObject({
      completed: 4,
      uncertain: 1,
      costMicro: 200_040,
    });
    expect(request).toHaveBeenCalledTimes(4);
  });

  it('同一输出互斥，拒绝同时派发；原运行正常结束后锁可释放', async () => {
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const running = run(async () => {
      entered();
      await wait;
      return reply();
    });
    await ready;
    try {
      await expect(run(async () => reply(), { resume: 'true' })).rejects.toThrow('正在运行');
    } finally {
      release();
    }
    await running;
  });

  it('明确拒绝即停止；恢复不能修改原输入、模型、预算或重复覆盖输出', async () => {
    const request = vi.fn(async () => {
      throw Object.assign(new Error('预算不足'), { code: 'call_budget_exceeded' });
    });
    expect(await run(request, { concurrency: '1' })).toMatchObject({ failed: 1, pending: 4 });
    await expect(run(request)).rejects.toThrow('已存在');
    await expect(run(request, { resume: 'true', budget_micro: '1' })).rejects.toThrow('不能修改');
    await input([{ id: '0', prompt: '已修改' }]);
    await expect(run(request, { resume: 'true' })).rejects.toThrow('不一致');
    vi.stubEnv('OASIS_MODEL', 'different/model');
    await expect(run(request, { resume: 'true', in: undefined })).rejects.toThrow('不一致');
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('输入重复、越界、非法字段和超限在派发前拒绝', async () => {
    const request = vi.fn(async () => reply());
    for (const values of [
      [
        { id: 'x', prompt: 'a' },
        { id: 'x', prompt: 'b' },
      ],
      [{ id: 'x', prompt: 'a', model: 'override' }],
      rows(1001),
    ]) {
      await input(values);
      await expect(run(request)).rejects.toThrow();
    }
    await input(rows(1));
    await expect(run(request, { concurrency: '5' })).rejects.toThrow('concurrency');
    await expect(
      runBatch({
        kind: 'text.batch',
        args: { in: source },
        out: join(dir, 'escape.jsonl'),
        request,
      }),
    ).rejects.toThrow('out/');
    expect(request).not.toHaveBeenCalled();
  });

  it('批量打分沿用 jev.decide，逐行保留结构化结果及费用', async () => {
    await input([{ id: 'score', question: '是否清楚？', context: '样本', scale: ['差', '好'] }]);
    const request = vi.fn(async (path: string, init?: RequestInit) => {
      expect(path).toBe('/tools/jev.decide');
      expect(JSON.parse(String(init?.body))).toEqual({
        args: { question: '是否清楚？', context: '样本', scale: ['差', '好'] },
        max_cost_micro: 200_000,
      });
      return { text: '好', data: { choice: '好' }, costMicro: 12 };
    });
    expect(await run(request, {}, undefined, 'jev.decide')).toMatchObject({
      completed: 1,
      costMicro: 12,
    });
    expect(JSON.parse((await readFile(output, 'utf8')).trim()).data).toEqual({ choice: '好' });
  });
});
