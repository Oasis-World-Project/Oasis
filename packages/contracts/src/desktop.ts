// 桌面端（Electron）给页面开放的接口（ADR 0007 §10）：preload 用 contextBridge 挂在 window.oasisDesktop 上。
// 只开放这几个明确的能力；写文件只能写进用户自己选的同步文件夹。

export interface DesktopSyncStatus {
  /** 用户选的同步文件夹；还没选为 null */
  folder: string | null;
  /** 已经同步到这个文件夹的成果 id（用户在电脑上删了也算同步过，不会再下回来） */
  synced: string[];
}

export interface OasisDesktop {
  syncStatus(): Promise<DesktopSyncStatus>;
  /** 弹出系统对话框选文件夹；用户取消时返回 null */
  chooseSyncFolder(): Promise<string | null>;
  /** 把一个成果写进同步文件夹的 relativePath（相对路径，不能跳出文件夹） */
  writeSyncedFile(artifactId: string, relativePath: string, data: ArrayBuffer): Promise<void>;
  /** 在文件管理器里打开同步文件夹 */
  openSyncFolder(): Promise<void>;
}

/** 单个同步文件的大小上限（主进程也会检查） */
export const DESKTOP_SYNC_MAX_BYTES = 500 * 1024 * 1024;

/** 主进程和 preload 之间的 IPC 频道名 */
export const DESKTOP_CHANNELS = {
  status: 'oasis:sync-status',
  choose: 'oasis:sync-choose',
  write: 'oasis:sync-write',
  open: 'oasis:sync-open',
} as const;
