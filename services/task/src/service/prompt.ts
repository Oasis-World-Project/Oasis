// 拼交给节点的说明（ADR 0004 §6）：任务 → 角色和目标 → 上游交来的东西 → 用户追加的要求 → 少量必要的说明。
// 只讲事实和交付要求，怎么做由节点里的模型自己判断（用户 2026-11-07：规则只留最重要的）。
// 这里是各种节点共用的部分；某种节点自己的说明（干活、讨论发言、汇总）在 kinds/ 里它的插件中。
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

export const NO_QUESTIONS = '- 没有人会回答问题，拿不准的自己决定。';

/** 说明里的上下文几段：任务、任务单、角色、目标（goalLabel 是这一段的标题）、要交的文件、上游、素材、追加要求、自查 */
export function contextParts(c: NodeContext, goalLabel: string): string[] {
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

/**
 * 接不上原会话（持久工作目录不在了）时重新做这一步：新会话里先给完整说明，再说清之前的进度在哪；
 * 原本要接着交代的话（关卡发现的问题、用户的修改意见）附在最后。
 */
export function redoPrompt(full: string, previous: boolean, followUp?: string): string {
  return [
    full,
    `【重新做】这一步原来的会话接不上了，这是一个新会话。${
      previous
        ? `这一步之前交出的文件在 in/${PREVIOUS_DIR}/，在它的基础上做，已经做好的不用重做。`
        : '之前的进度没有保存下来，从头做。'
    }`,
    ...(followUp ? [`【原本接着要你做的】\n${followUp}`] : []),
  ].join('\n\n');
}

export function reworkPrompt(unmet: string[]): string {
  return [
    '系统检查发现这些问题：',
    ...unmet.map((u) => `- ${u}`),
    '',
    '只修这些，改完就结束（系统会再查一次），用一两句话说明改了什么。',
  ].join('\n');
}
