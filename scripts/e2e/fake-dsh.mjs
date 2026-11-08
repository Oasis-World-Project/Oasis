// 假供应商读懂 dsh 发来的对话：平台的几种提示、按提示切段、写文件的命令、规划员提示里的模型和任务单。

/** 平台发给 dsh 的几种提示（task 的 prompt.ts、planner.ts、harness 的接管提示）：每种开启一段 */
const PROMPTS = [
  ['plan', '你是 Oasis 的规划员。用户确认了下面的任务单'],
  ['replan', '你是 Oasis 的规划员。用户看了上一版成果'],
  ['planfix', '你写的 out/plan.json 有问题'],
  ['work', '你是 Oasis 工作流里的一个节点'],
  ['resume', '你刚才被用户停下了'],
  ['resume', '上次执行中断了，已有会话和产物已恢复'],
  ['recover', '服务连接中断后已恢复原工作目录和原会话'],
  ['revision', '用户看了成果，提出修改意见'],
  ['rework', '系统检查发现这些问题：'],
];
export const GOAL_TOOLS = new Set(['get_goal', 'update_goal', 'create_goal']);
/** 假型号的输出上限：model-gateway 应把 dsh 要的上限压到它以内 */
export const MODEL_MAX_TOKENS = 65_536;

export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('')
      : '';

/** 一条消息里的每段文字 */
const blocksOf = (content) =>
  typeof content === 'string'
    ? [content]
    : Array.isArray(content)
      ? content.filter((b) => b?.type === 'text').map((b) => b.text)
      : [];

/**
 * 把 dsh 发来的对话按平台提示切段：每段对应一次运行（开跑、继续、修复、修改、接管）里的往来。
 * 只认以提示开头的那段文字：持续目标的续跑消息会整段引用目标（也就是开跑提示），不算新的一段。
 */
export function segmentsOf(messages) {
  const segments = [];
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'user') {
      const blocks = blocksOf(message.content);
      const text = blocks.join('');
      const found = PROMPTS.find(([, sign]) => blocks.some((b) => b.trimStart().startsWith(sign)));
      if (found) segments.push({ kind: found[0], text, calls: [], notices: [] });
      else segments.at(-1)?.notices.push(text);
    } else if (message.role === 'assistant') {
      for (const call of message.tool_calls ?? []) {
        let args = {};
        try {
          args = JSON.parse(call.function?.arguments || '{}');
        } catch {
          // 参数不是 JSON：照样记下这次调用
        }
        const entry = { id: call.id, name: call.function?.name, args, result: undefined };
        calls.set(call.id, entry);
        segments.at(-1)?.calls.push(entry);
      }
    } else if (message.role === 'tool') {
      const entry = calls.get(message.tool_call_id);
      if (entry) entry.result = textOf(message.content);
    }
  }
  return segments;
}

/** 写文件的 bash 命令：内容走 base64，路径里可以有中文和空格 */
export function writeFiles(files) {
  const parts = [];
  for (const [file, content] of Object.entries(files)) {
    const dir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '';
    const b64 = Buffer.from(content).toString('base64');
    parts.push(`${dir ? `mkdir -p '${dir}' && ` : ''}printf %s '${b64}' | base64 -d > '${file}'`);
  }
  return parts.join(' && ');
}

export const parseJson = (text) => {
  try {
    return JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
};

/** 规划员提示里的可用模型、任务单、修改意见、上一版工作流 */
export function planContext(text) {
  const section = (name) => {
    const start = text.indexOf(`【${name}】`);
    if (start < 0) return '';
    const rest = text.slice(start + name.length + 2);
    const end = rest.search(/\n\n【/);
    return (end < 0 ? rest : rest.slice(0, end)).replace(/^[^\n]*\n/, '');
  };
  const models = [...section('可以用的模型').matchAll(/^- ([^\s（]+)（/gm)].map((m) => m[1]);
  const sheetLine = text.slice(text.indexOf('【任务单】') + 6).split('\n')[0];
  const previousStart = text.indexOf('【上一版工作流】');
  const previous =
    previousStart < 0
      ? undefined
      : parseJson(text.slice(text.indexOf('\n', previousStart) + 1).split(/\n\n【/)[0] ?? '');
  return {
    models,
    sheet: parseJson(sheetLine) ?? { deliverables: [] },
    request: text.includes('【修改意见】') ? section('修改意见') : undefined,
    previous,
  };
}
