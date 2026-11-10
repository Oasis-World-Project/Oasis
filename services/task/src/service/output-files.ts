// 文件匹配与交付选择属于 task；消费者直接使用 task 产出的最终清单。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { TaskBody } from '@oasis/contracts/task';
import type { Deliverable } from '../repo/schema.ts';
import type { Node } from '../repo/task-store.ts';

/**
 * 路径模式 → 正则：* 匹配一层里的任意字符，** 跨层。
 * 不带通配符的模式既指这个文件，也指这个目录里的全部文件：「必须交出 site」「交付 site」说的是目录时，
 * 目录里有文件就算有。2026-11-10：工具节点检查上游的 in/build/site，上游因此被要求交出「site」，
 * 关卡把它当成一个文件查，报「缺少文件 out/site」，让节点白返工了一次。
 */
export function patternRegExp(pattern: string): RegExp {
  const plain = !pattern.includes('*');
  const text = plain ? pattern.replace(/\/+$/, '') : pattern;
  let source = '^';
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (char === '*' && text[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(plain ? `${source}(?:/.*)?$` : `${source}$`);
}

export function selectDeliverables(deliverables: Deliverable[], nodes: Node[]): Deliverable[] {
  return deliverables.map((d) => {
    const node = nodes.find((n) => n.id === d.nodeId);
    if (node?.config.deliver === undefined) return d;
    const files = selectedOutputFiles(node.outputs, node.config.deliver);
    return { ...d, files };
  });
}

function selectedOutputFiles(outputs: RunOutputFile[], deliver: string[]): RunOutputFile[] {
  const patterns = deliver.map(patternRegExp);
  return outputs.filter(
    (file) =>
      file.size > 0 &&
      !file.path.split('/').some((p) => p.startsWith('.oasis-')) &&
      patterns.some((p) => p.test(file.path)),
  );
}

/** 每个明确承诺的选择器都需要产出，不能被同节点的其他文件掩盖。 */
export function missingDeliveryFiles(outputs: RunOutputFile[], deliver?: string[]): string[] {
  return (deliver ?? [])
    .filter(
      (pattern) =>
        !outputs.some(
          (file) =>
            file.size > 0 &&
            !file.path.split('/').some((p) => p.startsWith('.oasis-')) &&
            patternRegExp(pattern).test(file.path),
        ),
    )
    .map((pattern) => `最终交付缺少文件 out/${pattern}`);
}

export function deliveryManifest(
  deliverables: Deliverable[],
  nodes: Node[],
): TaskBody['deliveryFiles'] {
  if (!deliverables.some((d) => d.files !== undefined)) return undefined;
  const seen = new Set<string>();
  return deliverables.flatMap((d) => {
    if (!d.nodeId) return [];
    const node = nodes.find((n) => n.id === d.nodeId);
    const files: RunOutputFile[] = d.files ?? node?.outputs ?? [];
    return files
      .filter((f) => {
        const id = `${d.nodeId}/${f.path}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((f) => ({
        deliverable: d.name,
        nodeId: d.nodeId!,
        path: f.path,
        size: f.size,
        ...(f.sha256 ? { sha256: f.sha256 } : {}),
        ...(node?.config.outputsRunId ? { runId: node.config.outputsRunId } : {}),
      }));
  });
}
