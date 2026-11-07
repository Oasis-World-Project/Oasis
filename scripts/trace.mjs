#!/usr/bin/env node
// 任务追踪（docs/engineering/回归测试.md）：一条命令看清一个任务的每次运行、模型和工具调用、算力、关卡提醒、
// 费用来源和画布成果，并标出异常——按估算扣的钱、卡住的调用、没退回的冻结、运行结束了还在的容器、花费对不上。
// 用法：pnpm trace <任务 ID>   （只读本机开发数据库和 Docker，不改任何东西）
import { execFileSync } from 'node:child_process';
import { literal, query } from './e2e/db.mjs';

const taskId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(taskId ?? '')) {
  console.error('用法：pnpm trace <任务 ID>');
  process.exit(2);
}
const usd = (micro) => `$${((micro ?? 0) / 1_000_000).toFixed(4)}`;
const time = (value) =>
  value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—';
const span = (from, to) =>
  from && to ? `${Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000))}s` : '';
const ids = (rows, key = 'id') => rows.map((r) => literal(r[key])).join(',') || "''";

const [task] = query(
  'task',
  `select id, title, status, attention, version, spent_micro, estimate_micro, planner_run_id, plan_attempts, created_at, finished_at, revision from tasks where id = ${literal(taskId)}`,
);
if (!task) {
  console.error(`没有这个任务：${taskId}（已删除的任务查不到，删除是真删除）`);
  process.exit(1);
}
const nodes = query(
  'task',
  `select id, key, title, kind, model, status, attempts, reworks, warning, spent_micro, retired_version from nodes where task_id = ${literal(taskId)} order by created_at`,
);
const nodeRuns = query(
  'task',
  `select id, node_id, attempt, purpose, status, error, created_at, finished_at, request->>'continueFrom' as continue_from from node_runs where task_id = ${literal(taskId)} order by created_at`,
);
const runIds = [
  ...nodeRuns.map((r) => r.id),
  ...(task.planner_run_id ? [task.planner_run_id] : []),
];
const harnessRuns = runIds.length
  ? query(
      'harness',
      `select id, status, error, container_id, jsonb_array_length(outputs) as outputs, continue_from, created_at, started_at, finished_at,
         (select count(*) from run_events e where e.run_id = runs.id and e.kind = 'tool_call') as tool_calls,
         (select string_agg(distinct e.data->>'status', ',') from run_events e where e.run_id = runs.id and e.kind = 'status') as statuses
       from runs where id in (${runIds.map(literal).join(',')})`,
    )
  : [];
const calls = query(
  'model_gateway',
  `select id, kind, model, status, cost_source, charged_micro, run_id, node_id, hold_id, error, created_at, finished_at from calls where task_id = ${literal(taskId)} order by created_at`,
);
const holds = calls.some((c) => c.hold_id)
  ? query(
      'billing',
      `select id, status, amount_micro, charged_micro from holds where id in (${ids(
        calls.filter((c) => c.hold_id),
        'hold_id',
      )})`,
    )
  : [];
const artifacts = query(
  'canvas',
  `select path, node_id, size from artifacts where task_id = ${literal(taskId)} order by path`,
);
let containers = [];
try {
  containers = execFileSync(
    'docker',
    [
      'ps',
      '--filter',
      'label=oasis.component=harness-sandbox',
      '--format',
      '{{.ID}} {{.Label "oasis.run-id"}}',
    ],
    {
      encoding: 'utf8',
      windowsHide: true,
    },
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, run] = line.split(' ');
      return { id, run };
    });
} catch {
  // Docker 不可用：容器检查跳过
}

const anomalies = [];
const byRun = (runId) => calls.filter((c) => c.run_id === runId);
function describeCalls(list) {
  if (!list.length) return '没有模型/工具调用';
  const kinds = {};
  for (const c of list) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const sources = {};
  for (const c of list) {
    const source = c.cost_source ?? (c.status === 'running' ? '进行中' : '没扣费');
    sources[source] = (sources[source] ?? 0) + 1;
  }
  const total = list.reduce((sum, c) => sum + (c.charged_micro ?? 0), 0);
  const lines = [
    `${Object.entries(kinds)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ')}，花费 ${usd(total)}（来源 ${Object.entries(sources)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ')}）`,
  ];
  const errors = [...new Set(list.filter((c) => c.error).map((c) => `${c.kind}：${c.error}`))];
  for (const error of errors.slice(0, 3)) lines.push(`      失败的调用 ${error}`);
  if (errors.length > 3) lines.push(`      ……还有 ${errors.length - 3} 种失败`);
  return lines.join('\n');
}
function runLine(runId, label) {
  const h = harnessRuns.find((r) => r.id === runId);
  const lines = [
    `${label} ${runId.slice(0, 8)} ${h ? `${h.status}  ${time(h.started_at ?? h.created_at)} → ${time(h.finished_at)} ${span(h.started_at ?? h.created_at, h.finished_at)}  产出 ${h.outputs} 个  工具调用 ${h.tool_calls} 次` : '（harness 里没有这次运行）'}`,
    `      ${describeCalls(byRun(runId))}`,
  ];
  if (h?.statuses?.includes('recovering')) lines.push('      经历过 harness 接管（recovering）');
  if (h?.error) lines.push(`      错误：${h.error}`);
  return lines.join('\n');
}

console.log(
  `任务 ${task.id}「${task.title}」 ${task.status}  第 ${task.version} 版  花费 ${usd(task.spent_micro)}（预估 ${usd(task.estimate_micro)}）`,
);
console.log(
  `创建 ${new Date(task.created_at).toLocaleString('zh-CN', { hour12: false })}  结束 ${task.finished_at ? new Date(task.finished_at).toLocaleString('zh-CN', { hour12: false }) : '—'}`,
);
if (task.attention) console.log(`需要处理：${task.attention.reason} ${task.attention.message}`);
if (task.revision)
  console.log(
    `进行中的修改：第 ${task.revision.version} 版，${task.revision.plan ? '方案待确认' : '规划中'}：${task.revision.request}`,
  );
if (task.planner_run_id)
  console.log(runLine(task.planner_run_id, `规划员（第 ${task.plan_attempts} 次）`));
console.log('\n节点：');
for (const node of nodes) {
  console.log(
    `  ● ${node.key}「${node.title}」 ${node.status}${node.retired_version ? `（第 ${node.retired_version} 版起已删除）` : ''}  ${node.model}  运行 ${node.attempts} 次  关卡退回 ${node.reworks} 次  花费 ${usd(node.spent_micro)}`,
  );
  if (node.warning) console.log(`      提醒：${node.warning}`);
  for (const run of nodeRuns.filter((r) => r.node_id === node.id))
    console.log(
      `    ${runLine(run.id, `运行 #${run.attempt} ${run.purpose}${run.continue_from ? '（接着上次）' : ''}`)}`,
    );
}
console.log(
  `\n画布成果 ${artifacts.length} 个：${artifacts.map((a) => a.path).join('、') || '（没有）'}`,
);

// ---------- 异常 ----------
// 算力本来就按核数×实际时长计价（记作 estimate），不算异常
const estimated = calls.filter((c) => c.cost_source === 'estimate' && c.kind !== 'compute');
if (estimated.length)
  anomalies.push(
    `${estimated.length} 次调用按估算扣费（共 ${usd(estimated.reduce((s, c) => s + (c.charged_micro ?? 0), 0))}）：${estimated.map((c) => `${c.kind} ${c.id.slice(0, 8)}${c.error ? `（${c.error}）` : ''}`).join('、')}`,
  );
const stuck = calls.filter(
  (c) => c.status === 'running' && Date.now() - new Date(c.created_at) > 5 * 60_000,
);
if (stuck.length)
  anomalies.push(
    `${stuck.length} 次调用卡在进行中超过 5 分钟：${stuck.map((c) => `${c.kind} ${c.id.slice(0, 8)} 开始于 ${time(c.created_at)}`).join('、')}`,
  );
const openHolds = holds.filter(
  (h) => h.status === 'open' && calls.some((c) => c.hold_id === h.id && c.status !== 'running'),
);
if (openHolds.length)
  anomalies.push(
    `${openHolds.length} 笔冻结在调用结束后没退回：${openHolds.map((h) => h.id.slice(0, 8)).join('、')}`,
  );
const finished = new Set(
  harnessRuns
    .filter((r) => ['succeeded', 'failed', 'cancelled', 'stopped'].includes(r.status))
    .map((r) => r.id),
);
const leftover = containers.filter((c) => finished.has(c.run));
if (leftover.length)
  anomalies.push(
    `运行已结束但容器还在：${leftover.map((c) => `${c.id}（运行 ${c.run.slice(0, 8)}）`).join('、')}`,
  );
const charged = calls.reduce((s, c) => s + (c.charged_micro ?? 0), 0);
if (
  ['succeeded', 'failed', 'cancelled'].includes(task.status) &&
  Math.abs(charged - task.spent_micro) > 1
)
  anomalies.push(`任务记的花费 ${usd(task.spent_micro)} 和调用合计 ${usd(charged)} 对不上`);
const orphanRuns = nodeRuns.filter(
  (r) => !harnessRuns.some((h) => h.id === r.id) && r.status !== 'pending',
);
if (orphanRuns.length)
  anomalies.push(
    `task 记着、harness 里却没有的运行：${orphanRuns.map((r) => r.id.slice(0, 8)).join('、')}`,
  );

console.log(
  anomalies.length
    ? `\n异常 ${anomalies.length} 项：\n${anomalies.map((a) => `  ✗ ${a}`).join('\n')}`
    : '\n没有发现异常。',
);
process.exit(anomalies.length ? 1 : 0);
