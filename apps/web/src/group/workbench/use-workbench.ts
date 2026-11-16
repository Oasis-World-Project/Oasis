// 工作台的状态：收起 / 展开 / 拉宽，在看哪个页签，预览里打开了哪些文件，展开了哪个任务；
// 群文件和任务从服务端读（群文件变了、有任务开始或结束时重新读）。
import type { GroupFile, GroupSnapshot } from '@oasis/contracts/group';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useMemo, useState } from 'react';
import { groupFilesQuery, groupWorkQuery } from '../../api/queries.ts';
import { tasksOf, workMark, type RoomTask } from './tasks.ts';

type BenchMode = 'collapsed' | 'open' | 'wide';
export type BenchTab = 'preview' | 'files' | 'tasks';

const STORAGE_KEY = 'oasis.workbench';
// 展开还是收起记在本地；隐私模式等情况下 localStorage 可能不可用，失败就用默认值
function storedMode(): BenchMode {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value === 'open' || value === 'wide' ? value : 'collapsed';
  } catch {
    return 'collapsed';
  }
}

function storeMode(mode: BenchMode): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // 存不了就只在本次会话里生效
  }
}

export interface Workbench {
  mode: BenchMode;
  setMode: (mode: BenchMode) => void;
  tab: BenchTab;
  setTab: (tab: BenchTab) => void;
  files: GroupFile[];
  tasks: RoomTask[];
  /** 预览里打开着的文件（路径，还在群文件里的） */
  opened: string[];
  /** 正在看的那个 */
  current: GroupFile | undefined;
  openFile: (path: string) => void;
  closeFile: (path: string) => void;
  /** 展开着过程的那个任务 */
  focus: string | undefined;
  setFocus: (runId: string | undefined) => void;
  openTasks: (runId?: string) => void;
}

const EMPTY: never[] = [];

export function useWorkbench(group: GroupSnapshot | null): Workbench {
  const [mode, setModeState] = useState<BenchMode>(storedMode);
  const [tab, setTab] = useState<BenchTab>('files');
  const [openedPaths, setOpened] = useState<string[]>([]);
  const [currentPath, setCurrent] = useState<string>();
  const [focus, setFocus] = useState<string>();
  const enabled = group?.kind === 'group';
  const id = group?.id ?? '';
  const messages = group?.messages ?? EMPTY;
  const filesQuery = useQuery({ ...groupFilesQuery(id, group?.filesRev ?? 0), enabled });
  const mark = useMemo(() => workMark(messages), [messages]);
  const workQuery = useQuery({ ...groupWorkQuery(id, mark), enabled });
  const files = filesQuery.data ?? EMPTY;
  const work = workQuery.data ?? EMPTY;
  const tasks = useMemo(() => tasksOf([...work, ...messages]), [work, messages]);

  const setMode = useCallback((next: BenchMode) => {
    setModeState(next);
    storeMode(next);
  }, []);
  /** 去看某个页签；工作台收着的话先展开 */
  const show = useCallback((next: BenchTab) => {
    setTab(next);
    setModeState((current) => {
      if (current !== 'collapsed') return current;
      storeMode('open');
      return 'open';
    });
  }, []);
  const openFile = useCallback(
    (path: string) => {
      setOpened((list) => (list.includes(path) ? list : [...list, path]));
      setCurrent(path);
      show('preview');
    },
    [show],
  );
  const closeFile = useCallback((path: string) => {
    setOpened((list) => list.filter((item) => item !== path));
  }, []);
  const openTasks = useCallback(
    (runId?: string) => {
      if (runId) setFocus(runId);
      show('tasks');
    },
    [show],
  );

  const opened = useMemo(
    () => openedPaths.filter((path) => files.some((file) => file.path === path)),
    [openedPaths, files],
  );
  const shown = opened.includes(currentPath ?? '') ? currentPath : opened.at(-1);
  return {
    mode,
    setMode,
    tab,
    setTab,
    files,
    tasks,
    opened,
    current: files.find((file) => file.path === shown),
    openFile,
    closeFile,
    focus,
    setFocus,
    openTasks,
  };
}
