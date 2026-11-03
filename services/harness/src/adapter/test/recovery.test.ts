import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import Fastify from 'fastify';
import { describe, it, expect } from 'vitest';
import { createDockerApi, defaultDockerSocket } from '../../executor/docker-api.ts';
import { createDockerExecutor } from '../../executor/executor.ts';

describe.skipIf(!process.env.OASIS_NATIVE_IMAGE || !process.env.TEST_DATABASE_URL)(
  '真实控制进程崩溃接管',
  () => {
    it.each(['crash', 'shutdown'])(
      '%s 后恢复同一原生目标和完整目录，输出只制作一次且只产生一次完成事件',
      async (mode) => {
        const schema = 'recovery_test_' + randomUUID().replaceAll('-', '');
        const pool = new pg.Pool({
          connectionString: process.env.TEST_DATABASE_URL,
          options: `-c search_path=${schema}`,
        });
        const directory = await mkdtemp(join(tmpdir(), 'oasis-recovery-'));
        const runId = randomUUID(),
          payerId = randomUUID(),
          taskId = randomUUID();
        const docker = createDockerApi(defaultDockerSocket());
        const clean = createDockerExecutor({
          docker: {
            ...docker,
            listContainers: (label) =>
              docker.listContainers(label.replace('harness-sandbox', 'harness-recovery-test')),
          },
          image: process.env.OASIS_NATIVE_IMAGE!,
          network: 'none',
          cpus: 1,
          memoryMb: 2048,
          pidsLimit: 512,
          workdir: '/workspace',
        });
        const gateway = Fastify();
        const calls: string[] = [];
        gateway.get('/internal/v1/models/execution', async () => ({
          models: ['deepseek/deepseek-v4.1-flash', 'test/secondary', 'test/tertiary'].map((id) => ({
            id,
            name: id,
            contextWindow: 1048576,
            maxTokens: 131072,
            input: ['text', 'image'],
            reasoning: true,
          })),
        }));
        gateway.post('/internal/run-keys', async () => ({
          keyId: randomUUID(),
          key: 'offline-only',
          expiresAt: new Date(Date.now() + 3600000).toISOString(),
        }));
        for (const route of [
          '/internal/run-keys/:id/revoke',
          '/internal/run-keys/:id/renew',
          '/internal/v1/compute/:id/settle',
          '/internal/v1/compute/runs/:id/recover',
          '/internal/v1/tools/runs/:id/cancel',
        ])
          gateway.post(route, async (request, reply) => {
            calls.push(request.routeOptions.url!);
            return reply.code(204).send();
          });
        gateway.post('/internal/v1/compute', async () => ({ callId: randomUUID(), heldMicro: 0 }));
        const gatewayUrl = await gateway.listen({ host: '127.0.0.1', port: 0 });
        const children: ChildProcess[] = [];
        const exited: Promise<unknown>[] = [];
        let diagnostics = '';
        const start = (mode: string) => {
          const child = spawn(
            process.execPath,
            [
              new URL('../../../test/recovery-worker.ts', import.meta.url).pathname.replace(
                /^\/(\w:)/,
                '$1',
              ),
              mode,
            ],
            {
              env: {
                ...process.env,
                OASIS_TEST_SCHEMA: schema,
                OASIS_TEST_DIRECTORY: directory,
                OASIS_TEST_GATEWAY: gatewayUrl,
                OASIS_TEST_RUN: runId,
                OASIS_TEST_PAYER: payerId,
                OASIS_TEST_TASK: taskId,
              },
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
            },
          );
          child.stderr?.on('data', (chunk: Buffer) => {
            diagnostics = (diagnostics + chunk.toString()).slice(-4000);
          });
          children.push(child);
          exited.push(new Promise((resolve) => child.once('exit', resolve)));
          return child;
        };
        const until = async (predicate: () => Promise<boolean>) => {
          const deadline = Date.now() + 60000;
          while (!(await predicate())) {
            if (Date.now() > deadline || children.at(-1)?.exitCode !== null) {
              const state = await pool.query('select status, error from runs where id=$1', [runId]);
              throw new Error(
                'Offline recovery deadline: ' + JSON.stringify(state.rows) + diagnostics,
              );
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        };
        try {
          await pool.query(`create schema ${schema}`);
          const migrations = new URL('../../../migrations/', import.meta.url);
          for (const file of (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort()) {
            const sql = await readFile(new URL(file, migrations), 'utf8');
            await pool.query(sql.split('-- migrate:up')[1]!.split('-- migrate:down')[0]!);
          }
          const first = start('start');
          await until(
            async () =>
              (
                await pool.query(
                  "select 1 from run_events where run_id=$1 and kind='tool_result' and data::text like '%DURABLE_WORKSPACE_CREATED%'",
                  [runId],
                )
              ).rowCount! > 0,
          );
          if (mode === 'crash') first.kill('SIGKILL');
          else first.send('shutdown');
          await exited[0];
          expect(
            (await pool.query('select status from runs where id=$1', [runId])).rows[0].status,
          ).toBe(mode === 'crash' ? 'running' : 'queued');
          expect((await pool.query('select count(*)::int as n from outbox')).rows[0].n).toBe(0);
          start('recover');
          await until(
            async () =>
              (
                await pool.query(
                  "select 1 from runs where id=$1 and status in ('succeeded','failed')",
                  [runId],
                )
              ).rowCount! > 0,
          );
          expect(
            (await pool.query('select status,error from runs where id=$1', [runId])).rows[0],
          ).toEqual({ status: 'succeeded', error: null });
          expect((await pool.query('select count(*)::int as n from runs')).rows[0].n).toBe(1);
          expect((await pool.query('select count(*)::int as n from outbox')).rows[0].n).toBe(1);
          expect(
            (
              await pool.query(
                "select count(*)::int as n from run_events where run_id=$1 and kind='tool_result' and data::text like '%DURABLE_WORKSPACE_CREATED%'",
                [runId],
              )
            ).rows[0].n,
          ).toBe(1);
          expect(
            (
              await pool.query(
                "select count(*)::int as n from run_events where run_id=$1 and kind='tool_result' and data::text like '%DURABLE_WORKSPACE_VERIFIED%'",
                [runId],
              )
            ).rows[0].n,
          ).toBe(1);
          expect(calls).toContain('/internal/v1/compute/runs/:id/recover');
          expect(calls).not.toContain('/internal/v1/tools/runs/:id/cancel');
        } finally {
          for (const child of children) child.kill('SIGKILL');
          await Promise.all(exited);
          await clean.suspend?.(runId);
          for (const box of await docker.listContainers('oasis.component=harness-recovery-test'))
            if (box.Labels['oasis.run-id'] === runId) await docker.removeContainer(box.Id);
          await clean.purgeWorkspace?.(runId);
          await pool.query(`drop schema if exists ${schema} cascade`);
          await pool.end();
          await gateway.close();
          await rm(directory, { recursive: true, force: true });
        }
      },
      150000,
    );
  },
);
