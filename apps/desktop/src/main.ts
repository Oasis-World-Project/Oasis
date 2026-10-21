// Oasis 桌面端主进程：一个加载 Web 外壳的窗口。
// 安全默认值：渲染进程隔离 + 沙箱 + 不开放 Node；外部链接交给系统浏览器；默认拒绝摄像头等权限申请。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { app, BrowserWindow, session, shell } from 'electron';

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

app.whenReady().then(
  async () => {
    session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
      callback(false),
    );
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
