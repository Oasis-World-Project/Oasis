// 桌面端（Electron）给页面开放的接口：preload 用 contextBridge 挂在 window.oasisDesktop 上。
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
  /**
   * 把一个成果写进同步文件夹的 relativePath（相对路径，不能跳出文件夹）。
   * artifactId：成果 id；同一个成果修改后原地换成新版时是「id@新摘要」，这样会再同步一次。
   * replacesSha256：修改出的新版要替换的旧文件摘要；那里的文件正是旧版（用户没改过）就覆盖，
   * 否则另存为「名字 (新版).扩展名」。
   */
  beginSyncedFile(
    artifactId: string,
    relativePath: string,
    size: number,
    sha256?: string | null,
    replacesSha256?: string | null,
  ): Promise<string | null>;
  appendSyncedFile(token: string, data: Uint8Array): Promise<void>;
  finishSyncedFile(token: string): Promise<void>;
  abortSyncedFile(token: string): Promise<void>;
  /** 在文件管理器里打开同步文件夹 */
  openSyncFolder(): Promise<void>;
  /**
   * 截取本窗口里这块区域（CSS 像素，相对窗口可视区）当前的真实画面，返回 PNG。
   * 用于在运行中的应用上批注：隔离框里的画面页面自己读不到，只有主进程能截。旧版桌面端没有这个能力。
   */
  capturePage?(rect: DesktopCaptureRect): Promise<Uint8Array>;
  /** 在你的电脑上干活：这台电脑的设备号、连没连上 Oasis。旧版桌面端没有这个能力 */
  deviceStatus?(): Promise<DesktopDevice>;
  /**
   * 弹出系统对话框选 AI 干活的项目文件夹（Windows 上顺手给自己加上这个文件夹的完全控制，dsh 的沙箱要）；
   * 用户取消时返回 null。旧版桌面端没有这个能力
   */
  chooseProjectFolder?(): Promise<DesktopProjectFolder | null>;
}

/** 这台电脑接 Oasis 的活的情况 */
export interface DesktopDevice {
  /** 这台电脑的设备号（存在桌面版自己的数据目录里） */
  deviceId: string;
  /** 连上了 Oasis（登录着、网络通），能接活 */
  connected: boolean;
  /** 接不了活的原因（如没装 Node.js 24）；没问题为 null */
  problem: string | null;
}

export interface DesktopProjectFolder {
  deviceId: string;
  folder: string;
}

export interface DesktopCaptureRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 单个同步文件的大小上限（主进程也会检查） */
export const DESKTOP_SYNC_MAX_BYTES = 2 * 1024 * 1024 * 1024;

/** 主进程和 preload 之间的 IPC 频道名 */
export const DESKTOP_CHANNELS = {
  status: 'oasis:sync-status',
  choose: 'oasis:sync-choose',
  begin: 'oasis:sync-begin',
  append: 'oasis:sync-append',
  finish: 'oasis:sync-finish',
  abort: 'oasis:sync-abort',
  open: 'oasis:sync-open',
  capture: 'oasis:capture-page',
  device: 'oasis:device-status',
  project: 'oasis:project-choose',
} as const;
