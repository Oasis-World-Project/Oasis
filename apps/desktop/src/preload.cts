// 给页面开放的桌面端接口（ADR 0007 §10）：只有这几个，挂在 window.oasisDesktop 上。
// 沙箱里的 preload 只能 require('electron')，所以写成 CommonJS（.cts），频道名直接写在这里，
// 要和 @oasis/contracts/desktop 的 DESKTOP_CHANNELS 一致（测试会检查）。
import type { OasisDesktop } from '@oasis/contracts/desktop';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: OasisDesktop = {
  syncStatus: () => ipcRenderer.invoke('oasis:sync-status'),
  chooseSyncFolder: () => ipcRenderer.invoke('oasis:sync-choose'),
  writeSyncedFile: (artifactId, relativePath, data) =>
    ipcRenderer.invoke('oasis:sync-write', artifactId, relativePath, data),
  openSyncFolder: () => ipcRenderer.invoke('oasis:sync-open'),
};

contextBridge.exposeInMainWorld('oasisDesktop', api);
