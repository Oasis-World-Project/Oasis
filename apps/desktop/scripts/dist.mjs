// 打 Windows 安装包（pnpm desktop:dist，只能在 Windows 上跑）：
//   1. 主进程和 preload 各打成一个文件（esbuild），连同 app.json（窗口加载的网址）放进 build/app；
//   2. 下载固定版本的 Node（校验 SHA-256），用它把固定版本的 dsh 装进 build/runtime——装好的桌面版
//      「在这台电脑上干活」不用用户另装 Node、也不用现装 dsh；
//   3. electron-builder 打成 NSIS 安装包（装到当前用户名下，不要管理员权限），放在 release/。
// 不签名（安装时 Windows 会提示「未知发布者」）、不带自动更新。
// 用法：$env:OASIS_RELEASE_WEB_URL='https://…'; pnpm desktop:dist
//   下载慢时：OASIS_NODE_DIST（Node 的下载站，默认 https://nodejs.org/dist）、
//   ELECTRON_BUILDER_BINARIES_MIRROR（electron-builder 要的 NSIS 等工具）可以指到镜像站。
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { DSH_VERSION } from '@oasis/contracts/device';
import { Arch, build as pack, Platform } from 'electron-builder';
import { build as bundle } from 'esbuild';

/** 自带的 Node：和沙箱镜像里的是同一个版本（infra/images/harness-sandbox-base/Dockerfile 的 NODE_IMAGE） */
const NODE = {
  version: '24.21.0',
  sha256: '158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541',
};

if (process.platform !== 'win32') throw new Error('安装包只做了 Windows 的：请在 Windows 上运行');
const webUrl = process.env.OASIS_RELEASE_WEB_URL;
if (!webUrl || !URL.canParse(webUrl))
  throw new Error(
    '先设置 OASIS_RELEASE_WEB_URL：装好的桌面版打开的网址（比如 https://oasis.example.com）',
  );

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const dir = (...parts) => path.join(root, 'build', ...parts);
/** 包名：安装目录、electron-builder 的缓存目录都从它来 */
const APP_NAME = 'oasis';
const step = (text) => console.log(`\n== ${text}`);
const run = (command, args, options = {}) => {
  const done = spawnSync(command, args, { stdio: 'inherit', windowsHide: true, ...options });
  if (done.status !== 0) throw new Error(`${command} ${args[0] ?? ''} 没成功（${done.status}）`);
};

// ---------- 1. 应用本身 ----------
step('打包主进程和 preload');
rmSync(dir('app'), { recursive: true, force: true });
mkdirSync(dir('app'), { recursive: true });
const shared = { bundle: true, platform: 'node', target: 'node24', logLevel: 'warning' };
await bundle({
  ...shared,
  entryPoints: [path.join(root, 'src/main.ts')],
  outfile: dir('app', 'main.js'),
  format: 'esm',
  // ws 的两个可选加速模块没装，运行时它自己会退回纯 JS 的实现
  external: ['electron', 'bufferutil', 'utf-8-validate'],
  // 打进来的 CommonJS 依赖（ws、tar-stream）要用 require 取 Node 自带的模块
  banner: {
    js: "import { createRequire as oasisCreateRequire } from 'node:module';\nconst require = oasisCreateRequire(import.meta.url);",
  },
});
await bundle({
  ...shared,
  entryPoints: [path.join(root, 'src/preload.cts')],
  outfile: dir('app', 'preload.cjs'),
  format: 'cjs',
  external: ['electron'],
});
writeFileSync(dir('app', 'app.json'), `${JSON.stringify({ webUrl }, null, 2)}\n`);
writeFileSync(
  dir('app', 'package.json'),
  `${JSON.stringify({ name: APP_NAME, productName: 'Oasis', version: pkg.version, description: 'Oasis', author: 'Oasis', type: 'module', main: 'main.js' }, null, 2)}\n`,
);

// ---------- 2. 自带的运行环境：Node 和 dsh ----------
const nodeName = `node-v${NODE.version}-win-x64`;
const nodeDir = dir('runtime', 'node');
if (!existsSync(path.join(nodeDir, 'node.exe'))) {
  step(`下载 Node ${NODE.version}`);
  mkdirSync(dir('cache'), { recursive: true });
  const zip = dir('cache', `${nodeName}.zip`);
  if (!existsSync(zip)) {
    const from = `${process.env.OASIS_NODE_DIST ?? 'https://nodejs.org/dist'}/v${NODE.version}/${nodeName}.zip`;
    const response = await fetch(from);
    if (!response.ok) throw new Error(`下载 Node 没成功（${response.status}）：${from}`);
    writeFileSync(`${zip}.part`, Buffer.from(await response.arrayBuffer()));
    renameSync(`${zip}.part`, zip);
  }
  const sha256 = createHash('sha256').update(readFileSync(zip)).digest('hex');
  if (sha256 !== NODE.sha256) {
    rmSync(zip);
    throw new Error(`下载到的 Node 校验不对（${sha256}），已删掉，重新运行再下一次`);
  }
  rmSync(dir('runtime'), { recursive: true, force: true });
  mkdirSync(dir('runtime'), { recursive: true });
  // Windows 自带的 tar 能解 zip
  run('tar', ['-xf', zip, '-C', dir('runtime')]);
  renameSync(dir('runtime', nodeName), nodeDir);
}
const dshRoot = dir('runtime', 'dsh');
const dshBin = path.join(dshRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js');
const dshMarker = path.join(dshRoot, `.installed-${DSH_VERSION}`);
if (!existsSync(dshMarker) || !existsSync(dshBin)) {
  step(`用自带的 Node 装 dsh ${DSH_VERSION}（约 3 分钟）`);
  rmSync(dshRoot, { recursive: true, force: true });
  mkdirSync(dshRoot, { recursive: true });
  writeFileSync(path.join(dshRoot, 'package.json'), '{ "private": true }\n');
  // 参数都是写死的；npm 是 .cmd，要经命令行起
  run(
    `"${path.join(nodeDir, 'npm.cmd')}" install --no-audit --no-fund --loglevel=error @deepseek-ai/dsh@${DSH_VERSION}`,
    [],
    {
      cwd: dshRoot,
      shell: true,
      env: { ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH}` },
    },
  );
  if (!existsSync(dshBin)) throw new Error('dsh 装完了却找不到它');
  run(path.join(nodeDir, 'node.exe'), [dshBin, '--version'], { cwd: dshRoot });
  writeFileSync(dshMarker, `${new Date().toISOString()}\n`);
}

// ---------- 3. 安装包 ----------
step('打安装包');
// electron-builder 的安装器会把自己（约 200 MB）另存一份到 %LOCALAPPDATA%\<包名>-updater，留给自动更新做增量下载；
// 不带自动更新，这一份用不上，卸载时也不清：装完就删掉
writeFileSync(
  dir('installer.nsh'),
  [
    '!macro customInstall',
    '  Delete "$LOCALAPPDATA\\${APP_INSTALLER_STORE_FILE}"',
    `  RMDir "$LOCALAPPDATA\\${APP_NAME}-updater"`,
    '!macroend',
    '',
  ].join('\n'),
);
const electron = path.dirname(require.resolve('electron/package.json'));
await pack({
  targets: Platform.WINDOWS.createTarget('nsis', Arch.x64),
  config: {
    appId: 'space.elysiumgrid.oasis',
    productName: 'Oasis',
    directories: { app: dir('app'), output: path.join(root, 'release') },
    // 用已经装在仓库里的 Electron，不另下载
    electronDist: path.join(electron, 'dist'),
    electronVersion: JSON.parse(readFileSync(path.join(electron, 'package.json'), 'utf8')).version,
    asar: true,
    npmRebuild: false,
    // 不带自动更新
    publish: null,
    extraResources: [
      {
        from: dir('runtime'),
        to: 'runtime',
        // npm 装出来六万多个文件，一多半运行时用不到（类型声明、TypeScript 源码、源码映射、调试符号、说明文档）：
        // 不带它们，安装包小三成，装起来快一倍多
        filter: [
          '**/*',
          '!**/.installed-*',
          '!**/*.{ts,mts,cts,map,pdb,tsbuildinfo}',
          '!**/{README,Readme,readme,CHANGELOG,Changelog,changelog,HISTORY,History,history}*',
          // PowerShell 里敲 npm 会先找到 npm.ps1，它在 dsh 的沙箱里会报一次「访问命名管道被拒绝」；不带它就用 npm.cmd
          '!node/*.ps1',
        ],
      },
    ],
    win: { target: [{ target: 'nsis', arch: ['x64'] }] },
    nsis: {
      // 带向导的安装：可以改安装位置（默认还是当前用户的 %LOCALAPPDATA%\Programs\Oasis）
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      perMachine: false,
      // 只装到当前用户名下，用不到提权的小工具（它还常被杀毒软件拦下，打包会卡在复制它这一步）
      packElevateHelper: false,
      // 不带自动更新，就不用给增量更新准备的分块表
      differentialPackage: false,
      include: dir('installer.nsh'),
      artifactName: 'Oasis-Setup-${version}-x64.exe',
      shortcutName: 'Oasis',
    },
  },
});
console.log(`\n安装包在 ${path.join(root, 'release')}`);
