import { useCallback, useState } from 'react';

const STORAGE_KEY = 'oasis.sidebar';

// 侧栏展开状态记在本地（PRD G-01）。隐私模式等情况下 localStorage 可能不可用，失败就用默认值。
function readOpen(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'closed';
  } catch {
    return true;
  }
}

function writeOpen(open: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, open ? 'open' : 'closed');
  } catch {
    // 存不了就只在本次会话里生效
  }
}

export function useSidebarState() {
  const [open, setOpen] = useState(readOpen);
  const toggle = useCallback(() => {
    setOpen((current) => {
      writeOpen(!current);
      return !current;
    });
  }, []);
  return { open, toggle };
}
