// 桌面端：后台同步成果（挂在应用外壳上，打开应用期间每 60 秒看一次有没有新成果），
// 以及画布页上的同步条（选文件夹、看进度、打开文件夹）。浏览器里都不显示。
import type { OasisDesktop } from '@oasis/contracts/desktop';
import { queryOptions, useQuery, useQueryClient } from '@tanstack/react-query';
import { FolderOpen, FolderSync } from 'lucide-react';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { artifactsQuery } from '../api/queries.ts';
import { desktop, pendingOf, syncOnce, syncProgress } from './sync.ts';

const syncStatusQuery = (bridge: OasisDesktop) =>
  queryOptions({ queryKey: ['desktop-sync'], queryFn: () => bridge.syncStatus() });

function Runner({ bridge }: { bridge: OasisDesktop }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery(syncStatusQuery(bridge));
  const { data: artifacts } = useQuery({
    ...artifactsQuery(),
    enabled: Boolean(status?.folder),
    refetchInterval: 60_000,
  });
  useEffect(() => {
    if (!status?.folder || !artifacts) return;
    void syncOnce(bridge, artifacts, status).then(() =>
      queryClient.invalidateQueries({ queryKey: ['desktop-sync'] }),
    );
  }, [bridge, status, artifacts, queryClient]);
  return null;
}

/** 放在应用外壳里：桌面端才在后台同步 */
export function DesktopSync() {
  const bridge = desktop();
  return bridge ? <Runner bridge={bridge} /> : null;
}

const button =
  'inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border-0 px-3.5 text-[13px] font-medium disabled:opacity-45';

function Bar({ bridge }: { bridge: OasisDesktop }) {
  const queryClient = useQueryClient();
  const { data: status } = useQuery(syncStatusQuery(bridge));
  const { data: artifacts = [] } = useQuery(artifactsQuery());
  const progress = useSyncExternalStore(syncProgress.subscribe, syncProgress.get);
  const [choosing, setChoosing] = useState(false);
  if (!status) return null;

  async function choose() {
    setChoosing(true);
    try {
      await bridge.chooseSyncFolder();
    } finally {
      setChoosing(false);
      void queryClient.invalidateQueries({ queryKey: ['desktop-sync'] });
    }
  }

  const waiting = pendingOf(artifacts, status).length;
  const state = progress.running
    ? `正在同步 ${progress.done} / ${progress.total}`
    : progress.error
      ? `同步出错：${progress.error}（一分钟后自动再试）`
      : waiting > 0
        ? `还有 ${waiting} 个等着同步`
        : '全部已同步';

  return (
    <section
      aria-label="同步到电脑"
      className="flex flex-wrap items-center gap-3 rounded-card bg-glass-strong px-4 py-3 shadow-edge-strong"
    >
      <FolderSync size={18} aria-hidden="true" className="shrink-0 text-ink-muted" />
      {status.folder ? (
        <p className="m-0 flex min-w-0 flex-1 flex-col text-[13px]">
          <span className="truncate">
            成果会自动存进 <span className="font-medium">{status.folder}</span>
          </span>
          <span
            role="status"
            className={progress.error && !progress.running ? 'text-accent' : 'text-ink-muted'}
          >
            {state}
          </span>
        </p>
      ) : (
        <p className="m-0 min-w-0 flex-1 text-[13px]">
          <span className="font-medium">同步到电脑</span>
          <span className="text-ink-muted">
            ：选一个文件夹，任务完成后成果会自动存进去，按任务分好文件夹。
          </span>
        </p>
      )}
      {status.folder && (
        <button
          type="button"
          onClick={() => void bridge.openSyncFolder()}
          className={`${button} bg-solid text-on-solid`}
        >
          <FolderOpen size={15} aria-hidden="true" />
          打开文件夹
        </button>
      )}
      <button
        type="button"
        onClick={() => void choose()}
        disabled={choosing}
        className={`${button} ${status.folder ? 'bg-track text-ink' : 'bg-accent text-on-accent'}`}
      >
        {status.folder ? '换个文件夹' : '选文件夹'}
      </button>
    </section>
  );
}

/** 画布页上的同步条：桌面端才显示 */
export function DesktopSyncBar() {
  const bridge = desktop();
  return bridge ? <Bar bridge={bridge} /> : null;
}
