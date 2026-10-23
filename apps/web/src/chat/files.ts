// 成果文件按扩展名分成几类，决定怎么预览、文件图标上写什么。

export type PreviewKind = 'image' | 'video' | 'audio' | 'pdf' | 'text' | 'page' | 'none';

const KINDS: Record<string, PreviewKind> = {
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
  csv: 'text',
  json: 'text',
  jsonl: 'text',
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
