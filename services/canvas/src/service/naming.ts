// 成果的类别（照原型 ⑧）和同步到电脑时的路径（纯函数，ADR 0007 §8、§10）。
import type { ArtifactCategory } from '@oasis/contracts/canvas';

const CATEGORY_BY_EXT: Record<string, ArtifactCategory> = {};
const groups: [ArtifactCategory, string][] = [
  ['doc', 'md txt pdf doc docx ppt pptx rtf png jpg jpeg webp gif svg'],
  ['media', 'mp3 wav m4a ogg flac aac mp4 webm mov mkv'],
  ['threed', 'glb gltf obj fbx stl usdz ply'],
  ['app', 'html htm js mjs ts tsx jsx css py sh vue apk'],
];
for (const [category, exts] of groups) {
  for (const ext of exts.split(' ')) CATEGORY_BY_EXT[ext] = category;
}

/** 文件属于哪一类；认不出的（表格、数据、压缩包……）算「数据和其他」 */
export function categoryOf(path: string): ArtifactCategory {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase() ?? '';
  return CATEGORY_BY_EXT[ext] ?? 'data';
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com\d|lpt\d)$/i;

/** 一段文件或文件夹名：去掉 Windows / macOS 不允许的字符，不能以点或空格结尾，不能是保留名 */
export function safeSegment(raw: string): string {
  let name = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (name.length > 80) name = name.slice(0, 80).trim();
  if (!name || name === '.' || name === '..') return '未命名';
  const stem = name.split('.')[0] ?? name;
  return WINDOWS_RESERVED.test(stem) ? `${name}_` : name;
}

/** 名字被占用时加序号：报告.md → 报告 (2).md；文件夹名直接加在后面 */
function withNumber(name: string, n: number, isFile: boolean): string {
  if (!isFile) return `${name} (${n})`;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** 在 taken（不分大小写，Windows 不区分）之外挑一个名字 */
export function uniqueName(name: string, taken: Set<string>, isFile: boolean): string {
  let candidate = name;
  for (let n = 2; taken.has(candidate.toLowerCase()); n += 1)
    candidate = withNumber(name, n, isFile);
  return candidate;
}

/** 节点产出里的路径 → 同步文件夹里任务目录下的相对路径（每一段都清理过） */
export const safePath = (path: string) =>
  path.split('/').filter(Boolean).map(safeSegment).join('/');
