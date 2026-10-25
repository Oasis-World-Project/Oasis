// 文件匹配与交付选择属于 task；消费者直接使用 task 产出的最终清单。
import type { RunOutputFile } from '@oasis/contracts/harness';
import type { TaskBody, ExpectedFile } from '@oasis/contracts/task';
import type { Deliverable } from '../repo/schema.ts';
import type { Node } from '../repo/task-store.ts';

export function patternRegExp(pattern: string): RegExp {
  return new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*')}$`);
}

/** 关卡只读取明确期望或交付的文件，过程脚本不能先耗尽正文额度。 */
export function filesForInspection(
  outputs: RunOutputFile[],
  expects: ExpectedFile[],
  deliver?: string[],
): RunOutputFile[] {
  const patterns = [
    ...expects.map((e) => (typeof e === 'string' ? e : e.pattern)),
    ...(deliver ?? []),
  ].map(patternRegExp);
  return patterns.length
    ? outputs.filter((file) => patterns.some((re) => re.test(file.path)))
    : outputs;
}

export function selectDeliverables(deliverables: Deliverable[], nodes: Node[]): Deliverable[] {
  return deliverables.map((d) => {
    const node = nodes.find((n) => n.id === d.nodeId);
    if (node?.config.deliver === undefined) return d;
    const patterns = node.config.deliver.map(patternRegExp);
    const files = node.outputs.filter(
      (file) =>
        file.size > 0 &&
        !file.path.split('/').some((p) => p.startsWith('.oasis-')) &&
        patterns.some((p) => p.test(file.path)),
    );
    return { ...d, files };
  });
}

export function deliveryManifest(
  deliverables: Deliverable[],
  nodes: Node[],
): TaskBody['deliveryFiles'] {
  if (!deliverables.some((d) => d.files !== undefined)) return undefined;
  const seen = new Set<string>();
  return deliverables.flatMap((d) => {
    if (!d.nodeId) return [];
    const files: RunOutputFile[] = d.files ?? nodes.find((n) => n.id === d.nodeId)?.outputs ?? [];
    return files
      .filter((f) => {
        const id = `${d.nodeId}/${f.path}`;
        if (seen.has(id)) return false;
        seen.add(id);
        return true;
      })
      .map((f) => ({ deliverable: d.name, nodeId: d.nodeId!, path: f.path, size: f.size }));
  });
}
