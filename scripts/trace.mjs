#!/usr/bin/env node
// 对话追踪（docs/engineering/回归测试.md）：一条命令看清一个私聊里的每一轮（harness 的一次运行）、
// 模型和工具调用、算力、费用来源和画布成果，并标出异常——按估算扣的钱、卡住的调用、没退回的冻结、
// 运行结束了还在的容器、消息上记的花费和调用合计对不上。
// 用法：pnpm trace <对话 ID>   （只读本机开发数据库和 Docker，不改任何东西）
import { execFileSync } from 'node:child_process';
import { literal, query } from './e2e/db.mjs';

const conversationId = process.argv[2];
if (!/^[0-9a-f-]{36}$/.test(conversationId ?? '')) {
  console.error('用法：pnpm trace <对话 ID>');
  process.exit(2);
}
const usd = (micro) => `$${((micro ?? 0) / 1_000_000).toFixed(4)}`;
const time = (value) => (value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '—');
const span = (from, to) =>
  from && to ? `${Math.max(0, Math.round((new Date(to) - new Date(from)) / 1000))}s` : '';
const ids = (rows, key = 'id') => rows.map((r) => literal(r[key])).join(',') || "''";

const [conversation] = query(
  'conversation',
  `select id, title, model_key, last_run_id, turn from conversations where id = ${literal(conversationId)}`,
);
if (!conversation) {
  console.error(`没有这个对话：${conversationId}（删掉的对话查不到，删除是真删除）`);
  process.exit(1);
}
const runs = query(
  'harness',
  `select id, session_id, model, status, error, container_id, jsonb_array_length(outputs) as outputs, continue_from, created_at, started_at, finished_at,
     (select count(*) from run_events e where e.run_id = runs.id and e.kind = 'tool_call') as tool_calls,
     (select string_agg(distinct e.data->>'status', ',') from run_events e where e.run_id = runs.id and e.kind = 'status') as statuses
   from runs where conversation_id = ${literal(conversationId)} order by created_at`,
);
const calls = runs.length
  ? query(
      'model_gateway',
      `select id, kind, model, provider, status, cost_source, charged_micro, run_id, hold_id, error, created_at, finished_at from calls where run_id in (${ids(runs)}) order by created_at`,
    )
  : [];
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
  `select path, run_id, size from artifacts where conversation_id = ${literal(conversationId)} order by path`,
);
// 每一轮结束时写在最后一段 AI 消息上的花费
const recorded = query(
  'conversation',
  `select data->>'runId' as run_id, (data->>'spentMicro')::bigint as spent from messages where conversation_id = ${literal(conversationId)} and data ? 'spentMicro'`,
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
      '{{.ID}} {{.Label "oasis.session-id"}}',
    ],
    { encoding: 'utf8', windowsHide: true },
  )
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, session] = line.split(' ');
      return { id, session };
    });
} catch {
  // Docker 不可用：容器检查跳过
}

const anomalies = [];
const byRun = (runId) => calls.filter((c) => c.run_id === runId);
const chargedOf = (list) => list.reduce((sum, c) => sum + Number(c.charged_micro ?? 0), 0);
function describeCalls(list) {
  if (!list.length) return '没有模型/工具调用';
  const kinds = {};
  for (const c of list) kinds[c.kind] = (kinds[c.kind] ?? 0) + 1;
  const sources = {};
  for (const c of list) {
    const source = c.cost_source ?? (c.status === 'running' ? '进行中' : '没扣费');
    sources[source] = (sources[source] ?? 0) + 1;
  }
  const lines = [
    `${Object.entries(kinds)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ')}，花费 ${usd(chargedOf(list))}（来源 ${Object.entries(sources)
      .map(([k, n]) => `${k}×${n}`)
      .join(' ')}）`,
  ];
  // 同一型号在 OpenRouter 上有好几家在跑：这一轮的模型调用各是哪家答的
  const providers = {};
  for (const c of list) if (c.provider) providers[c.provider] = (providers[c.provider] ?? 0) + 1;
  if (Object.keys(providers).length)
    lines.push(
      `      哪家答的 ${Object.entries(providers)
        .map(([k, n]) => `${k}×${n}`)
        .join(' ')}`,
    );
  const errors = [...new Set(list.filter((c) => c.error).map((c) => `${c.kind}：${c.error}`))];
  for (const error of errors.slice(0, 3)) lines.push(`      失败的调用 ${error}`);
  if (errors.length > 3) lines.push(`      ……还有 ${errors.length - 3} 种失败`);
  return lines.join('\n');
}

console.log(
  `私聊 ${conversation.id}「${conversation.title}」  AI ${conversation.model_key ?? '—'}  在做的任务「${conversation.turn?.title ?? '—'}」`,
);
console.log(
  `正在进行的一轮：${conversation.turn ? conversation.turn.runId : '没有'}  下一轮接着：${conversation.last_run_id ?? '新会话'}`,
);
console.log(`\n每一轮（${runs.length}）：`);
for (const run of runs) {
  console.log(
    `  ● ${time(run.started_at ?? run.created_at)} ${run.id.slice(0, 8)} ${run.status} ${span(run.started_at ?? run.created_at, run.finished_at)}  ${run.model}  会话 ${String(run.session_id ?? run.id).slice(0, 8)}${run.continue_from ? '（接着上一轮）' : '（新会话）'}  产出 ${run.outputs} 个  工具调用 ${run.tool_calls} 次`,
  );
  console.log(`      ${describeCalls(byRun(run.id))}`);
  if (run.statuses?.includes('recovering')) console.log('      经历过 harness 接管（recovering）');
  if (run.error) console.log(`      错误：${run.error}`);
}
console.log(
  `\n画布成果 ${artifacts.length} 个：${artifacts.map((a) => a.path).join('、') || '（没有）'}`,
);

// ---------- 异常 ----------
// 算力本来就按核数×实际时长计价（记作 estimate），不算异常
const estimated = calls.filter((c) => c.cost_source === 'estimate' && c.kind !== 'compute');
if (estimated.length)
  anomalies.push(
    `${estimated.length} 次调用按估算扣费（共 ${usd(chargedOf(estimated))}）：${estimated.map((c) => `${c.kind} ${c.id.slice(0, 8)}${c.error ? `（${c.error}）` : ''}`).join('、')}`,
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
const ended = runs.filter((r) =>
  ['succeeded', 'failed', 'cancelled', 'stopped'].includes(r.status),
);
// 一轮做完，沙箱会空着留一会儿等同一份会话的下一轮（SANDBOX_IDLE_SECONDS，默认 60 秒）；留太久才算遗留
const LEFTOVER_MS = 5 * 60_000;
const sessionOf = (run) => String(run.session_id ?? run.id);
const leftover = containers.filter((c) => {
  const last = runs.filter((r) => sessionOf(r) === c.session).at(-1);
  return (
    last && ended.includes(last) && Date.now() - new Date(last.finished_at).getTime() > LEFTOVER_MS
  );
});
if (leftover.length)
  anomalies.push(
    `会话的最后一轮结束 5 分钟了沙箱还在：${leftover.map((c) => `${c.id}（会话 ${c.session.slice(0, 8)}）`).join('、')}`,
  );
for (const row of recorded) {
  const charged = chargedOf(byRun(row.run_id));
  if (Math.abs(charged - Number(row.spent)) > 1)
    anomalies.push(
      `一轮 ${String(row.run_id).slice(0, 8)} 消息上记的花费 ${usd(row.spent)} 和调用合计 ${usd(charged)} 对不上`,
    );
}

console.log(
  anomalies.length
    ? `\n异常 ${anomalies.length} 项：\n${anomalies.map((a) => `  ✗ ${a}`).join('\n')}`
    : '\n没有发现异常。',
);
process.exit(anomalies.length ? 1 : 0);
