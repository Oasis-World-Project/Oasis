// 桌面端把成果同步到电脑（ADR 0007 §10）：页面负责下载（它有登录状态），主进程负责写进用户选的文件夹。
// 浏览器里没有 window.oasisDesktop，这些都不起作用。
import type { DesktopSyncStatus, OasisDesktop } from '@oasis/contracts/desktop';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { artifactContentUrl } from '../api/queries.ts';

export const desktop = (): OasisDesktop | undefined =>
  (globalThis as { oasisDesktop?: OasisDesktop }).oasisDesktop;

interface SyncProgress {
  running: boolean;
  /** 这一轮要同步几个、已经同步了几个 */
  total: number;
  done: number;
  error: string | null;
}

let progress: SyncProgress = { running: false, total: 0, done: 0, error: null };
const listeners = new Set<() => void>();

function update(patch: Partial<SyncProgress>) {
  progress = { ...progress, ...patch };
  listeners.forEach((listener) => listener());
}

export const syncProgress = {
  get: () => progress,
  subscribe(listener: () => void) {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};

/** 还没同步过的成果，先登记的先下 */
export const pendingOf = (artifacts: ArtifactBody[], status: DesktopSyncStatus) => {
  const synced = new Set(status.synced);
  return artifacts
    .filter((a) => !synced.has(a.id))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
};

/** 同步一轮：一个一个下载、写进文件夹；同一时间只跑一轮。出错就停下，下一轮再试 */
export async function syncOnce(
  bridge: OasisDesktop,
  artifacts: ArtifactBody[],
  status: DesktopSyncStatus,
): Promise<void> {
  if (progress.running || !status.folder) return;
  const pending = pendingOf(artifacts, status);
  if (pending.length === 0) {
    update({ total: 0, done: 0, error: null });
    return;
  }
  update({ running: true, total: pending.length, done: 0, error: null });
  try {
    for (const [index, artifact] of pending.entries()) {
      const response = await fetch(artifactContentUrl(artifact.id), { credentials: 'same-origin' });
      if (!response.ok) throw new Error(`下载「${artifact.name}」失败（${response.status}）`);
      await bridge.writeSyncedFile(artifact.id, artifact.syncPath, await response.arrayBuffer());
      update({ done: index + 1 });
    }
  } catch (err) {
    update({ error: err instanceof Error ? err.message : '同步失败了' });
  } finally {
    update({ running: false });
  }
}
