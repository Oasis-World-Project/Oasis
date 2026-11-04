// 成果文件按扩展名分成几类，决定怎么预览、文件图标上写什么。
export interface PreviewFile {
  path: string;
  size: number;
  url: string;
  downloadUrl: string;
  pdfUrl?: string;
  modelPreview?: boolean;
  /** 网页预览时，同一成果里可被相对地址引用的其他文件（path 与上面同一套相对路径） */
  assets?: { path: string; url: string }[];
  /** 网页里以 / 开头的地址从哪个目录算；默认网页所在目录 */
  root?: string;
}

export type PreviewKind =
  | 'image'
  | 'video'
  | 'audio'
  | 'pdf'
  | 'text'
  | 'page'
  | 'document'
  | 'presentation'
  | 'model'
  | 'none';

const KINDS: Record<string, PreviewKind> = {
  glb: 'model',
  gltf: 'model',
  blend: 'model',
  obj: 'model',
  fbx: 'model',
  stl: 'model',
  usdz: 'model',
  ply: 'model',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  webp: 'image',
  gif: 'image',
  svg: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  mp3: 'audio',
  wav: 'audio',
  m4a: 'audio',
  ogg: 'audio',
  pdf: 'pdf',
  md: 'text',
  txt: 'text',
  csv: 'document',
  tsv: 'document',
  xlsx: 'document',
  docx: 'document',
  pptx: 'presentation',
  ppt: 'presentation',
  json: 'text',
  jsonl: 'document',
  css: 'text',
  js: 'text',
  ts: 'text',
  py: 'text',
  html: 'page',
  htm: 'page',
};

const extensionOf = (path: string): string => {
  const name = path.split('/').at(-1) ?? path;
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

export const previewKindOf = (path: string): PreviewKind => KINDS[extensionOf(path)] ?? 'none';

/** 文件图标上的字：扩展名，最多 4 个字母 */
export const badgeOf = (path: string): string =>
  extensionOf(path).slice(0, 4).toUpperCase() || 'FILE';

export const baseName = (path: string): string => path.split('/').at(-1) ?? path;
