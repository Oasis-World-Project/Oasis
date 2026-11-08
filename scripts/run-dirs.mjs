// 回归、验收、冒烟脚本的输出（2026-11-08）：都放在 .tmp/<名字>/<时间>/，新建前只留最近几次、更早的删掉；
// turbo 的本地构建缓存只留最近几天。以前只写不删，项目目录涨到 3 GB（回归记录 766 MB、out/ 里的
// 旧验收输出 542 MB、构建缓存 374 MB）。
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
const DAY = 24 * 3600_000;

/** 这次运行的输出目录 .tmp/<name>/<时间>/：先删掉更早的，连同这次一共留 keep 次 */
export function runDir(name, keep) {
  const base = path.join(ROOT, '.tmp', name);
  mkdirSync(base, { recursive: true });
  const runs = readdirSync(base)
    .filter((entry) => STAMP.test(entry))
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - (keep - 1))))
    rmSync(path.join(base, old), { recursive: true, force: true });
  const dir = path.join(base, new Date().toISOString().replace(/[:.]/g, '-'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 固定的输出目录 .tmp/<name>/（分几步跑、后一步读前一步结果的验证用；每次覆盖，不会越积越多） */
export function fixedDir(name) {
  const dir = path.join(ROOT, '.tmp', name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** turbo 本地缓存只增不减：删掉 days 天前写的条目，返回释放的字节数（dryRun 只算不删） */
export function pruneTurboCache(days = 7, dryRun = false) {
  const dir = path.join(ROOT, '.turbo', 'cache');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let freed = 0;
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = statSync(file, { throwIfNoEntry: false });
    if (!stat?.isFile() || Date.now() - stat.mtimeMs < days * DAY) continue;
    freed += stat.size;
    if (!dryRun) rmSync(file, { force: true });
  }
  return freed;
}
