// 在你的电脑上跑 dsh：dsh 要真正的 Node（22.19 以上的 22 版或 24 以上；Electron 跑不了它的原生模块）。
// 装好的版本（安装包）自带 Node 和装好的 dsh，直接用；从源码跑（pnpm desktop）时用电脑上装的 Node，第一次干活
// 时在桌面版自己的数据目录里装固定版本的 dsh（约 3 分钟）。每个会话的家目录里先生成 dsh 的基础组合
// （Oasis 的组合文件随后由 harness 放进来、盖在上面），再放 oasis-tool、oasis-op 两个命令。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DSH_VERSION } from '@oasis/contracts/device';

interface DshCommand {
  command: string;
  args: string[];
  /** 起 dsh 时另加的环境变量（dsh 包在哪、不发遥测）；命令所在的 bin/ 由调用方加进 PATH */
  env: Record<string, string>;
  /** 另外要放进 PATH 的目录：安装包自带的 Node（AI 跑的命令、oasis-tool 都用它） */
  path: string[];
}

/** 安装包里自带的运行环境：Node 发行包的目录，和装好了 dsh 的目录（里面有 node_modules） */
export interface BundledRuntime {
  nodeDir: string;
  dshRoot: string;
}

export interface DshRuntime {
  /** 这台电脑能不能跑（没装 Node 这类问题）；没问题为 null */
  problem(): string | null;
  /** 把这个会话的家目录准备好（第一次要先装 dsh，这时报 installing_dsh），返回起 dsh 的命令 */
  prepare(home: string, onStatus: (status: string) => void): Promise<DshCommand>;
}

/** 电脑上 node 的版本能不能跑 dsh；没装时 version 为 undefined */
export function nodeProblem(version: string | undefined): string | null {
  if (!version)
    return '这台电脑没装 Node.js：装好 24 版（nodejs.org）后重开 Oasis 桌面版，才能在这台电脑上干活';
  const [major = 0, minor = 0] = version.replace(/^v/, '').split('.').map(Number);
  return major >= 24 || (major === 22 && minor >= 19)
    ? null
    : `这台电脑的 Node.js 是 ${version}，dsh 要 24 版（或 22.19 以上的 22 版）：升级后重开 Oasis 桌面版`;
}

/**
 * 跑一个命令，不成功就报错（带上输出的末尾）。Windows 上 npm 是 .cmd，要经命令行起：整条命令自己拼好
 * （参数都是写死的，没有外来的内容）
 */
function run(command: string, args: string[], cwd: string, env = process.env): Promise<void> {
  return new Promise((resolve, reject) => {
    const viaShell = process.platform === 'win32' && command === 'npm';
    const child = spawn(viaShell ? [command, ...args].join(' ') : command, viaShell ? [] : args, {
      cwd,
      env,
      shell: viaShell,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const keep = (data: Buffer) => (output = (output + data.toString()).slice(-4000));
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              `${command} ${args[0] ?? ''} 没成功（${code}）：${output.trim().slice(-800)}`,
            ),
          ),
    );
  });
}

/** 会话家目录 bin/ 里的两个命令：用电脑上的 node 跑放进 tools/ 的脚本 */
async function writeCommands(home: string) {
  const bin = path.join(home, 'bin');
  await mkdir(bin, { recursive: true });
  const commands = {
    'oasis-tool': 'oasis-tool.ts',
    'oasis-op': 'services/harness/sandbox/oasis-op.ts',
  };
  for (const [name, script] of Object.entries(commands)) {
    if (process.platform === 'win32')
      await writeFile(
        path.join(bin, `${name}.cmd`),
        `@node --no-warnings "%~dp0..\\tools\\${script.replaceAll('/', '\\')}" %*\r\n`,
      );
    else {
      const file = path.join(bin, name);
      await writeFile(
        file,
        `#!/bin/sh\nexec node --no-warnings "$(dirname "$0")/../tools/${script}" "$@"\n`,
      );
      await chmod(file, 0o755);
    }
  }
}

export function createDshRuntime(dataDir: string, bundled?: BundledRuntime): DshRuntime {
  const root = bundled?.dshRoot ?? path.join(dataDir, 'runtime', `dsh-${DSH_VERSION}`);
  const node = bundled ? path.join(bundled.nodeDir, 'node.exe') : 'node';
  const pkg = path.join(root, 'node_modules', '@deepseek-ai', 'dsh');
  const bin = path.join(pkg, 'lib', 'bin.js');
  /** 装完才写，装到一半退出的下次重装 */
  const marker = path.join(root, '.installed');
  let problem: string | null | undefined;
  let installing: Promise<void> | undefined;

  async function install() {
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, 'package.json'), '{ "private": true }\n');
    await run(
      'npm',
      ['install', '--no-audit', '--no-fund', '--loglevel=error', `@deepseek-ai/dsh@${DSH_VERSION}`],
      root,
    );
    if (!existsSync(bin)) throw new Error('dsh 装完了却找不到它');
    await writeFile(marker, `${new Date().toISOString()}\n`);
  }

  return {
    problem() {
      if (bundled) return null;
      if (problem === undefined) {
        const result = spawnSync('node', ['--version'], {
          encoding: 'utf8',
          timeout: 10_000,
          windowsHide: true,
        });
        problem = nodeProblem(result.status === 0 ? result.stdout.trim() : undefined);
      }
      return problem;
    },

    async prepare(home, onStatus) {
      if (!bundled && (!existsSync(marker) || !existsSync(bin))) {
        onStatus('installing_dsh');
        installing ??= install().finally(() => (installing = undefined));
        await installing;
      }
      const env = { DSH_TELEMETRY_DISABLED: '1' };
      // dsh 的基础组合（从它自带的 sdk 模板复制出 oasis）；Oasis 的组合文件随后由 harness 放进来
      if (!existsSync(path.join(home, 'profiles', 'oasis', 'package.json'))) {
        await mkdir(home, { recursive: true });
        await run(node, [bin, 'oasis', '--from-default-profile', 'sdk', '--dump-config'], home, {
          ...process.env,
          ...env,
          DSH_HOME: home,
        });
      }
      await writeCommands(home);
      return {
        command: node,
        args: [bin, '--profile', 'oasis'],
        env: { ...env, OASIS_DSH_PACKAGE: path.join(pkg, 'package.json') },
        path: bundled ? [bundled.nodeDir] : [],
      };
    },
  };
}
