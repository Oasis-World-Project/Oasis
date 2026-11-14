// dsh 的通知翻译成 Oasis 的运行事件（从 dsh.ts 分出来，dsh.ts 太长了）：给人看的一句话、待办、
// 工具结果里存下的文件和长任务。dsh 的事件格式变了只改这里。
import type { RunEventKind } from '@oasis/contracts/harness';
import { TOOL_LABELS } from '@oasis/contracts/model-gateway';
import {
  jobFacts,
  OASIS_TOOL,
  savedFiles,
  stepFacts,
  TOOL_HELP,
  toolFailure,
} from './step-facts.ts';

export interface AgentEvent {
  kind: RunEventKind;
  data: Record<string, unknown>;
}

/** 工具参数和结果在事件里最多保留这么多字符（完整内容在持久卷里的 dsh 会话记录里） */
const MAX_EVENT_TEXT = 4000;
const clip = (text: string) =>
  text.length > MAX_EVENT_TEXT ? `${text.slice(0, MAX_EVENT_TEXT)}…（已截断）` : text;

/** 参数原文（JSON，可能被截断）里的一个字符串字段 */
function argOf(args: string, key: string): string | undefined {
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[key];
    return typeof value === 'string' ? value : undefined;
  } catch {
    const raw = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(args)?.[1];
    return raw?.replace(/\\n/g, '\n').replace(/\\(["\\/])/g, '$1');
  }
}

const brief = (text: string, max: number) => {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > max ? `${line.slice(0, max)}…` : line;
};

/** oasis-tool 命令里的工具和要做的内容（提示词、搜索词……） */
function oasisTool(command: string): string | undefined {
  const tool = OASIS_TOOL.exec(command)?.[1];
  if (!tool) return undefined;
  const what = /--(?:prompt|query|question|text|url|dir)\s+(?:"([^"]*)|'([^']*)|(\S+))/.exec(
    command,
  );
  const detail = what ? (what[1] ?? what[2] ?? what[3] ?? '') : '';
  const name = TOOL_LABELS[tool] ?? `用工具 ${tool}`;
  if (TOOL_HELP.test(command)) return `看用法：${name}`;
  return detail ? `${name}：${brief(detail, 40)}` : name;
}

/** 一次工具调用给人看的一句话（dsh 的工具名不出这个文件） */
function toolLabel(name: string, args: string): string {
  const path = argOf(args, 'path') ?? argOf(args, 'file_path') ?? '';
  switch (name) {
    case 'bash':
    case 'pwsh': {
      const command = argOf(args, 'command') ?? '';
      const label = oasisTool(command) ?? `运行命令：${brief(command, 80)}`;
      // 放到后台的命令这一步马上就结束，之后用 job_output 看它的输出
      return /"run_in_background"\s*:\s*true/.test(args) ? `${label}（放到后台）` : label;
    }
    case 'job_output':
      return '看后台命令的输出';
    case 'write':
      return `写文件 ${path}`;
    case 'edit':
      return `改文件 ${path}`;
    case 'str_replace_editor':
      return `${argOf(args, 'command') === 'view' ? '读' : '改'}文件 ${path}`;
    case 'read':
      return `读文件 ${path}`;
    case 'read_image':
      return `看图片 ${path}`;
    case 'glob':
    case 'grep':
      return `查找 ${argOf(args, 'pattern') ?? ''}`;
    case 'web_search':
      return `搜索：${brief(argOf(args, 'query') ?? '', 40)}`;
    case 'web_fetch':
      return `读网页 ${argOf(args, 'url') ?? ''}`;
    case 'skill':
      return `读经验：${argOf(args, 'name') ?? ''}`;
    default:
      return name;
  }
}

/** todo_write 的待办：pending / in_progress / completed → pending / doing / done */
function todosOf(args: string) {
  try {
    const { todos } = JSON.parse(args) as { todos?: { content?: unknown; status?: unknown }[] };
    return (todos ?? []).flatMap((todo) =>
      typeof todo.content === 'string'
        ? [
            {
              text: todo.content,
              status:
                todo.status === 'completed'
                  ? 'done'
                  : todo.status === 'in_progress'
                    ? 'doing'
                    : 'pending',
            },
          ]
        : [],
    );
  } catch {
    return undefined;
  }
}

interface Block {
  type?: string;
  text?: string;
}
const textOf = (content: unknown): string =>
  Array.isArray(content)
    ? (content as Block[])
        .filter((b) => b.type === 'text' && typeof b.text === 'string')
        .map((b) => b.text)
        .join('')
    : typeof content === 'string'
      ? content
      : '';

/** 把 dsh 的一条通知翻译成 Oasis 的运行事件；不关心的返回 undefined。 */
export function translateNotification(method: string, params: unknown): AgentEvent | undefined {
  const p = (params ?? {}) as { status?: string; event?: { type?: string; data?: unknown } };
  if (method === 'session.status' && typeof p.status === 'string') {
    return { kind: 'status', data: { status: p.status } };
  }
  if (method !== 'session.event' || !p.event?.type) return undefined;
  const data = (p.event.data ?? {}) as Record<string, unknown>;
  switch (p.event.type) {
    case 'user/message': {
      // dsh 每一步还会插一条「运行时上下文」用户消息，只保留真正来自用户的
      const source = data.source as { kind?: string } | undefined;
      if (source?.kind !== 'user') return undefined;
      return { kind: 'user_message', data: { text: clip(textOf(data.content)) } };
    }
    case 'assistant/message': {
      const message = data.message as { content?: unknown } | undefined;
      const text = textOf(message?.content);
      // 模型调工具前常吐一段空白，不算它说了话
      return text.trim() ? { kind: 'assistant_text', data: { text: clip(text) } } : undefined;
    }
    case 'tool/call': {
      const name = String(data.name ?? '');
      const args = String(data.arguments ?? '');
      // 待办单独成一种事件（进度参考），不算一步
      const items = name === 'todo_write' ? todosOf(args) : undefined;
      if (items) return { kind: 'todos', data: { items } };
      return {
        kind: 'tool_call',
        data: {
          callId: data.callId,
          name,
          arguments: clip(args),
          label: toolLabel(name, args),
          ...stepFacts(name, (key) => argOf(args, key)),
        },
      };
    }
    case 'tool/result': {
      const message = data.message as
        { toolCallId?: string; content?: unknown; isError?: boolean } | undefined;
      const error = data.error as { reason?: string } | undefined;
      const output = textOf(message?.content);
      const files = savedFiles(output);
      const jobs = jobFacts(output);
      const failed = toolFailure(output);
      return {
        kind: 'tool_result',
        data: {
          callId: message?.toolCallId,
          ok: !message?.isError && !failed,
          text: clip(output),
          ...(error?.reason
            ? { error: clip(error.reason) }
            : failed
              ? { error: clip(failed) }
              : {}),
          ...(files.length ? { files } : {}),
          ...(jobs.length ? { jobs } : {}),
        },
      };
    }
    case 'turn/end': {
      const reason = data.reason as { kind?: string; error?: { message?: string } } | undefined;
      if (reason?.kind === 'error') {
        return { kind: 'error', data: { message: clip(reason.error?.message ?? '模型调用失败') } };
      }
      if (reason?.kind === 'completed') return { kind: 'turn_end', data: { reason: 'completed' } };
      const kind = reason?.kind ?? 'unknown';
      return {
        kind: 'error',
        data: {
          reason: kind,
          message:
            kind === 'max-tokens'
              ? '输出达到 token 上限，运行未完成'
              : `运行未正常结束：${clip(kind)}`,
        },
      };
    }
    default:
      return undefined;
  }
}
