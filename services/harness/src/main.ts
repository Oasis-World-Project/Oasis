// harness：Agent 运行时。唯一接触 DeepSeek Harness 的服务（只在 src/adapter/ 里），
// 每份会话起一个沙箱跑 dsh（本机 Docker、租的 E2B，或交给用户电脑上的桌面版跑），模型调用经 model-gateway 计费。
import { fileURLToPath } from 'node:url';
import {
  createDockerApi,
  createPostgres,
  createServiceClient,
  defaultDockerSocket,
  startService,
  type ServiceResource,
} from '@oasis/service-kit';
import { DEVICE_PATHS, SANDBOX_PATHS } from './adapter/dsh.ts';
import { registerDevices, registerRoutes } from './api/routes.ts';
import { harnessEnv } from './config.ts';
import { createDeviceHub, type DeviceHub } from './executor/device.ts';
import { createE2bExecutor } from './executor/e2b.ts';
import { createDockerExecutor, type Executor } from './executor/executor.ts';
import { createRunsRepo } from './repo/runs-repo.ts';
import { loadGuide, loadSandboxFiles } from './service/guide.ts';
import { holdInstanceLock } from './service/instance-lock.ts';
import { createRunService, type RunService } from './service/run-service.ts';

/** 给主 AI 的平台说明和技能（每轮现读） */
const GUIDE_DIR = fileURLToPath(new URL('../guide', import.meta.url));
/** 仓库根目录：沙箱里的 oasis-tool 这些命令和 dsh 组合每轮从这里现读 */
const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

let executor: Executor;
let devices: DeviceHub | undefined;
let runs: RunService | undefined;
let recoveryTimer: NodeJS.Timeout | undefined;

await startService({
  name: 'harness',
  env: harnessEnv,
  migrationsDir: fileURLToPath(new URL('../migrations', import.meta.url)),
  resources: async (ctx) => {
    const { config } = ctx;
    const postgres = createPostgres(config.DATABASE_URL, ctx.logger);
    // 一台机器只跑一个 harness：占到锁才往下走（接管遗留的运行、开始接活）
    const instanceLock = await holdInstanceLock({
      databaseUrl: config.DATABASE_URL,
      logger: ctx.logger,
    });

    if (config.CLOUD_EXECUTOR === 'e2b') {
      if (!config.E2B_API_KEY || !config.E2B_RUN_API_URL)
        throw new Error('CLOUD_EXECUTOR=e2b 要填 E2B_API_KEY 和 E2B_RUN_API_URL');
      executor = createE2bExecutor({
        apiKey: config.E2B_API_KEY,
        template: config.E2B_TEMPLATE,
        timeoutMs: config.E2B_TIMEOUT_SECONDS * 1000,
        allowOut: [
          new URL(config.E2B_RUN_API_URL).hostname,
          ...config.E2B_ALLOW_OUT.split(',')
            .map((host) => host.trim())
            .filter(Boolean),
        ],
        workdir: SANDBOX_PATHS.workdir,
        logger: ctx.logger,
      });
    } else
      executor = createDockerExecutor({
        docker: createDockerApi(config.DOCKER_SOCKET ?? defaultDockerSocket()),
        image: config.SANDBOX_IMAGE,
        network: config.SANDBOX_NETWORK,
        cpus: config.SANDBOX_CPUS,
        memoryMb: config.SANDBOX_MEMORY_MB,
        pidsLimit: config.SANDBOX_PIDS_LIMIT,
        workdir: SANDBOX_PATHS.workdir,
        sessionsDir: SANDBOX_PATHS.sessions,
        cache: { dir: SANDBOX_PATHS.cache, maxMb: config.SANDBOX_CACHE_MAX_MB },
      });
    // 就绪 = 云端沙箱可用（Docker：镜像和网络都在；E2B：Key 能用）；关闭时先让进行中的运行收尾
    const sandboxes: ServiceResource = {
      name: 'sandboxes',
      ready: () => executor.check(),
      close: async () => {
        clearInterval(recoveryTimer);
        await runs?.stopAll();
        // 进行中的运行（包括用户电脑上的）收好尾再断开电脑，它们会自己重连
        devices?.close();
      },
    };
    return { postgres, instanceLock, sandboxes };
  },
  routes: async (app, { config, resources, logger, name }) => {
    devices = createDeviceHub({ logger, paths: DEVICE_PATHS });
    registerDevices(app, devices);
    runs = createRunService({
      repo: createRunsRepo(resources.postgres.pool),
      executor,
      devices,
      modelGateway: createServiceClient('model-gateway', config.MODEL_GATEWAY_URL, {
        timeoutMs: 10_000,
      }),
      canvas: createServiceClient('canvas', config.CANVAS_URL, { timeoutMs: 60_000 }),
      materialsMaxBytes: config.MATERIALS_MAX_BYTES,
      transferTimeoutMs: config.FILE_TRANSFER_TIMEOUT_MS,
      // E2B 的沙箱在公网上：直接调公网的 gateway、直接访问放行的软件包仓库，不经本机的入口和出口代理
      modelBaseUrl: config.E2B_RUN_API_URL ?? config.SANDBOX_MODEL_BASE_URL,
      packages: {
        egressProxy: config.CLOUD_EXECUTOR === 'e2b' ? undefined : config.SANDBOX_EGRESS_PROXY,
        npmRegistry: config.SANDBOX_NPM_REGISTRY,
        pipIndexUrl: config.SANDBOX_PIP_INDEX_URL,
      },
      guide: () => loadGuide(GUIDE_DIR),
      sandboxFiles: () => loadSandboxFiles(REPO_ROOT),
      maxConcurrent: config.MAX_CONCURRENT_RUNS,
      batchEnv: Object.fromEntries(
        Object.entries(config)
          .filter(([key]) => key.startsWith('OASIS_BATCH_'))
          .map(([key, value]) => [key, String(value)]),
      ),
      leaseMs: config.RUN_LEASE_MS,
      keyTtlSeconds: config.RUN_KEY_TTL_SECONDS,
      cores: config.SANDBOX_CPUS,
      setupSeconds: config.SANDBOX_SETUP_SECONDS,
      outputMaxBytes: config.OUTPUT_MAX_BYTES,
      idleMs: {
        cloud: config.SANDBOX_IDLE_SECONDS * 1000,
        device: config.DEVICE_IDLE_SECONDS * 1000,
      },
      serviceName: name,
      logger,
    });
    registerRoutes(app, runs);
    // 接管上次进程遗留的运行；Docker 暂时不可用也不阻止启动（/ready 会显示 sandboxes 失败）
    await runs.recover().catch((err: unknown) => logger.warn({ err }, '清理遗留运行失败'));
    recoveryTimer = setInterval(() => {
      void runs
        ?.recover()
        .catch((err: unknown) => logger.warn({ err }, '运行接管暂未完成，稍后重试'));
    }, config.RECOVERY_INTERVAL_MS);
  },
});
