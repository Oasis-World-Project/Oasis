#!/usr/bin/env node
// 由 .env.example 生成本地 .env，并为空着的密码和密钥填入随机值。已存在 .env 时不覆盖。
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const target = path.join(ROOT, '.env');
if (existsSync(target)) {
  console.log('.env 已存在，未做改动。需要重建请先手动删除它。');
  process.exit(0);
}
const SECRET_KEY = /(_PASSWORD|_SECRET_KEY|_ACCESS_KEY)$/;
const lines = readFileSync(path.join(ROOT, '.env.example'), 'utf8').split('\n');
const filled = lines.map((line) => {
  const m = line.match(/^([A-Z0-9_]+)=$/);
  return m && SECRET_KEY.test(m[1]) ? `${m[1]}=${randomBytes(18).toString('hex')}` : line;
});
writeFileSync(target, filled.join('\n'));
console.log('已生成 .env（随机密码已填入）。');
