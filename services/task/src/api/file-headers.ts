// 下载成果文件时的响应头。
/**
 * 成果文件是 AI 写的，可能是带脚本的网页或 SVG。它和应用同源，直接打开时脚本能借用户的登录状态调接口，
 * 所以一律加 CSP sandbox（脚本不跑、来源变成不透明）；PDF 例外，加了浏览器自带的阅读器就打不开，而 PDF 里的脚本浏览器本来就不执行。
 */
export function fileHeaders(
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
