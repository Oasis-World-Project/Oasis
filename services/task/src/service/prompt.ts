// 拼交给节点的说明（ADR 0004 §6）：任务 → 角色和目标 → 上游交来的东西 → 用户追加的要求 → 固定规则。
// 讨论节点的发言、汇总，以及关卡退回后的修改，都在这一份上下文的基础上拼。
import type { RunOutputFile } from '@oasis/contracts/harness';

interface UpstreamInput {
  key: string;
  title: string;
  summary: string | null;
  outputs: RunOutputFile[];
}

/** 一个节点的上下文（几种说明共用） */
export interface NodeContext {
  brief: string;
  title: string;
  role: string;
  goal: string;
  upstream: UpstreamInput[];
  userNotes: string[];
  /** 分给这个节点的外部工具（工具名） */
  tools: string[];
}

export interface Speech {
  round: number;
  name: string;
  text: string;
}

const NO_QUESTIONS = '- 不要向用户提问，也不会有人回答；拿不准的地方自己做合理的决定。';

function context(c: NodeContext, goalLabel: string): string[] {
  const parts = [`【整个任务】\n${c.brief}`];
  if (c.role.trim()) parts.push(`【你的角色】\n${c.role}`);
  parts.push(`【${goalLabel}】\n${c.goal}`);
  if (c.upstream.length > 0) {
    const lines = c.upstream.map((u) => {
      const files = u.outputs.length
        ? u.outputs.map((f) => `in/${u.key}/${f.path}`).join('、')
        : '（没有文件）';
      const said = u.summary ? `；它最后说：${u.summary}` : '';
      return `- 「${u.title}」交来的文件：${files}${said}`;
    });
    parts.push(`【上游交给你的东西】\n${lines.join('\n')}`);
  }
  if (c.userNotes.length > 0) {
    parts.push(`【用户追加的要求】\n${c.userNotes.map((n) => `- ${n}`).join('\n')}`);
  }
  return parts;
}

const transcriptText = (speeches: Speech[]) =>
  speeches.map((s) => `- 第 ${s.round} 轮 ${s.name}：${s.text}`).join('\n');

/** 节点能用的外部工具：都通过沙箱里的 oasis-tool 命令调用，用法让 AI 自己查 */
function toolsPart(tools: string[]): string[] {
  if (tools.length === 0) return [];
  return [
    [
      '【可以用的工具】',
      `- 这次分给你的：${tools.join('、')}。`,
      '- 都用 oasis-tool 命令调用。先运行 `oasis-tool list` 看每个工具的用法，再按用法调用，例如 `oasis-tool image.generate --prompt "……" --out out/图.png`。',
      '- 工具按次收费，记在任务花费里：想清楚再调，不要反复试。',
      '- 要等很久的工具（视频）命令会自己等；没等到时按它的提示运行 `oasis-tool wait <任务号>`。',
    ].join('\n'),
  ];
}

/** 干活节点 */
export function workPrompt(c: NodeContext): string {
  return [
    `你是 Oasis 工作流里的一个节点，负责「${c.title}」。`,
    ...context(c, '你要做的事'),
    ...toolsPart(c.tools),
    [
      '【规则】',
      '- 把成果文件写到 out/ 目录（可以建子目录），下游节点和用户只看得到 out/ 里的东西。',
      NO_QUESTIONS,
      '- 做完后用一两句话说明你交付了什么、做了哪些自己的决定。',
    ].join('\n'),
  ].join('\n\n');
}

/** 讨论节点：某位参与者某一轮的发言。第一轮带完整上下文；之后接着自己的会话，只给上一轮别人说了什么 */
export function speechPrompt(input: {
  context: NodeContext;
  name: string;
  stance: string;
  round: number;
  rounds: number;
  others: Speech[];
  newNotes: string[];
}): string {
  const ask = [
    `这是第 ${input.round} 轮（共 ${input.rounds} 轮）。`,
    '直接在你最后一条消息里说出你的发言（300 字以内），不用写文件，也不用调工具，除非你需要看 in/ 里的材料。',
  ].join('');
  if (input.round === 1) {
    return [
      `你是「${input.name}」，正在参加一场讨论：「${input.context.title}」。`,
      ...(input.stance.trim() ? [`【你的立场】\n${input.stance}`] : []),
      ...context(input.context, '讨论的题目'),
      `【规则】\n${NO_QUESTIONS}\n- ${ask}`,
    ].join('\n\n');
  }
  const notes = input.newNotes.length
    ? `\n\n【用户新追加的要求】\n${input.newNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  return `【上一轮其他人说了】\n${transcriptText(input.others)}${notes}\n\n${ask}请回应：同意什么、反对什么、还要补充什么。`;
}

/** 讨论节点：汇总者根据全部发言写出结论 */
export function summaryPrompt(input: { context: NodeContext; transcript: Speech[] }): string {
  return [
    `你负责汇总一场讨论：「${input.context.title}」。`,
    ...context(input.context, '讨论的题目'),
    `【讨论记录】\n${transcriptText(input.transcript)}`,
    [
      '【规则】',
      '- 把讨论结论写到 out/ 目录（例如 out/讨论结论.md）：大家同意的、还有分歧的、最后建议怎么做。',
      NO_QUESTIONS,
      '- 做完后用一两句话说明结论。',
    ].join('\n'),
  ].join('\n\n');
}

/** 停止后继续：接着原会话做完；停下期间用户追加的要求一起带上 */
export function resumePrompt(newNotes: string[]): string {
  const notes = newNotes.length
    ? `\n\n【用户新追加的要求】\n${newNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  return `你刚才被用户停下了。请接着把没做完的做完，已经做好的不用重做；成果照样写到 out/。${notes}`;
}

/** 关卡没过：接着原会话改一次 */
export function reworkPrompt(unmet: string[]): string {
  return [
    '交付前的检查发现以下地方还没满足：',
    ...unmet.map((u) => `- ${u}`),
    '',
    '请修改 out/ 里的成果，把这些地方补上。改完后用一两句话说明改了什么。',
  ].join('\n');
}
