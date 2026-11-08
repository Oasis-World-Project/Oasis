// oasis-tool 里和文件打交道的部分：结果存到哪、图片按实际格式改后缀、读本地图片、app.check 带上的应用文件。
import { readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

/** 文件要存到哪：给了 --out 就用它（多个文件时加 -1、-2），否则放进 out/ 用工具给的名字 */
export function targetsFor(files: { name: string }[], out: string | undefined): string[] {
  if (!out) return files.map((f) => join('out', f.name));
  if (files.length === 1) return [out];
  const ext = extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  const mixed = new Set(files.map((f) => extname(f.name))).size > 1;
  return files.map((f, i) => `${stem}-${i + 1}${mixed ? extname(f.name) : ext || extname(f.name)}`);
}

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.gif': 'gif',
};

/** 文件头对应的图片后缀；不是认得的图片返回 undefined */
function imageExtOf(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return '.png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return '.jpg';
  if (
    bytes.length >= 12 &&
    bytes.toString('ascii', 0, 4) === 'RIFF' &&
    bytes.toString('ascii', 8, 12) === 'WEBP'
  )
    return '.webp';
  if (bytes.length >= 4 && bytes.toString('ascii', 0, 4) === 'GIF8') return '.gif';
  return undefined;
}

/**
 * 要存成图片、但内容是另一种图片格式时，按实际格式改后缀（2026-11-05：JPEG 存成 .png，
 * 后面看图报签名无效、节点返工）。不是图片后缀或认不出内容时原样返回。
 */
export function matchImageExt(target: string, bytes: Buffer): string {
  const ext = extname(target);
  const actual = imageExtOf(bytes);
  if (!actual || !(ext.toLowerCase() in IMAGE_EXTS)) return target;
  if (IMAGE_EXTS[ext.toLowerCase()] === IMAGE_EXTS[actual]) return target;
  return `${target.slice(0, -ext.length)}${actual}`;
}

export async function localImages(
  paths: unknown,
): Promise<{ mediaType: string; base64: string }[]> {
  if (
    !Array.isArray(paths) ||
    paths.length < 1 ||
    paths.length > 4 ||
    paths.some((p) => typeof p !== 'string')
  )
    throw new Error('请提供 1–4 个图片路径');
  let total = 0;
  const images = [];
  for (const path of paths as string[]) {
    const mediaType = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.webp': 'image/webp',
    }[extname(path).toLowerCase()];
    if (!mediaType) throw new Error('图片只支持 PNG、JPEG、WebP');
    total += (await stat(path)).size;
    if (total > 20 * 1024 * 1024) throw new Error('图片总大小超过 20 MiB');
    images.push({ mediaType, base64: (await readFile(path)).toString('base64') });
  }
  return images;
}

/** app.check 一次带上的应用文件上限（入口代理收 50 MB 的请求，base64 后要放得下） */
const APP_MAX_FILES = 1000;
const APP_MAX_BYTES = 25 * 1024 * 1024;

/**
 * app.check：浏览器检查在平台的隔离容器里跑（ADR 0024），读不到沙箱，所以把 out/<dir> 里的文件
 * 随调用带上。只认普通文件、不跟随符号链接；超过上限就说清楚，交付后关卡照样会检查。
 */
export async function appFiles(
  args: Record<string, unknown>,
): Promise<{ path: string; contentBase64: string }[]> {
  const usage = '--dir 写 oasis-app.json 所在的目录，如 out/site';
  if (typeof args.dir !== 'string') throw new Error(usage);
  const dir = args.dir.replace(/^(\.\/)?(\/workspace\/)?(out\/)?/, '').replace(/\/+$/, '');
  if (!dir || dir.split('/').some((part) => !part || part === '.' || part === '..'))
    throw new Error(usage);
  args.dir = dir;
  const root = resolve(process.env.OASIS_OUT_DIR ?? 'out', dir);
  const files: { path: string; contentBase64: string }[] = [];
  let total = 0;
  const walk = async (folder: string): Promise<void> => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) {
        total += (await stat(full)).size;
        if (files.length >= APP_MAX_FILES || total > APP_MAX_BYTES)
          throw new Error(
            `out/${dir} 超过自查上限（${APP_MAX_FILES} 个文件、25 MB），自查不了；交付后关卡照样会检查`,
          );
        files.push({
          path: relative(root, full).split(sep).join('/'),
          contentBase64: (await readFile(full)).toString('base64'),
        });
      }
    }
  };
  try {
    await walk(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT')
      throw new Error(`out/${dir} 不存在`, { cause: error });
    throw error;
  }
  return files;
}
