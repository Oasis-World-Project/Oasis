// 给沙箱里主 AI 的说明和命令：guide/AGENTS.md 是平台规则（在 Oasis 里怎么干活；在用户电脑上干活时
// 「环境」一节换成 guide/device.md），guide/playbooks/ 下
// 每个 .md 是一份场景经验，作为技能交给 AI，需要时它自己读；oasis-tool 这些命令和 dsh 组合也从仓库里拿。
// 每轮开沙箱时现读，改了不用重启 harness。
// 经验格式：第一行「# 名称」，接着一行「> 适用：……」，其余是正文。
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { SANDBOX_PATHS, type AgentGuide } from '../adapter/dsh.ts';

export interface Playbook {
  /** 文件名，如 images */
  key: string;
  /** 第一行的标题，如「图片类」 */
  name: string;
  /** 「适用」那一行：什么样的活用得上 */
  when: string;
  /** 全文 */
  content: string;
}

/** 解析一份经验；缺标题或「适用」行就报错（经验是仓库里的文件，写错了应该尽早发现） */
export function parsePlaybook(key: string, content: string): Playbook {
  const lines = content.split(/\r?\n/);
  const name = lines
    .find((l) => l.startsWith('# '))
    ?.slice(2)
    .trim();
  const when = lines
    .find((l) => l.startsWith('> 适用：'))
    ?.slice('> 适用：'.length)
    .trim();
  if (!name || !when) throw new Error(`经验 ${key}.md 要以「# 名称」和「> 适用：……」开头`);
  return { key, name, when, content: content.trim() };
}

async function loadPlaybooks(dir: string): Promise<Playbook[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (f) => parsePlaybook(basename(f, '.md'), await readFile(join(dir, f), 'utf8'))),
  );
}

/** 放进沙箱某个目录的一组文件（path 相对 dir） */
export interface SandboxFiles {
  dir: string;
  files: { path: string; content: Buffer }[];
}

/**
 * 沙箱里 Oasis 自己的文件，按镜像里的位置（见 infra/images/harness-sandbox-base/Dockerfile）每轮
 * 现放进沙箱，改了不用重建镜像（3D 镜像重建要重下 Blender）；镜像里那份留给离线验收。root 是仓库根目录。
 * - /opt/oasis：oasis-tool、oasis-op 和它们用到的两个契约文件；
 * - dsh 用户目录：Oasis 的 dsh 组合 profiles/oasis/cordis.patch.yml（模型指向 model-gateway、权限档、
 *   关掉用不上的插件……）和同目录的两个插件 node-goal.mjs、approval.mjs。
 */
export async function loadSandboxFiles(root: string): Promise<SandboxFiles[]> {
  const group = async (dir: string, files: [from: string, path: string][]) => ({
    dir,
    files: await Promise.all(
      files.map(async ([from, path]) => ({ path, content: await readFile(join(root, from)) })),
    ),
  });
  const profile = (name: string): [string, string] => [
    `services/harness/src/adapter/profile/${name}`,
    `profiles/oasis/${name}`,
  ];
  return Promise.all([
    group(SANDBOX_PATHS.tools, [
      ['services/harness/sandbox/oasis-tool.ts', 'oasis-tool.ts'],
      ['services/harness/sandbox/tool-api.ts', 'tool-api.ts'],
      ['services/harness/sandbox/batch.ts', 'batch.ts'],
      ['services/harness/sandbox/tool-files.ts', 'tool-files.ts'],
      ['services/harness/sandbox/oasis-op.ts', 'services/harness/sandbox/oasis-op.ts'],
      ['packages/contracts/src/ops.ts', 'packages/contracts/src/ops.ts'],
      ['packages/contracts/src/tool-args.ts', 'packages/contracts/src/tool-args.ts'],
    ]),
    group(SANDBOX_PATHS.dshHome, [
      profile('cordis.patch.yml'),
      profile('node-goal.mjs'),
      profile('approval.mjs'),
    ]),
  ]);
}

/** 读平台规则（device.md 是在用户电脑上干活时换上的「环境」一节）和全部经验 */
export async function loadGuide(dir: string): Promise<AgentGuide> {
  const [rules, device, playbooks] = await Promise.all([
    readFile(join(dir, 'AGENTS.md'), 'utf8'),
    readFile(join(dir, 'device.md'), 'utf8'),
    loadPlaybooks(join(dir, 'playbooks')),
  ]);
  return {
    rules,
    device,
    skills: playbooks.map((p) => ({
      name: p.key,
      description: `${p.name}。适用：${p.when}`,
      content: p.content,
    })),
  };
}
