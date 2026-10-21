#!/usr/bin/env node
// 生成本地开发用的 .env：
//   1. 仓库根目录：由 .env.example 生成，空着的密码和密钥填入随机值；
//   2. 每个服务：由 services/<服务>/.env.example 生成，${变量} 换成根目录 .env 里的值。
// 已存在的 .env 一律不覆盖；需要重建时先手动删除。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const SECRET_KEY = /(_PASSWORD|_SECRET_KEY|_ACCESS_KEY)$/;

function parseEnv(text) {
  const vars = {};
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) vars[m[1]] = m[2];
  }
  return vars;
}

const rootEnv = path.join(ROOT, '.env');
if (existsSync(rootEnv)) {
  console.log('.env 已存在，保留不动。');
} else {
  const lines = readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n');
  const filled = lines.map((line) => {
    const m = line.match(/^([A-Z0-9_]+)=$/);
    return m && SECRET_KEY.test(m[1]) ? `${m[1]}=${randomBytes(18).toString('hex')}` : line;
  });
  writeFileSync(rootEnv, filled.join('\n'));
  console.log('已生成 .env（随机密码已填入）。');
}

const vars = parseEnv(readFileSync(rootEnv, 'utf8'));
const servicesDir = path.join(ROOT, 'services');
for (const name of readdirSync(servicesDir)) {
  const example = path.join(servicesDir, name, '.env.example');
  const target = path.join(servicesDir, name, '.env');
  if (!existsSync(example)) continue;
  if (existsSync(target)) {
    console.log(`services/${name}/.env 已存在，保留不动。`);
    continue;
  }
  const text = readFileSync(example, 'utf8').replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    if (vars[key] === undefined || vars[key] === '') {
      throw new Error(`services/${name}/.env.example 引用了根目录 .env 里没有的变量 ${key}`);
    }
    return vars[key];
  });
  writeFileSync(target, text);
  console.log(`已生成 services/${name}/.env`);
}
