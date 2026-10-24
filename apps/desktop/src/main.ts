// Oasis 桌面端主进程：一个加载 Web 外壳的窗口。
// 安全默认值：渲染进程隔离 + 沙箱 + 不开放 Node；外部链接交给系统浏览器；默认拒绝摄像头等权限申请。
// 给页面开放的能力只有 preload 里的几个：把成果同步到用户选的文件夹（ADR 0007 §10）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DESKTOP_CHANNELS } from '@oasis/contracts/desktop';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  session,
  shell,
  type IpcMainInvokeEvent,
} from 'electron';
import { createSyncFolder, freePath, type SyncFolder } from './sync-folder.ts';

const envFile = path.join(import.meta.dirname, '..', '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const webUrl = process.env.OASIS_WEB_URL;
if (!webUrl) {
  process.stderr.write('缺少 OASIS_WEB_URL：请先运行 pnpm env:init，或设置这个环境变量\n');
  process.exit(1);
}
const appOrigin = new URL(webUrl).origin;

/** 不是本应用自己的页面，一律不在窗口里打开。 */
function isExternal(url: string): boolean {
  try {
    return new URL(url).origin !== appOrigin;
  } catch {
    return true;
  }
}

function openInBrowser(url: string): void {
  if (/^https?:\/\//.test(url)) void shell.openExternal(url);
}

/** 开发期 Vite 可能还没起来：每秒重试一次，最多等 30 秒。 */
async function loadWithRetry(win: BrowserWindow, url: string, attempts = 30): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await win.loadURL(url);
      return;
    } catch (err) {
      if (attempt >= attempts) throw err;
      await delay(1_000);
    }
  }
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'Oasis',
    backgroundColor: '#DEDDE7',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
      preload: path.join(import.meta.dirname, 'preload.cjs'),
    },
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    openInBrowser(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!isExternal(url)) return;
    event.preventDefault();
    openInBrowser(url);
  });
  return win;
}

/** 只接受本应用自己页面发来的请求 */
function fromApp(event: IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? '';
  if (isExternal(url)) throw new Error('不接受这个页面的请求');
}

/** 同步到电脑：选文件夹、看状态、写文件、打开文件夹 */
function registerSync(sync: SyncFolder): void {
  ipcMain.handle(DESKTOP_CHANNELS.status, (event) => {
    fromApp(event);
    return sync.status();
  });
  ipcMain.handle(DESKTOP_CHANNELS.choose, async (event) => {
    fromApp(event);
    const owner = BrowserWindow.fromWebContents(event.sender);
    const options = {
      title: '选一个文件夹，任务的成果会自动存进去',
      properties: ['openDirectory', 'createDirectory'] as ('openDirectory' | 'createDirectory')[],
    };
    const result = owner
      ? await dialog.showOpenDialog(owner, options)
      : await dialog.showOpenDialog(options);
    const folder = result.filePaths[0];
    if (result.canceled || !folder) return null;
    await sync.setFolder(folder);
    return sync.folder();
  });
  ipcMain.handle(
    DESKTOP_CHANNELS.write,
    async (event, artifactId: unknown, relativePath: unknown, data: unknown) => {
      fromApp(event);
      if (
        typeof artifactId !== 'string' ||
        typeof relativePath !== 'string' ||
        !(data instanceof ArrayBuffer || data instanceof Uint8Array)
      ) {
        throw new Error('参数不合格');
      }
      await sync.write(artifactId, relativePath, data);
    },
  );
  ipcMain.handle(DESKTOP_CHANNELS.open, async (event) => {
    fromApp(event);
    const folder = await sync.folder();
    if (folder) await shell.openPath(folder);
  });
}

/** 点下载：存进系统的「下载」文件夹（重名加序号），存好后在文件管理器里选中它，不用再去找 */
function handleDownloads(): void {
  session.defaultSession.on('will-download', (_event, item) => {
    const target = freePath(path.join(app.getPath('downloads'), item.getFilename()));
    item.setSavePath(target);
    item.once('done', (_done, state) => {
      if (state === 'completed') shell.showItemInFolder(target);
    });
  });
}

app.whenReady().then(
  async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
    registerSync(createSyncFolder(path.join(app.getPath('userData'), 'sync.json')));
    handleDownloads();
    await loadWithRetry(createWindow(), webUrl);

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void loadWithRetry(createWindow(), webUrl);
    });
  },
  (err: unknown) => {
    process.stderr.write(`桌面端启动失败：${String(err)}\n`);
    app.exit(1);
  },
);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
