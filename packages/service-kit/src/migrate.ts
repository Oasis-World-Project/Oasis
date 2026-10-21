// 用 dbmate 执行本服务的 SQL 迁移（纯 SQL、带回滚段，见 AGENTS.md B.8）。
import { spawn } from 'node:child_process';
import { resolveBinary } from 'dbmate';
import type { Logger } from './logger.ts';

export async function runMigrations(options: {
  databaseUrl: string;
  migrationsDir: string;
  logger: Logger;
}): Promise<void> {
  const args = [
    '--migrations-dir',
    options.migrationsDir,
    '--no-dump-schema',
    '--wait',
    '--wait-timeout',
    '30s',
    'up',
  ];
  const output: string[] = [];
  await new Promise<void>((resolve, reject) => {
    // 连接串经环境变量传给 dbmate，不出现在进程命令行里
    const child = spawn(resolveBinary(), args, {
      env: { ...process.env, DATABASE_URL: options.databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => output.push(chunk.toString()));
    child.on('error', reject);
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`数据库迁移失败：\n${output.join('').trim()}`)),
    );
  });
  const applied = output
    .join('')
    .split('\n')
    .filter((line) => line.startsWith('Applied:'));
  options.logger.info(
    { applied: applied.map((line) => line.slice('Applied:'.length).trim()) },
    '数据库迁移完成',
  );
}
