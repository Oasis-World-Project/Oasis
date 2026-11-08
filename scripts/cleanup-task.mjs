#!/usr/bin/env node
// 任务收尾清理（工程规范 §6）：只删除未被 Git 跟踪、可再生成的临时产物，并报告释放空间。
// 默认删 .tmp、日志、根目录的 out/（旧验收脚本的输出，现在都写进 .tmp）和 7 天前的构建缓存条目；
// 构建目录只报告不删除（--build 才删）；Docker 资源只报告，传 --docker 才清理悬空镜像和 72 小时前的构建缓存。
// --dry-run 只列出会删什么、能释放多少，不动任何文件。
// 用法：node scripts/cleanup-task.mjs [--dry-run] [--scope=.tmp/<任务目录>] [--build] [--docker] [--quiet]
import { spawnSync } from 'node:child_process';
import { readdirSync, rmSync, statSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { pruneTurboCache } from './run-dirs.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const quiet = args.has('--quiet');
const dryRun = args.has('--dry-run');

const TEMP_DIRS = new Set(['.tmp', '__pycache__', '.pytest_cache', 'coverage']);
const TEMP_FILE = /(\.tmp|\.log|^\.eslintcache)$/;
const BUILD_DIRS = new Set(['dist', 'build', 'out', 'release', '.turbo', '.vite']);
const SKIP_DIRS = new Set(['node_modules', '.git']);

function git(argv) {
  const r = spawnSync('git', argv, { cwd: ROOT, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : '';
}
const tracked = new Set(git(['ls-files']).split('\n').filter(Boolean));
const isTracked = (rel) => tracked.has(rel) || [...tracked].some((t) => t.startsWith(`${rel}/`));

function sizeOf(p) {
  const st = statSync(p, { throwIfNoEntry: false });
  if (!st) return 0;
  if (!st.isDirectory()) return st.size;
  return readdirSync(p).reduce((sum, name) => sum + sizeOf(path.join(p, name)), 0);
}

const toDelete = [];
const buildDirs = [];
function walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs).split(path.sep).join('/');
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if ((TEMP_DIRS.has(entry.name) || rel === 'out') && !isTracked(rel)) toDelete.push(abs);
      else if (BUILD_DIRS.has(entry.name)) buildDirs.push(abs);
      else walk(abs);
    } else if (TEMP_FILE.test(entry.name) && !isTracked(rel)) {
      toDelete.push(abs);
    }
  }
}
const scopes = [...args].filter((arg) => arg.startsWith('--scope=')).map((arg) => arg.slice(8));
if (scopes.length) {
  for (const scope of scopes) {
    if (!statSync(path.resolve(ROOT, scope), { throwIfNoEntry: false })) continue;
    const absolute = realpathSync(path.resolve(ROOT, scope));
    const rel = path.relative(ROOT, absolute).split(path.sep).join('/');
    if (!rel.startsWith('.tmp/') || rel.includes('..') || isTracked(rel))
      throw new Error('定向清理只允许项目 .tmp 下未跟踪的任务子目录');
    toDelete.push(absolute);
  }
} else walk(ROOT);
if (args.has('--build')) toDelete.push(...buildDirs.splice(0));

const fmt = (n) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1024).toFixed(1)} KB`);
let freed = 0;
for (const p of toDelete) {
  const size = sizeOf(p);
  freed += size;
  if (!dryRun) rmSync(p, { recursive: true, force: true });
  if (!quiet)
    console.log(`  ${dryRun ? '会删除' : '已删除'} ${path.relative(ROOT, p)}（${fmt(size)}）`);
}
// 构建缓存：--build 时整个 .turbo 已在上面算过；否则只删 7 天前写的条目
const cacheFreed = scopes.length || args.has('--build') ? 0 : pruneTurboCache(7, dryRun);
if (cacheFreed && !quiet)
  console.log(`  ${dryRun ? '会删除' : '已删除'} 7 天前的构建缓存（${fmt(cacheFreed)}）`);
freed += cacheFreed;

function dockerReport() {
  const probe = spawnSync('docker', ['images', '-f', 'dangling=true', '-q'], { encoding: 'utf8' });
  if (probe.status !== 0) return '  Docker 未运行，跳过';
  if (args.has('--docker') && !dryRun) {
    spawnSync('docker', ['image', 'prune', '-f'], { stdio: 'inherit' });
    spawnSync('docker', ['builder', 'prune', '-f', '--filter', 'until=72h'], { stdio: 'inherit' });
    return '  已清理悬空镜像和 72 小时前的构建缓存';
  }
  const dangling = probe.stdout.split('\n').filter(Boolean).length;
  return `  悬空镜像 ${dangling} 个（未清理；需要时运行 pnpm cleanup --docker）`;
}

if (quiet && toDelete.length === 0 && !cacheFreed) process.exit(0);
console.log(
  dryRun
    ? `\n预览：会删除 ${toDelete.length} 项，能释放 ${fmt(freed)}（没有动任何文件）`
    : `\n清理完成：删除 ${toDelete.length} 项，释放 ${fmt(freed)}`,
);
if (!quiet) {
  for (const p of buildDirs)
    console.log(`  构建目录保留：${path.relative(ROOT, p)}（${fmt(sizeOf(p))}）`);
  console.log(dockerReport());
}
