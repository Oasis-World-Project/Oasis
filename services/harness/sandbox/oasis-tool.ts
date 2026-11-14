// oasis-tool：沙箱里的 AI 调用 Oasis 工具的命令，只依赖 Node 自带的能力。harness 每轮把当前版本放进
// 沙箱的 /opt/oasis（镜像里那份给离线验收用），改了不用重建镜像。
// 经入口代理连 model-gateway，带本次运行的临时 Key；生成的文件（图片、音频……）写到指定位置。
//
//   oasis-tool list                                   看有哪些工具、怎么用（<工具> --help 只看一个）
//   oasis-tool image.generate --prompt "…" --out out/图.png
//   oasis-tool video.generate --prompt "…" --out out/视频.mp4   长任务：提交后自己等，等不到就给任务号
//   oasis-tool video.generate … --wait false                    只提交、马上给任务号（几段一起交）
//   oasis-tool wait <任务号> [<任务号> …]                        一起等，各存到交的时候写的 --out
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { basename, dirname, extname, join } from 'node:path';
import { runBatch } from './batch.ts';
import {
  appFiles,
  localImages,
  localMedia,
  matchExt,
  renderScene,
  saveFetched,
  startOf,
  targetsFor,
} from './tool-files.ts';

/** 这些参数是列表：逗号分隔，或者直接写 JSON 数组 */
const LIST_ARGS = new Set(['urls', 'options', 'scale', 'ref', 'files', 'steps']);
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
  unit: string;
  available: boolean;
  /** 每个型号的典型单价和用时（旧版网关没有） */
  rates?: { model: string; costMicro: number; seconds: number | null }[];
  args?: { name: string; description: string; choices?: string[] }[];
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
    else if (name === 'plan') args[name] = JSON.parse(value) as unknown;
    // 描述里常有逗号，只认 JSON 数组
    else if (name === 'prompts') {
      const list: unknown = value.trim().startsWith('[') ? JSON.parse(value) : undefined;
      if (!Array.isArray(list))
        throw new Error('--prompts 要写成 JSON 数组，如 \'["画面一","画面二"]\'');
      args[name] = list;
    } else if (LIST_ARGS.has(name)) {
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

/** 列出工具、用法和单价；only：只看这一个，连同每个参数（oasis-tool <工具> --help） */
async function list(only?: string): Promise<void> {
  const { tools } = (await request('/tools')) as { tools: ToolEntry[] };
  const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(micro < 10_000 ? 4 : 3)}`;
  const shown = tools.filter((t) => t.available && (!only || t.key === only));
  if (only && !shown.length) throw new Error(`没有能用的工具 ${only}，oasis-tool list 看有哪些`);
  for (const tool of shown) {
    // 每个型号的单价和用时：AI 用 --model 选，默认第一个
    const rates = (tool.rates ?? [])
      .map(
        (r) =>
          `${r.model} 每${tool.unit}约 ${usd(r.costMicro)}${r.seconds ? `、一次约 ${r.seconds} 秒` : ''}`,
      )
      .join('；');
    const args = (only ? (tool.args ?? []) : []).map(
      (a) => `\n    --${a.name}：${a.description}${a.choices ? `（${a.choices.join('、')}）` : ''}`,
    );
    say(
      `${tool.key}（${tool.name}）：${tool.description}\n  用法：${tool.usage}${rates ? `\n  型号与单价（--model 指定，默认第一个）：${rates}` : ''}${args.length ? `\n  参数：${args.join('')}` : ''}\n`,
    );
  }
  const manifest = process.env.OASIS_SOFTWARE_MANIFEST;
  if (manifest && !only)
    say(`沙箱已安装的软件（安装时生成的实际版本）：\n${await readFile(manifest, 'utf8')}`);
}

/**
 * 存下工具交回的文件。job：等到的长任务的任务号——先说它做好了，每个「已保存」后面也带上（AI 常只看
 * 输出的末几行，进度页靠它把文件对上任务号）
 */
async function save(result: ToolResult, out: string | undefined, job?: string): Promise<void> {
  say(job ? `做好了（任务号 ${job}）\n${result.text}` : result.text);
  const targets = targetsFor(result.files, out);
  for (const [i, f] of result.files.entries()) {
    if (basename(f.name) !== f.name || f.name.includes('\\')) throw new Error('工具文件名不安全');
    const target = targets[i] ?? join('out', f.name);
    await mkdir(dirname(target), { recursive: true });
    let saved: string;
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
      saved = matchExt(target, await startOf(target));
      if (saved !== target) await rename(target, saved);
    } else {
      const bytes = Buffer.from(f.base64, 'base64');
      saved = matchExt(target, bytes);
      await writeFile(saved, bytes);
    }
    if (saved !== target)
      say(
        `注意：返回的文件实际是 ${extname(saved).slice(1).toUpperCase()}，按实际格式存成了 ${saved}`,
      );
    say(`已保存：${saved}${job ? `（任务号 ${job}）` : ''}`);
  }
  say(`花费：$${(result.costMicro / 1_000_000).toFixed(4)}`);
}

/** 长任务的恢复记录放在哪（交的时候记下任务号和 --out，重跑同一条命令不会重复提交） */
const stateDir = () => process.env.OASIS_TOOL_STATE_DIR ?? join('out', '.oasis-tools');

/** 交这个长任务时写的 --out；没记下就是 undefined（存进 out/，用工具给的名字） */
async function savedOut(id: string): Promise<string | undefined> {
  const names = await readdir(stateDir()).catch(() => [] as string[]);
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const state = JSON.parse(await readFile(join(stateDir(), name), 'utf8')) as {
        jobId?: string;
        out?: string;
      };
      if (state.jobId === id) return state.out;
    } catch {
      // 写到一半的记录不算
    }
  }
  return undefined;
}

/** 几个一起等时一个一个地存，各自的输出不交错 */
let saving: Promise<unknown> = Promise.resolve();
function inTurn(task: () => Promise<void>): Promise<void> {
  const next = saving.then(task, task);
  saving = next.catch(() => undefined);
  return next;
}

/** 等一个长任务做完并保存；等到上限还没好返回 false */
async function waitOne(id: string, out: string | undefined, deadline: number): Promise<boolean> {
  for (;;) {
    const job = (await request(`/tools/jobs/${encodeURIComponent(id)}`)) as ToolJob;
    if (job.status === 'completed' && job.result) {
      const result = job.result;
      await inTurn(() => save(result, out, id));
      return true;
    }
    // 供应商明确没做出来的不收费，可以重新提交；结果没确认的可能已经收费，不能重新提交
    if (job.status === 'failed')
      throw new Error(
        `${job.error ?? '没做出来'}（任务号 ${id}，供应商没做出来，没有收费；要再试就加 --new true 重新提交）`,
      );
    if (job.status === 'uncertain')
      throw new Error(`${job.error ?? '结果没确认'}；任务号 ${id}，不要重新提交以免重复收费`);
    if (Date.now() + POLL_MS > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/** 等长任务做完：一起等、各存各的（out 只在等一个时给）；等到上限还没好的，告诉 AI 怎么接着等 */
async function wait(ids: string[], out?: string): Promise<void> {
  const deadline = Date.now() + waitSeconds() * 1000;
  const results = await Promise.allSettled(
    ids.map(async (id) => waitOne(id, out ?? (await savedOut(id)), deadline)),
  );
  const pending = ids.filter((_, i) => {
    const r = results[i];
    return r?.status === 'fulfilled' && !r.value;
  });
  if (pending.length) {
    const again = `oasis-tool wait ${pending.join(' ')}${out ? ` --out ${JSON.stringify(out)}` : ''}`;
    say(`还没做好（任务号 ${pending.join('、')}）。先做别的，过一会儿运行：${again}`);
  }
  const failed = results.flatMap((r) =>
    r.status === 'rejected'
      ? [r.reason instanceof Error ? r.reason.message : String(r.reason)]
      : [],
  );
  if (failed.length) throw new Error(failed.join('\n'));
}

async function run(key: string, argv: string[]): Promise<void> {
  const { args, out, file } = parseArgs(argv);
  // --wait false：长任务只提交、马上给任务号，几个交完再用 wait 一起等
  const noWait = args.wait === 'false';
  delete args.wait;
  if (key === 'app.check') {
    args.files = await appFiles(args);
    // 给了 --out 就要一份完整报告存进去；没给只看终端里的结论
    if (out) args.report = true;
  }
  const renderInputs = key === '3d.render' ? await renderScene(args) : [];
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
    if (noWait) {
      say(
        `已提交，没等结果（任务号 ${id}）。几个都交完后一起等：oasis-tool wait ${id} <别的任务号…>`,
      );
      return;
    }
    return wait([id], out);
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
    const folder = stateDir();
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
  if (key === 'image.generate' && args.ref !== undefined) {
    args.references = await localImages(args.ref);
    delete args.ref;
  }
  if (key === 'media.inspect' && args.files !== undefined)
    args.files = await localMedia(args.files);
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
      // 记下存到哪：之后 wait 几个任务号一起等时，各存各的
      await writeFile(
        partial,
        JSON.stringify({ ...requestState, jobId: result.job.id, ...(out ? { out } : {}) }),
      );
      await rename(partial, statePath);
    } finally {
      await rm(partial, { force: true });
    }
  }
  if (key === 'web.fetch' && out) {
    await saveFetched(result.files, out);
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
      '用法：oasis-tool list | oasis-tool <工具名> --参数 值 … [--out 路径] [--wait false] | oasis-tool wait <任务号> [<任务号> …]',
    );
    return;
  }
  if (command === 'list') return list();
  if (rest.includes('--help') || rest.includes('-h')) return list(command);
  if (command === 'cancel') {
    const [id] = rest;
    if (!id || !/^[a-f0-9-]{36}$/.test(id)) throw new Error('cancel 后面需要任务号');
    await request(`/tools/jobs/${encodeURIComponent(id)}/cancel`, { method: 'POST', body: '{}' });
    say('取消意图已保存；供应商终态及费用仍由后台核对，请用 wait 查询。');
    return;
  }
  if (command === 'wait') {
    const at = rest.findIndex((token) => token.startsWith('--'));
    const ids = at < 0 ? rest : rest.slice(0, at);
    const { out } = parseArgs(at < 0 ? [] : rest.slice(at));
    if (!ids.length) throw new Error('wait 后面要写任务号（几个一起等就都写上）');
    if (ids.length > 1 && out)
      throw new Error('几个任务一起等时不写 --out：各存到交的时候写的 --out');
    // 一起等：有一个没做出来，其余的照样等完
    return wait(ids, out);
  }
  // 沙箱里的本地操作：工具目录里叫 op.*，由 oasis-op 做
  if (command.startsWith('op.')) {
    const child = spawn('oasis-op', [command.slice(3), ...rest], { stdio: 'inherit' });
    process.exitCode = await new Promise<number>((done) => {
      child.on('error', () => done(127));
      child.on('close', (code) => done(code ?? 1));
    });
    return;
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
