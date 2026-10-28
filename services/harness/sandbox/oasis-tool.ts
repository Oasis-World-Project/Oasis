// oasis-tool：沙箱里的 AI 调用 Oasis 工具的命令（ADR 0006）。装在沙箱镜像里，只依赖 Node 自带的能力。
// 经入口代理连 model-gateway，带本次运行的临时 Key；生成的文件（图片、音频……）写到指定位置。
//
//   oasis-tool list                                   看有哪些工具、怎么用
//   oasis-tool image.generate --prompt "…" --out out/图.png
//   oasis-tool web.search --query "…"
//   oasis-tool audio.transcribe --file in/录音.mp3
//   oasis-tool video.generate --prompt "…" --out out/视频.mp4   长任务：提交后自己等，等不到就给任务号
//   oasis-tool wait <任务号> --out out/视频.mp4                   接着等长任务
import { mkdir, readFile, stat, writeFile, rename, rm, realpath, lstat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join, resolve, relative, isAbsolute } from 'node:path';
import { runBatch } from './batch.ts';

/** 这些参数是列表：逗号分隔，或者直接写 JSON 数组 */
const LIST_ARGS = new Set(['urls', 'options', 'scale', 'ref', 'images']);
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm']);

interface ToolFile {
  name: string;
  mediaType: string;
  base64: string;
  id?: string;
  size?: number;
  sha256?: string;
}
interface ToolResult {
  text: string;
  files: ToolFile[];
  costMicro: number;
  job?: { id: string };
}
interface ToolJob {
  status: 'pending' | 'completed' | 'failed' | 'uncertain';
  result?: ToolResult;
  error?: string;
}

/** 长任务每隔几秒问一次进度；一次命令最多等多久（秒），免得超过运行命令的时间限制 */
const POLL_MS = 5_000;
const waitSeconds = () => Number(process.env.OASIS_TOOL_WAIT_SECONDS) || 100;
interface ToolEntry {
  key: string;
  name: string;
  description: string;
  usage: string;
  available: boolean;
}

/** 解析 --名字 值；同时返回 --out 和 --file */
export function parseArgs(argv: string[]): {
  args: Record<string, unknown>;
  out?: string;
  file?: string;
} {
  const args: Record<string, unknown> = {};
  let out: string | undefined;
  let file: string | undefined;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i] ?? '';
    if (!flag.startsWith('--')) throw new Error(`看不懂参数「${flag}」，参数要写成 --名字 值`);
    const name = flag.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${name} 后面缺少值`);
    i += 1;
    if (name === 'out') out = value;
    else if (name === 'file') file = value;
    else if (LIST_ARGS.has(name)) {
      args[name] = value.trim().startsWith('[')
        ? (JSON.parse(value) as unknown)
        : value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    } else args[name] = value;
  }
  return { args, ...(out ? { out } : {}), ...(file ? { file } : {}) };
}

/** 文件要存到哪：给了 --out 就用它（多个文件时加 -1、-2），否则放进 out/ 用工具给的名字 */
export function targetsFor(files: ToolFile[], out: string | undefined): string[] {
  if (!out) return files.map((f) => join('out', f.name));
  if (files.length === 1) return [out];
  const ext = extname(out);
  const stem = ext ? out.slice(0, -ext.length) : out;
  const mixed = new Set(files.map((f) => extname(f.name))).size > 1;
  return files.map((f, i) => `${stem}-${i + 1}${mixed ? extname(f.name) : ext || extname(f.name)}`);
}

/** 命令的输出（AI 读的就是这些） */
const say = (text: string) => process.stdout.write(`${text}\n`);

async function openRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const base = process.env.OASIS_MODEL_BASE_URL;
  // 在 dsh 的命令里只有 OASIS_TOOL_AUTH（OASIS_RUN_KEY 会被 dsh 去掉）
  const key = process.env.OASIS_TOOL_AUTH ?? process.env.OASIS_RUN_KEY;
  if (!base || !key) throw new Error('这里不是 Oasis 的沙箱，用不了 oasis-tool');
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...init.headers,
      authorization: `Bearer ${key}`,
    },
  });
  if (response.ok) return response;
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string };
  };
  throw Object.assign(new Error(body.error?.message ?? `工具服务返回 ${response.status}`), {
    code: body.error?.code,
    status: response.status,
  });
}
async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  return (await openRequest(path, init)).json();
}

async function list(): Promise<void> {
  const { tools } = (await request('/tools')) as { tools: ToolEntry[] };
  for (const tool of tools.filter((t) => t.available)) {
    say(`${tool.key}（${tool.name}）：${tool.description}\n  用法：${tool.usage}\n`);
  }
  const manifest = process.env.OASIS_SOFTWARE_MANIFEST;
  if (manifest)
    say(`沙箱已安装的软件（安装时生成的实际版本）：\n${await readFile(manifest, 'utf8')}`);
}

async function save(result: ToolResult, out: string | undefined): Promise<void> {
  say(result.text);
  const targets = targetsFor(result.files, out);
  for (const [i, f] of result.files.entries()) {
    if (basename(f.name) !== f.name || f.name.includes('\\')) throw new Error('工具文件名不安全');
    const target = targets[i] ?? join('out', f.name);
    await mkdir(dirname(target), { recursive: true });
    if (f.id !== undefined) {
      if (
        !result.job ||
        !/^\d{1,3}$/.test(f.id) ||
        !/^[a-f0-9-]{36}$/.test(result.job.id) ||
        !Number.isSafeInteger(f.size) ||
        !f.sha256
      )
        throw new Error('工具文件引用不完整');
      const response = await openRequest(`/tools/jobs/${result.job.id}/files/${f.id}`);
      if (!response.body) throw new Error('工具文件没有内容流');
      const partial = `${target}.${randomUUID()}.partial`;
      const hash = createHash('sha256');
      let size = 0;
      const check = new Transform({
        transform(chunk: Buffer, _encoding, done) {
          size += chunk.length;
          if (size > f.size! || size > 512 * 1024 * 1024)
            return done(new Error('工具文件超过大小上限'));
          hash.update(chunk);
          done(null, chunk);
        },
      });
      try {
        await pipeline(
          Readable.fromWeb(response.body),
          check,
          createWriteStream(partial, { flags: 'wx' }),
        );
        if (size !== f.size || hash.digest('hex') !== f.sha256)
          throw new Error('工具文件大小或校验和不一致');
        await rename(partial, target);
      } finally {
        await rm(partial, { force: true });
      }
    } else await writeFile(target, Buffer.from(f.base64, 'base64'));
    say(`已保存：${target}`);
  }
  say(`花费：$${(result.costMicro / 1_000_000).toFixed(4)}`);
}

/** 等长任务做完：做好了就保存；等到上限还没好，告诉 AI 怎么接着等 */
async function wait(id: string, out: string | undefined): Promise<void> {
  const deadline = Date.now() + waitSeconds() * 1000;
  for (;;) {
    const job = (await request(`/tools/jobs/${encodeURIComponent(id)}`)) as ToolJob;
    if (job.status === 'completed' && job.result) return save(job.result, out);
    if (job.status === 'failed' || job.status === 'uncertain')
      throw new Error(`${job.error ?? '没做出来'}；任务号 ${id}，不要重新提交以免重复收费`);
    if (Date.now() + POLL_MS > deadline) {
      const again = `oasis-tool wait ${id}${out ? ` --out ${JSON.stringify(out)}` : ''}`;
      say(`还没做好（任务号 ${id}）。先做别的，过一会儿运行：${again}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function localImages(paths: unknown): Promise<{ mediaType: string; base64: string }[]> {
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

async function run(key: string, argv: string[]): Promise<void> {
  const { args, out, file } = parseArgs(argv);
  const renderInputs: string[] = [];
  if (key === '3d.render') {
    if (typeof args.scene !== 'string') throw new Error('--scene 需要本地 scene.json');
    const source = resolve(args.scene),
      directory = dirname(source);
    if ((await stat(source)).size > 1024 ** 2) throw new Error('Scene exceeds limit');
    const scene = JSON.parse(await readFile(source, 'utf8')) as {
      assets?: { id: string; path: string; sha256: string }[];
    };
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
      renderInputs.push(target);
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
  }
  const finishJob = async (id: string) => {
    if (key === '3d.render') {
      const state = (await request(`/tools/jobs/${id}`)) as { phase?: string };
      if (state.phase === 'uploading') {
        for (const [index, path] of renderInputs.entries())
          await openRequest(`/tools/jobs/${id}/inputs/${index}`, {
            method: 'PUT',
            headers: { 'content-type': 'application/octet-stream' },
            body: Readable.toWeb(createReadStream(path)),
            duplex: 'half',
          } as RequestInit);
        await request(`/tools/jobs/${id}/submit`, { method: 'POST', body: '{}' });
      }
    }
    return wait(id, out);
  };
  if (key === '3d.generate' && args.image !== undefined) {
    if (typeof args.image !== 'string') throw new Error('--image 需要本地图片路径');
    args.image = await localImages([args.image]);
  }
  if (key === 'audio.music' && args.lyrics_file !== undefined) {
    if (typeof args.lyrics_file !== 'string' || (await stat(args.lyrics_file)).size > 14_000)
      throw new Error('歌词文件超过上限');
    args.lyrics = await readFile(args.lyrics_file, 'utf8');
    delete args.lyrics_file;
  }
  if (key === 'video.generate' && args.first_frame !== undefined) {
    if (typeof args.first_frame !== 'string') throw new Error('--first_frame 需要一个本地图片路径');
    // 编码在幂等键计算前完成：同一路径换了图片也不能取回旧视频。
    args.first_frame = await localImages([args.first_frame]);
  }
  const forceNew = args.new === 'true';
  delete args.new;
  const maxCost = args.max_cost_micro === undefined ? undefined : Number(args.max_cost_micro);
  delete args.max_cost_micro;
  let statePath: string | undefined;
  let requestState: { key: string; jobId?: string } | undefined;
  if (
    key === 'audio.music' ||
    key === 'video.generate' ||
    key === '3d.generate' ||
    key === '3d.render'
  ) {
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({
          key,
          out,
          args: Object.fromEntries(Object.entries(args).sort(([a], [b]) => a.localeCompare(b))),
        }),
      )
      .digest('hex');
    const folder = process.env.OASIS_TOOL_STATE_DIR ?? join('out', '.oasis-tools');
    await mkdir(folder, { recursive: true });
    statePath = join(folder, `${fingerprint}.json`);
    const scope = process.env.OASIS_TOOL_SCOPE;
    const hash = createHash('sha256')
      .update(`${scope ?? ''}:${fingerprint}`)
      .digest('hex');
    const stableKey = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
    const fresh = { key: scope && !forceNew ? stableKey : randomUUID() };
    if (forceNew) await writeFile(statePath, JSON.stringify(fresh));
    else {
      try {
        await writeFile(statePath, JSON.stringify(fresh), { flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
    requestState = JSON.parse(await readFile(statePath, 'utf8')) as { key: string; jobId?: string };
    if (!/^[a-f0-9-]{36}$/.test(requestState.key))
      throw new Error('工具恢复记录损坏，未提交供应商');
    if (requestState.jobId) {
      say(`沿用任务号 ${requestState.jobId}，未重新提交。`);
      return finishJob(requestState.jobId);
    }
  }
  if (
    key === 'text.batch' ||
    (key === 'jev.decide' && (args.in !== undefined || args.resume !== undefined))
  ) {
    if (file) throw new Error('批次请使用 --in，不使用 --file');
    const result = await runBatch({ kind: key, args, out, request });
    say(
      `批次进度：完成 ${result.completed}，失败 ${result.failed}，不确定 ${result.uncertain}，待运行 ${result.pending}。费用及预留：${result.costMicro} 微美元。`,
    );
    say(`结果：${out}；恢复使用同一 --out 并加 --resume true。不确定的行不会自动重发。`);
    return;
  }
  const paths =
    key === 'image.generate' ? args.ref : key === 'image.inspect' ? args.images : undefined;
  if (paths !== undefined) {
    delete args.ref;
    args[key === 'image.generate' ? 'references' : 'images'] = await localImages(paths);
  }
  if (key === 'web.fetch' && out) args.format = 'files';
  if (file) {
    const format = extname(file).slice(1).toLowerCase();
    if (!AUDIO_FORMATS.has(format)) throw new Error(`不支持的音频格式：${format}`);
    if ((await stat(file)).size > 20 * 1024 * 1024)
      throw new Error('转写输入超过 20 MiB，请先分段');
    args.audio_base64 = (await readFile(file)).toString('base64');
    args.format = format;
  }
  const result = (await request(`/tools/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify({
      args,
      ...(requestState ? { idempotency_key: requestState.key } : {}),
      ...(maxCost === undefined ? {} : { max_cost_micro: maxCost }),
    }),
  })) as ToolResult;
  if (result.job && statePath && requestState) {
    const partial = `${statePath}.${randomUUID()}.partial`;
    try {
      await writeFile(partial, JSON.stringify({ ...requestState, jobId: result.job.id }));
      await rename(partial, statePath);
    } finally {
      await rm(partial, { force: true });
    }
  }
  if (key === 'web.fetch' && out) {
    for (const f of result.files) {
      if (
        basename(f.name) !== f.name ||
        f.name.includes('\\') ||
        !/^\d+-[a-f0-9]{12}\.md$/.test(f.name)
      )
        throw new Error('工具返回了不安全的文件名');
      await mkdir(out, { recursive: true });
      await writeFile(join(out, f.name), Buffer.from(f.base64, 'base64'));
    }
    say(result.text);
    say(
      `已保存 ${result.files.length} 份全文到 ${out}；花费：$${(result.costMicro / 1_000_000).toFixed(4)}`,
    );
    return;
  }
  if (!result.job) return save(result, out);
  say(result.text);
  return finishJob(result.job.id);
}

export async function main(argv: string[]): Promise<void> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help') {
    say(
      '用法：oasis-tool list | oasis-tool <工具名> --参数 值 … [--out 路径] | oasis-tool wait <任务号>',
    );
    return;
  }
  if (command === 'list') return list();
  if (command === 'cancel') {
    const [id] = rest;
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('cancel 后面需要任务号');
    await request(`/tools/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
    say('取消意图已保存；供应商终态及费用仍由后台核对，请用 wait 查询。');
    return;
  }
  if (command === 'wait') {
    const [id, ...more] = rest;
    if (!id) throw new Error('wait 后面要写任务号');
    return wait(id, parseArgs(more).out);
  }
  return run(command, rest);
}

// 作为命令运行时（测试里只导入上面的函数）
if (import.meta.main) {
  // 输出被提前关掉（如 oasis-tool list | head）不算出错
  process.stdout.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') process.exit(0);
    throw err;
  });
  main(process.argv.slice(2)).catch((err: unknown) => {
    process.stderr.write(`oasis-tool 出错：${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
