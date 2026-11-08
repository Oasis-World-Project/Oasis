// oasis-steps：工具节点的步骤执行器（ADR 0025）。harness 起工具运行时沙箱里跑的是它，不起 AI。
// 按 in/.oasis-steps.json 一步一步执行：外部工具交给 oasis-tool，本地操作（op.*）交给 oasis-op。
// 每步失败自动重试 2 次；长任务（视频、音乐……）一直等到做完。进度记在 out/.oasis-steps/progress.json，
// 接管或停止后继续时跳过已经做完的步骤（做到一半的长任务由 oasis-tool 接着原来的提交，不重复收费）。
// 往 stdout 写一行一个 JSON，harness 记成运行事件（services/harness/src/service/run/steps.ts）：
//   {"type":"tool_call","callId":…,"name":"bash","arguments":"{\"command\":…,\"description\":…}"}
//   {"type":"tool_result","callId":…,"ok":true,"text":…}
//   {"type":"assistant_text","text":…}
//   {"type":"done","ok":true} 或 {"type":"done","ok":false,"error":…}
// 镜像里按仓库的相对位置放（infra/images/harness-sandbox-base/Dockerfile），import 路径两边一致。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { argValue } from '../../../packages/contracts/src/tool-args.ts';

export interface Step {
  tool: string;
  args?: Record<string, unknown>;
  out?: string;
}

export interface Ran {
  code: number;
  stdout: string;
  stderr: string;
}

/** 执行器要用的外部能力：测试里换成假的 */
export interface Runner {
  /** 工作目录（out/ 在它下面） */
  root: string;
  run(argv: string[]): Promise<Ran>;
  emit(event: Record<string, unknown>): void;
  sleep(ms: number): Promise<void>;
}

const STEPS_FILE = 'in/.oasis-steps.json';
const PROGRESS_FILE = 'out/.oasis-steps/progress.json';
/** 每步最多试几次：第一次 + 自动重试 2 次 */
const ATTEMPTS = 3;
/** 第 n 次重试前等多久（毫秒） */
const BACKOFF_MS = 10_000;
/** oasis-tool 一次最多等长任务多久（秒）；还没好就接着 wait，直到做完 */
const WAIT_SECONDS = '600';
/** 文字结果的工具（搜索、看图、转写、判断）给了 out 就把文字存进去 */
const TEXT_OUT = /\.(?:txt|md|json|jsonl|csv)$/i;
/** oasis-tool 等不到长任务时说的话：取出任务号接着等 */
const PENDING = /还没做好（任务号 ([a-f0-9-]{36})）/;
/** oasis-tool 的结果行，不算工具给的文字 */
const TOOL_LINES = /^(?:花费：|已保存|还没做好|沿用任务号|注意：返回的图片)/;

/** 一步要运行的命令：oasis-tool <工具> --参数 值 … [--out 路径]；op.* 交给 oasis-op */
export function commandOf(step: Step, extra: string[] = []): string[] {
  const local = step.tool.startsWith('op.');
  const argv = [local ? 'oasis-op' : 'oasis-tool', local ? step.tool.slice(3) : step.tool];
  for (const [name, value] of Object.entries(step.args ?? {}))
    if (value !== undefined && value !== null && value !== '')
      argv.push(`--${name}`, argValue(value));
  if (step.out) argv.push('--out', step.out);
  return [...argv, ...extra];
}

/** 给人看的命令（工作流页上显示）：有空格、引号等的值加引号 */
export const shown = (argv: string[]) =>
  argv.map((a) => (/^[\w./:@%+=,-]+$/.test(a) ? a : JSON.stringify(a))).join(' ');

/** 失败的原因：工具自己说的最后一句（去掉「oasis-tool 出错：」前缀），没有就看退出码 */
export function errorOf(result: Ran): string {
  const said = result.stderr.trim() || result.stdout.trim();
  const last = (said.split('\n').at(-1) ?? '').replace(/^oasis-(?:tool|op) 出错：/, '').trim();
  return last || `退出码 ${result.code}`;
}

/**
 * 失败后下一次怎么试：结果没确认的长任务不再试（重新提交可能重复收费，交给用户）；供应商明确没做出来
 * （没有收费）或旧结果已过期的重新提交；批次接着原来的进度；其余照原样再试——做到一半的长任务会接着原来的提交。
 */
export function nextTry(error: string): string[] | 'stop' {
  if (/不要重新提交/.test(error)) return 'stop';
  if (/没有收费|已过期/.test(error)) return ['--new', 'true'];
  if (/--resume true/.test(error)) return ['--resume', 'true'];
  return [];
}

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );

/** 跑一次：长任务等到做完；成功时返回工具说的话 */
async function attempt(
  runner: Runner,
  step: Step,
  argv: string[],
): Promise<{ ok: true; stdout: string } | { ok: false; error: string }> {
  let result = await runner.run(argv);
  for (;;) {
    if (result.code !== 0) return { ok: false, error: errorOf(result) };
    const pending = PENDING.exec(result.stdout)?.[1];
    if (!pending) return { ok: true, stdout: result.stdout };
    result = await runner.run([
      'oasis-tool',
      'wait',
      pending,
      ...(step.out ? ['--out', step.out] : []),
    ]);
  }
}

/** 结果有没有落到 out：文字结果的工具把文字存进去；该有文件却没有算失败 */
export async function settleOut(
  root: string,
  step: Step,
  stdout: string,
): Promise<string | undefined> {
  if (!step.out || /^已保存/m.test(stdout)) return undefined;
  const target = join(root, step.out);
  if (await exists(target)) return undefined;
  if (!TEXT_OUT.test(step.out)) return `工具说做完了，但没有生成 ${step.out}`;
  const text = stdout
    .split('\n')
    .filter((line) => !TOOL_LINES.test(line))
    .join('\n')
    .trim();
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${text}\n`);
  return undefined;
}

/** 执行一步（含自动重试）；做不成返回原因 */
async function runStep(runner: Runner, step: Step, index: number): Promise<string | undefined> {
  const label = `第 ${index + 1} 步（${step.tool}）`;
  let extra: string[] = [];
  let error = '';
  for (let tried = 1; tried <= ATTEMPTS; tried += 1) {
    const argv = commandOf(step, extra);
    const callId = `step-${index + 1}-${tried}`;
    runner.emit({
      type: 'tool_call',
      callId,
      name: 'bash',
      arguments: JSON.stringify({
        command: shown(argv),
        description: tried > 1 ? `${label}，第 ${tried} 次` : label,
      }),
    });
    const result = await attempt(runner, step, argv);
    const problem = result.ok ? await settleOut(runner.root, step, result.stdout) : result.error;
    if (result.ok && !problem) {
      runner.emit({ type: 'tool_result', callId, ok: true, text: result.stdout.trim() });
      return undefined;
    }
    error = problem ?? '没做成';
    runner.emit({ type: 'tool_result', callId, ok: false, text: '', error });
    const next = nextTry(error);
    if (next === 'stop') break;
    extra = next;
    if (tried < ATTEMPTS) {
      const wait = BACKOFF_MS * tried;
      runner.emit({
        type: 'assistant_text',
        text: `${label}没成功：${error}。${Math.round(wait / 1000)} 秒后自动重试。`,
      });
      await runner.sleep(wait);
    }
  }
  return `${label}没做成：${error}`;
}

interface Progress {
  version: 1;
  digest: string;
  done: number[];
}

/**
 * 按顺序执行步骤；done 里的（之前做完的）跳过，每做完一步记一次进度。
 * 全部做完返回 undefined，做不成返回原因。
 */
export async function runSteps(
  runner: Runner,
  steps: Step[],
  done: Set<number>,
  save: (done: Set<number>) => Promise<void>,
): Promise<string | undefined> {
  if (done.size)
    runner.emit({
      type: 'assistant_text',
      text: `接着上次的进度：前面做完的 ${done.size} 步不再重做。`,
    });
  for (const [index, step] of steps.entries()) {
    if (done.has(index)) continue;
    const failure = await runStep(runner, step, index);
    if (failure) return failure;
    done.add(index);
    await save(done);
  }
  const outputs = [...new Set(steps.map((s) => s.out).filter((o): o is string => Boolean(o)))];
  runner.emit({
    type: 'assistant_text',
    text: `${steps.length} 步都做完了${outputs.length ? `，结果在 ${outputs.join('、')}` : ''}。`,
  });
  return undefined;
}

/** 真正的命令：子进程的输出收起来（stdout 只留给事件） */
function spawnRun(argv: string[]): Promise<Ran> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      env: { ...process.env, OASIS_TOOL_WAIT_SECONDS: WAIT_SECONDS },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      stdout = (stdout + text).slice(-5_000_000);
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => {
      stderr = (stderr + text).slice(-20_000);
    });
    child.on('error', (error) =>
      resolve({ code: 127, stdout, stderr: `${stderr}${error.message}` }),
    );
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function main(runner: Runner): Promise<void> {
  const steps = JSON.parse(await readFile(join(runner.root, STEPS_FILE), 'utf8')) as Step[];
  if (!Array.isArray(steps) || !steps.length) throw new Error('没有要执行的步骤');
  const digest = createHash('sha256').update(JSON.stringify(steps)).digest('hex');
  const file = join(runner.root, PROGRESS_FILE);
  let done = new Set<number>();
  try {
    const saved = JSON.parse(await readFile(file, 'utf8')) as Progress;
    // 步骤改过了（摘要不同）就从头做
    if (saved.version === 1 && saved.digest === digest) done = new Set(saved.done);
  } catch {
    // 没有进度（第一次跑）：从头做
  }
  const failure = await runSteps(runner, steps, done, async (finished) => {
    await mkdir(dirname(file), { recursive: true });
    const progress: Progress = { version: 1, digest, done: [...finished].sort((a, b) => a - b) };
    await writeFile(`${file}.partial`, JSON.stringify(progress));
    await rename(`${file}.partial`, file);
  });
  runner.emit(failure ? { type: 'done', ok: false, error: failure } : { type: 'done', ok: true });
}

if (import.meta.main) {
  const emit = (event: Record<string, unknown>) =>
    process.stdout.write(`${JSON.stringify(event)}\n`);
  main({
    root: process.cwd(),
    run: spawnRun,
    emit,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
    .catch((error: unknown) => {
      emit({
        type: 'done',
        ok: false,
        error: `工具步骤没法开始：${error instanceof Error ? error.message : String(error)}`,
      });
    })
    .finally(() => {
      // 做完后等 harness 取走产出、销毁沙箱（标准输入关掉就退出）
      process.stdin.on('end', () => process.exit(0));
      process.stdin.resume();
    });
}
