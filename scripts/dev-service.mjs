#!/usr/bin/env node
// 开发服务只在源码、共享包构建结果或本地配置的内容变化后重启。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const roots = [
  'src',
  '../../packages/contracts/dist',
  '../../packages/service-kit/dist',
  '.env',
  'package.json',
];
let cache = new Map();
function fingerprint() {
  const next = new Map();
  const hash = createHash('sha256');
  function visit(file) {
    let stat;
    try {
      stat = statSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(file).sort()) visit(path.join(file, name));
      return;
    }
    const previous = cache.get(file);
    const stamp = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
    const digest =
      previous?.stamp === stamp
        ? previous.digest
        : createHash('sha256').update(readFileSync(file)).digest('hex');
    next.set(file, { stamp, digest });
    hash.update(JSON.stringify([file, digest]));
  }
  for (const root of roots) visit(root);
  cache = next;
  return hash.digest('hex');
}

let child;
let retryTimer;
let failures = 0;
let stopping = false;
let restarting = false;
let current = fingerprint();
let pending = current;
const inputArgs = process.argv.slice(2);
const watching = inputArgs[0] !== '--no-watch';
if (!watching) inputArgs.shift();
const args = ['--env-file-if-exists=.env', ...inputArgs];
if (inputArgs.length === 0) throw new Error('用法：node ../../scripts/dev-service.mjs src/main.ts');

function start() {
  clearTimeout(retryTimer);
  const startedAt = Date.now();
  child = spawn(process.execPath, args, { stdio: 'inherit' });
  child.on('error', (error) =>
    console.error(JSON.stringify({ event: 'dev.start_failed', code: error.code })),
  );
  child.on('exit', (code, signal) => {
    if (!restarting && !stopping) {
      console.error(JSON.stringify({ event: 'dev.exited', code, signal }));
      // 正常退出和明确终止保持停止；异常崩溃/依赖暂不可用可在原监督进程内恢复。
      if (code !== 0 && signal !== 'SIGINT' && signal !== 'SIGTERM' && code !== 3221225786) {
        failures = Date.now() - startedAt >= 30000 ? 0 : failures + 1;
        const delayMs = Math.min(30000, 1000 * 2 ** Math.min(failures - 1, 5));
        console.error(JSON.stringify({ event: 'dev.retry_scheduled', delayMs }));
        retryTimer = setTimeout(start, delayMs);
      }
    }
  });
}

function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

const timer = watching
  ? setInterval(async () => {
      if (stopping || restarting) return;
      try {
        const next = fingerprint();
        // 连续两次一致，避免编辑器保存/编译写入期间启动半份代码。
        if (next === current || next !== pending) {
          pending = next;
          return;
        }
        restarting = true;
        clearTimeout(retryTimer);
        await stop();
        current = next;
        if (!stopping) {
          console.log(JSON.stringify({ event: 'dev.content_changed' }));
          start();
        }
      } catch (error) {
        console.error(JSON.stringify({ event: 'dev.watch_failed', code: error.code }));
      } finally {
        restarting = false;
      }
    }, 500)
  : undefined;

for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    clearTimeout(retryTimer);
    await stop();
    process.exit(0);
  });
start();
