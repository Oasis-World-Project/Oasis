// 离线故障注入控制进程。与产品相同的运行服务、PostgreSQL repo 和 Docker 执行器。
import { readFile } from 'node:fs/promises';
import pg from 'pg';
import {
  createDockerApi,
  createServiceClient,
  defaultDockerSocket,
  packFiles,
} from '@oasis/service-kit';
import { pino } from 'pino';
import { SANDBOX_PATHS } from '../src/adapter/dsh.ts';
import { createDockerExecutor, type Executor } from '../src/executor/executor.ts';
import { createRunsRepo } from '../src/repo/runs-repo.ts';
import { createRunService } from '../src/service/run-service.ts';

const pool = new pg.Pool({
  connectionString: process.env.TEST_DATABASE_URL,
  options: `-c search_path=${process.env.OASIS_TEST_SCHEMA}`,
});
const docker = createDockerApi(defaultDockerSocket());
const docked = createDockerExecutor({
  docker: {
    ...docker,
    listContainers: async (label) =>
      (
        await docker.listContainers(label.replace('harness-sandbox', 'harness-recovery-test'))
      ).filter((box) => box.Labels['oasis.session-id'] === process.env.OASIS_TEST_RUN),
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
// 沙箱的入口换成假模型供应商（它再起镜像里的 dsh）：每次起沙箱时把它放进 in/
const provider = await readFile(
  new URL('../src/adapter/test/native-provider.mjs', import.meta.url),
);
const executor: Executor = {
  ...docked,
  start: async (spec) =>
    docked.start({
      ...spec,
      files: [
        ...spec.files,
        {
          dir: SANDBOX_PATHS.workdir,
          tar: await packFiles([{ path: 'in/provider.mjs', content: provider }]),
        },
      ],
    }),
};
const client = createServiceClient('offline-test', process.env.OASIS_TEST_GATEWAY!);
const service = createRunService({
  repo: createRunsRepo(pool),
  executor,
  modelGateway: client,
  canvas: client,
  idleMs: { cloud: 0, device: 0 },
  modelBaseUrl: 'http://offline.invalid/v1',
  packages: {
    egressProxy: undefined,
    npmRegistry: 'https://registry.npmjs.org/',
    pipIndexUrl: 'https://pypi.org/simple',
  },
  maxConcurrent: 1,
  cores: 1,
  leaseMs: 60000,
  guide: async () => ({ rules: '# 离线测试\n', device: '', skills: [] }),
  serviceName: 'harness',
  logger: pino({ level: 'silent' }),
});
if (process.argv[2] === 'recover') await service.recover();
else
  await service.start({
    runId: process.env.OASIS_TEST_RUN!,
    payerId: process.env.OASIS_TEST_PAYER!,
    conversationId: process.env.OASIS_TEST_CONVERSATION!,
    model: 'deepseek/deepseek-v4.1-flash',
    persona: '',
    prompt: 'Write the proof once using delegated models, then verify the preserved workspace.',
    materials: [],
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
