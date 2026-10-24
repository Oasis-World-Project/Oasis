// JSONL 批次：逐行先记 started 再调用，恢复绝不重发已派发的行；不依赖第三方包。
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

type Request = (path: string, init?: RequestInit) => Promise<unknown>;
type Row = { id: string; [key: string]: unknown };
interface Meta {
  version: 1;
  kind: string;
  output: string;
  digest: string;
  rows: Row[];
  model: string;
  maxTokens: number;
  rowBudget: number;
  budget: number;
}
interface Result {
  id: string;
  status: 'started' | 'completed' | 'failed' | 'uncertain';
  costMicro: number;
  text?: string;
  data?: unknown;
  error?: string;
}
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const exists = async (path: string) =>
  stat(path).then(
    () => true,
    (err: NodeJS.ErrnoException) => {
      if (err.code === 'ENOENT') return false;
      throw err;
    },
  );
const integer = (value: unknown, fallback: number, max: number, name: string) => {
  const number = value === undefined ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < 1 || number > max)
    throw new Error(`${name} 必须为 1–${max} 的整数`);
  return number;
};
const limit = (name: string, fallback: number, max: number) =>
  integer(process.env[name], fallback, max, name);

async function atomic(path: string, value: unknown) {
  const pending = `${path}.pending`;
  const file = await open(pending, 'w');
  try {
    await file.writeFile(JSON.stringify(value));
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(pending, path);
}

async function lock(directory: string) {
  const path = join(directory, 'lock');
  try {
    await mkdir(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    const recovery = join(directory, 'recover-lock');
    await mkdir(recovery);
    try {
      const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as {
        host: string;
        pid: number;
      };
      if (!Number.isInteger(owner.pid) || owner.pid < 1 || typeof owner.host !== 'string')
        throw new Error('批次锁损坏，不能自动接管', { cause: err });
      let active = owner.host === hostname();
      if (active) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') active = false;
        }
      }
      if (active) throw new Error('该批次正在运行，不能同时写入同一输出', { cause: err });
      await rm(path, { recursive: true });
      await mkdir(path);
    } finally {
      await rm(recovery, { recursive: true, force: true });
    }
  }
  await atomic(join(path, 'owner.json'), { host: hostname(), pid: process.pid });
  return () => rm(path, { recursive: true, force: true });
}

function rowsOf(text: string, kind: string, maxRows: number): Row[] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim());
  if (!lines.length || lines.length > maxRows) throw new Error(`批次需要 1–${maxRows} 行`);
  const ids = new Set<string>();
  return lines.map((line, index) => {
    const row = JSON.parse(line) as Row;
    if (
      !row ||
      typeof row !== 'object' ||
      Array.isArray(row) ||
      typeof row.id !== 'string' ||
      !/^[\w.-]{1,100}$/.test(row.id) ||
      ids.has(row.id)
    )
      throw new Error(`第 ${index + 1} 行 id 无效或重复`);
    ids.add(row.id);
    const allowed =
      kind === 'text.batch' ? ['id', 'prompt'] : ['id', 'question', 'context', 'options', 'scale'];
    if (Object.keys(row).some((key) => !allowed.includes(key)))
      throw new Error(`第 ${index + 1} 行含不支持的字段`);
    const prompt = kind === 'text.batch' ? row.prompt : row.question;
    const max = kind === 'text.batch' ? 20_000 : 1000;
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > max)
      throw new Error(`第 ${index + 1} 行提示/问题无效`);
    if (
      row.context !== undefined &&
      (typeof row.context !== 'string' || row.context.length > 20_000)
    )
      throw new Error(`第 ${index + 1} 行 context 无效`);
    for (const key of ['options', 'scale']) {
      const values = row[key];
      if (
        values !== undefined &&
        (!Array.isArray(values) ||
          values.length < 2 ||
          values.length > 10 ||
          values.some((v) => typeof v !== 'string' || !v.trim() || v.length > 200))
      )
        throw new Error(`第 ${index + 1} 行 ${key} 无效`);
    }
    if (row.options && row.scale) throw new Error('options 和 scale 不能同时给出');
    return row;
  });
}

/** signal 只停止派发；在途请求仍等待服务端结果，网络超时才标为不确定。 */
export async function runBatch(input: {
  kind: string;
  args: Record<string, unknown>;
  out: string | undefined;
  request: Request;
  signal?: AbortSignal;
}): Promise<{
  completed: number;
  failed: number;
  uncertain: number;
  pending: number;
  costMicro: number;
}> {
  const { args, kind } = input;
  const allowed = new Set([
    'in',
    'resume',
    'concurrency',
    'max_tokens',
    'budget_micro',
    'row_budget_micro',
  ]);
  if (Object.keys(args).some((key) => !allowed.has(key)))
    throw new Error('批次包含不支持的参数（模型固定为当前节点模型）');
  if (!input.out) throw new Error('批次必须提供 --out out/结果.jsonl');
  const output = resolve(input.out);
  const rel = relative(resolve('out'), output);
  if (
    !rel ||
    isAbsolute(rel) ||
    rel.startsWith(`..${sep}`) ||
    rel === '..' ||
    resolve('out', rel) !== output ||
    rel.split(sep)[0] === '.oasis-batches'
  )
    throw new Error('批次输出必须位于 out/ 内且不能占用保留目录');
  const maxRows = limit('OASIS_BATCH_MAX_ROWS', 1000, 1000);
  const maxBytes = limit('OASIS_BATCH_MAX_INPUT_BYTES', 5 * 1024 * 1024, 20 * 1024 * 1024);
  const maxConcurrency = limit('OASIS_BATCH_CONCURRENCY', 4, 16);
  const tokenLimit = limit('OASIS_BATCH_MAX_TOKENS', 2048, 8192);
  const budgetLimit = limit('OASIS_BATCH_BUDGET_MICRO', 1_000_000, 100_000_000);
  const rowLimit = limit('OASIS_BATCH_ROW_BUDGET_MICRO', 200_000, 10_000_000);
  const timeout = limit('OASIS_BATCH_TIMEOUT_MS', 120_000, 600_000);
  const concurrency = integer(args.concurrency, maxConcurrency, maxConcurrency, 'concurrency');
  if (args.resume !== undefined && args.resume !== 'true') throw new Error('--resume 只接受 true');
  const resume = args.resume === 'true';
  const directory = join(resolve('out'), '.oasis-batches', digest(rel));
  await mkdir(directory, { recursive: true });
  const release = await lock(directory);
  let stopped = input.signal?.aborted ?? false;
  const stop = () => {
    stopped = true;
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  input.signal?.addEventListener('abort', stop);
  try {
    let rows: Row[] | undefined;
    if (args.in !== undefined) {
      if (typeof args.in !== 'string') throw new Error('--in 必须是文件路径');
      if ((await stat(args.in)).size > maxBytes) throw new Error('输入文件超过批次大小上限');
      rows = rowsOf(await readFile(args.in, 'utf8'), kind, maxRows);
    }
    const metaPath = join(directory, 'meta.json');
    let meta: Meta;
    if (resume) {
      meta = JSON.parse(await readFile(metaPath, 'utf8')) as Meta;
      if (
        meta.version !== 1 ||
        meta.kind !== kind ||
        meta.output !== rel ||
        meta.model !== (process.env.OASIS_MODEL ?? '') ||
        meta.digest !== digest(JSON.stringify(meta.rows)) ||
        (rows && digest(JSON.stringify(rows)) !== meta.digest)
      )
        throw new Error('恢复输入、工具、模型或检查点摘要不一致');
      rowsOf(meta.rows.map((row) => JSON.stringify(row)).join('\n'), kind, maxRows);
      if (Buffer.byteLength(JSON.stringify(meta.rows)) > maxBytes)
        throw new Error('恢复输入超过大小上限');
      integer(meta.maxTokens, 1, tokenLimit, '检查点 token');
      integer(meta.rowBudget, 1, rowLimit, '检查点行预算');
      integer(meta.budget, 1, budgetLimit, '检查点预算');
      if (
        (args.max_tokens !== undefined && Number(args.max_tokens) !== meta.maxTokens) ||
        (args.row_budget_micro !== undefined && Number(args.row_budget_micro) !== meta.rowBudget) ||
        (args.budget_micro !== undefined && Number(args.budget_micro) !== meta.budget)
      )
        throw new Error('恢复不能修改 token 或预算；另建批次前先核对已有费用');
    } else {
      if (!rows) throw new Error('新批次必须提供 --in');
      if ((await exists(metaPath)) || (await exists(output)))
        throw new Error('批次或输出已存在，请使用 --resume true');
      meta = {
        version: 1,
        kind,
        output: rel,
        digest: digest(JSON.stringify(rows)),
        rows,
        model: process.env.OASIS_MODEL ?? '',
        maxTokens: integer(args.max_tokens, tokenLimit, tokenLimit, 'max_tokens'),
        rowBudget: integer(args.row_budget_micro, rowLimit, rowLimit, 'row_budget_micro'),
        budget: integer(args.budget_micro, budgetLimit, budgetLimit, 'budget_micro'),
      };
      if (kind === 'text.batch' && !meta.model) throw new Error('当前节点没有模型');
      await atomic(metaPath, meta);
    }
    const results = new Map<string, Result>();
    let used = 0;
    const pathOf = (id: string) => join(directory, `${digest(id)}.json`);
    for (const row of meta.rows) {
      if (!(await exists(pathOf(row.id)))) continue;
      const saved = JSON.parse(await readFile(pathOf(row.id), 'utf8')) as Result;
      if (
        saved.id !== row.id ||
        !['started', 'completed', 'failed', 'uncertain'].includes(saved.status) ||
        !Number.isSafeInteger(saved.costMicro) ||
        saved.costMicro < 0
      )
        throw new Error('行检查点损坏，不能自动恢复');
      if (saved.status === 'started') {
        saved.status = 'uncertain';
        saved.error = '上次请求已派发但结果未持久保存，不自动重发';
        saved.costMicro = meta.rowBudget;
        await atomic(pathOf(row.id), saved);
      }
      results.set(row.id, saved);
      used += saved.costMicro;
    }
    let next = 0;
    const work = async () => {
      while (!stopped && next < meta.rows.length) {
        const row = meta.rows[next];
        if (!row || results.has(row.id)) {
          next++;
          continue;
        }
        if (used + meta.rowBudget > meta.budget) break;
        next++;
        used += meta.rowBudget;
        const result: Result = { id: row.id, status: 'started', costMicro: meta.rowBudget };
        await atomic(pathOf(row.id), result);
        // 写入期间收到停止时还未派发，删除 started，下次可正常继续。
        if (stopped) {
          await rm(pathOf(row.id));
          used -= meta.rowBudget;
          break;
        }
        try {
          const body =
            kind === 'text.batch'
              ? {
                  model: meta.model,
                  stream: false,
                  max_tokens: meta.maxTokens,
                  max_cost_micro: meta.rowBudget,
                  messages: [{ role: 'user', content: row.prompt }],
                }
              : {
                  args: Object.fromEntries(Object.entries(row).filter(([key]) => key !== 'id')),
                  max_cost_micro: meta.rowBudget,
                };
          const response = (await input.request(
            kind === 'text.batch' ? '/chat/completions' : '/tools/jev.decide',
            {
              method: 'POST',
              body: JSON.stringify(body),
              signal: AbortSignal.timeout(timeout),
            },
          )) as {
            choices?: { message?: { content?: string } }[];
            oasis?: { costMicro?: number };
            costMicro?: number;
            text?: string;
            data?: unknown;
          };
          const text =
            kind === 'text.batch' ? response.choices?.[0]?.message?.content : response.text;
          const cost = kind === 'text.batch' ? response.oasis?.costMicro : response.costMicro;
          if (typeof text !== 'string' || !Number.isSafeInteger(cost) || cost! < 0)
            throw new Error('响应没有完整结果或计费信息');
          result.status = 'completed';
          result.text = text;
          result.data = response.data;
          result.costMicro = cost!;
          used += cost! - meta.rowBudget;
        } catch (error) {
          const code = (error as { code?: string }).code;
          const rejected = [
            'invalid_run_key',
            'invalid_tool_args',
            'call_budget_exceeded',
            'insufficient_balance',
            'provider_not_configured',
          ].includes(code ?? '');
          result.status = rejected ? 'failed' : 'uncertain';
          result.error = error instanceof Error ? error.message : String(error);
          // 明确在派发前拒绝也保留预留金额，避免反复失败继续消耗整批。
          if (rejected) stopped = true;
        }
        await atomic(pathOf(row.id), result);
        results.set(row.id, result);
      }
    };
    // 某个写入失败也必须等其余在途操作结束，不能提前释放锁。
    const workers = await Promise.allSettled(
      Array.from({ length: concurrency }, () =>
        work().catch((error: unknown) => {
          stopped = true;
          throw error;
        }),
      ),
    );
    const failure = workers.find((worker) => worker.status === 'rejected');
    if (failure?.status === 'rejected') throw failure.reason;
    await mkdir(dirname(output), { recursive: true });
    const pendingOutput = join(directory, 'output.pending');
    const file = await open(pendingOutput, 'w');
    try {
      for (const row of meta.rows) {
        const result = results.get(row.id);
        if (result) await file.writeFile(`${JSON.stringify(result)}\n`);
      }
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(pendingOutput, output);
    const values = [...results.values()];
    return {
      completed: values.filter((r) => r.status === 'completed').length,
      failed: values.filter((r) => r.status === 'failed').length,
      uncertain: values.filter((r) => r.status === 'uncertain').length,
      pending: meta.rows.length - values.length,
      costMicro: used,
    };
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    input.signal?.removeEventListener('abort', stop);
    await release();
  }
}
