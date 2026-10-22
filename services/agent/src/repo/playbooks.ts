// 场景经验手册（ADR 0006 §8）：playbooks/ 下每个 .md 一份，启动时读一次。
// 格式：第一行「# 名称」，接着一行「> 适用：……」，其余是正文。
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import type { Playbook } from '@oasis/contracts/agent';

/** 解析一份手册；缺标题或「适用」行就报错（手册是仓库里的文件，写错了应该在启动时发现） */
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
  if (!name || !when) throw new Error(`经验手册 ${key}.md 要以「# 名称」和「> 适用：……」开头`);
  return { key, name, when, content: content.trim() };
}

export async function loadPlaybooks(dir: string): Promise<Playbook[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort();
  return Promise.all(
    files.map(async (f) => parsePlaybook(basename(f, '.md'), await readFile(join(dir, f), 'utf8'))),
  );
}
