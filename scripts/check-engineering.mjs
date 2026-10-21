#!/usr/bin/env node
// 工程规范 §7 的确定性检查入口：命名、镜像命名、依赖方向、死代码/未用依赖、重复率、数据库迁移。
// 用法：node scripts/check-engineering.mjs [--only naming,images,deps,dead,dup,migrations]
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE_ROOTS = ['apps', 'services', 'packages'];
const SOURCE_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const FORBIDDEN_SUFFIX = /[_.-](v\d+|new|old|backup|bak|copy|refactored)$/i;
const IS_WINDOWS = process.platform === 'win32';
// AGENTS.md B.10：本项目运行的每个镜像都叫 oasis/<组件>:<标签>
const OASIS_IMAGE = /^oasis\/[a-z0-9]+(?:[._-][a-z0-9]+)*:[\w][\w.-]{0,127}$/;
const COMPOSE_FILE = /(^|\/)(docker-)?compose[^/]*\.ya?ml$/;
const DOCKER_BUILD = /docker\s+(?:buildx\s+)?build\b[^\n]*/g;

function run(cmd, args, { capture = false } = {}) {
  const options = {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  };
  // Windows 上 pnpm 是 .cmd 脚本，只能经 shell 启动；参数都是本脚本里的常量，不含外部输入
  const result =
    IS_WINDOWS && cmd === 'pnpm'
      ? spawnSync([cmd, ...args].join(' '), { ...options, shell: true })
      : spawnSync(cmd, args, options);
  return { ok: result.status === 0, stdout: result.stdout ?? '' };
}

function listRepoFiles() {
  const { ok, stdout } = run('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    capture: true,
  });
  if (!ok) throw new Error('git ls-files 执行失败');
  return stdout.split('\n').filter(Boolean);
}

const files = listRepoFiles();
const sourceRootsInUse = SOURCE_ROOTS.filter((root) =>
  files.some((f) => f.startsWith(`${root}/`) && SOURCE_EXT.test(f)),
);

function checkNaming() {
  const offenders = new Set();
  for (const file of files) {
    for (const segment of file.split('/')) {
      const stem = segment.replace(/\.[^.]+$/, '').replace(/\.(test|spec|d)$/, '');
      if (FORBIDDEN_SUFFIX.test(stem)) offenders.add(file);
    }
  }
  for (const file of offenders) console.error(`  禁止的版本后缀命名：${file}`);
  return offenders.size === 0;
}

function checkImages() {
  const problems = [];
  for (const file of files.filter((f) => COMPOSE_FILE.test(f))) {
    const doc = parseYaml(readFileSync(path.join(ROOT, file), 'utf8')) ?? {};
    for (const [name, svc] of Object.entries(doc.services ?? {})) {
      const image = typeof svc?.image === 'string' ? svc.image.replace(/\$\{[^}]*\}/g, 'x') : '';
      if (!OASIS_IMAGE.test(image)) {
        problems.push(
          `${file} › ${name}：镜像必须命名为 oasis/<组件>:<标签>（当前：${svc?.image ?? '未设置'}）`,
        );
      }
      if (svc?.build === undefined) {
        problems.push(
          `${file} › ${name}：必须有 build（第三方镜像用 infra/images/<组件>/Dockerfile 包装）`,
        );
      }
      if (svc?.pull_policy !== 'build') {
        problems.push(
          `${file} › ${name}：必须设置 pull_policy: build，禁止从镜像仓库拉取 oasis/ 同名镜像`,
        );
      }
    }
  }
  const scripts = files.filter(
    (f) => /\.(mjs|cjs|js|ts|sh|ps1|json)$/.test(f) && f !== 'scripts/check-engineering.mjs',
  );
  for (const file of scripts) {
    for (const [command] of readFileSync(path.join(ROOT, file), 'utf8').matchAll(DOCKER_BUILD)) {
      const tag = command.match(/(?:-t|--tag)[\s=]+["']?([^\s"']+)/)?.[1] ?? '';
      if (!OASIS_IMAGE.test(tag.replace(/\$\{?\w+\}?/g, 'x'))) {
        problems.push(`${file}：docker build 必须用 -t oasis/<组件>:<标签>（${command.trim()}）`);
      }
    }
  }
  for (const p of problems) console.error(`  ${p}`);
  return problems.length === 0;
}

function checkMigrations() {
  const migrations = files.filter((f) => /^services\/[^/]+\/migrations\/.+\.sql$/.test(f));
  let ok = true;
  for (const file of migrations) {
    const sql = readFileSync(path.join(ROOT, file), 'utf8');
    const phase = sql.match(/^--\s*phase:\s*(expand|migrate|contract)\s*$/m)?.[1];
    const problems = [];
    if (!phase) problems.push('缺少 "-- phase: expand|migrate|contract"');
    if (!/^--\s*migrate:up\s*$/m.test(sql)) problems.push('缺少 "-- migrate:up"');
    const down = sql.split(/^--\s*migrate:down\s*$/m)[1];
    if (down === undefined || down.replace(/--.*$/gm, '').trim() === '') {
      problems.push('缺少可执行的 "-- migrate:down" 回滚段');
    }
    if (phase === 'expand' && !/^--\s*contract-plan:\s*\S+/m.test(sql)) {
      problems.push('expand 迁移必须写 "-- contract-plan: <何时、如何收缩>"');
    }
    for (const p of problems) console.error(`  ${file}：${p}`);
    if (problems.length) ok = false;
  }
  return ok;
}

const CHECKS = {
  naming: { label: '版本后缀命名', fn: checkNaming },
  images: { label: '镜像命名 oasis/', fn: checkImages },
  migrations: { label: '数据库迁移 Expand/Contract', fn: checkMigrations },
  deps: {
    label: '依赖方向与循环依赖（dependency-cruiser）',
    needsSource: true,
    fn: () =>
      run('pnpm', [
        'exec',
        'depcruise',
        '--config',
        '.dependency-cruiser.cjs',
        '--output-type',
        'err',
        ...sourceRootsInUse,
      ]).ok,
  },
  dead: {
    label: '死代码与未使用依赖（knip）',
    fn: () => run('pnpm', ['exec', 'knip', '--no-progress']).ok,
  },
  dup: {
    label: '重复代码（jscpd）',
    needsSource: true,
    fn: () => run('pnpm', ['exec', 'jscpd', ...sourceRootsInUse]).ok,
  },
};

const onlyArg = process.argv.find((a) => a.startsWith('--only'));
const onlyValue = onlyArg?.includes('=')
  ? onlyArg.split('=')[1]
  : process.argv[process.argv.indexOf('--only') + 1];
const selected = onlyArg ? onlyValue.split(',') : Object.keys(CHECKS);

const results = [];
for (const name of selected) {
  const check = CHECKS[name];
  if (!check) {
    console.error(`未知检查项：${name}`);
    process.exit(2);
  }
  if (check.needsSource && sourceRootsInUse.length === 0) {
    results.push([check.label, '跳过（还没有源码）']);
    continue;
  }
  console.log(`\n▶ ${check.label}`);
  results.push([check.label, check.fn() ? '通过' : '失败']);
}

console.log('\n工程检查结果：');
for (const [label, status] of results) console.log(`  ${status.padEnd(4)}  ${label}`);
process.exit(results.some(([, s]) => s === '失败') ? 1 : 0);
