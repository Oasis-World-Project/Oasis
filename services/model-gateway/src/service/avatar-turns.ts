// 数字人每一轮对话的提示组织（ADR 0013 §4）：LiveAvatar 发来对话历史，我们换上自己的系统提示
// （人设 + 口语规则 + 这一轮检索到的知识要点 + 转人工规则），再交给模型。都是纯函数，方便测试。
import type { AvatarKnowledgeItem, AvatarSpec } from '@oasis/contracts/avatar';
import type { ChatCompletionRequest } from '@oasis/contracts/model-gateway';

type Message = ChatCompletionRequest['messages'][number];

/** 知识要点总量不超过这么多字时全部放进提示；超过就只放检索到的前几条 */
const INLINE_ALL_CHARS = 3000;
const TOP_K = 3;

const LANGUAGES: Record<string, string> = {
  zh: '中文',
  en: '英文',
  ja: '日文',
  ko: '韩文',
};

/** 去掉空白和标点，只比较文字本身 */
const normalize = (text: string) => text.replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

/** 字符二元组（中文按字，英文数字按词） */
function grams(text: string): Set<string> {
  const out = new Set<string>();
  const n = normalize(text);
  for (let i = 0; i < n.length - 1; i++) out.add(n.slice(i, i + 2));
  for (const word of text.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) out.add(word);
  return out;
}

function score(query: Set<string>, item: AvatarKnowledgeItem): number {
  const title = grams(item.title);
  const body = grams(item.content);
  let s = 0;
  for (const g of query) s += (title.has(g) ? 2 : 0) + (body.has(g) ? 1 : 0);
  return s;
}

/** 这一轮要放进提示的知识要点，以及其中真正和问题相关的（作为引用来源记下来） */
export function retrieve(
  knowledge: AvatarKnowledgeItem[],
  question: string,
): { included: AvatarKnowledgeItem[]; relevant: AvatarKnowledgeItem[] } {
  const query = grams(question);
  const scored = knowledge
    .map((item) => ({ item, s: score(query, item) }))
    .sort((a, b) => b.s - a.s);
  // 只有一两个字碰巧相同（如「房间」）不算相关：至少两处重合，且不低于最高分的一半
  const top = scored[0]?.s ?? 0;
  const relevant = scored.filter((x) => x.s >= Math.max(2, top / 2)).map((x) => x.item);
  const total = knowledge.reduce((sum, item) => sum + item.content.length, 0);
  const included = total <= INLINE_ALL_CHARS ? knowledge : relevant.slice(0, TOP_K);
  return { included, relevant: relevant.filter((item) => included.includes(item)).slice(0, TOP_K) };
}

function text(message: Message | undefined): string {
  if (!message) return '';
  const { content } = message as { content?: unknown };
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part: unknown) =>
        part && typeof part === 'object' && 'text' in part ? String(part.text) : '',
      )
      .join('');
  }
  return '';
}

function systemPrompt(spec: AvatarSpec, knowledge: AvatarKnowledgeItem[]): string {
  const language = LANGUAGES[spec.language] ?? spec.language;
  const parts = [
    spec.prompt,
    `说话规则：你在用语音和人实时对话，用${language}回答。每次 1 到 3 句、不超过 80 个字；不要用列表、标题、表情符号、网址或 Markdown；数字和英文写成念得出来的样子。`,
  ];
  if (knowledge.length > 0) {
    parts.push(
      [
        '可以参考的资料（事实性问题只按这些资料回答；资料里没有的就说不清楚，不要编）：',
        ...knowledge.map((item, i) => `[${i + 1}] ${item.title}：${item.content}`),
      ].join('\n'),
    );
  }
  if (spec.handoff) {
    parts.push(
      `转人工：${spec.handoff.when}。遇到这种情况，只说这一句：「${spec.handoff.message}」`,
    );
  }
  return parts.join('\n\n');
}

/** 换上我们的系统提示；保留 LiveAvatar 发来的对话历史（去掉它的系统提示） */
export function planTurn(spec: AvatarSpec, messages: Message[]) {
  const history = messages.filter((m) => m.role !== 'system');
  const question = text([...history].reverse().find((m) => m.role === 'user'));
  const { included, relevant } = retrieve(spec.knowledge, question);
  return {
    question,
    sources: relevant.map((item) => item.title),
    messages: [{ role: 'system', content: systemPrompt(spec, included) } as Message, ...history],
  };
}

/** 回答里说了转人工的话（忽略标点空白，比前 10 个字） */
export function saidHandoff(spec: AvatarSpec, answer: string): boolean {
  if (!spec.handoff) return false;
  const key = normalize(spec.handoff.message).slice(0, 10);
  return key.length > 0 && normalize(answer).includes(key);
}

/** 从转发的 SSE 里读出回答文字和第一个字出现的时间 */
export function createAnswerSniffer(clock: () => number = Date.now) {
  let buffer = '';
  let answer = '';
  let firstAt: number | undefined;
  return {
    push(chunk: string) {
      buffer += chunk;
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        for (const line of event.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          if (data === '[DONE]') continue;
          try {
            const parsed = JSON.parse(data) as { choices?: { delta?: { content?: unknown } }[] };
            const piece = parsed.choices?.[0]?.delta?.content;
            if (typeof piece === 'string' && piece.length > 0) {
              firstAt ??= clock();
              answer += piece;
            }
          } catch {
            // 不是 JSON 的事件不影响记录
          }
        }
      }
    },
    answer: () => answer,
    firstAt: () => firstAt,
  };
}
