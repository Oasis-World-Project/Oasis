// AI 说的话里的卡片：```oasis-questions 和 ```oasis-plan 代码块（写法见 harness 给 AI 的说明）；
// 群里的 ```oasis-assign（分工单）不在话里显示，```oasis-decline（不接）显示成一句话；
// ```oasis-deliver（AI 写明主成果是哪个文件，记在任务上）不在话里显示。
// 格式不对的代码块照原样当文字显示，不丢内容。
import {
  AssignBlock,
  DeclineBlock,
  DeliverBlock,
  PlanBlock,
  QuestionsBlock,
} from '@oasis/contracts/conversation';

export type TextBlock =
  | { kind: 'text'; text: string }
  | { kind: 'questions'; data: QuestionsBlock }
  | { kind: 'plan'; data: PlanBlock };

// 有的模型把整个代码块写在一行里（```oasis-assign {…} ```）：不要求换行，取里面从第一个 { 到最后一个 }
const FENCE = /```oasis-(questions|plan|assign|decline|deliver)\b([\s\S]*?)```/g;

function card(kind: string, body: string): TextBlock | null {
  let data: unknown;
  try {
    data = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
  } catch {
    return null;
  }
  // 群里的分工单另有一张卡片（它是群里单独的一条消息），话里的这一块不再显示
  if (kind === 'assign')
    return AssignBlock.safeParse(data).success ? { kind: 'text', text: '' } : null;
  // 主成果记在任务上（任务里它排在最前面），话里的这一块不显示
  if (kind === 'deliver')
    return DeliverBlock.safeParse(data).success ? { kind: 'text', text: '' } : null;
  if (kind === 'decline') {
    const parsed = DeclineBlock.safeParse(data);
    if (!parsed.success) return null;
    const { reason } = parsed.data;
    return { kind: 'text', text: reason ? `这一项我不接：${reason}` : '这一项我不接。' };
  }
  if (kind === 'questions') {
    const parsed = QuestionsBlock.safeParse(data);
    return parsed.success ? { kind: 'questions', data: parsed.data } : null;
  }
  const parsed = PlanBlock.safeParse(data);
  return parsed.success ? { kind: 'plan', data: parsed.data } : null;
}

/** 去掉话里不显示的那几块（分工单、主成果），别的原样留着：过程里照原样列出 AI 的话时用 */
export const withoutHidden = (text: string) =>
  text
    .replace(FENCE, (block, kind: string, body: string) =>
      (kind === 'assign' || kind === 'deliver') && card(kind, body) ? '' : block,
    )
    .trim();

/** 把一段话拆成文字和卡片，按原来的顺序 */
export function splitBlocks(text: string): TextBlock[] {
  const blocks: TextBlock[] = [];
  let last = 0;
  const pushText = (part: string) => {
    if (part.trim()) blocks.push({ kind: 'text', text: part.trim() });
  };
  for (const match of text.matchAll(FENCE)) {
    const found = card(match[1]!, match[2]!);
    if (!found) continue;
    pushText(text.slice(last, match.index));
    if (found.kind === 'text') pushText(found.text);
    else blocks.push(found);
    last = match.index + match[0].length;
  }
  pushText(text.slice(last));
  return blocks;
}

/** 问卷的回答：一题一行，作为一条普通消息发给 AI */
export function answerText(block: QuestionsBlock, answers: Record<string, string>): string {
  return block.questions.map((q, i) => `${i + 1}. ${q.text}——${answers[q.id] ?? ''}`).join('\n');
}
