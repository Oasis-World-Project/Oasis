#!/usr/bin/env node
// 把沙箱镜像的配方在 E2B 上建成模板：线上的云端沙箱用它（harness 的 CLOUD_EXECUTOR=e2b、E2B_TEMPLATE）。
// 不另写一份配方：逐条读 infra/images/harness-sandbox-base 和 harness-sandbox-3d 两份 Dockerfile 的指令，
// 换成 E2B 的构建步骤，在 E2B 那边构建（2026-11-26 实测基础那份 26 步、5 分半，不占这台机器）。
// 用法：pnpm sandbox:e2b [模板名]（默认 oasis-harness-sandbox；E2B 的模板名不能带 /）。
// Key 读 services/harness/.env 的 E2B_API_KEY，不打印。
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseEnv } from 'node:util';

const root = path.resolve(import.meta.dirname, '..');
// e2b 是 harness 的依赖，从它那里解析
const { Template } = createRequire(path.join(root, 'services/harness/package.json'))('e2b');
const { E2B_API_KEY: apiKey } = parseEnv(
  readFileSync(path.join(root, 'services/harness/.env'), 'utf8'),
);
if (!apiKey) throw new Error('先在 services/harness/.env 里填 E2B_API_KEY');
const name = process.argv[2] ?? 'oasis-harness-sandbox';
if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) throw new Error('模板名只能用小写字母、数字、- 和 _');

/** Dockerfile → 指令：注释行去掉（续行中间的也去掉），行尾的 \ 把下一行接上来 */
function instructions(file) {
  const out = [];
  let current = '';
  for (const raw of readFileSync(path.join(root, file), 'utf8').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^\s*#/.test(line) || (!line.trim() && !current)) continue;
    if (line.endsWith('\\')) current += `${line.slice(0, -1)} `;
    else {
      out.push((current + line).trim());
      current = '';
    }
  }
  return out.map((text) => ({
    op: text.split(/\s+/, 1)[0].toUpperCase(),
    rest: text.replace(/^\S+\s+/, ''),
  }));
}
const expand = (value, vars) =>
  value.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => vars[a ?? b] ?? all);
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

const args = {};
// 基础镜像（node 官方镜像）的 PATH：后面的 ENV 往它前面加
const envs = { PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin' };
let user = 'root';
let template = Template({ fileContextPath: root });
let based = false;
for (const file of [
  'infra/images/harness-sandbox-base/Dockerfile',
  'infra/images/harness-sandbox-3d/Dockerfile',
])
  for (const { op, rest } of instructions(file)) {
    if (op === 'ARG') {
      const [key, ...value] = rest.split('=');
      args[key] = process.env[key] ?? value.join('=');
    } else if (op === 'FROM') {
      // 第二份配方的 FROM 就是第一份建出来的：接着往下建
      if (based) continue;
      based = true;
      // E2B 的底座先装了一个比配方锁定的快照更新的 openssl：让 apt 可以降回快照里的版本
      template = template
        .fromImage(expand(rest, args).replace(/@sha256:.*/, ''))
        .runCmd(
          `printf 'APT::Get::allow-downgrades "true";\\n' > /etc/apt/apt.conf.d/98oasis-e2b`,
          { user: 'root' },
        );
    } else if (op === 'RUN') {
      // 构建参数在 E2B 上没有：写成每条命令前的 export；镜像源那些 BuildKit secret 不用
      const exports = Object.entries(args)
        .map(([key, value]) => `export ${key}=${quote(value)}`)
        .join('; ');
      template = template.runCmd(`${exports}; ${rest.replace(/^(--mount=\S+\s+)+/, '')}`, {
        user,
      });
    } else if (op === 'ENV') {
      const set = {};
      for (const [, key, value] of rest.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|\S+)/g))
        set[key] = expand(value.replace(/^"|"$/g, ''), { ...args, ...envs });
      Object.assign(envs, set);
      template = template.setEnvs(set);
    } else if (op === 'COPY') {
      const words = rest.split(/\s+/);
      const owner = /^--chown=([^:]+)/.exec(words[0])?.[1];
      const files = owner ? words.slice(1) : words;
      const dest = files.pop();
      template = template.copy(files, dest, { user: owner ?? 'root' });
    } else if (op === 'USER') user = rest.trim();
    else if (op === 'WORKDIR') template = template.setWorkdir(rest.trim());
    else if (op !== 'ENTRYPOINT') throw new Error(`${file} 里有没处理的指令：${op}`);
  }
// 模板里的 ENV 对 E2B 起的命令不生效：写成一个文件，harness 起 dsh、跑命令前先读它（executor/e2b.ts）
const exportsFile = Object.entries(envs)
  .map(([key, value]) => `export ${key}=${quote(value)}\n`)
  .join('');
template = template
  .runCmd(
    `printf %s ${quote(Buffer.from(exportsFile).toString('base64'))} | base64 -d > /opt/oasis/image-env.sh && chmod 644 /opt/oasis/image-env.sh`,
    { user: 'root' },
  )
  .setUser(user);

const started = Date.now();
/** 命令自己的输出太多，平时不打；出错时把最后这些行打出来 */
const tail = [];
const built = await Template.build(template, name, {
  apiKey,
  cpuCount: Number(process.env.E2B_TEMPLATE_CPUS ?? 2),
  memoryMB: Number(process.env.E2B_TEMPLATE_MEMORY_MB ?? 4096),
  onBuildLogs: (entry) => {
    const text = String(entry.message);
    tail.push(text);
    if (tail.length > 40) tail.shift();
    // 每一步的开头和出错的行
    if (entry.level === 'error' || (entry.level === 'info' && !/\[std(out|err)\]/.test(text)))
      console.log(text.slice(0, 200));
  },
}).catch((err) => {
  console.error(tail.map((line) => line.slice(0, 300)).join('\n'));
  throw err;
});
console.log(
  `建好了：模板 ${name}（${built.templateId}），用了 ${Math.round((Date.now() - started) / 1000)} 秒`,
);
