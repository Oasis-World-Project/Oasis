// 接需求（ADR 0005 §3）的纯函数部分：给私聊里的 AI 的说明、解析它按 JSON 给出的回答、把卡片写成文字。
// 这个 AI 只负责读懂需求：问普通人听得懂的问题、写任务单；团队、模型和工具由后台的规划员决定。
import { AUTO_ANSWER, IntakeQuestion } from '@oasis/contracts/conversation';
import type { ChatMessage } from '@oasis/contracts/model-gateway';
import { TaskSheet } from '@oasis/contracts/task';
import { z } from 'zod';
import type { IntakeTurn } from '../repo/schema.ts';

const Intro = z.string().trim().max(300).default('');

/** AI 的三种回答：再问几道题 / 给出任务单 / 用户不想做了 */
const IntakeReply = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('questions'),
    intro: Intro,
    questions: z.array(IntakeQuestion).min(1).max(4),
  }),
  z.object({ type: z.literal('sheet'), intro: Intro, sheet: TaskSheet }),
  z.object({ type: z.literal('cancel'), intro: Intro }),
]);
export type IntakeReply = z.infer<typeof IntakeReply>;

export interface IntakeState {
  /** 这个 AI 的名字（如 Claude） */
  name: string;
  request: string;
  context: { role: 'user' | 'assistant'; content: string }[];
  turns: IntakeTurn[];
  /** 还能再问几轮；0 = 必须给出任务单 */
  roundsLeft: number;
  /** 用户点了「直接开始」 */
  skipped: boolean;
}

function system(name: string): string {
  return `你是用户在 Oasis 里私聊的 AI「${name}」。用户想让 AI 团队帮忙做一件要交付成果的事，你负责把需求问清楚，写成任务单。团队怎么分工、用什么模型和工具由后台决定，你不用管，也不要承诺。

规则：
- 只问普通人听得懂的需求问题：给谁看、用在哪、什么风格、多长多少、必须包含什么、有没有素材或限制。技术问题（文件格式细节、工具、实现方式）你自己定，写进任务单的 assumptions。
- 每次最多 4 道选择题，每题 2–5 个选项，标出你推荐的默认项（default）。不要列「你看着办」，界面会自带；用户回答 ${AUTO_ANSWER} 就是「你看着办」，按你推荐的来。
- 已经清楚的不要再问，能合理默认的也不要问；信息够了就直接给任务单。宁可少问。
- 用户明确说不做了、只是随便聊聊，就回答 cancel。
- 只输出一个 JSON 对象，不要任何别的文字，不要代码块。

三种回答：
{"type":"questions","intro":"一句话开场","questions":[{"id":"q1","text":"问题","options":[{"id":"a","label":"选项"},{"id":"b","label":"选项"}],"default":"a"}]}
{"type":"sheet","intro":"一句话说明","sheet":{"title":"不超过 60 字","deliverables":[{"name":"交付物名称","form":"形式，如 Markdown 文档、PNG 图片"}],"criteria":["怎么算做好，普通话、能检查，1–8 条"],"style":["风格与限制"],"budgetMicro":null,"assumptions":["你自己定的技术假设"],"materials":[]}}
{"type":"cancel","intro":"一句话回应"}

说明：题目 id 用 q1、q2…，选项 id 用 a–e。budgetMicro 只有用户明确说了花费上限才填，单位是百万分之一美元（1 美元 = 1000000），否则填 null。`;
}

function describeTurn(turn: IntakeTurn): string {
  if (turn.kind === 'user') return `用户说：${turn.text}`;
  if (turn.kind === 'sheet') return `你给出的任务单：${JSON.stringify(turn.sheet)}`;
  const lines = turn.questions.map((q) => {
    const answer = turn.answers?.[q.id];
    const label =
      answer === undefined
        ? turn.skipped
          ? '没答（按默认）'
          : '没答'
        : answer === AUTO_ANSWER
          ? '你看着办'
          : (q.options.find((o) => o.id === answer)?.label ?? answer);
    return `- ${q.text} → ${label}`;
  });
  return `第 ${turn.round} 轮你问的问题和用户的回答：\n${lines.join('\n')}`;
}

/** 交给模型的消息 */
export function intakeMessages(state: IntakeState): ChatMessage[] {
  const parts = [`【用户的需求】\n${state.request}`];
  if (state.context.length > 0) {
    const chat = state.context.map((m) => `${m.role === 'user' ? '用户' : '你'}：${m.content}`);
    parts.push(`【开始前的聊天】\n${chat.join('\n')}`);
  }
  if (state.turns.length > 0)
    parts.push(`【接需求的过程】\n${state.turns.map(describeTurn).join('\n\n')}`);
  const lastSheet = state.turns.some((t) => t.kind === 'sheet');
  parts.push(
    state.skipped
      ? '【现在】用户点了「直接开始」：没答的都按默认，直接给出任务单。'
      : state.roundsLeft <= 0
        ? '【现在】不能再问了，请直接给出任务单。'
        : lastSheet
          ? '【现在】用户对上一版任务单提了意见：改出新的任务单（必要时也可以再问，但尽量不问）。'
          : `【现在】还可以再问 ${state.roundsLeft} 轮。信息够了就给任务单。`,
  );
  return [
    { role: 'system', content: system(state.name) },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** 从模型的回答里取出 JSON 并校验；不合格时抛出带原因的错误（原因会交回给模型重写） */
export function parseIntakeReply(text: string, mustSheet: boolean): IntakeReply {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('回答里没有 JSON 对象');
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new Error('JSON 格式不对');
  }
  const parsed = IntakeReply.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((i) => `${i.path.join('.')}：${i.message}`);
    throw new Error(`字段不对：${issues.join('；')}`);
  }
  if (mustSheet && parsed.data.type === 'questions')
    throw new Error('现在不能再问了，必须给出任务单');
  const ids = parsed.data.type === 'questions' ? parsed.data.questions.map((q) => q.id) : [];
  if (new Set(ids).size !== ids.length) throw new Error('题目 id 重复');
  return parsed.data;
}

/** 问题卡写成文字（只显示文字的地方用，也是之后聊天历史里的样子） */
export function questionsText(intro: string, questions: IntakeQuestion[]): string {
  const lines = questions.map((q, i) => {
    const options = q.options
      .map((o) => `${o.label}${o.id === q.default ? '（推荐）' : ''}`)
      .join(' / ');
    return `${i + 1}. ${q.text}：${options} / 你看着办`;
  });
  return [intro || '先确认几件事：', ...lines].join('\n');
}

/** 任务单写成文字；也是交给 task 的任务说明 */
export function sheetText(sheet: TaskSheet): string {
  const list = (items: string[]) => items.map((x) => `- ${x}`).join('\n');
  const parts = [
    `任务：${sheet.title}`,
    `要交付：\n${list(sheet.deliverables.map((d) => `${d.name}（${d.form}）`))}`,
    `怎么算做好：\n${list(sheet.criteria)}`,
  ];
  if (sheet.style.length > 0) parts.push(`风格与限制：\n${list(sheet.style)}`);
  if (sheet.budgetMicro !== null) {
    parts.push(`花费上限：$${(sheet.budgetMicro / 1_000_000).toFixed(2)}`);
  }
  if (sheet.assumptions.length > 0) parts.push(`AI 自己定的事：\n${list(sheet.assumptions)}`);
  if (sheet.materials.length > 0) parts.push(`素材：\n${list(sheet.materials)}`);
  return parts.join('\n\n');
}
