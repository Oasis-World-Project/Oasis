#!/usr/bin/env node
// 生成本地开发用的 .env：
//   1. 仓库根目录：由 .env.example 生成，空着的密码和密钥填入随机值；
//   2. 每个服务和应用：由 services/*、apps/* 下的 .env.example 生成，${变量} 换成根目录 .env 里的值。
// 已存在的 .env 不会被改动已有的值，只会在末尾补上 .env.example 里新增的项。
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECRET_KEY = /(_PASSWORD|_SECRET_KEY|_ACCESS_KEY|_PEPPER)$/;
const LINE = /^([A-Z0-9_]+)=(.*)$/;

function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(LINE);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

/** 把 example 的每一行变成最终的行：密钥填随机值，${变量} 换成根目录的值。 */
function render(lines, { fillSecrets, vars, rel }) {
  return lines.map((line) => {
    const m = line.match(LINE);
    if (!m) return line;
    if (fillSecrets && m[2] === '' && SECRET_KEY.test(m[1]))
      return `${m[1]}=${randomBytes(18).toString('hex')}`;
    return line.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
      // 根目录里有这一项但空着（如没填的 TAVILY_API_KEY）就照样留空；没有这一项多半是写错了名字
      if (!vars || vars[key] === undefined) {
        throw new Error(`${rel}/.env.example 引用了根目录 .env 里没有的变量 ${key}`);
      }
      return vars[key];
    });
  });
}

/** 生成或补全一个 .env。返回给人看的结果说明。 */
function sync(dir, rel, options) {
  const example = path.join(dir, '.env.example');
  const target = path.join(dir, '.env');
  if (!existsSync(example)) return undefined;
  const lines = readFileSync(example, 'utf8').split(/\r?\n/);
  if (!existsSync(target)) {
    writeFileSync(target, render(lines, { ...options, rel }).join('\n'));
    return `已生成 ${rel}/.env`;
  }
  const existing = parseEnv(readFileSync(target, 'utf8'));
  const missing = lines.filter((line) => {
    const m = line.match(LINE);
    return m && !(m[1] in existing);
  });
  if (missing.length === 0) return `${rel}/.env 已是最新，保留不动`;
  const added = render(missing, { ...options, rel });
  appendFileSync(target, `\n# 以下由 pnpm env:init 补充\n${added.join('\n')}\n`);
  return `${rel}/.env 补充了 ${added.map((l) => l.split('=')[0]).join('、')}`;
}

console.log(sync(ROOT, '.', { fillSecrets: true }));
const vars = parseEnv(readFileSync(path.join(ROOT, '.env'), 'utf8'));
for (const group of ['services', 'apps']) {
  const groupDir = path.join(ROOT, group);
  if (!existsSync(groupDir)) continue;
  for (const name of readdirSync(groupDir)) {
    const result = sync(path.join(groupDir, name), `${group}/${name}`, {
      fillSecrets: false,
      vars,
    });
    if (result) console.log(result);
  }
}
