// 会话记录存一版在我们这边：每轮结束存下 dsh 的会话记录（不带别的文件），一份会话只留最近几版；
// 撤回最近的一轮后，下一轮新起 dsh 之前先把上一版放回去。
import { describe, expect, it } from 'vitest';
import { SANDBOX_PATHS } from '../src/adapter/dsh.ts';
import { VERSIONS_KEPT } from '../src/repo/runs-repo.ts';
import {
  base,
  finished,
  methods,
  puts,
  rows,
  service,
  started,
  tarEntries,
  useService,
  versions,
  workspaces,
} from './support/run-fixture.ts';

async function turn(prompt: string, continueFrom?: string) {
  const run = await service.start({ ...base, prompt, ...(continueFrom ? { continueFrom } : {}) });
  await finished(run.id);
  return run.id;
}

describe('会话记录', () => {
  it('每轮结束存一版：只有会话记录那一个文件；一份会话只留最近几版', async () => {
    const first = await turn('第一句');
    const saved = await tarEntries(versions.get(first)!.archive);
    expect(saved.map((file) => [file.path, file.content.toString()])).toEqual([
      [`sessions/--workspace--/${first}/session.v4.jsonl.zstd`, 'native-fixture'],
    ]);
    let last = first;
    const runs = [first];
    for (let n = 2; n <= VERSIONS_KEPT + 1; n += 1)
      runs.push((last = await turn(`第 ${n} 句`, last)));
    expect([...versions.keys()]).toEqual(runs.slice(1));
  });

  it('撤回最近的一轮：它的记录删掉；下一轮新起 dsh、握手之前把上一版会话记录放回去，只放一次', async () => {
    // 做完留着等下一轮：撤回时空着的那个 dsh（手里是撤回之前的会话）要收掉
    useService({ idleMs: { cloud: 60_000, device: 0 } });
    const first = await turn('第一句');
    const second = await turn('第二句', first);
    expect(started).toHaveLength(1);
    await expect(service.undo(second, base.conversationId)).resolves.toEqual({
      continueFrom: first,
    });
    expect(rows.has(second)).toBe(false);
    expect(versions.get(first)?.restore).toBe(true);

    methods.length = 0;
    puts.length = 0;
    const again = await turn('换一句', first);
    expect(started).toHaveLength(2);
    const restored = puts.find((put) => put.dir === SANDBOX_PATHS.dshHome);
    expect(restored?.files.map((file) => file.path)).toEqual([
      `sessions/--workspace--/${first}/session.v4.jsonl.zstd`,
    ]);
    expect(methods).toContain('session/resume');
    expect(versions.get(first)?.restore).toBe(false);
    // 再往下一轮接着用空着的 dsh，不再放
    puts.length = 0;
    await turn('再一句', again);
    expect(puts.some((put) => put.dir === SANDBOX_PATHS.dshHome)).toBe(false);
  });

  it('撤回这份会话的第一轮：整份会话清掉，下一轮开新会话', async () => {
    const first = await turn('第一句');
    expect(workspaces.has(first)).toBe(true);
    await expect(service.undo(first, base.conversationId)).resolves.toEqual({ continueFrom: null });
    expect(rows.has(first)).toBe(false);
    expect(versions.has(first)).toBe(false);
    expect(workspaces.has(first)).toBe(false);
  });

  it('撤不了的：不是最近的一轮；之前那一轮的会话记录没存下来；别的对话的', async () => {
    const first = await turn('第一句');
    const second = await turn('第二句', first);
    await expect(service.undo(first, base.conversationId)).rejects.toMatchObject({
      code: 'session_advanced',
    });
    await expect(
      service.undo(second, '4d4d4d4d-4d4d-4d4d-8d4d-4d4d4d4d4d4d'),
    ).rejects.toMatchObject({ code: 'run_not_found' });
    versions.delete(first);
    await expect(service.undo(second, base.conversationId)).rejects.toMatchObject({
      code: 'session_version_gone',
    });
    expect(rows.has(second)).toBe(true);
  });
});
