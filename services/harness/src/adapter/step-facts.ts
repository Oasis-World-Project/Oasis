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

/** 命令输出里「已保存：路径」那几行说的文件（oasis-tool、oasis-op 存下的），相对工作目录 */
export function savedFiles(output: string): string[] {
  return [...output.matchAll(/^已保存：(.+)$/gm)].flatMap((match) => {
    const path = inWorkspace(match[1] ?? '');
    return path ? [path] : [];
  });
}

/** 一个长任务在这一步里的进展 */
export interface JobFact {
  id: string;
  /** submitted 交上去没等；waiting 等到上限还没好；done 做好了；failed 没做出来或结果没确认 */
  state: 'submitted' | 'waiting' | 'done' | 'failed';
  /** 做好了存下的文件 */
  files?: string[];
}

const JOB = '([0-9a-f-]{36})';

/**
 * 命令输出里长任务的进展，按任务号：「已提交，没等结果（任务号 X）」交上去没等；
 * 「还没做好（任务号 X、Y）」还在做；「做好了（任务号 X）」做好了，接着的「已保存」是它的文件；
 * 「任务号 X，供应商没做出来」「任务号 X，不要重新提交」没做出来。
 */
export function jobFacts(output: string): JobFact[] {
  const jobs = new Map<string, JobFact>();
  let current: JobFact | undefined;
  for (const line of output.split('\n')) {
    const done = new RegExp(`^做好了（任务号 ${JOB}）`).exec(line);
    if (done) {
      current = { id: done[1]!, state: 'done', files: [] };
      jobs.set(current.id, current);
      continue;
    }
    const saved = /^已保存：(.+)$/.exec(line);
    const path = saved ? inWorkspace(saved[1] ?? '') : undefined;
    if (path && current) current.files!.push(path);
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
