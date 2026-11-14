// 假供应商读懂 dsh 发来的对话：按用户的话切段、写文件的命令。

/** harness 接管时交给 AI 的话（services/harness/src/service/run/execute.ts 的 RECOVERED） */
const RECOVERED = '服务连接中断后已恢复原工作目录和原会话';
/** 用户的话里的场景标记：[[e2e:场景@本轮编号/第几句]] */
const SAY_MARK = /\[\[e2e:([\w-]+)@(\w+)\/([\w-]+)\]\]/g;
/** 假型号的输出上限：model-gateway 应把 dsh 要的上限压到它以内 */
export const MODEL_MAX_TOKENS = 65_536;

export const textOf = (content) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((b) => (b?.type === 'text' ? b.text : '')).join('')
      : '';

/**
 * 把 dsh 发来的对话按用户的话切段：带场景标记的每句话（开一轮、插话、「继续」）开一段，
 * 接管后的恢复提示也开一段（接着前面那句话的脚本做）。别的用户消息（平台说明、提醒）记在所在段里。
 * 一个会话里攒着之前每一轮的往来：段数说明 AI 是不是接着原会话做的。
 */
export function segmentsOf(messages) {
  const segments = [];
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'user') {
      const text = textOf(message.content);
      // 收尾时留下的几句话连成一段交给下一轮：按最后一句算
      const mark = [...text.matchAll(SAY_MARK)].at(-1);
      if (mark) segments.push({ kind: 'say', mark, text, calls: [], notices: [] });
      else if (text.trimStart().startsWith(RECOVERED))
        segments.push({ kind: 'recover', text, calls: [], notices: [] });
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
