// 把成果写进用户选的同步文件夹（ADR 0007 §10）。只在主进程里用，页面碰不到文件系统：
// - 路径只能是同步文件夹里的相对路径，跳不出去；
// - 已经有同名文件就不覆盖（可能是用户自己改过的），只记为已同步；
// - 先写临时文件再改名，写到一半断了不会留下半个文件；
// - 哪些成果同步过记在桌面端自己的数据目录里，按文件夹分开记（换了文件夹会重新同步一遍）。
import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DESKTOP_SYNC_MAX_BYTES, type DesktopSyncStatus } from '@oasis/contracts/desktop';

interface SyncRecord {
  folder: string | null;
  /** 文件夹 → 同步过的成果 id */
  synced: Record<string, string[]>;
}

const EMPTY: SyncRecord = { folder: null, synced: {} };

/** 相对路径 → 同步文件夹里的绝对路径；不合格的（绝对路径、..、反斜杠、盘符）抛错 */
export function resolveInside(folder: string, relative: string): string {
  if (typeof relative !== 'string' || relative.length === 0 || relative.length > 1000) {
    throw new Error('路径不合格');
  }
  const segments = relative.split('/');
  if (
    segments.some(
      (s) =>
        s === '' ||
        s === '.' ||
        s === '..' ||
        s.includes('\\') ||
        s.includes(':') ||
        s.includes('\0'),
    )
  ) {
    throw new Error(`路径不合格：${relative}`);
  }
  const root = path.resolve(folder);
  const target = path.resolve(root, ...segments);
  const back = path.relative(root, target);
  if (back.startsWith('..') || path.isAbsolute(back))
    throw new Error(`路径跳出了同步文件夹：${relative}`);
  return target;
}

/** 文件已存在时加序号：报告.pdf → 报告 (2).pdf（给「下载」用） */
export function freePath(target: string): string {
  const { dir, name, ext } = path.parse(target);
  let candidate = target;
  for (let n = 2; existsSync(candidate); n += 1) candidate = path.join(dir, `${name} (${n})${ext}`);
  return candidate;
}

export function createSyncFolder(recordFile: string) {
  async function load(): Promise<SyncRecord> {
    try {
      const parsed = JSON.parse(await readFile(recordFile, 'utf8')) as Partial<SyncRecord>;
      return { folder: parsed.folder ?? null, synced: parsed.synced ?? {} };
    } catch {
      return { ...EMPTY, synced: {} };
    }
  }

  async function save(record: SyncRecord): Promise<void> {
    await mkdir(path.dirname(recordFile), { recursive: true });
    const temp = `${recordFile}.tmp`;
    await writeFile(temp, JSON.stringify(record, null, 2));
    await rename(temp, recordFile);
  }

  // 写记录要排队：几个文件接连写完时不能互相覆盖
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };

  return {
    async status(): Promise<DesktopSyncStatus> {
      const record = await load();
      return {
        folder: record.folder,
        synced: record.folder ? (record.synced[record.folder] ?? []) : [],
      };
    },

    async folder(): Promise<string | null> {
      return (await load()).folder;
    },

    setFolder: (folder: string) =>
      serial(async () => {
        const record = await load();
        await save({ ...record, folder: path.resolve(folder) });
      }),

    /** 写一个成果；返回实际写了没有（已有同名文件时不写） */
    write: (artifactId: string, relative: string, data: ArrayBuffer | Uint8Array) =>
      serial(async () => {
        const record = await load();
        if (!record.folder) throw new Error('还没选同步文件夹');
        if (typeof artifactId !== 'string' || !/^[0-9a-f-]{36}$/i.test(artifactId)) {
          throw new Error('成果 id 不合格');
        }
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
        if (bytes.byteLength > DESKTOP_SYNC_MAX_BYTES) throw new Error('文件太大，没有同步');
        const target = resolveInside(record.folder, relative);
        let written = false;
        if (!existsSync(target)) {
          await mkdir(path.dirname(target), { recursive: true });
          const partial = `${target}.oasis-partial`;
          try {
            await writeFile(partial, bytes);
            await rename(partial, target);
          } catch (err) {
            await rm(partial, { force: true });
            throw err;
          }
          written = true;
        }
        const done = new Set(record.synced[record.folder] ?? []);
        done.add(artifactId);
        await save({ ...record, synced: { ...record.synced, [record.folder]: [...done] } });
        return written;
      }),
  };
}

export type SyncFolder = ReturnType<typeof createSyncFolder>;
