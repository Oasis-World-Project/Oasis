// 对一个 AI 能做的事共用一套：问卷卡的回答、任务单的确认、「继续」都是往对话里发一句话。
// 它干活时发的话先排队，排着的可以「引导」（现在交给它）或删掉。怎么发见 group/ai-actions.ts。
import { createContext, useContext } from 'react';

export interface ChatActions {
  conversationId: string;
  /** 正在做的是哪个操作（如 'answer'）；没有为 null */
  busy: string | null;
  error: string | null;
  /** 有一轮在进行：再发的话先排队 */
  turnActive: boolean;
  /** 发一句话，可以带文件；返回是否发出去了（没发出去时原因在 error 里） */
  say: (name: string, content: string, attachments?: string[]) => Promise<boolean>;
  /** 「引导」：排着队的一句现在交给 AI */
  steer: (messageId: string) => Promise<void>;
  /** 从队里删掉一句；返回是否删掉了 */
  unqueue: (messageId: string) => Promise<boolean>;
  /** 停下正在进行的一轮（已经做出来的存下，说「继续」接着做） */
  stop: () => Promise<void>;
  /** 让输入框获得焦点，并换一句提示（如「说说要改哪里」） */
  focusComposer: (hint?: string) => void;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const actions = useContext(ChatActionsContext);
  if (!actions) throw new Error('useChatActions 只能在聊天页里用');
  return actions;
}
