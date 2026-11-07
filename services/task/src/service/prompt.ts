// 拼交给节点的说明（ADR 0004 §6）：任务 → 角色和目标 → 上游交来的东西 → 用户追加的要求 → 少量必要的说明。
// 只讲事实和交付要求，怎么做由节点里的模型自己判断（用户 2026-11-07：规则只留最重要的）。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { TaskSheet } from '@oasis/contracts/task';

interface UpstreamInput {
  key: string;
  title: string;
  summary: string | null;
  outputs: RunOutputFile[];
}

/** 一个节点的上下文（几种说明共用） */
export interface NodeContext {
  brief: string;
  sheet?: TaskSheet;
  title: string;
  role: string;
  goal: string;
  upstream: UpstreamInput[];
  userNotes: string[];
  /** 分给这个节点的外部工具（工具名） */
  tools: string[];
  /** 用户给的素材在沙箱里的路径（materials/…） */
  materials: string[];
  deliver?: string[];
  /** 交付前的自查清单（方案里的 checks；ADR 0017：节点自己对照，系统不再逐条打分） */
  checks?: string[];
  /** 修改时重新做：上一版这个节点交出的文件在 in/_previous/（ADR 0022） */
  previous?: boolean;
  /** 预算和进度（ADR 0016 §5）：只是参考，节点自己决定做几版、什么时候停手 */
  budget?: {
    /** 分给这个节点的份额；旧节点没有 */
    nodeMicro?: number;
    /** 用户选的整个任务预算；旧任务没有 */
    taskMicro?: number;
    /** 报价时估的整个任务用时（分钟） */
    taskMinutes?: number;
    spentMicro: number;
    elapsedMinutes: number;
  };
}

/** 修改时「重新做」的节点：上一版它交出的文件放在 in/ 下的这个目录（ADR 0022） */
export const PREVIOUS_DIR = '_previous';

export interface Speech {
  round: number;
  name: string;
  text: string;
}

const NO_QUESTIONS = '- 没有人会回答问题，拿不准的自己决定。';

function context(c: NodeContext, goalLabel: string): string[] {
  const parts = [`【整个任务】\n${c.brief}`];
  if (c.sheet) parts.push(`【用户确认的任务单】\n${JSON.stringify(c.sheet)}`);
  if (c.role.trim()) parts.push(`【你的角色】\n${c.role}`);
  parts.push(`【${goalLabel}】\n${c.goal}`);
  if (c.deliver !== undefined)
    parts.push(
      `【要交出的文件】\n${c.deliver.map((p) => `- out/${p}`).join('\n')}\n（* 只匹配一层，** 递归；草稿放别的目录）`,
    );
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
  if (c.previous) {
    parts.push(
      `【上一版】用户看过上一版成果要修改，这一步上一版交出的文件在 in/${PREVIOUS_DIR}/，在它的基础上改，没要求改的地方保持不变。`,
    );
  }
  if (c.materials.length > 0) {
    parts.push(
      `【用户给的素材】需要时打开参考或直接使用：\n${c.materials.map((p) => `- ${p}`).join('\n')}`,
    );
  }
  if (c.userNotes.length > 0) {
    parts.push(`【用户追加的要求】\n${c.userNotes.map((n) => `- ${n}`).join('\n')}`);
  }
  if (c.checks?.length) {
    parts.push(`【交付前看一眼】\n${c.checks.map((t) => `- ${t}`).join('\n')}`);
  }
  return parts;
}

const usd = (micro: number) => `$${(micro / 1_000_000).toFixed(2)}`;

/** 预算和进度：只给事实，节点自己掂量 */
function budgetPart(b: NonNullable<NodeContext['budget']>): string {
  const facts = [
    ...(b.nodeMicro ? [`这一步分到约 ${usd(b.nodeMicro)}`] : []),
    ...(b.taskMicro
      ? [`整个任务预算约 ${usd(b.taskMicro)}，已花 ${usd(b.spentMicro)}`]
      : [`整个任务已花 ${usd(b.spentMicro)}`]),
    `已经跑了 ${b.elapsedMinutes} 分钟${b.taskMinutes ? `，预计总用时约 ${b.taskMinutes} 分钟` : ''}`,
  ];
  return `【预算和用时】${facts.join('；')}。预算是参考不是上限，但花的是用户的钱、用户也在等：够用就交。`;
}

const transcriptText = (speeches: Speech[]) =>
  speeches.map((s) => `- 第 ${s.round} 轮 ${s.name}：${s.text}`).join('\n');

/** 节点能用的外部工具：都通过沙箱里的 oasis-tool 命令调用，用法让 AI 自己查 */
function toolsPart(tools: string[]): string {
  return [
    '【工具】',
    ...(tools.length ? [`- 规划建议用：${tools.join('、')}（不限于这些）。`] : []),
    '- `oasis-tool list` 列出全部工具、用法和单价；长任务没等到就按提示 `oasis-tool wait <任务号>`。',
    '- 交互网页、3D 预览等的文件格式见 in/.oasis-formats.json。沙箱里没有浏览器，网页用 `oasis-tool app.check --dir out/<应用目录>` 在独立浏览器里跑。',
  ].join('\n');
}

/** 干活节点 */
export function workPrompt(c: NodeContext): string {
  return [
    `你是 Oasis 工作流里的一个节点，负责「${c.title}」。`,
    ...context(c, '你要做的事'),
    ...(c.budget ? [budgetPart(c.budget)] : []),
    toolsPart(c.tools),
    [
      '【说明】',
      '- 成果写到 out/（可建子目录），下游和用户只看得到 out/。',
      '- 这是持续目标：要交的文件都做好了就 update_goal complete 结束。',
      NO_QUESTIONS,
      '- 最后用一两句话说明交付了什么。',
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
    '直接在你最后一条消息里说出你的发言，不用写文件，也不用调工具，除非你需要看 in/ 里的材料。',
  ].join('');
  if (input.round === 1) {
    return [
      `你是「${input.name}」，正在参加一场讨论：「${input.context.title}」。`,
      ...(input.stance.trim() ? [`【你的立场】\n${input.stance}`] : []),
      ...context(input.context, '讨论的题目'),
      `【说明】\n${NO_QUESTIONS}\n- ${ask}`,
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
      '【说明】',
      '- 把结论写到 out/（例如 out/讨论结论.md）：共识、分歧、建议怎么做。',
      NO_QUESTIONS,
      '- 做完后用一两句话说明结论。',
    ].join('\n'),
  ].join('\n\n');
}

/** 停止后继续：接着原会话做完；停下期间用户追加的要求一起带上 */
export function resumePrompt(newNotes: string[], interrupted = false): string {
  const notes = newNotes.length
    ? `\n\n【用户新追加的要求】\n${newNotes.map((n) => `- ${n}`).join('\n')}`
    : '';
  return `${interrupted ? '上次执行中断了，已有会话和产物已恢复。先核对实际状态，避免重复已完成的操作。' : '你刚才被用户停下了。'}请接着把没做完的做完，已经做好的不用重做；成果照样写到 out/。${notes}`;
}

/**
 * 用户看过成果后的修改（ADR 0012，2026-11-05 改为在原任务里接着原会话改）：
 * 交付节点和它的下游都接着自己上次的会话，只改修改意见涉及的地方。
 */
export function revisionPrompt(request: string, plan?: string): string {
  return [
    '用户看了成果，提出修改意见（批注截图在 materials/ 下，编号与批注一致）：',
    '',
    request,
    '',
    ...(plan ? ['AI 团队给你这一步的安排：', plan, ''] : []),
    '在上次成果的基础上改：只动意见涉及的地方；上游有更新以 in/ 里最新的为准；和你无关的意见不用管。改完在 out/ 交齐全部成果（没改的也要在），update_goal complete，用一两句话说明改了什么。',
  ].join('\n');
}

export function reworkPrompt(unmet: string[]): string {
  return [
    '系统检查发现这些问题：',
    ...unmet.map((u) => `- ${u}`),
    '',
    '只修这些，改完就结束（系统会再查一次），用一两句话说明改了什么。',
  ].join('\n');
}
