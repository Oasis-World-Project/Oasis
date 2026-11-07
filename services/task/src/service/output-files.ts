// 文件匹配与交付选择属于 task；消费者直接使用 task 产出的最终清单。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { TaskBody } from '@oasis/contracts/task';
import type { Deliverable } from '../repo/schema.ts';
import type { Node } from '../repo/task-store.ts';

export function patternRegExp(pattern: string): RegExp {
  let source = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const char = pattern[i]!;
    if (char === '*' && pattern[i + 1] === '*') {
      source += '.*';
      i += 1;
    } else if (char === '*') source += '[^/]*';
    else source += /[.+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${source}$`);
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
