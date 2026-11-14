#!/usr/bin/env node
// 拿型号清单（packages/contracts/src/lineup.ts）对着 OpenRouter 目录核对：
// 下架了 / 找不到的、对话 AI 里不会调工具的、标价和目录差得多的，以及清单里的这些厂商在核对日之后新出的型号。
// 用法：pnpm models:check [--since 2026-09-01] [--probe]
//   --since  新出的型号从哪天算起（默认是清单里写的核对日 LINEUP_CHECKED）
//   --probe  给每个对话 AI 的型号发一次带工具的小请求（花不到 $0.01）：这边地区调不调得通、会不会按格式调工具。
//            Key 从 services/model-gateway/.env 读，不打印
// 有下架或找不到的型号时退出码是 1。
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { CHAT_AIS, LINEUP_CHECKED, TOOL_LINEUP } from '../packages/contracts/src/lineup.ts';

const args = process.argv.slice(2);
const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : LINEUP_CHECKED;
const probe = args.includes('--probe');
const BASE = 'https://openrouter.ai/api/v1';

async function catalog() {
  const all = new Map();
  for (const query of [
    '',
    '?output_modalities=image',
    '?output_modalities=video',
    '?output_modalities=audio',
    '?output_modalities=all',
  ]) {
    const response = await fetch(`${BASE}/models${query}`);
    if (!response.ok) throw new Error(`读不到 OpenRouter 目录（${response.status}）`);
    for (const model of (await response.json()).data ?? []) all.set(model.id, model);
  }
  return all;
}

const perMillion = (price) => Math.round(Number(price ?? 0) * 1e6 * 1000) / 1000;
const day = (model) => new Date(model.created * 1000).toISOString().slice(0, 10);
const problems = [];
const notes = [];
const say = (line) => console.log(line);

const models = await catalog();
say(`OpenRouter 目录：${models.size} 个型号。清单核对日 ${LINEUP_CHECKED}。\n`);

// ---- 对话 AI 们 ----
say('【对话 AI 们】');
for (const ai of CHAT_AIS)
  for (const option of ai.options) {
    const found = models.get(option.model);
    const name = `${ai.name} · ${option.label}（${option.model}）`;
    if (!found) {
      problems.push(name);
      say(`  ✗ 目录里没有：${name}`);
      continue;
    }
    if (!(found.supported_parameters ?? []).includes('tools'))
      say(`  ! 不会调工具（做不了任务）：${name}`);
    const input = perMillion(found.pricing?.prompt);
    const output = perMillion(found.pricing?.completion);
    const off = (a, b) => Math.abs(a - b) > Math.max(0.01, b * 0.1);
    if (off(input, option.inputPrice) || off(output, option.outputPrice))
      say(
        `  ! 标价变了：${name} 清单 $${option.inputPrice}/$${option.outputPrice}，目录 $${input}/$${output}` +
          (option.model.startsWith('deepseek/') ? '（DeepSeek 走官方，按官方价，可以不管）' : ''),
      );
  }

// ---- 工具用的型号 ----
say('\n【工具用的型号】');
for (const [line, spec] of Object.entries(TOOL_LINEUP)) {
  if (spec.provider !== 'openrouter') {
    notes.push(`${spec.label}（${line}）的型号在 fal 上，不在 OpenRouter 目录里，这里不核对`);
    continue;
  }
  for (const model of spec.models)
    if (!models.has(model.id)) {
      problems.push(`${spec.label}：${model.name}（${model.id}）`);
      say(`  ✗ 目录里没有：${spec.label} · ${model.name}（${model.id}）`);
    }
}

// ---- 新出的 ----
const listed = new Set([
  ...CHAT_AIS.flatMap((ai) => ai.options.map((o) => o.model)),
  ...Object.values(TOOL_LINEUP).flatMap((spec) => spec.models.map((m) => m.id)),
]);
const vendors = new Set([...listed].map((id) => id.split('/')[0]));
const fresh = [...models.values()]
  .filter((m) => vendors.has(m.id.split('/')[0]) && !listed.has(m.id) && day(m) >= since)
  .sort((a, b) => a.id.localeCompare(b.id));
say(`\n【清单里这些厂商 ${since} 以后新出的】${fresh.length ? '' : '没有'}`);
for (const m of fresh) {
  const tools = (m.supported_parameters ?? []).includes('tools') ? '会调工具' : '不会调工具';
  const out = (m.architecture?.output_modalities ?? ['text']).join('+');
  say(
    `  · ${m.id}（${m.name}，${day(m)}，出 ${out}，${tools}，$${perMillion(m.pricing?.prompt)}/$${perMillion(m.pricing?.completion)}）`,
  );
}

// ---- 试调 ----
if (probe) {
  const env = parseEnv(readFileSync('services/model-gateway/.env', 'utf8'));
  const key = env.OPENROUTER_API_KEY;
  if (!key) throw new Error('services/model-gateway/.env 里没有 OPENROUTER_API_KEY');
  const tools = [
    {
      type: 'function',
      function: {
        name: 'write_file',
        description: 'Write a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' }, content: { type: 'string' } },
          required: ['path', 'content'],
        },
      },
    },
  ];
  say('\n【试调对话 AI 的型号（带一个工具）】');
  let cost = 0;
  for (const ai of CHAT_AIS)
    for (const option of ai.options) {
      const response = await fetch(`${BASE}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: option.model,
          max_tokens: 300,
          usage: { include: true },
          tools,
          messages: [{ role: 'user', content: '在 out/hello.txt 里写一行「你好」。用工具完成。' }],
        }),
      }).catch((err) => ({ ok: false, status: String(err) }));
      const body = response.ok ? await response.json().catch(() => ({})) : {};
      cost += body.usage?.cost ?? 0;
      const calls = body.choices?.[0]?.message?.tool_calls?.length ?? 0;
      say(
        `  ${response.ok ? (calls ? '✓' : '!') : '✗'} ${ai.name} · ${option.label}：` +
          (response.ok ? (calls ? '按格式调了工具' : '没调工具') : `调不通（${response.status}）`),
      );
    }
  say(`  试调花了 $${cost.toFixed(4)}`);
}

for (const note of notes) say(`\n（${note}）`);
say(
  problems.length
    ? `\n有 ${problems.length} 个型号目录里没有，要换。`
    : '\n清单里的型号目录里都有。',
);
process.exitCode = problems.length ? 1 : 0;
