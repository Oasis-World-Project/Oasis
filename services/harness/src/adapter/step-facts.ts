// 进度页要用的一步的事实（dsh 的工具名不出适配层）：跑的是 oasis-tool 的哪个工具、点名的型号，
// 写、改的文件，oasis-tool 和 oasis-op 存下的文件，长任务的进展（按任务号）。都按完整的参数和输出算
// （事件里的会截断）。输出的写法见 services/harness/sandbox/oasis-tool.ts。

/** 命令里调的 oasis-tool 工具（如 image.generate） */
export const OASIS_TOOL = /(?:^|[\s;&|(])oasis-tool\s+([a-z0-9]+(?:\.[a-z0-9_-]+)*)/;
/** 只是查工具怎么用（oasis-tool <工具> --help），不算调用 */
export const TOOL_HELP = /oasis-tool\s+\S+\s+(?:--help|-h)(?:\s|$)/;

/** 工作目录里的相对路径；工作目录外的、往上跳的不算 */
function inWorkspace(path: string): string | undefined {
  const relative = path
    .trim()
    .replace(/^\/workspace\//, '')
    .replace(/^\.\//, '');
  return relative && !relative.startsWith('/') && !relative.split('/').includes('..')
    ? relative
    : undefined;
}

/** 一次工具调用的事实：oasis-tool 的工具名和点名的型号；写、改的文件。arg 取参数里的一个字段 */
export function stepFacts(
  name: string,
  arg: (key: string) => string | undefined,
): Record<string, string> {
  if (name === 'bash' || name === 'pwsh') {
    const command = arg('command') ?? '';
    const tool = OASIS_TOOL.exec(command)?.[1];
    const model = /--model\s+["']?([^"'\s]+)/.exec(command)?.[1];
    if (!tool || TOOL_HELP.test(command)) return {};
    return { oasisTool: tool, ...(model ? { oasisModel: model } : {}) };
  }
  const writes =
    name === 'write' ||
    name === 'edit' ||
    (name === 'str_replace_editor' && arg('command') !== 'view');
  const path = writes ? inWorkspace(arg('file_path') ?? arg('path') ?? '') : undefined;
  return path ? { path } : {};
}

const JOB = '([0-9a-f-]{36})';
/** 「已保存：路径」一行；等到的长任务存下的，后面带「（任务号 X）」 */
const SAVED = new RegExp(`^已保存：(.+?)(?:（任务号 ${JOB}）)?$`);
const lines = (output: string) => output.split(/\r?\n/);

/** 命令输出里「已保存：路径」那几行说的文件（oasis-tool、oasis-op 存下的），相对工作目录 */
export function savedFiles(output: string): string[] {
  return lines(output).flatMap((line) => {
    const path = inWorkspace(SAVED.exec(line)?.[1] ?? '');
    return path ? [path] : [];
  });
}

/**
 * oasis-tool 这次没做成：命令的退出码不是 0，输出里有「oasis-tool 出错：…」（dsh 照样算这次调用
 * 成功，进度页要说没做出来）。返回出错的那句
 */
export function toolFailure(output: string): string | undefined {
  if (!/exit code: [1-9]\d*\]/.test(output)) return undefined;
  return /oasis-tool 出错：(.+)/.exec(output)?.[1]?.trim();
}

/** 一个长任务在这一步里的进展 */
export interface JobFact {
  id: string;
  /** submitted 交上去没等；waiting 等到上限还没好；done 做好了；failed 没做出来或结果没确认 */
  state: 'submitted' | 'waiting' | 'done' | 'failed';
  /** 做好了存下的文件 */
  files?: string[];
}

/**
 * 命令输出里长任务的进展，按任务号：「已提交，没等结果（任务号 X）」交上去没等；
 * 「还没做好（任务号 X、Y）」还在做；「做好了（任务号 X）」做好了，带着这个任务号的「已保存」是它的文件
 * （AI 常只看输出的末几行，「做好了」那句可能截掉了）；「任务号 X，供应商没做出来」「任务号 X，
 * 不要重新提交」没做出来。
 */
export function jobFacts(output: string): JobFact[] {
  const jobs = new Map<string, JobFact>();
  const done = (id: string) => {
    const known = jobs.get(id);
    if (known?.state === 'done') return known;
    const job: JobFact = { id, state: 'done', files: [] };
    jobs.set(id, job);
    return job;
  };
  for (const line of lines(output)) {
    const finished = new RegExp(`^做好了（任务号 ${JOB}）`).exec(line);
    if (finished) done(finished[1]!);
    const saved = SAVED.exec(line);
    const path = inWorkspace(saved?.[1] ?? '');
    if (saved?.[2] && path) {
      const files = done(saved[2]).files!;
      // AI 反复等同一批时，同一个文件会存好几次
      if (!files.includes(path)) files.push(path);
    }
    for (const m of line.matchAll(new RegExp(`已提交，没等结果（任务号 ${JOB}）`, 'g')))
      jobs.set(m[1]!, { id: m[1]!, state: 'submitted' });
    const pending = /还没做好（任务号 ([^）]+)）/.exec(line);
    for (const id of pending?.[1]?.split('、') ?? [])
      if (/^[0-9a-f-]{36}$/.test(id)) jobs.set(id, { id, state: 'waiting' });
    for (const m of line.matchAll(
      new RegExp(`任务号 ${JOB}，(?:供应商没做出来|不要重新提交)`, 'g'),
    ))
      jobs.set(m[1]!, { id: m[1]!, state: 'failed' });
  }
  return [...jobs.values()];
}
