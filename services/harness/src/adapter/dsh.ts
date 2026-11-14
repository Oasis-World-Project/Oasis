// dsh 的适配层：全仓只有这里认识 DeepSeek Harness（AGENTS.md B.3）。
// 对外只暴露 Oasis 自己的概念：沙箱里的目录约定、环境变量、一次 agent 会话、翻译后的运行事件（events.ts）。
// dsh 升级（SDK 协议、事件格式变化）只改这个目录和 profile/ 下的组合。
import type { Readable, Writable } from 'node:stream';
import { DEVICE_ROOTS } from '@oasis/contracts/device';
import type { ExecutionEnvironment, Permissions, Workplace } from '@oasis/contracts/harness';
import type { ModelCapabilities } from '@oasis/contracts/model-gateway';
import { ApplicationSpec } from '@oasis/contracts/canvas';
import { BrowserTestPlan } from '@oasis/contracts/ui-test';
import { MODEL_PREVIEW_LIMITS, ModelPreviewSpec } from '@oasis/contracts/model-preview';
import { translateNotification, type AgentEvent } from './events.ts';
import { createJsonRpcClient } from './jsonrpc.ts';

/** 沙箱镜像里的目录约定（与 infra/images/harness-sandbox-base/Dockerfile 一致） */
export const SANDBOX_PATHS = {
  workdir: '/workspace',
  inputs: '/workspace/in',
  outputs: '/workspace/out',
  /** dsh 的用户目录：每轮开沙箱时放进平台说明（AGENTS.md）、技能（skills/）和 dsh 组合（profiles/oasis/） */
  dshHome: '/home/node/.dsh',
  /** dsh 的会话存储（含附件），和 /workspace 一起挂在这个会话的持久卷上：下一轮接着原会话 */
  sessions: '/home/node/.dsh/sessions',
  /** Oasis 自己的命令（oasis-tool、oasis-op）：每轮开沙箱时放进当前版本，改了不用重建镜像 */
  tools: '/opt/oasis',
} as const;

/**
 * 在用户电脑上，沙箱里的这些目录对应哪里（{project}、{home} 由桌面版换成实际的）：平台放的文件在项目里的
 * .oasis/ 下；dsh 的家目录（说明、技能、组合、会话）和 Oasis 的命令在桌面版自己的数据目录里，按会话分开。
 */
export const DEVICE_PATHS: [sandbox: string, device: string][] = [
  [SANDBOX_PATHS.dshHome, DEVICE_ROOTS.home],
  [SANDBOX_PATHS.tools, `${DEVICE_ROOTS.home}/tools`],
  [SANDBOX_PATHS.workdir, `${DEVICE_ROOTS.project}/.oasis`],
];

/** 给沙箱里 AI 的平台说明和技能（技能是各类活的经验，AI 需要时自己读） */
export interface AgentGuide {
  rules: string;
  /** 在用户电脑上干活时换掉说明里的「## 环境」一节 */
  device: string;
  skills: { name: string; description: string; content: string }[];
}

/** 说明里和 section 同一标题的一节（到下一个二级标题为止）换成 section */
function replaceSection(rules: string, section: string): string {
  const heading = section.trim().split('\n')[0] ?? '';
  const start = rules.indexOf(`${heading}\n`);
  if (!heading.startsWith('## ') || start < 0) return `${rules.trim()}\n\n${section.trim()}\n`;
  const next = rules.indexOf('\n## ', start + heading.length);
  return `${rules.slice(0, start)}${section.trim()}\n${next < 0 ? '' : rules.slice(next)}`;
}

/**
 * 放进 dsh 用户目录的文件（路径相对 {@link SANDBOX_PATHS.dshHome}）：dsh 把 AGENTS.md 当作用户的
 * 全局说明放进系统提示，把 skills/ 下的技能列给 AI（2026-11-14 用镜像里的 dsh 实测两处都会读）。
 * 这个 AI 的人设放在说明最前面；在用户电脑上干活时「环境」一节换成电脑上的。
 */
export function guideFiles(
  guide: AgentGuide,
  persona: string,
  workplace: Workplace = { kind: 'cloud' },
) {
  const who = persona.trim() ? `# 你是谁\n\n${persona.trim()}\n\n` : '';
  const rules =
    workplace.kind === 'device' ? replaceSection(guide.rules, guide.device) : guide.rules;
  return [
    { path: 'AGENTS.md', content: Buffer.from(who + rules) },
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

/**
 * 原生持久文件只在适配层识别；缺失与损坏必须区分。dsh 按工作目录分开存：沙箱里是 --workspace--，
 * 用户电脑上是项目文件夹的路径（如 --D-proj--）。
 */
export const isSessionArchive = (path: string, sessionId?: string) => {
  const parts = path.split('/');
  return (
    /^--.+--$/.test(parts[0] ?? '') &&
    (sessionId === undefined || parts[1] === sessionId) &&
    /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/.test(parts[2] ?? '')
  );
};

/** 沙箱装软件包的通路：出口代理和仓库地址 */
export interface SandboxPackages {
  /** 出口代理；没有时沙箱完全不能出站 */
  egressProxy: string | undefined;
  npmRegistry: string;
  pipIndexUrl: string;
}

/**
 * 这一轮的权限 → dsh 的权限档（profile/cordis.patch.yml 里配的 5 个预设）和 approval.mjs 怎么答：
 * 只读 / 可改项目文件夹 / 完全访问；超出时不做的用 -strict 档（不问、直接不做），直接允许的由插件自己答。
 */
export function permissionEnv(permissions: Permissions): Record<string, string> {
  const mode = (
    { read: 'read-only', project: 'workspace-write', full: 'danger-full-access' } as const
  )[permissions.access];
  return {
    DSH_PERMISSION_MODE: mode,
    OASIS_PERMISSION:
      mode !== 'danger-full-access' && permissions.beyond === 'deny' ? `${mode}-strict` : mode,
    OASIS_APPROVAL: permissions.beyond === 'allow' ? 'allow' : 'ask',
  };
}

/**
 * 沙箱的环境变量。runKey 是密钥，调用方不得记进日志。place：云端沙箱给入口代理地址和装软件包的通路；
 * 用户电脑上给这一轮的权限，地方相关的路径写成 {project}、{home}、{origin}，桌面版换成实际的
 * （平台放的文件在项目里的 .oasis/ 下，dsh 的家目录在桌面版自己的数据目录里，调模型和工具经网页地址上的 gateway）。
 */
export function sandboxEnv(input: {
  runKey: string;
  model: string;
  place: { modelBaseUrl: string; packages: SandboxPackages } | { permissions: Permissions };
}): Record<string, string> {
  const { place } = input;
  const modelBaseUrl =
    'permissions' in place ? `${DEVICE_ROOTS.origin}/api/run/v1` : place.modelBaseUrl;
  const base = {
    OASIS_MODEL_BASE_URL: modelBaseUrl,
    OASIS_RUN_KEY: input.runKey,
    // dsh 运行命令时会去掉名字像密钥的环境变量（含 KEY、TOKEN……），oasis-tool 拿不到 OASIS_RUN_KEY；
    // 这把临时 Key 本来就是给这次运行里的 AI 用工具的，所以用一个不会被去掉的名字再给一份
    OASIS_TOOL_AUTH: input.runKey,
    OASIS_MODEL: input.model,
    DSH_MAX_TOKENS_AS_SUCCESS: 'false',
  };
  if ('permissions' in place) {
    const oasis = `${DEVICE_ROOTS.project}/.oasis`;
    return {
      ...base,
      DSH_HOME: DEVICE_ROOTS.home,
      OASIS_IN: `${oasis}/in`,
      OASIS_OUT_DIR: `${oasis}/out`,
      OASIS_TOOL_STATE_DIR: `${oasis}/out/.oasis-tools`,
      ...permissionEnv(place.permissions),
    };
  }
  const { egressProxy, npmRegistry, pipIndexUrl } = place.packages;
  // 调模型、工具的入口代理不走出口代理
  const noProxy = [new URL(modelBaseUrl).hostname, 'localhost', '127.0.0.1'].join(',');
  return {
    ...base,
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
