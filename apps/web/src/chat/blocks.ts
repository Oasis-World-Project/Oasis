// AI 说的话里的卡片：```oasis-questions 和 ```oasis-plan 代码块（写法见 harness 给 AI 的说明）。
// 格式不对的代码块照原样当文字显示，不丢内容。
import { PlanBlock, QuestionsBlock } from '@oasis/contracts/conversation';

export type TextBlock =
  | { kind: 'text'; text: string }
  | { kind: 'questions'; data: QuestionsBlock }
  | { kind: 'plan'; data: PlanBlock };

const FENCE = /```oasis-(questions|plan)[^\n]*\n([\s\S]*?)\n?```/g;

function card(kind: string, body: string): TextBlock | null {
  let data: unknown;
  try {
    data = JSON.parse(body);
  } catch {
    return null;
  }
  if (kind === 'questions') {
    const parsed = QuestionsBlock.safeParse(data);
    return parsed.success ? { kind: 'questions', data: parsed.data } : null;
  }
  const parsed = PlanBlock.safeParse(data);
  return parsed.success ? { kind: 'plan', data: parsed.data } : null;
}

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
    blocks.push(found);
    last = match.index + match[0].length;
  }
  pushText(text.slice(last));
  return blocks;
}

/** 问卷的回答：一题一行，作为一条普通消息发给 AI */
export function answerText(block: QuestionsBlock, answers: Record<string, string>): string {
  return block.questions.map((q, i) => `${i + 1}. ${q.text}——${answers[q.id] ?? ''}`).join('\n');
}
