// 拼交给节点的说明（ADR 0004 §6）：任务 → 角色和目标 → 上游交来的东西 → 用户追加的要求 → 固定规则。
import type { RunOutputFile } from '@oasis/contracts/harness';

export interface UpstreamInput {
  key: string;
  title: string;
  summary: string | null;
  outputs: RunOutputFile[];
}

export function buildPrompt(input: {
  brief: string;
  title: string;
  role: string;
  goal: string;
  upstream: UpstreamInput[];
  userNotes: string[];
}): string {
  const parts = [
    `你是 Oasis 工作流里的一个节点，负责「${input.title}」。`,
    `【整个任务】\n${input.brief}`,
  ];
  if (input.role.trim()) parts.push(`【你的角色】\n${input.role}`);
  parts.push(`【你要做的事】\n${input.goal}`);
  if (input.upstream.length > 0) {
    const lines = input.upstream.map((u) => {
      const files = u.outputs.length
        ? u.outputs.map((f) => `in/${u.key}/${f.path}`).join('、')
        : '（没有文件）';
      const said = u.summary ? `；它最后说：${u.summary}` : '';
      return `- 「${u.title}」交来的文件：${files}${said}`;
    });
    parts.push(`【上游交给你的东西】\n${lines.join('\n')}`);
  }
  if (input.userNotes.length > 0) {
    parts.push(`【用户对你追加的要求】\n${input.userNotes.map((n) => `- ${n}`).join('\n')}`);
  }
  parts.push(
    [
      '【规则】',
      '- 把成果文件写到 out/ 目录（可以建子目录），下游节点和用户只看得到 out/ 里的东西。',
      '- 不要向用户提问，也不会有人回答；拿不准的地方自己做合理的决定。',
      '- 做完后用一两句话说明你交付了什么、做了哪些自己的决定。',
    ].join('\n'),
  );
  return parts.join('\n\n');
}
