// 左侧收起式侧栏，结构照原型 v6：字标 → 拉群/搜索 → 四个主入口 → 群聊 → 私聊 → 底部「我」。
// 不显示未读数字或红点（PRD G-02）。
import { Link } from '@tanstack/react-router';
import {
  Globe,
  House,
  Image,
  LayoutGrid,
  MessageCircle,
  MessagesSquare,
  PanelLeftClose,
  PanelLeftOpen,
  Plus,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useSidebarState } from './use-sidebar-state.ts';

interface NavEntry {
  to: '/' | '/ais' | '/plaza' | '/canvas' | '/groups' | '/dms';
  label: string;
  icon: LucideIcon;
  /** 展开时这一项下面的空列表说明 */
  emptyHint?: string;
}

const MAIN_ENTRIES: NavEntry[] = [
  { to: '/', label: '首页', icon: House },
  { to: '/ais', label: 'AI 们', icon: LayoutGrid },
  { to: '/plaza', label: '广场', icon: Globe },
  { to: '/canvas', label: '画布', icon: Image },
];

const CHAT_ENTRIES: NavEntry[] = [
  { to: '/groups', label: '群聊', icon: MessagesSquare, emptyHint: '还没有群' },
  { to: '/dms', label: '私聊', icon: MessageCircle, emptyHint: '还没有私聊' },
];

const ITEM_BASE =
  'flex h-[42px] items-center rounded-item text-ink no-underline transition-colors hover:bg-glass-strong aria-[current=page]:bg-glass-active aria-[current=page]:font-medium aria-[current=page]:shadow-raised';

const ROUND_BUTTON =
  'flex size-[42px] shrink-0 items-center justify-center rounded-full border-0 bg-glass-strong text-ink shadow-edge-strong disabled:cursor-not-allowed disabled:opacity-55';

function NavLink({ entry, open }: { entry: NavEntry; open: boolean }) {
  const Icon = entry.icon;
  return (
    <Link
      to={entry.to}
      activeOptions={{ exact: entry.to === '/' }}
      aria-label={open ? undefined : entry.label}
      title={open ? undefined : entry.label}
      className={open ? `${ITEM_BASE} gap-3 px-3` : `${ITEM_BASE} w-[44px] justify-center`}
    >
      <Icon size={19} strokeWidth={1.7} aria-hidden="true" />
      {open && <span>{entry.label}</span>}
    </Link>
  );
}

export function Sidebar() {
  const { open, toggle } = useSidebarState();
  const ToggleIcon = open ? PanelLeftClose : PanelLeftOpen;

  return (
    <nav
      aria-label="主导航"
      data-state={open ? 'open' : 'closed'}
      className={`glass sticky top-[18px] flex h-[calc(100vh-36px)] shrink-0 flex-col rounded-panel ${
        open ? 'w-[252px] px-[14px] pb-[14px] pt-[18px]' : 'w-[76px] items-center pb-[14px] pt-4'
      }`}
    >
      <div className={open ? 'flex items-center gap-2 pb-3 pl-2 pr-1' : 'pb-2'}>
        {open && (
          <span className="flex-1 font-display text-[21px] font-medium leading-none tracking-[-0.02em]">
            oasis
          </span>
        )}
        <button
          type="button"
          onClick={toggle}
          aria-label={open ? '收起侧栏' : '展开侧栏'}
          className={`${ROUND_BUTTON} cursor-pointer`}
        >
          <ToggleIcon size={18} strokeWidth={1.8} aria-hidden="true" />
        </button>
      </div>

      {/* 拉群、搜索在第 4 阶段接入 */}
      <div className={open ? 'flex gap-1.5 pb-2.5' : 'flex flex-col items-center gap-2 pb-2'}>
        <button
          type="button"
          disabled
          title="拉群：即将开放"
          aria-label={open ? undefined : '拉群'}
          className={`flex h-[42px] items-center justify-center gap-1.5 rounded-item border-0 bg-solid text-on-solid disabled:cursor-not-allowed disabled:opacity-55 ${
            open ? 'flex-1 text-sm font-medium' : 'w-[44px]'
          }`}
        >
          <Plus size={16} strokeWidth={2.2} aria-hidden="true" />
          {open && '拉群'}
        </button>
        {open && (
          <button
            type="button"
            disabled
            title="搜索：即将开放"
            aria-label="搜索"
            className={ROUND_BUTTON}
          >
            <Search size={18} strokeWidth={1.8} aria-hidden="true" />
          </button>
        )}
      </div>

      <div className={open ? 'flex flex-col gap-0.5' : 'flex flex-col items-center gap-1'}>
        {MAIN_ENTRIES.map((entry) => (
          <NavLink key={entry.to} entry={entry} open={open} />
        ))}
      </div>

      {!open && <span aria-hidden="true" className="my-2 h-px w-7 bg-hairline" />}

      <div className={open ? 'mt-4 flex flex-col gap-0.5' : 'flex flex-col items-center gap-1'}>
        {CHAT_ENTRIES.map((entry) => (
          <div key={entry.to} className="flex flex-col">
            <NavLink entry={entry} open={open} />
            {open && entry.emptyHint && (
              <span className="px-3 pb-2 pl-[43px] text-xs text-ink-muted">{entry.emptyHint}</span>
            )}
          </div>
        ))}
      </div>

      <span className="min-h-3 flex-1" />

      <Link
        to="/me"
        aria-label={open ? undefined : '我'}
        title={open ? undefined : '我'}
        className={`flex items-center text-ink no-underline aria-[current=page]:shadow-raised ${
          open
            ? 'gap-2.5 rounded-[22px] bg-glass-strong p-2.5 shadow-edge-strong aria-[current=page]:bg-glass-active'
            : 'justify-center rounded-full'
        }`}
      >
        <span
          aria-hidden="true"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-person-me text-sm font-medium shadow-avatar-ring"
        >
          我
        </span>
        {open && <span className="text-[13.5px] font-medium">我</span>}
      </Link>
    </nav>
  );
}
