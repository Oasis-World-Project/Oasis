import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

const root = path.resolve(import.meta.dirname, '..');
const launcher = path.join(root, 'scripts/dev-service.mjs');
async function until(condition) {
  const deadline = Date.now() + 15000;
  while (!condition()) {
    assert.ok(Date.now() < deadline, '开发子进程未在期限内达到预期状态');
    await delay(40);
  }
}

test('开发热重载忽略重复写入和时间戳变化，响应实际源码、共享包、配置及删除恢复', async (t) => {
  mkdirSync(path.join(root, '.tmp'), { recursive: true });
  const dir = mkdtempSync(path.join(root, '.tmp/dev-service-test-'));
  const service = path.join(dir, 'services/fixture');
  const source = path.join(service, 'src/main.mjs');
  const shared = path.join(dir, 'packages/contracts/dist/value.mjs');
  mkdirSync(path.dirname(source), { recursive: true });
  mkdirSync(path.dirname(shared), { recursive: true });
  writeFileSync(shared, 'export const value = 1;');
  writeFileSync(path.join(service, '.env'), 'TEST_VALUE=alpha\n');
  const program = `import {value} from '../../../packages/contracts/dist/value.mjs';
console.log(JSON.stringify({boot:true,value,env:process.env.TEST_VALUE}));
setInterval(()=>{},1000);`;
  writeFileSync(source, program);
  const child = spawn(process.execPath, [launcher, 'src/main.mjs'], {
    cwd: service,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const boots = () =>
    output
      .split('\n')
      .filter((line) => line.startsWith('{"boot":'))
      .map((line) => JSON.parse(line));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => boots().length === 1);
  writeFileSync(source, readFileSync(source));
  const later = new Date(Date.now() + 10000);
  utimesSync(shared, later, later);
  writeFileSync(path.join(dir, 'unrelated.txt'), '不是开发输入');
  await delay(1800);
  assert.equal(boots().length, 1, output);
  writeFileSync(shared, 'export const value = 2;');
  await until(() => boots().at(-1)?.value === 2);
  writeFileSync(path.join(service, '.env'), 'TEST_VALUE=beta\n');
  await until(() => boots().at(-1)?.env === 'beta');
  writeFileSync(source, program.replace('boot:true', 'boot:true,edited:true'));
  await until(() => boots().at(-1)?.edited === true);
  rmSync(source);
  await until(() => output.includes('MODULE_NOT_FOUND'));
  writeFileSync(source, program);
  await until(() => boots().length === 5);
  assert.deepEqual(boots().at(-1), { boot: true, value: 2, env: 'beta' });
  writeFileSync(source, `${program}\nprocess.exit(0);`);
  await until(() => boots().length === 6);
  await delay(1800);
  assert.equal(boots().length, 6, '正常退出不会被异常恢复器复活');
});

test('执行服务不热重启源码，但异常退出和强制中断子进程后会退避恢复', async (t) => {
  const dir = mkdtempSync(path.join(root, '.tmp/dev-service-test-'));
  mkdirSync(path.join(dir, 'src'));
  const source = path.join(dir, 'src/main.mjs');
  writeFileSync(
    source,
    `import{readFileSync,writeFileSync,existsSync}from'node:fs';
const n=existsSync('attempt.txt')?Number(readFileSync('attempt.txt','utf8'))+1:1;
writeFileSync('attempt.txt',String(n));console.log(JSON.stringify({boot:true,n,pid:process.pid}));
if(n===1)process.exit(1);else setInterval(()=>{},1000);`,
  );
  const child = spawn(process.execPath, [launcher, '--no-watch', 'src/main.mjs'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const boots = () =>
    output
      .split('\n')
      .filter((line) => line.startsWith('{"boot":'))
      .map((line) => JSON.parse(line));
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      if (process.platform === 'win32')
        execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
      else child.kill('SIGTERM');
    }
    rmSync(dir, { recursive: true, force: true });
  });
  await until(() => boots().at(-1)?.n === 2);
  writeFileSync(source, readFileSync(source, 'utf8') + '\n// 源码变化不打断执行。\n');
  await delay(1200);
  assert.equal(boots().length, 2);
  process.kill(boots().at(-1).pid, 'SIGKILL');
  await until(() => boots().at(-1)?.n === 3);
  assert.ok(output.includes('dev.retry_scheduled'));
});
