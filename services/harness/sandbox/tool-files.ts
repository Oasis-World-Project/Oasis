// oasis-tool 里和文件打交道的部分：结果存到哪、图片和音频按实际格式改后缀、读本地图片、app.check 带上的应用文件。
import { open, readdir, readFile, stat } from 'node:fs/promises';
import { extname, join, relative, resolve, sep } from 'node:path';

/**
 * 文件要存到哪：给了 --out 就用它（多个文件时加 -1、-2），否则放进 out/ 用工具给的名字。
 * 几个文件后缀不一样、其中只有一个和 --out 同后缀时，它就是主结果，原样存到 --out（工具节点、下游都按这个路径找它）；
 * 其余的是附带的（如 app.check 的截图），放在旁边，名字接在后面。
 */
export function targetsFor(files: { name: string }[], out: string | undefined): string[] {
  if (!out) return files.map((f) => join('out', f.name));
  if (files.length === 1) return [out];
  const ext = extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  const mixed = new Set(files.map((f) => extname(f.name))).size > 1;
  const main = mixed && ext ? files.filter((f) => extname(f.name) === ext) : [];
  if (main.length === 1) return files.map((f) => (f === main[0] ? out : `${stem}-${f.name}`));
  return files.map((f, i) => `${stem}-${i + 1}${mixed ? extname(f.name) : ext || extname(f.name)}`);
}

/** 认得文件头的图片、音频格式：后缀 → 格式（.jpg 和 .jpeg 是同一种） */
const FORMATS: Record<string, string> = {
  '.png': 'png',
  '.jpg': 'jpeg',
  '.jpeg': 'jpeg',
  '.webp': 'webp',
  '.gif': 'gif',
  '.mp3': 'mp3',
  '.wav': 'wav',
  '.flac': 'flac',
  '.ogg': 'ogg',
};

/** ID3 标签一共多长：10 字节的头加标签体，长度每字节只用低 7 位 */
const id3Length = (b: Buffer) =>
  10 + (((b[6]! & 127) << 21) | ((b[7]! & 127) << 14) | ((b[8]! & 127) << 7) | (b[9]! & 127));

/** 文件头对应的后缀；不是认得的图片或音频返回 undefined */
function extOf(bytes: Buffer): string | undefined {
  const tag = (from: number, to: number) => bytes.toString('ascii', from, to);
  if (bytes.length >= 8 && bytes.readUInt32BE(0) === 0x89504e47) return '.png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return '.jpg';
  if (bytes.length >= 12 && tag(0, 4) === 'RIFF')
    return tag(8, 12) === 'WEBP' ? '.webp' : tag(8, 12) === 'WAVE' ? '.wav' : undefined;
  if (bytes.length >= 4 && tag(0, 4) === 'GIF8') return '.gif';
  if (bytes.length >= 4 && tag(0, 4) === 'fLaC') return '.flac';
  if (bytes.length >= 4 && tag(0, 4) === 'OggS') return '.ogg';
  // 开头挂着 ID3 标签的要看标签后面：fal 给生成的音频挂一段内容凭证，后面可能是 FLAC（2026-11-11）
  if (bytes.length >= 10 && tag(0, 3) === 'ID3')
    return tag(id3Length(bytes), id3Length(bytes) + 4) === 'fLaC' ? '.flac' : '.mp3';
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return '.mp3';
  return undefined;
}

/**
 * 要存成图片或音频、但内容是另一种格式时，按实际格式改后缀（2026-11-05：JPEG 存成 .png，
 * 后面看图报签名无效、节点返工；2026-11-11：音乐型号回的是 FLAC）。不是这些后缀或认不出内容时原样返回。
 */
export function matchExt(target: string, bytes: Buffer): string {
  const ext = extname(target);
  const actual = extOf(bytes);
  if (!actual || !(ext.toLowerCase() in FORMATS)) return target;
  if (FORMATS[ext.toLowerCase()] === FORMATS[actual]) return target;
  return `${target.slice(0, -ext.length)}${actual}`;
}

/** 已经存好的文件开头的一段，够 matchExt 认格式：挂着 ID3 标签的连标签后面几个字节一起读 */
export async function startOf(path: string): Promise<Buffer> {
  const file = await open(path);
  try {
    const head = Buffer.alloc(16);
    const { bytesRead } = await file.read(head, 0, 16, 0);
    if (bytesRead < 10 || head.toString('ascii', 0, 3) !== 'ID3')
      return head.subarray(0, bytesRead);
    // 标签大得离谱的不读进来，按没有后续算
    const whole = Buffer.alloc(Math.min(id3Length(head) + 4, 16 * 1024 * 1024));
    return whole.subarray(0, (await file.read(whole, 0, whole.length, 0)).bytesRead);
  } finally {
    await file.close();
  }
}

/** 能交给型号看、听的本地文件：后缀 → 种类和供应商要的格式写法 */
const MEDIA: Record<string, { kind: 'image' | 'video' | 'audio'; type: string }> = {
  '.png': { kind: 'image', type: 'image/png' },
  '.jpg': { kind: 'image', type: 'image/jpeg' },
  '.jpeg': { kind: 'image', type: 'image/jpeg' },
  '.webp': { kind: 'image', type: 'image/webp' },
  '.mp4': { kind: 'video', type: 'video/mp4' },
  '.webm': { kind: 'video', type: 'video/webm' },
  '.mov': { kind: 'video', type: 'video/quicktime' },
  '.mp3': { kind: 'audio', type: 'mp3' },
  '.wav': { kind: 'audio', type: 'wav' },
  '.m4a': { kind: 'audio', type: 'm4a' },
  '.flac': { kind: 'audio', type: 'flac' },
  '.ogg': { kind: 'audio', type: 'ogg' },
};

/**
 * 读 1–4 个本地文件带给工具（合计不超过 20 MiB）。media.inspect 三种都收；
 * 生图的参考图、视频首帧只收图片（imagesOnly）。
 */
export async function localMedia(paths: unknown, imagesOnly = false) {
  const what = imagesOnly ? '图片' : '文件';
  if (
    !Array.isArray(paths) ||
    paths.length < 1 ||
    paths.length > 4 ||
    paths.some((p) => typeof p !== 'string')
  )
    throw new Error(`请提供 1–4 个${what}路径`);
  let total = 0;
  const files = [];
  for (const path of paths as string[]) {
    const media = MEDIA[extname(path).toLowerCase()];
    if (!media || (imagesOnly && media.kind !== 'image'))
      throw new Error(
        imagesOnly
          ? '图片只支持 PNG、JPEG、WebP'
          : '只支持图片 png/jpg/webp、视频 mp4/webm/mov、音频 mp3/wav/m4a/flac/ogg',
      );
    total += (await stat(path)).size;
    if (total > 20 * 1024 * 1024) throw new Error(`${what}总大小超过 20 MiB`);
    const base64 = (await readFile(path)).toString('base64');
    files.push(
      media.kind === 'audio'
        ? { kind: media.kind, format: media.type, base64 }
        : { kind: media.kind, mediaType: media.type, base64 },
    );
  }
  return files;
}

/** 只要图片的地方（参考图、首帧）：网关那边的参数不带 kind */
export async function localImages(paths: unknown) {
  return (await localMedia(paths, true)).map((file) => ({
    mediaType: (file as { mediaType: string }).mediaType,
    base64: file.base64,
  }));
}

/** app.check 一次带上的应用文件上限（入口代理收 50 MB 的请求，base64 后要放得下） */
const APP_MAX_FILES = 1000;
const APP_MAX_BYTES = 25 * 1024 * 1024;

/** 清单里写的 root（应用在做它的那个节点的产出里的位置）；读不出来返回 undefined，留给检查去说清楚 */
async function manifestRoot(folder: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(join(folder, 'oasis-app.json'), 'utf8')) as {
      root?: unknown;
    };
    return typeof manifest.root === 'string' ? manifest.root.replace(/\/+$/, '') : undefined;
  } catch {
    return undefined;
  }
}

/**
 * app.check：浏览器检查在平台的隔离容器里跑（ADR 0024），读不到沙箱，所以把应用目录里的文件随调用带上。
 * 应用可以是这个节点自己做的（out/<dir>），也可以是上游交来的（in/<上游 key>/<dir>，工具节点检查上游的
 * 网页就是这种）。只认普通文件、不跟随符号链接；超过上限就说清楚，交付后关卡照样会检查。
 * 交给检查的 dir 是「应用在做它的那个节点的产出里的位置」，也就是清单里的 root：自己做的是 out/ 之后的部分；
 * 上游交来的在 in/<上游 key>/ 之后（展开节点的每一条在 in/<上游 key>/<条目号>/ 之后），按清单写的 root 认。
 */
export async function appFiles(
  args: Record<string, unknown>,
): Promise<{ path: string; contentBase64: string }[]> {
  const usage =
    '--dir 写 oasis-app.json 所在的目录：自己做的如 out/site，上游交来的如 in/<上游 key>/site';
  if (typeof args.dir !== 'string') throw new Error(usage);
  const given = args.dir.replace(/^(\.\/)?(\/workspace\/)?/, '').replace(/\/+$/, '');
  // 没写 out/、in/ 的按 out/ 下的目录算
  const path = /^(?:out|in)\//.test(given) ? given : `out/${given}`;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(usage);
  const upstream = parts[0] === 'in';
  const outDir = resolve(process.env.OASIS_OUT_DIR ?? 'out');
  const root = upstream ? resolve(outDir, '..', path) : resolve(outDir, parts.slice(1).join('/'));
  let dir = parts.slice(upstream ? 2 : 1).join('/');
  if (upstream) {
    const declared = await manifestRoot(root);
    if (declared && path.endsWith(`/${declared}`)) dir = declared;
  }
  if (!dir) throw new Error(usage);
  args.dir = dir;
  // 结果里说的是实际检查的那个目录
  args.shown = path;
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
            `${path} 超过自查上限（${APP_MAX_FILES} 个文件、25 MB），自查不了；交付后关卡照样会检查`,
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
      throw new Error(`${path} 不存在`, { cause: error });
    throw error;
  }
  return files;
}
