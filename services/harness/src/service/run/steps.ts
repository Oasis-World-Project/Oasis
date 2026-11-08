// 工具运行（ADR 0025）：沙箱里不起 AI，起的是镜像里的工具步骤执行器 oasis-steps。它按 in/.oasis-steps.json
// 一步一步调 oasis-tool / oasis-op（每步失败自动重试），往 stdout 写一行一个 JSON；这里把它们记成运行事件，
// 读到 done 为止。进度记在工作目录里（out/.oasis-steps/），接管或停止后继续时执行器跳过做完的步骤。
import { createInterface } from 'node:readline';
import type { RunEventBody, StartRunBody } from '@oasis/contracts/harness';
import { STEPS_RUNNER, type Sandbox } from '../../executor/executor.ts';

/** 沙箱里跑执行器的命令（代替镜像默认的 dsh） */
export const STEPS_COMMAND = ['node', '--no-warnings', STEPS_RUNNER];

/** 交给执行器的步骤：和 dsh 的元数据一样放在 in/ 下，接管时照样重放 */
export const stepsFile = (steps: NonNullable<StartRunBody['steps']>) => ({
  path: 'in/.oasis-steps.json',
  content: Buffer.from(JSON.stringify(steps)),
});

const KINDS = new Set<RunEventBody['kind']>([
  'assistant_text',
  'tool_call',
  'tool_result',
  'error',
]);
const LIMIT = 20_000;
const clip = (value: unknown) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
  return text.length > LIMIT ? `${text.slice(0, LIMIT)}…（已截断）` : text;
};

/** 执行器的一行 → 运行事件的内容；认不出的行返回 undefined */
export function stepEvent(
  line: string,
): { kind: RunEventBody['kind'] | 'done'; data: Record<string, unknown> } | undefined {
  let event: unknown;
  try {
    event = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!event || typeof event !== 'object') return undefined;
  const { type, ...rest } = event as { type?: unknown } & Record<string, unknown>;
  if (type === 'done') return { kind: 'done', data: rest };
  if (typeof type !== 'string' || !KINDS.has(type as RunEventBody['kind'])) return undefined;
  const data = Object.fromEntries(
    Object.entries(rest).map(([key, value]) =>
      ['text', 'arguments', 'error', 'message'].includes(key) ? [key, clip(value)] : [key, value],
    ),
  );
  return { kind: type as RunEventBody['kind'], data };
}

/**
 * 读执行器的输出直到 done：成功返回 undefined，失败返回原因。运行被中止时（沙箱被暂停、销毁）
 * 不再等，调用方按中止原因收尾。
 */
export async function runToolSteps(input: {
  sandbox: Pick<Sandbox, 'stdout'>;
  signal: AbortSignal;
  record: (kind: RunEventBody['kind'], data: Record<string, unknown>) => void;
  stderr: () => string;
}): Promise<string | undefined> {
  const lines = createInterface({ input: input.sandbox.stdout, crlfDelay: Infinity });
  const close = () => lines.close();
  input.signal.addEventListener('abort', close, { once: true });
  try {
    for await (const line of lines) {
      const event = stepEvent(line);
      if (!event) continue;
      if (event.kind === 'done')
        return event.data.ok === true ? undefined : clip(event.data.error ?? '工具步骤没做完');
      input.record(event.kind, event.data);
    }
  } finally {
    input.signal.removeEventListener('abort', close);
  }
  const tail = input.stderr().trim();
  return `工具步骤执行器意外退出${tail ? `：${tail.slice(-500)}` : ''}`;
}
