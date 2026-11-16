// 任务名（画布上任务框的标题、进度页的标题、成果在电脑上的文件夹名）：用户确认的任务单的标题；没有
// 任务单就是用户那句要求的开头。用户是在确认任务单、答 AI 的题时，往回找那句要求。
import { PlanBlock } from '@oasis/contracts/conversation';

/** 一条消息里要用的：谁说的、哪种消息（文字、任务卡、开新话题的分隔）、说了什么 */
export interface Said {
  author: 'user' | 'ai';
  kind: string;
  content: string;
}

/** AI 话里的卡片（写法和网页上的 blocks.ts 一样；整块写在一行里也认） */
const FENCE = /```oasis-(questions|plan)\b([\s\S]*?)```/g;
/** 代码块里的 JSON：从第一个 { 到最后一个 }；不是 JSON 就抛错 */
export const fenceJson = (body: string): unknown =>
  JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1));
/** 确认任务单、答题这种短回复；再长就当是一句新的要求 */
const SHORT_REPLY = 20;
/** 网页上答题发来的：一题一行「1. 题目——答案」 */
const ANSWERS = /^\d+\. .+——/m;
const TITLE_MAX = 30;
/** 往回找几段 */
const MAX_HOPS = 5;

/** AI 这段话里最后一份任务单的标题，有没有出题 */
function cardsOf(text: string): { plan?: string; questions: boolean } {
  let plan: string | undefined;
  let questions = false;
  for (const [, kind, body] of text.matchAll(FENCE)) {
    if (kind === 'questions') {
      questions = true;
      continue;
    }
    try {
      const parsed = PlanBlock.safeParse(fenceJson(body!));
      if (parsed.success) plan = parsed.data.title;
    } catch {
      // 不是 JSON：当普通文字
    }
  }
  return { plan, questions };
}

/** 一句要求的开头：第一行，到第一个句号、问号、冒号这类为止，太长截短 */
export function opening(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  const sentence = line.split(/[。！？!?；;：:]/)[0]?.trim() || line;
  return sentence.length > TITLE_MAX ? `${sentence.slice(0, TITLE_MAX)}…` : sentence;
}

/**
 * 这一轮的任务名。before：这一轮之前的消息（按先后），text：这一轮用户说的话。
 * 上一段 AI 的话里有任务单、用户这句是短回复（确认）：用任务单的标题；有题目、用户这句是答题：
 * 要求在那段话前面，接着往回找；都不是：就是这句要求的开头。开了新话题就不再往前找。
 */
export function taskTitle(before: Said[], text: string): string {
  let request = text;
  let end = before.length;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    let ai = end - 1;
    while (ai >= 0 && !(before[ai]!.author === 'ai' && before[ai]!.kind === 'text')) {
      if (before[ai]!.kind === 'topic') return opening(request) || '未命名任务';
      ai -= 1;
    }
    if (ai < 0) break;
    const cards = cardsOf(before[ai]!.content);
    const reply = request.trim().length <= SHORT_REPLY || ANSWERS.test(request);
    if (cards.plan && reply) return cards.plan;
    if (!cards.questions || !reply) break;
    let first = ai;
    while (first > 0 && before[first - 1]!.author === 'user' && before[first - 1]!.kind === 'text')
      first -= 1;
    if (first === ai) break;
    request = before
      .slice(first, ai)
      .map((said) => said.content)
      .join('\n');
    end = first;
  }
  return opening(request) || '未命名任务';
}
