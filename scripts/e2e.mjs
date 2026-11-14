#!/usr/bin/env node
// 全链路回归（docs/engineering/回归测试.md）：本机起全部服务，模型换成按脚本回复的假供应商，
// 沙箱容器、浏览器检查、对象存储、画布都是真的。从「用户在私聊里说一句话」一直跑到「画布里打开成果」。
// 用法：pnpm e2e [场景名…] [--keep]   （先停掉 pnpm dev；--keep 跑完不停服务，方便排查）
//      pnpm e2e --real [场景名…]      真模型、真工具，每个场景花费上限 $1（做游戏这类场景在 e2e/real.mjs
//                                    里单独放宽；要花真钱，按需跑）
import { spawnSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFakeProvider, setRun } from './e2e/fake-provider.mjs';
import { IMAGE_MODEL, JPEG_IMAGE_MODEL } from './e2e/fake-media.mjs';
import { literal, query } from './e2e/db.mjs';
import { loadFixtures } from './e2e/fixtures.mjs';
import { SCENARIOS } from './e2e/scenarios.mjs';
import { REAL_BUDGET_MICRO, REAL_SCENARIOS } from './e2e/real.mjs';
import { checkCanvas } from './e2e/canvas.mjs';
import { schemaDrift } from './e2e/schema.mjs';
import {
  createStack,
  ensureInfra,
  FIRST,
  portBusy,
  portOf,
  readEnv,
  ROOT,
  SECOND,
  SERVICES,
  webPort,
} from './e2e/stack.mjs';
import { signIn } from './e2e/user.mjs';
import { pruneTurboCache, runDir } from './run-dirs.mjs';

const args = process.argv.slice(2);
const keep = args.includes('--keep');
const real = args.includes('--real');
const catalogue = real ? REAL_SCENARIOS : SCENARIOS;
const picked = args.filter((a) => !a.startsWith('--'));
const unknown = picked.filter((name) => !catalogue[name]);
if (unknown.length) {
  console.error(
    `没有这些${real ? '真模型' : ''}场景：${unknown.join('、')}（有：${Object.keys(catalogue).join('、')}）`,
  );
  process.exit(2);
}
const names = picked.length ? picked : Object.keys(catalogue);
const usd = (micro) => `$${(Number(micro) / 1_000_000).toFixed(4)}`;
/** 这个测试用户一共被扣了多少（私聊里每一轮的模型和工具调用都算） */
const charged = (userId) =>
  Number(
    query(
      'model_gateway',
      `select coalesce(sum(charged_micro), 0)::bigint as micro from calls where payer_id = ${literal(userId)}`,
    )[0].micro,
  );
// 每轮的记录在 .tmp/e2e/<时间>/，只留最近 5 轮；构建缓存只留 7 天（每轮都会构建一次）
const outDir = runDir('e2e', 5);
const cacheFreed = pruneTurboCache();
const started = Date.now();
const log = (line) =>
  console.log(`[${((Date.now() - started) / 1000).toFixed(0).padStart(4)}s] ${line}`);
if (cacheFreed) log(`清掉 7 天前的构建缓存 ${(cacheFreed / 1048576).toFixed(0)} MB`);
// 这一轮的编号写进每个场景的标记：上一轮没收尾的对话不会混进来
setRun(randomUUID().slice(0, 6));

function run(command, options = {}) {
  const result = spawnSync(command, {
    cwd: ROOT,
    shell: true,
    stdio: 'inherit',
    windowsHide: true,
    ...options,
  });
  if (result.status !== 0) throw new Error(`命令失败：${command}`);
}

// ---------- 准备：Docker、镜像、端口、中间件、共享包 ----------
const harnessEnv = readEnv(path.join(ROOT, 'services/harness/.env'));
const inspectorEnv = readEnv(path.join(ROOT, 'services/inspector/.env'));
const images = [
  harnessEnv.SANDBOX_IMAGE || 'oasis/harness-sandbox-3d:0.2.1-rc.5-blender4.3.2',
  inspectorEnv.BROWSER_IMAGE || 'oasis/inspector-browser:1.64.0',
  'oasis/harness-sandbox-base:0.2.1-rc.5',
];
for (const image of images)
  if (spawnSync('docker', ['image', 'inspect', image], { stdio: 'ignore' }).status !== 0)
    throw new Error(`缺少镜像 ${image}：先运行 pnpm sandbox:build / pnpm browser:build`);
const busy = [];
for (const name of SERVICES) if (await portBusy(portOf(name))) busy.push(`${name}:${portOf(name)}`);
if (await portBusy(webPort())) busy.push(`web:${webPort()}`);
if (busy.length) throw new Error(`这些端口被占用（${busy.join('、')}）：先停掉 pnpm dev 再跑回归`);
ensureInfra(log);
log('构建共享包');
run(
  'pnpm exec turbo run build --filter=./packages/* --filter=@oasis/desktop --output-logs=errors-only',
);
const fixtures = real ? undefined : loadFixtures();

// ---------- 起服务：模型目录 → 假供应商 → 其余服务（模型网关指向假供应商）→ Web ----------
const providerEnv = (url) => ({
  OPENROUTER_BASE_URL: `${url}/api/v1`,
  OPENROUTER_DECISIONS_URL: `${url}/api/alpha/decisions`,
  OPENROUTER_API_KEY: 'e2e-fake-key',
  TAVILY_API_KEY: '',
  FAL_API_KEY: '',
  RUNPOD_API_KEY: '',
  BROWSERSTACK_USERNAME: '',
  BROWSERSTACK_ACCESS_KEY: '',
  LIVEAVATAR_API_KEY: '',
  TOOL_IMAGE_MODELS: `${IMAGE_MODEL},${JPEG_IMAGE_MODEL}`,
  TOOL_INSPECT_MODELS: 'fake/vision-1',
  TOOL_VIDEO_MODELS: 'fake/video-1',
  TOOL_SPEECH_MODELS: 'fake/speech-1',
  TOOL_TRANSCRIBE_MODELS: 'fake/transcribe-1',
});
const env = {
  harness: {
    SANDBOX_CPUS: '1',
    MAX_CONCURRENT_RUNS: '4',
    RECOVERY_INTERVAL_MS: '5000',
  },
  // AI 自查 app.check 开的检查浏览器
  'model-gateway': { BROWSER_CHECK_CPUS: '1' },
};
const stack = createStack({ logDir: path.join(outDir, 'logs'), env, log });
let provider;
const results = [];
try {
  await stack.startAll(FIRST);
  if (real) {
    // 真模型：模型网关照 .env 连真的供应商和工具
    const raised = names
      .filter((name) => catalogue[name].budgetMicro)
      .map((name) => `${name} ${usd(catalogue[name].budgetMicro)}`);
    log(
      `真模型回归：${names.join('、')}，每个场景花费上限 ${usd(REAL_BUDGET_MICRO)}${raised.length ? `（${raised.join('、')}）` : ''}`,
    );
  } else {
    // 假供应商认得私聊里每个 AI 每一档的上游型号（agent 的模型表）
    const providerModels = query(
      'agent',
      "select distinct option ->> 'model' as model from models, jsonb_array_elements(options) as option",
    ).map((row) => row.model);
    provider = createFakeProvider({
      scenarios: SCENARIOS,
      fixtures,
      // 边跑边记：卡住时也能看到假供应商收到了什么
      onRecord: (call) =>
        appendFileSync(path.join(outDir, 'calls.jsonl'), `${JSON.stringify(call)}\n`),
      models: [...new Set([...providerModels, 'deepseek/deepseek-v4.1-flash'])],
    });
    const providerUrl = await provider.listen();
    log(`假供应商 ${providerUrl}`);
    env['model-gateway'] = { ...env['model-gateway'], ...providerEnv(providerUrl) };
  }
  await stack.startAll(SECOND);
  const drift = await schemaDrift();
  if (drift.length)
    throw new Error(`开发库表结构和迁移文件不一致（改过已经应用的迁移？）：\n${drift.join('\n')}`);
  const webUrl = await stack.startWeb('dev');
  const gatewayUrl = `http://127.0.0.1:${portOf('gateway')}`;
  const origin =
    readEnv(path.join(ROOT, 'services/gateway/.env')).GATEWAY_ALLOWED_ORIGINS?.split(',')[0] ??
    'http://127.0.0.1:5173';
  const mailpit = `http://127.0.0.1:${readEnv(path.join(ROOT, '.env')).MAILPIT_UI_HOST_PORT ?? 8025}`;

  // 上一轮回归中断时留下的私聊：用当时的测试账号登录，删掉（和用户删私聊同一条路，进行中的一轮先取消）
  const testers = query(
    'identity',
    `select id, email from users where email like 'e2e-%@example.test'`,
  );
  const owners = testers.length
    ? new Set(
        query(
          'conversation',
          `select distinct owner_id from conversations where kind = 'dm' and owner_id in (${testers.map((u) => literal(u.id)).join(',')})`,
        ).map((r) => r.owner_id),
      )
    : new Set();
  for (const tester of testers.filter((u) => owners.has(u.id))) {
    const old = await signIn({ gateway: gatewayUrl, mailpit, origin, email: tester.email });
    log(`清理上一轮留下的私聊：${await old.removeDms()} 个（${tester.email}）`);
  }

  // ---------- 跑场景：会重启服务的场景单独排在后面一个个跑 ----------
  async function play(name) {
    const scenario = catalogue[name];
    const t = {
      name,
      failures: [],
      conversations: [],
      provider,
      stack,
      fixtures,
      outDir,
      webUrl,
      log: (line) => log(`[${name}] ${line}`),
      check(condition, message) {
        if (!condition) {
          this.failures.push(message);
          this.log(`✗ ${message}`);
        }
      },
      track(conversationId) {
        this.conversations.push(conversationId);
        this.log(`私聊 ${conversationId}`);
      },
      canvas: (artifact, plan) => checkCanvas({ t, webUrl, outDir, artifact, plan }),
    };
    const begin = Date.now();
    let watchdog;
    try {
      t.user = await signIn({ gateway: gatewayUrl, mailpit, origin });
      if (real) {
        // 花费看门狗：超过上限就停下这个用户正在进行的一轮，场景判失败（模型绕圈也烧不了多少钱）
        const budget = scenario.budgetMicro ?? REAL_BUDGET_MICRO;
        let over = false;
        watchdog = setInterval(() => {
          const micro = charged(t.user.userId);
          if (micro <= budget || over) return;
          over = true;
          t.check(false, `花费 ${usd(micro)} 超过上限 ${usd(budget)}，已停下`);
          for (const id of t.conversations) t.user.stop(id).catch(() => {});
        }, 10_000);
      }
      await scenario.run(t);
    } catch (err) {
      t.failures.push(err instanceof Error ? (err.stack ?? err.message) : String(err));
      t.log(`✗ ${err instanceof Error ? err.message : err}`);
    } finally {
      clearInterval(watchdog);
    }
    const spent = real && t.user ? charged(t.user.userId) : undefined;
    if (spent !== undefined) t.log(`一共花费 ${usd(spent)}`);
    // 收尾也是用户路径：删掉私聊（真删除），成果、会话记录、工作目录一起删（--keep 时留着排查）
    if (t.user && t.conversations.length && !keep) {
      try {
        await t.user.removeDms(t.conversations);
        for (const id of t.conversations) {
          let left = [];
          for (let i = 0; i < 30; i++) {
            left = await t.user.artifacts(id);
            if (!left.length) break;
            await new Promise((resolve) => setTimeout(resolve, 1_000));
          }
          t.check(left.length === 0, `删除私聊 30 秒后画布里还剩 ${left.length} 个成果`);
        }
      } catch (err) {
        t.check(false, `删除私聊失败：${err instanceof Error ? err.message : err}`);
      }
    }
    const seconds = Math.round((Date.now() - begin) / 1000);
    results.push({
      name,
      passed: t.failures.length === 0,
      seconds,
      failures: t.failures,
      conversations: t.conversations,
      spent,
    });
    log(`${t.failures.length ? '✗ 未通过' : '✓ 通过'} ${name}（${seconds}s）`);
  }
  const parallel = names.filter((n) => !catalogue[n].serial);
  const serial = names.filter((n) => catalogue[n].serial);
  await Promise.all(parallel.map(play));
  for (const name of serial) await play(name);
} catch (err) {
  results.push({
    name: '准备',
    passed: false,
    seconds: 0,
    failures: [err instanceof Error ? (err.stack ?? err.message) : String(err)],
  });
  log(`✗ ${err instanceof Error ? err.message : err}`);
} finally {
  if (provider?.violations.length) {
    results.push({
      name: '供应商协议',
      passed: false,
      seconds: 0,
      failures: [...new Set(provider.violations)],
    });
  }
  writeFileSync(
    path.join(outDir, 'report.json'),
    JSON.stringify({ results, calls: provider?.calls ?? [] }, null, 2),
  );
  if (!keep) {
    await stack.stopAll();
    await provider?.close();
  }
}

console.log('\n回归结果：');
for (const r of results) {
  console.log(
    `  ${r.passed ? '通过' : '失败'}  ${r.name}${r.seconds ? `（${r.seconds}s${r.spent !== undefined ? `，花费 ${usd(r.spent)}` : ''}）` : ''}`,
  );
  for (const failure of r.failures)
    console.log(`        - ${failure.split('\n').join('\n          ')}`);
}
console.log(`\n日志和记录：${path.relative(ROOT, outDir)}`);
if (keep) console.log('服务还开着（--keep），排查完按 Ctrl+C 结束。');
else process.exit(results.every((r) => r.passed) ? 0 : 1);
