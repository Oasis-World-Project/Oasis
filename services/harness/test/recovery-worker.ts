// 离线故障注入控制进程。与产品相同的运行服务、PostgreSQL repo 和 Docker 执行器。
import { createReadStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import pg from 'pg';
import {
  checkedParts,
  createDockerApi,
  createServiceClient,
  defaultDockerSocket,
  type ObjectStore,
} from '@oasis/service-kit';
import { pino } from 'pino';
import { SANDBOX_PATHS } from '../src/adapter/dsh.ts';
import { createDockerExecutor } from '../src/executor/executor.ts';
import { createRunsRepo } from '../src/repo/runs-repo.ts';
import { createRunService } from '../src/service/run-service.ts';

const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${process.env.OASIS_TEST_SCHEMA}`,
});
const directory = process.env.OASIS_TEST_DIRECTORY!;
const path = (key: string) => {
  if (!/^runs\/[\w-]+\/[\w.-]+$/.test(key)) throw new Error('Invalid test object key');
  return join(directory, key);
};
const store: ObjectStore = {
  get: (key) => readFile(path(key)),
  read: async (key) => createReadStream(path(key)),
  delete: async (key) => rm(path(key), { force: true }),
  async put(key, body) {
    await mkdir(dirname(path(key)), { recursive: true });
    await writeFile(path(key), body);
  },
  async putStream(key, source, _type, limits) {
    const parts = checkedParts(source, limits);
    const chunks: Buffer[] = [];
    for (;;) {
      const item = await parts.next();
      if (item.done) {
        await this.put(key, Buffer.concat(chunks), 'application/x-tar');
        return item.value;
      }
      chunks.push(item.value);
    }
  },
};
const docker = createDockerApi(defaultDockerSocket());
const executor = createDockerExecutor({
  docker: {
    ...docker,
    listContainers: async (label) =>
      (
        await docker.listContainers(label.replace('harness-sandbox', 'harness-recovery-test'))
      ).filter((box) => box.Labels['oasis.run-id'] === process.env.OASIS_TEST_RUN),
    createContainer: (name, spec) =>
      docker.createContainer(
        name,
        name.startsWith('oasis-run-')
          ? {
              ...spec,
              Labels: {
                ...(spec.Labels as Record<string, string>),
                'oasis.component': 'harness-recovery-test',
              },
              Entrypoint: ['node'],
              Cmd: ['/workspace/in/provider.mjs'],
              Env: [...(spec.Env as string[]), 'OASIS_NATIVE_MODE=persistent'],
            }
          : {
              ...spec,
              Labels: {
                ...(spec.Labels as Record<string, string>),
                'oasis.component': 'harness-recovery-probe',
              },
            },
      ),
  },
  image: process.env.OASIS_NATIVE_IMAGE!,
  network: 'none',
  cpus: 1,
  memoryMb: 2048,
  pidsLimit: 512,
  workdir: SANDBOX_PATHS.workdir,
  sessionsDir: SANDBOX_PATHS.sessions,
});
const client = createServiceClient('offline-test', process.env.OASIS_TEST_GATEWAY!);
const service = createRunService({
  repo: createRunsRepo(pool),
  executor,
  store,
  modelGateway: client,
  canvas: client,
  modelBaseUrl: 'http://offline.invalid/v1',
  packages: {
    egressProxy: undefined,
    npmRegistry: 'https://registry.npmjs.org/',
    pipIndexUrl: 'https://pypi.org/simple',
  },
  maxConcurrent: 1,
  cores: 1,
  leaseMs: 60000,
  goalRoundWindow: 2,
  serviceName: 'harness',
  logger: pino({ level: 'silent' }),
});
if (process.argv[2] === 'recover') await service.recover();
else
  await service.start({
    runId: process.env.OASIS_TEST_RUN!,
    payerId: process.env.OASIS_TEST_PAYER!,
    taskId: process.env.OASIS_TEST_TASK!,
    model: 'deepseek/deepseek-v4.1-flash',
    goal: true,
    prompt:
      'Write the proof once using delegated models. Verify the preserved workspace and complete the goal.',
    inputsFrom: [],
    inputs: [
      {
        path: 'provider.mjs',
        contentBase64: (
          await readFile(new URL('../src/adapter/test/native-provider.mjs', import.meta.url))
        ).toString('base64'),
      },
    ],
  });
const timer = setInterval(() => {}, 1000);
const shutdown = () => {
  void service
    .stopAll()
    .then(() => pool.end())
    .then(() => {
      clearInterval(timer);
      process.exit(0);
    });
};
process.once('SIGTERM', shutdown);
process.once('message', shutdown);
