// oasis-tool 里和文件打交道的部分：结果存到哪、图片和音频按实际格式改后缀、读本地图片、
// 3d.render 的场景和资产、app.check 带上的应用文件、web.fetch 抓回的全文。
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, open, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * 文件要存到哪：给了 --out 就用它（多个文件时加 -1、-2），否则放进 out/ 用工具给的名字。
 * 几个文件后缀不一样、其中只有一个和 --out 同后缀时，它就是主结果，原样存到 --out（之后都按这个路径找它）；
 * 其余的是附带的（如 app.check 的截图），放在旁边，名字接在后面。
 * 工具给的名字以「-序号」结尾（如一次生几张图时的 image-3.png）时用同一个序号：中间有一张没做出来，
 * 后面的也和描述的顺序对得上。
 */
export function targetsFor(files: { name: string }[], out: string | undefined): string[] {
  // 交付目录：沙箱里是 out/，用户电脑上是项目里的 .oasis/out/
  if (!out) return files.map((f) => join(process.env.OASIS_OUT_DIR ?? 'out', f.name));
  if (files.length === 1) return [out];
  const ext = extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  const mixed = new Set(files.map((f) => extname(f.name))).size > 1;
  const main = mixed && ext ? files.filter((f) => extname(f.name) === ext) : [];
  if (main.length === 1) return files.map((f) => (f === main[0] ? out : `${stem}-${f.name}`));
  const numbers = files.map((f) => /-(\d+)\.[^.]+$/.exec(f.name)?.[1]);
  const numbered = numbers.every(Boolean) && new Set(numbers).size === files.length;
  return files.map(
    (f, i) =>
      `${stem}-${numbered ? numbers[i] : i + 1}${mixed ? extname(f.name) : ext || extname(f.name)}`,
  );
}

/** 生图、视频、配音、音乐、3D 做出的文件花了用户的钱，都留给用户：只能存进交付目录（做好一个就进画布） */
export const KEPT_TOOLS = new Set([
  'image.generate',
  'video.generate',
  'audio.speech',
  'audio.music',
  '3d.generate',
  '3d.render',
]);

/** --out 写在交付目录（沙箱里是 out/，用户电脑上是项目里的 .oasis/out/）里面才行，不然这次不提交 */
export function requireDelivered(out: string): void {
  const dir = process.env.OASIS_OUT_DIR ?? 'out';
  const fold = (path: string) => (sep === '\\' ? path.toLowerCase() : path);
  if (fold(resolve(out)).startsWith(fold(`${resolve(dir)}${sep}`))) return;
  throw new Error(
    `生成的文件要存进 ${dir}/（用户在画布里才看得到）：--out 写成 ${dir}/名字，素材写成 ${dir}/素材/名字。这次没有提交，没有收费`,
  );
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
 * 后面看图报签名无效；2026-11-11：音乐型号回的是 FLAC）。不是这些后缀或认不出内容时原样返回。
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

/** web.fetch 抓回的全文存进 --out 目录（文件名只认「序号-摘要.md」） */
export async function saveFetched(files: { name: string; base64: string }[], out: string) {
  for (const f of files) {
    if (basename(f.name) !== f.name || !/^\d+-[a-f0-9]{12}\.md$/.test(f.name))
      throw new Error('工具返回了不安全的文件名');
    await mkdir(out, { recursive: true });
    await writeFile(join(out, f.name), Buffer.from(f.base64, 'base64'));
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

/**
 * 3d.render：读本地 scene.json，核对它引用的资产（不能跳出场景目录、不能是链接、大小和摘要对得上），
 * 把场景和资产清单、渲染设置写进参数；返回要上传的资产文件（提交后逐个上传）。
 */
export async function renderScene(args: Record<string, unknown>): Promise<string[]> {
  if (typeof args.scene !== 'string') throw new Error('--scene 需要本地 scene.json');
  const source = resolve(args.scene),
    directory = dirname(source);
  if ((await stat(source)).size > 1024 ** 2) throw new Error('Scene exceeds limit');
  const scene = JSON.parse(await readFile(source, 'utf8')) as {
    assets?: { id: string; path: string; sha256: string }[];
  };
  const inputs: string[] = [];
  const assets = [];
  for (const asset of scene.assets ?? []) {
    const target = resolve(directory, asset.path),
      rel = relative(directory, target);
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error('Asset path escapes scene');
    const actual = relative(await realpath(directory), await realpath(target));
    if (actual.startsWith('..') || isAbsolute(actual) || (await lstat(target)).isSymbolicLink())
      throw new Error('Asset symlink escapes scene');
    const size = (await stat(target)).size;
    if (size <= 0 || size > 100 * 1024 ** 2 || assets.length >= 20)
      throw new Error('Asset exceeds limits');
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(target)) hash.update(chunk);
    if (hash.digest('hex') !== asset.sha256) throw new Error('Asset hash mismatch');
    inputs.push(target);
    assets.push({ id: asset.id, size, sha256: asset.sha256 });
  }
  args.scene = scene;
  args.assets = assets;
  args.render = {
    width: Number(args.width ?? 512),
    height: Number(args.height ?? 512),
    samples: Number(args.samples ?? 32),
    backend: args.backend ?? 'CUDA',
  };
  for (const key of ['width', 'height', 'samples', 'backend']) delete args[key];
  return inputs;
}

/** app.check 一次带上的应用文件上限（入口代理收 50 MB 的请求，base64 后要放得下） */
const APP_MAX_FILES = 1000;
const APP_MAX_BYTES = 25 * 1024 * 1024;

/**
 * app.check：浏览器检查在平台的隔离容器里跑，读不到沙箱，所以把应用目录里的文件随调用带上。
 * 只查 out/ 里的应用（交给用户的都在那里）；只认普通文件、不跟随符号链接；超过上限就说清楚。
 * 交给检查的 dir 是应用在 out/ 里的位置，也就是清单里的 root。
 */
export async function appFiles(
  args: Record<string, unknown>,
): Promise<{ path: string; contentBase64: string }[]> {
  const usage = '--dir 写 oasis-app.json 所在的目录，如 out/site';
  if (typeof args.dir !== 'string') throw new Error(usage);
  // 用户电脑上交付目录是 .oasis/out/，写法和沙箱里的 out/ 一样认
  const given = args.dir
    .replaceAll('\\', '/')
    .replace(/^(\.\/)?(\/workspace\/|\.oasis\/)?/, '')
    .replace(/\/+$/, '');
  // 没写 out/ 的按 out/ 下的目录算
  const path = given.startsWith('out/') ? given : `out/${given}`;
  const parts = path.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(usage);
  const dir = parts.slice(1).join('/');
  if (!dir) throw new Error(usage);
  const root = resolve(process.env.OASIS_OUT_DIR ?? 'out', dir);
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
          throw new Error(`${path} 超过自查上限（${APP_MAX_FILES} 个文件、25 MB），自查不了`);
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
