// 给沙箱里主 AI 的说明：guide/AGENTS.md 是平台规则（在 Oasis 里怎么干活），guide/playbooks/ 下
// 每个 .md 是一份场景经验，作为技能交给 AI，需要时它自己读。每轮开沙箱时现读，改了不用重启 harness。
// 经验格式：第一行「# 名称」，接着一行「> 适用：……」，其余是正文。
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { AgentGuide } from '../adapter/dsh.ts';

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

/** 读平台规则和全部经验 */
export async function loadGuide(dir: string): Promise<AgentGuide> {
  const [rules, playbooks] = await Promise.all([
    readFile(join(dir, 'AGENTS.md'), 'utf8'),
    loadPlaybooks(join(dir, 'playbooks')),
  ]);
  return {
    rules,
    skills: playbooks.map((p) => ({
      name: p.key,
      description: `${p.name}。适用：${p.when}`,
      content: p.content,
    })),
  };
}
