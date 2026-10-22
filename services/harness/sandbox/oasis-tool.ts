// oasis-tool：沙箱里的 AI 调用 Oasis 工具的命令（ADR 0006）。装在沙箱镜像里，只依赖 Node 自带的能力。
// 经入口代理连 model-gateway，带本次运行的临时 Key；生成的文件（图片、音频……）写到指定位置。
//
//   oasis-tool list                                   看有哪些工具、怎么用
//   oasis-tool image.generate --prompt "…" --out out/图.png
//   oasis-tool web.search --query "…"
//   oasis-tool audio.transcribe --file in/录音.mp3
//   oasis-tool video.generate --prompt "…" --out out/视频.mp4   长任务：提交后自己等，等不到就给任务号
//   oasis-tool wait <任务号> --out out/视频.mp4                   接着等长任务
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';

/** 这些参数是列表：逗号分隔，或者直接写 JSON 数组 */
const LIST_ARGS = new Set(['urls', 'options', 'scale']);
const AUDIO_FORMATS = new Set(['mp3', 'wav', 'm4a', 'flac', 'ogg', 'webm']);

interface ToolFile {
  name: string;
  mediaType: string;
  base64: string;
}
interface ToolResult {
  text: string;
  files: ToolFile[];
  costMicro: number;
  job?: { id: string };
}
interface ToolJob {
  status: 'pending' | 'completed' | 'failed';
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
  return files.map((f, i) => `${stem}-${i + 1}${ext || extname(f.name)}`);
}

/** 命令的输出（AI 读的就是这些） */
const say = (text: string) => process.stdout.write(`${text}\n`);

async function request(path: string, init: RequestInit = {}): Promise<unknown> {
  const base = process.env.OASIS_MODEL_BASE_URL;
  // 在 dsh 的命令里只有 OASIS_TOOL_AUTH（OASIS_RUN_KEY 会被 dsh 去掉）
  const key = process.env.OASIS_TOOL_AUTH ?? process.env.OASIS_RUN_KEY;
  if (!base || !key) throw new Error('这里不是 Oasis 的沙箱，用不了 oasis-tool');
  const response = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
  });
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string };
  };
  if (!response.ok) throw new Error(body.error?.message ?? `工具服务返回 ${response.status}`);
  return body;
}

async function list(): Promise<void> {
  const { tools } = (await request('/tools')) as { tools: ToolEntry[] };
  for (const tool of tools.filter((t) => t.available)) {
    say(`${tool.key}（${tool.name}）：${tool.description}\n  用法：${tool.usage}\n`);
  }
}

async function save(result: ToolResult, out: string | undefined): Promise<void> {
  say(result.text);
  const targets = targetsFor(result.files, out);
  for (const [i, f] of result.files.entries()) {
    const target = targets[i] ?? join('out', f.name);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(f.base64, 'base64'));
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
    if (job.status === 'failed') throw new Error(job.error ?? '没做出来');
    if (Date.now() + POLL_MS > deadline) {
      const again = `oasis-tool wait ${id}${out ? ` --out ${JSON.stringify(out)}` : ''}`;
      say(`还没做好（任务号 ${id}）。先做别的，过一会儿运行：${again}`);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function run(key: string, argv: string[]): Promise<void> {
  const { args, out, file } = parseArgs(argv);
  if (file) {
    const format = extname(file).slice(1).toLowerCase();
    if (!AUDIO_FORMATS.has(format)) throw new Error(`不支持的音频格式：${format}`);
    args.audio_base64 = (await readFile(file)).toString('base64');
    args.format = format;
  }
  const result = (await request(`/tools/${encodeURIComponent(key)}`, {
    method: 'POST',
    body: JSON.stringify({ args }),
  })) as ToolResult;
  if (!result.job) return save(result, out);
  say(result.text);
  return wait(result.job.id, out);
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
