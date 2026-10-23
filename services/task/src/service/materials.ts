// 用户给的素材怎么放进沙箱：都放在 materials/ 下，同名的加序号（ADR 0007 §4）。
import type { Material } from '@oasis/contracts/canvas';

/** 文件名 → 不重名的路径，如 materials/照片.jpg、materials/照片 (2).jpg */
export function materialPaths(materials: Material[]): { uploadId: string; path: string }[] {
  const used = new Set<string>();
  return materials.map((m) => {
    const dot = m.name.lastIndexOf('.');
    const stem = dot > 0 ? m.name.slice(0, dot) : m.name;
    const ext = dot > 0 ? m.name.slice(dot) : '';
    let name = m.name;
    for (let n = 2; used.has(name.toLowerCase()); n += 1) name = `${stem} (${n})${ext}`;
    used.add(name.toLowerCase());
    return { uploadId: m.uploadId, path: `materials/${name}` };
  });
}
