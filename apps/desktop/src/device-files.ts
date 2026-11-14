// 在你的电脑上干活时的文件：harness 发来的 tar 包放进项目的 .oasis/ 和这个会话的 dsh 家目录；要取回的目录
// 或文件打成 tar（和 Docker 取出的格式一样：条目以被取的目录或文件的名字开头）。路径里的 {project}、{home}、
// {origin} 换成实际的；平台只碰这两个地方，跳不出去，链接之类的不跟。
import { createReadStream, createWriteStream } from 'node:fs';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DEVICE_ROOTS } from '@oasis/contracts/device';
import { extract as tarExtract, pack as tarPack } from 'tar-stream';

export interface Place {
  /** 项目文件夹 */
  project: string;
  /** 这个会话的 dsh 家目录（桌面版自己的数据目录里） */
  home: string;
  /** 网页地址：电脑上的 dsh 调模型和工具经这里的 gateway */
  origin: string;
}

/** 一次取回的文件最多多大（和 harness 那边一致） */
const READ_MAX_BYTES = 512 * 1024 * 1024;

/** 把 {project}、{home}、{origin} 换成实际的；以 {project}、{home} 开头的是路径，顺手换成本机的写法 */
export function resolvePlace(value: string, place: Place): string {
  const replaced = value
    .replaceAll(DEVICE_ROOTS.project, place.project)
    .replaceAll(DEVICE_ROOTS.home, place.home)
    .replaceAll(DEVICE_ROOTS.origin, place.origin);
  return value.startsWith(DEVICE_ROOTS.project) || value.startsWith(DEVICE_ROOTS.home)
    ? path.normalize(replaced)
    : replaced;
}

/** target 是不是 root 本身或在它里面 */
function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (relative.split(path.sep)[0] !== '..' && !path.isAbsolute(relative));
}

/** 平台能碰的两个地方：项目里的 .oasis/ 和这个会话的 dsh 家目录；别处一律不认 */
export function placePath(value: string, place: Place): string {
  const target = path.resolve(resolvePlace(value, place));
  if (![path.join(place.project, '.oasis'), place.home].some((root) => within(root, target)))
    throw new Error(`平台不能碰这个位置：${value}`);
  return target;
}

/** 把 tar 包放进 dir（条目是相对 dir 的路径）；有跳出 dir 的条目就停下报错，链接之类的不收 */
export async function extractTar(dir: string, data: Buffer): Promise<void> {
  await mkdir(dir, { recursive: true });
  const extract = tarExtract();
  const feeding = pipeline(Readable.from([data]), extract);
  void feeding.catch(() => undefined);
  for await (const entry of extract) {
    const { name, type } = entry.header;
    const target = path.resolve(dir, name);
    if (!within(dir, target)) {
      extract.destroy();
      throw new Error(`文件包里有跳出目录的路径：${name}`);
    }
    if (type === 'directory') {
      await mkdir(target, { recursive: true });
      entry.resume();
    } else if (type === 'file') {
      await mkdir(path.dirname(target), { recursive: true });
      await pipeline(entry, createWriteStream(target));
    } else entry.resume();
  }
  await feeding;
}

/**
 * 把 target（目录或文件）打成 tar：条目以它的名字开头，只收目录和普通文件；不存在时返回 undefined。
 * 超过 maxBytes 报错。
 */
export async function packPath(
  target: string,
  maxBytes = READ_MAX_BYTES,
): Promise<Buffer | undefined> {
  const top = await lstat(target).catch(() => undefined);
  if (!top || !(top.isDirectory() || top.isFile())) return undefined;
  const archive = tarPack();
  const chunks: Buffer[] = [];
  const collecting = (async () => {
    for await (const chunk of archive) chunks.push(chunk as Buffer);
  })();
  let total = 0;
  const add = async (file: string, name: string) => {
    const info = await lstat(file);
    if (info.isDirectory()) {
      archive.entry({ name: `${name}/`, type: 'directory', mode: 0o755 });
      for (const child of (await readdir(file)).sort())
        await add(path.join(file, child), `${name}/${child}`);
    } else if (info.isFile()) {
      total += info.size;
      if (total > maxBytes) throw new Error('要取回的文件太大');
      await pipeline(
        createReadStream(file),
        archive.entry({ name, size: info.size, mode: 0o644, mtime: info.mtime }),
      );
    }
  };
  try {
    await add(target, path.basename(target));
    archive.finalize();
  } catch (err) {
    archive.destroy(err instanceof Error ? err : new Error(String(err)));
    await collecting.catch(() => undefined);
    throw err;
  }
  await collecting;
  return Buffer.concat(chunks);
}
