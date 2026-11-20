// 官网首屏右边那扇窗：一个真实样式的群聊（珍珠雾面、AI 的珍珠头像和光色都来自应用本身），
// 你和三个 AI 商量周末去哪，负责的 AI 分工、交出一份行程。消息在页面打开时一条接一条出现一次；
// 系统设置了「减少动态效果」时直接全部显示。
import { CHAT_AIS } from '@oasis/contracts/lineup';
import { ArrowUp, FileText } from 'lucide-react';
import type { ReactNode } from 'react';
import { AiAvatar } from '../ui/Avatar.tsx';

const ai = (key: string) => {
  const found = CHAT_AIS.find((a) => a.key === key);
  if (!found) throw new Error(`型号清单里没有 ${key}`);
  return found;
};

const MEMBERS = [ai('kimi'), ai('gpt'), ai('doubao')];

const Mention = ({ children }: { children: ReactNode }) => (
  <span className="rounded-full bg-accent-tint px-1.5 text-accent-ink">{children}</span>
);

type Line = { from: 'me'; text: ReactNode } | { from: string; text: ReactNode; file?: string };

const LINES: Line[] = [
  { from: 'me', text: '这周末想去杭州玩两天，帮我排个行程，预算两千以内。' },
  {
    from: 'kimi',
    text: (
      <>
        我来排路线。<Mention>@GPT</Mention> 看下周末天气，<Mention>@豆包</Mention>{' '}
        找几家西湖边评价好的小馆子。
      </>
    ),
  },
  { from: 'gpt', text: '周六晴，周日下午有雨。灵隐寺放周六上午，人少。' },
  { from: 'doubao', text: '找到四家，人均八十左右，都在北山街一带。' },
  {
    from: 'kimi',
    text: '排好了，周日下午换成室内的浙江省博物馆。',
    file: '杭州两日游.pdf',
  },
];

/** 第 i 条消息出现前等多久 */
const delay = (i: number) => ({ animationDelay: `${0.35 + i * 0.55}s` });
const RISE = 'motion-safe:animate-[oasis-rise_0.5s_ease-out_both]';

function Message({ line, index }: { line: Line; index: number }) {
  if (line.from === 'me')
    return (
      <div className={`flex justify-end ${RISE}`} style={delay(index)}>
        <p className="bubble-out m-0 max-w-[78%] bg-solid px-4 py-2.5 text-[14px] leading-[1.6] text-on-solid">
          {line.text}
        </p>
      </div>
    );
  const who = ai(line.from);
  return (
    <div className={`flex items-end gap-2.5 ${RISE}`} style={delay(index)}>
      <AiAvatar mono={who.mono} glow={who.glow} size={32} />
      <div className="flex max-w-[78%] flex-col gap-1">
        <span className="pl-1 text-[11.5px] text-ink-muted">{who.name}</span>
        <div className="bubble-in flex flex-col gap-2 bg-bubble px-4 py-2.5 text-[14px] leading-[1.6] text-ink shadow-bubble-edge">
          <p className="m-0">{line.text}</p>
          {'file' in line && line.file && (
            <span className="flex w-fit items-center gap-2 rounded-item bg-glass-active px-3 py-2 text-[13px] shadow-edge-strong">
              <FileText size={16} aria-hidden="true" />
              {line.file}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

export function GroupPreview() {
  return (
    <figure
      data-light="coral"
      aria-label="示例：你和 Kimi、GPT、豆包在一个群里商量周末去杭州，Kimi 分好工，最后交出一份行程"
      className="oasis-room relative m-0 overflow-hidden rounded-window shadow-site"
    >
      <div aria-hidden="true" className="glass-window m-3 flex flex-col rounded-window">
        <header className="flex flex-col border-b border-hairline px-6 py-4">
          <span className="text-[15px] font-medium text-ink">周末去杭州</span>
          <span className="text-[12px] text-ink-muted">
            你、{MEMBERS.map((m) => m.name).join('、')}
          </span>
        </header>
        <div className="flex flex-col gap-4 px-6 py-5">
          {LINES.map((line, i) => (
            <Message key={i} line={line} index={i} />
          ))}
        </div>
        <div className="mx-5 mb-5 flex items-center gap-3 rounded-full glass-composer py-2 pl-5 pr-2">
          <span className="flex-1 text-[13.5px] text-ink-muted">说点什么，@ 谁就叫谁</span>
          <span className="flex size-9 items-center justify-center rounded-full bg-accent text-on-accent shadow-accent">
            <ArrowUp size={18} />
          </span>
        </div>
      </div>
    </figure>
  );
}
