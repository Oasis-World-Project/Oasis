// 给页面开放的桌面端接口（ADR 0007 §10、0009 §18）：只有这几个，挂在 window.oasisDesktop 上。
// 沙箱里的 preload 只能 require('electron')，所以写成 CommonJS（.cts），频道名直接写在这里，
// 要和 @oasis/contracts/desktop 的 DESKTOP_CHANNELS 一致（测试会检查）。
import type { OasisDesktop } from '@oasis/contracts/desktop';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const { contextBridge, ipcRenderer } = require('electron') as typeof import('electron');

const api: OasisDesktop = {
  syncStatus: () => ipcRenderer.invoke('oasis:sync-status'),
  chooseSyncFolder: () => ipcRenderer.invoke('oasis:sync-choose'),
  beginSyncedFile: (id, relative, size, sha256, replacesSha256) =>
    ipcRenderer.invoke('oasis:sync-begin', id, relative, size, sha256, replacesSha256),
  appendSyncedFile: (token, data) => ipcRenderer.invoke('oasis:sync-append', token, data),
  finishSyncedFile: (token) => ipcRenderer.invoke('oasis:sync-finish', token),
  abortSyncedFile: (token) => ipcRenderer.invoke('oasis:sync-abort', token),
  openSyncFolder: () => ipcRenderer.invoke('oasis:sync-open'),
  capturePage: (rect) => ipcRenderer.invoke('oasis:capture-page', rect),
};

contextBridge.exposeInMainWorld('oasisDesktop', api);
