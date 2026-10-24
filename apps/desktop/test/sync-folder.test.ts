// 桌面端同步文件夹（ADR 0007 §10）：路径跳不出去、不覆盖已有文件、记下同步过的、换文件夹重新同步。
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_CHANNELS } from '@oasis/contracts/desktop';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncFolder, freePath, resolveInside } from '../src/sync-folder.ts';

const A = '00000000-0000-4000-8000-000000000001';
const B = '00000000-0000-4000-8000-000000000002';
const bytes = (text: string) => new TextEncoder().encode(text);

let home: string;
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'oasis-sync-'));
});
afterEach(() => rm(home, { recursive: true, force: true }));

describe('同步文件夹里的路径', () => {
  it('只能是文件夹里的相对路径', () => {
    const root = path.join(home, '成果');
    expect(resolveInside(root, '民宿首页/首页文案.md')).toBe(
      path.join(root, '民宿首页', '首页文案.md'),
    );
    for (const bad of [
      '../外面.txt',
      '/etc/passwd',
      'a/../../b',
      'a\\..\\b',
      'C:/x',
      'a//b',
      '',
      'a/./b',
    ]) {
      expect(() => resolveInside(root, bad), bad).toThrow();
    }
  });

  it('下载时重名加序号', async () => {
    await writeFile(path.join(home, '报告.pdf'), '');
    await writeFile(path.join(home, '报告 (2).pdf'), '');
    expect(freePath(path.join(home, '报告.pdf'))).toBe(path.join(home, '报告 (3).pdf'));
    expect(freePath(path.join(home, '新的.pdf'))).toBe(path.join(home, '新的.pdf'));
  });
});

describe('同步记录', () => {
  it('没选文件夹不能写；选了之后写进去并记下，同一个成果不会重复', async () => {
    const sync = createSyncFolder(path.join(home, 'data', 'sync.json'));
    expect(await sync.status()).toEqual({ folder: null, synced: [] });
    await expect(sync.write(A, '任务/a.md', bytes('x'))).rejects.toThrow('还没选同步文件夹');

    const folder = path.join(home, '成果');
    await sync.setFolder(folder);
    expect(await sync.write(A, '民宿首页/首页文案.md', bytes('# 小木屋'))).toBe(true);
    expect(await readFile(path.join(folder, '民宿首页', '首页文案.md'), 'utf8')).toBe('# 小木屋');
    expect(existsSync(path.join(folder, '民宿首页', '首页文案.md.oasis-partial'))).toBe(false);
    expect(await sync.status()).toEqual({ folder, synced: [A] });
  });

  it('已经有同名文件（可能是自己改过的）不覆盖，只记为同步过', async () => {
    const sync = createSyncFolder(path.join(home, 'sync.json'));
    const folder = path.join(home, '成果');
    await sync.setFolder(folder);
    await sync.write(A, '任务/a.md', bytes('原来的'));
    await writeFile(path.join(folder, '任务', 'b.md'), '我自己写的');
    expect(await sync.write(B, '任务/b.md', bytes('新的'))).toBe(false);
    expect(await readFile(path.join(folder, '任务', 'b.md'), 'utf8')).toBe('我自己写的');
    expect((await sync.status()).synced).toEqual([A, B]);
  });

  it('同时写几个文件，记录不会互相覆盖；换了文件夹就重新同步', async () => {
    const sync = createSyncFolder(path.join(home, 'sync.json'));
    await sync.setFolder(path.join(home, '一'));
    await Promise.all([sync.write(A, 'x/a.md', bytes('a')), sync.write(B, 'x/b.md', bytes('b'))]);
    expect((await sync.status()).synced.sort()).toEqual([A, B]);
    await sync.setFolder(path.join(home, '二'));
    expect((await sync.status()).synced).toEqual([]);
  });

  it('id 不合格、文件太大都不写', async () => {
    const sync = createSyncFolder(path.join(home, 'sync.json'));
    await sync.setFolder(path.join(home, '成果'));
    await expect(sync.write('../x', 'a.md', bytes('x'))).rejects.toThrow('成果 id 不合格');
    const big = { byteLength: 600 * 1024 * 1024 } as unknown as Uint8Array;
    Object.setPrototypeOf(big, Uint8Array.prototype);
    await expect(sync.write(A, 'a.md', big)).rejects.toThrow('文件太大');
  });
});

describe('preload', () => {
  it('频道名和契约一致', async () => {
    const source = await readFile(
      path.join(import.meta.dirname, '..', 'src', 'preload.cts'),
      'utf8',
    );
    for (const channel of Object.values(DESKTOP_CHANNELS)) expect(source).toContain(`'${channel}'`);
  });
});
