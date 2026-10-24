// 下载用户或 AI 给的文件（成果、素材）时的响应头。
/**
 * 成果文件是 AI 写的，可能是带脚本的网页或 SVG。它和应用同源，直接打开时脚本能借用户的登录状态调接口，
 * 所以一律加 CSP sandbox（脚本不跑、来源变成不透明）；PDF 例外，加了浏览器自带的阅读器就打不开，而 PDF 里的脚本浏览器本来就不执行。
 */
export function fileResponseHeaders(
  contentType: string,
  path: string,
  download: boolean,
): Record<string, string> {
  const name = encodeURIComponent(path.split('/').at(-1) ?? 'file');
  return {
    'content-type': contentType,
    'x-content-type-options': 'nosniff',
    'content-disposition': `${download ? 'attachment' : 'inline'}; filename*=UTF-8''${name}`,
    ...(contentType.startsWith('application/pdf') ? {} : { 'content-security-policy': 'sandbox' }),
  };
}

const CONTENT_TYPES: Record<string, string> = {
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  html: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  pdf: 'application/pdf',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  ogg: 'audio/ogg',
  glb: 'model/gltf-binary',
  zip: 'application/zip',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};
/** 按扩展名猜文件类型；不认识的当二进制 */
export const contentTypeOf = (path: string): string =>
  CONTENT_TYPES[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';

/**
 * 解析请求里的 Range（只支持单段：bytes=a-b、bytes=a-、bytes=-n）。
 * 没有或看不懂就返回 undefined（整个返回）；超出文件范围返回 'unsatisfiable'（416）。
 */
export function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | 'unsatisfiable' | undefined {
  const match = header ? /^bytes=(\d*)-(\d*)$/.exec(header.trim()) : null;
  if (!match || (match[1] === '' && match[2] === '')) return undefined;
  const [, from = '', to = ''] = match;
  if (from === '') {
    const suffix = Number(to);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(from);
  const end = to === '' ? size - 1 : Math.min(Number(to), size - 1);
  if (start >= size || end < start) return 'unsatisfiable';
  return { start, end };
}
