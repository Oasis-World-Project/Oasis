// dsh 的适配层：全仓只有这里认识 DeepSeek Harness（AGENTS.md B.3）。
// 对外只暴露 Oasis 自己的概念：沙箱里的目录约定、环境变量、一次 agent 会话、翻译后的运行事件。
// dsh 升级（SDK 协议、事件格式变化）只改这个目录和 profile/ 下的组合。
import type { Readable, Writable } from 'node:stream';
import type { RunEventKind } from '@oasis/contracts/harness';
import { TOOL_LABELS, type ModelCapabilities } from '@oasis/contracts/model-gateway';
import type { ExecutionEnvironment } from '@oasis/contracts/harness';
import { ApplicationSpec } from '@oasis/contracts/canvas';
import { BrowserTestPlan } from '@oasis/contracts/ui-test';
import { MODEL_PREVIEW_LIMITS, ModelPreviewSpec } from '@oasis/contracts/model-preview';
import { createJsonRpcClient } from './jsonrpc.ts';
import { jobFacts, OASIS_TOOL, savedFiles, stepFacts, TOOL_HELP } from './step-facts.ts';

/** 沙箱镜像里的目录约定（与 infra/images/harness-sandbox-base/Dockerfile 一致） */
export const SANDBOX_PATHS = {
  workdir: '/workspace',
  inputs: '/workspace/in',
  outputs: '/workspace/out',
  /** dsh 的用户目录：每轮开沙箱时放进平台说明（AGENTS.md）和技能（skills/<名>/SKILL.md） */
  dshHome: '/home/node/.dsh',
  /** dsh 的会话存储（含附件），和 /workspace 一起挂在这个会话的持久卷上：下一轮接着原会话 */
  sessions: '/home/node/.dsh/sessions',
  /** Oasis 自己的命令（oasis-tool、oasis-op）：每轮开沙箱时放进当前版本，改了不用重建镜像 */
  tools: '/opt/oasis',
} as const;

/** 给沙箱里 AI 的平台说明和技能（技能是各类活的经验，AI 需要时自己读） */
export interface AgentGuide {
  rules: string;
  skills: { name: string; description: string; content: string }[];
}

/**
 * 放进 dsh 用户目录的文件（路径相对 {@link SANDBOX_PATHS.dshHome}）：dsh 把 AGENTS.md 当作用户的
 * 全局说明放进系统提示，把 skills/ 下的技能列给 AI（2026-11-14 用镜像里的 dsh 实测两处都会读）。
 * 这个 AI 的人设放在说明最前面。
 */
export function guideFiles(guide: AgentGuide, persona: string) {
  const who = persona.trim() ? `# 你是谁\n\n${persona.trim()}\n\n` : '';
  return [
    { path: 'AGENTS.md', content: Buffer.from(who + guide.rules) },
    ...guide.skills.map((skill) => ({
      path: `skills/${skill.name}/SKILL.md`,
      content: Buffer.from(
        `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.content.trim()}\n`,
      ),
    })),
  ];
}

/** dsh 里指向 model-gateway 的模型路由名（profile/cordis.patch.yml 里定义） */
const PROVIDER = 'openrouter';

/** 原生持久文件只在适配层识别；缺失与损坏必须区分。 */
export const isSessionArchive = (path: string, sessionId?: string) => {
  const parts = path.split('/');
  return (
    parts[0] === '--workspace--' &&
    (sessionId === undefined || parts[1] === sessionId) &&
    /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(parts[2] ?? '')
  );
};

/** 沙箱的环境变量。runKey 是密钥，调用方不得记进日志。 */
/** 沙箱装软件包的通路：出口代理和仓库地址 */
export interface SandboxPackages {
  /** 出口代理；没有时沙箱完全不能出站 */
  egressProxy: string | undefined;
  npmRegistry: string;
  pipIndexUrl: string;
}

export function sandboxEnv(input: {
  modelBaseUrl: string;
  runKey: string;
  model: string;
  packages: SandboxPackages;
}): Record<string, string> {
  const { egressProxy, npmRegistry, pipIndexUrl } = input.packages;
  // 调模型、工具的入口代理不走出口代理
  const noProxy = [new URL(input.modelBaseUrl).hostname, 'localhost', '127.0.0.1'].join(',');
  return {
    OASIS_MODEL_BASE_URL: input.modelBaseUrl,
    OASIS_RUN_KEY: input.runKey,
    // dsh 运行命令时会去掉名字像密钥的环境变量（含 KEY、TOKEN……），oasis-tool 拿不到 OASIS_RUN_KEY；
    // 这把临时 Key 本来就是给这次运行里的 AI 用工具的，所以用一个不会被去掉的名字再给一份
    OASIS_TOOL_AUTH: input.runKey,
    OASIS_MODEL: input.model,
    DSH_MAX_TOKENS_AS_SUCCESS: 'false',
    ...(egressProxy
      ? {
          HTTP_PROXY: egressProxy,
          HTTPS_PROXY: egressProxy,
          http_proxy: egressProxy,
          https_proxy: egressProxy,
          NO_PROXY: noProxy,
          no_proxy: noProxy,
          npm_config_registry: npmRegistry,
          PIP_INDEX_URL: pipIndexUrl,
          UV_DEFAULT_INDEX: pipIndexUrl,
        }
      : {}),
  };
}

/** 元数据用文件传入，避免 Linux 单个环境变量的长度边界。 */
export function runtimeFiles(input: {
  models: ModelCapabilities[];
  sessionId: string;
  recovering?: boolean;
  environment?: ExecutionEnvironment;
}) {
  return [
    {
      path: 'in/.oasis-formats.json',
      content: Buffer.from(
        JSON.stringify({
          application: {
            schema: ApplicationSpec.toJSONSchema(),
            example: ApplicationSpec.parse({
              version: 1,
              kind: 'static',
              root: 'site',
              entry: 'index.html',
            }),
            location: 'out/<root>/oasis-app.json',
            paths: 'root 相对 out/；entry 相对 root，清单必须位于该 root 目录内。',
          },
          browserTest: {
            schema: BrowserTestPlan.toJSONSchema(),
            location: '与 oasis-app.json 同目录的 oasis-test.json',
          },
          // 3D 预览的事实：用到再读
          model3d: {
            interactive:
              '画布直接交互预览自包含的 GLB：不引用外部文件、不用扩展，骨骼/形变/压缩暂不支持。',
            limits: MODEL_PREVIEW_LIMITS,
            otherFormats:
              'blend/obj/fbx/stl/usdz/ply/gltf 不能直接预览；要预览就在同目录放 oasis-model-preview.json，指向同时交付的 GLB、封面图或转台视频。',
            tools:
              '3D 沙箱里：oasis-3d snapshot <模型> --out <目录> 自动取景出视角图；oasis-3d check <模型> 查尺寸、拓扑和能否预览；Blender 脚本里 import oasis_blender（导出可预览 GLB、基础材质）。',
            sidecar: {
              schema: ModelPreviewSpec.toJSONSchema(),
              location: '与原件同目录的 oasis-model-preview.json；路径相对该文件，sha256 填实际值',
            },
          },
        }),
      ),
    },
    ...(input.environment
      ? [
          {
            path: 'in/.oasis-environment.json',
            content: Buffer.from(JSON.stringify(input.environment)),
          },
        ]
      : []),
    {
      path: 'in/.oasis-models.json',
      content: Buffer.from(
        JSON.stringify(
          input.models.map(({ reasoning, ...model }) => ({
            ...model,
            // Oasis 插件默认取最后一档：最高到 high
            reasoningEfforts: reasoning ? { off: null, high: 'high' } : false,
            compat: {
              thinkingFormat: 'openrouter',
              supportsReasoningEffort: reasoning,
              maxTokensField: 'max_tokens',
            },
          })),
        ),
      ),
    },
    {
      path: 'in/.oasis-execution.json',
      content: Buffer.from(
        JSON.stringify({ sessionId: input.sessionId, recovering: input.recovering ?? false }),
      ),
    },
  ];
}
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
      return oasisTool(command) ?? `运行命令：${brief(command, 80)}`;
    }
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
      return {
        kind: 'tool_result',
        data: {
          callId: message?.toolCallId,
          ok: !message?.isError,
          text: clip(output),
          ...(error?.reason ? { error: clip(error.reason) } : {}),
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

/** 一个根会话及其原生托管代理树。子会话的终态不参与根会话完成判定。 */
export function connectAgent(io: {
  stdin: Writable;
  stdout: Readable;
  sessionId: string;
  onEvent: (event: AgentEvent) => void;
}) {
  let lastError: string | undefined = '运行未收到正常结束通知';
  let pendingTurns = 0;
  /** 有用户消息进了会话、还没等到它所在那一轮的结束通知 */
  let awaitingEnd = false;
  const parents = new Map<string, string>();
  const belongs = (id: string): boolean =>
    id === io.sessionId || (parents.has(id) && belongs(parents.get(id)!));
  const rpc = createJsonRpcClient({
    input: io.stdout,
    output: io.stdin,
    onClose: (error) => {
      lastError = error.message;
    },
    onNotification: (method, params) => {
      const p = (params ?? {}) as {
        sessionId?: string;
        parentSessionId?: string;
        childSessionId?: string;
      };
      if (
        method === 'subagent.started' &&
        p.parentSessionId &&
        p.childSessionId &&
        belongs(p.parentSessionId)
      ) {
        parents.set(p.childSessionId, p.parentSessionId);
        io.onEvent({
          kind: 'status',
          data: {
            status: 'subagent_started',
            sessionId: p.childSessionId,
            parentSessionId: p.parentSessionId,
          },
        });
        return;
      }
      if ((method === 'session.event' || method === 'session.status') && !p.sessionId) {
        rpc.abort(new Error('会话通知缺少 sessionId，不能判断根会话是否完成'));
        return;
      }
      if (p.sessionId && !belongs(p.sessionId)) return;
      const root = !p.sessionId || p.sessionId === io.sessionId;
      const event = translateNotification(method, params);
      if (!event) return;
      if (root) {
        // 发出的每条消息进了会话历史就算处理了：一轮进行中的插话会被插进这一轮的下一步（Oasis 插件），
        // 不再单独开一轮，所以不能按轮次结束来数
        if (event.kind === 'user_message') {
          pendingTurns = Math.max(0, pendingTurns - 1);
          awaitingEnd = true;
        }
        if (event.kind === 'error' || event.kind === 'turn_end') {
          awaitingEnd = false;
          lastError = event.kind === 'error' ? String(event.data.message) : undefined;
        }
      }
      io.onEvent({
        ...event,
        data: {
          ...event.data,
          ...(p.sessionId ? { sessionId: p.sessionId } : {}),
          ...(!root && p.sessionId ? { parentSessionId: parents.get(p.sessionId) } : {}),
        },
      });
    },
  });
  const session = { sessionId: io.sessionId };
  return {
    initialize: (model: string, cwd: string) =>
      rpc.request('initialize', { cwd, provider: PROVIDER, model }, 60_000),
    /** 接着原会话：从持久卷里的会话记录恢复，修好中断的最后一轮，不发新消息 */
    resume: async () => {
      await rpc.request('session/resume', session, 60_000);
      lastError = undefined;
    },
    prompt: (text: string) => {
      pendingTurns++;
      lastError = '运行未收到正常结束通知';
      return rpc.request(
        'session/prompt',
        { ...session, contentBlocks: [{ type: 'text', text }] },
        30_000,
      );
    },
    /** 等这一轮做完；返回失败原因（正常结束为 undefined） */
    async waitIdle(): Promise<string | undefined> {
      try {
        await rpc.request('session/wait', session);
        if (lastError) return lastError;
        if (pendingTurns > 0 || awaitingEnd) return '运行未收到正常结束通知';
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
    shutdown: () => rpc.request('shutdown', undefined, 10_000),
    abort: (error: Error) => {
      lastError = error.message;
      rpc.abort(error);
    },
  };
}
export type AgentConnection = ReturnType<typeof connectAgent>;
