// 把成果写进用户选的同步文件夹（ADR 0007 §10）。只在主进程里用，页面碰不到文件系统：
// - 路径只能是同步文件夹里的相对路径，跳不出去；
// - 已经有同名文件就不覆盖（可能是用户自己改过的），只记为已同步；修改出的新版例外（ADR 0012）：
//   那里还是没改过的旧版就覆盖，用户改过就另存为「名字 (新版).扩展名」；
// - 先写临时文件再改名，写到一半断了不会留下半个文件；
// - 哪些成果同步过记在桌面端自己的数据目录里，按文件夹分开记（换了文件夹会重新同步一遍）。
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
  open,
  link,
  realpath,
  type FileHandle,
} from 'node:fs/promises';
import path from 'node:path';
import { DESKTOP_SYNC_MAX_BYTES, type DesktopSyncStatus } from '@oasis/contracts/desktop';

interface SyncRecord {
  folder: string | null;
  /** 文件夹 → 同步过的成果 id */
  synced: Record<string, string[]>;
  pending?: Record<string, { folder: string; relative: string }>;
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

/**
 * 改名覆盖旧文件。Windows 上杀毒软件或索引服务刚扫到新写的文件时，会短暂占着它，
 * 改名报 EPERM / EBUSY / EACCES；稍等再试几次。
 */
async function replaceFile(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (attempt >= 5 || !['EPERM', 'EBUSY', 'EACCES'].includes(code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** 电脑上一个文件的 SHA-256（判断它是不是用户没改过的旧版） */
async function fileSha256(file: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest('hex');
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
      return {
        folder: parsed.folder ?? null,
        synced: parsed.synced ?? {},
        pending: parsed.pending ?? {},
      };
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

  const transfers = new Map<
    string,
    {
      file: FileHandle;
      target: string;
      partial: string;
      folder: string;
      id: string;
      size: number;
      count: number;
      hash: ReturnType<typeof createHash>;
      sha256?: string | null;
      /** 修改出的新版替换用户没改过的旧版 */
      overwrite: boolean;
    }
  >();
  async function discard(token: string) {
    const item = transfers.get(token);
    if (item) {
      await item.file.close();
      await rm(item.partial, { force: true });
      transfers.delete(token);
    }
    const record = await load();
    delete record.pending?.[token];
    await save(record);
  }
  return {
    recover: () =>
      serial(async () => {
        const record = await load();
        for (const [token, item] of Object.entries(record.pending ?? {})) {
          if (!/^[a-f0-9-]{36}$/.test(token)) throw new Error('同步恢复记录不合格');
          const target = resolveInside(item.folder, item.relative);
          const parent = await realpath(path.dirname(target)).catch(() => null);
          const root = await realpath(item.folder).catch(() => null);
          if (parent && root && !path.relative(root, parent).startsWith('..'))
            await rm(`${target}.oasis-${token}.partial`, { force: true });
        }
        record.pending = {};
        await save(record);
      }),
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

    begin: (
      artifactId: string,
      relative: string,
      size: number,
      sha256?: string | null,
      replacesSha256?: string | null,
    ) =>
      serial(async () => {
        const record = await load();
        if (!record.folder) throw new Error('还没选同步文件夹');
        // 「id」或修改后原地换成新版的「id@新摘要」（ADR 0012）
        if (!/^[0-9a-f-]{36}(@[a-f0-9]{64})?$/i.test(artifactId)) throw new Error('成果 id 不合格');
        if (!Number.isSafeInteger(size) || size < 0 || size > DESKTOP_SYNC_MAX_BYTES)
          throw new Error('文件太大，没有同步');
        if (sha256 != null && !/^[a-f0-9]{64}$/.test(sha256)) throw new Error('校验和不合格');
        if (replacesSha256 != null && !/^[a-f0-9]{64}$/.test(replacesSha256))
          throw new Error('旧版校验和不合格');
        if (transfers.size >= 4) throw new Error('同步任务过多');
        let target = resolveInside(record.folder, relative);
        await mkdir(path.dirname(target), { recursive: true });
        const root = await realpath(record.folder);
        const parent = await realpath(path.dirname(target));
        if (
          path.relative(root, parent).startsWith('..') ||
          path.isAbsolute(path.relative(root, parent))
        )
          throw new Error('同步目录包含越界链接');
        // 修改出的新版（ADR 0012）：那里还是用户没改过的旧版就覆盖；用户改过就另存为「(新版)」
        let overwrite = false;
        if (existsSync(target)) {
          if (!replacesSha256) {
            record.synced[record.folder] = [
              ...new Set([...(record.synced[record.folder] ?? []), artifactId]),
            ];
            await save(record);
            return null;
          }
          if ((await fileSha256(target)) === replacesSha256) overwrite = true;
          else {
            const { dir, name, ext } = path.parse(target);
            target = freePath(path.join(dir, `${name} (新版)${ext}`));
          }
        }
        const token = randomUUID();
        const partial = `${target}.oasis-${token}.partial`;
        const file = await open(partial, 'wx');
        transfers.set(token, {
          file,
          target,
          partial,
          folder: record.folder,
          id: artifactId,
          size,
          count: 0,
          hash: createHash('sha256'),
          sha256,
          overwrite,
        });
        record.pending ??= {};
        record.pending[token] = {
          folder: record.folder,
          relative: path.relative(record.folder, target).split(path.sep).join('/'),
        };
        try {
          await save(record);
        } catch (error) {
          await file.close();
          await rm(partial, { force: true });
          transfers.delete(token);
          throw error;
        }
        return token;
      }),
    append: (token: string, bytes: Uint8Array) =>
      serial(async () => {
        const item = transfers.get(token);
        if (!item) throw new Error('同步会话不存在');
        if (bytes.byteLength > 1024 * 1024 || item.count + bytes.byteLength > item.size) {
          await discard(token);
          throw new Error('同步分块大小不合格');
        }
        try {
          let offset = 0;
          while (offset < bytes.length) {
            const written = await item.file.write(bytes, offset, bytes.length - offset);
            if (!written.bytesWritten) throw new Error('写入未完成');
            offset += written.bytesWritten;
          }
          item.hash.update(bytes);
          item.count += bytes.length;
        } catch (error) {
          await discard(token);
          throw error;
        }
      }),
    finish: (token: string) =>
      serial(async () => {
        const item = transfers.get(token);
        if (!item) throw new Error('同步会话不存在');
        if (item.count !== item.size || (item.sha256 && item.hash.digest('hex') !== item.sha256)) {
          await discard(token);
          throw new Error('同步大小或校验和不一致');
        }
        await item.file.sync();
        await item.file.close();
        transfers.delete(token);
        try {
          // 替换没改过的旧版：改名覆盖（原子）；其余情况不覆盖已有文件
          if (item.overwrite) await replaceFile(item.partial, item.target);
          else await link(item.partial, item.target);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        } finally {
          await rm(item.partial, { force: true });
        }
        const record = await load();
        delete record.pending?.[token];
        record.synced[item.folder] = [...new Set([...(record.synced[item.folder] ?? []), item.id])];
        await save(record);
      }),
    abort: (token: string) => serial(() => discard(token)),
  };
}

export type SyncFolder = ReturnType<typeof createSyncFolder>;
