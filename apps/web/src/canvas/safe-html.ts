// 使用纯解析器重建 HTML；原始内容在清洗前从不交给浏览器 DOM。
import { DashboardData } from '@oasis/contracts/canvas';
import { parse, type DefaultTreeAdapterMap } from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
const TAGS = new Set(
  'html head body title style main section article header footer nav div span p h1 h2 h3 h4 h5 h6 strong b em i u s small sub sup blockquote pre code br hr ul ol li dl dt dd table caption thead tbody tfoot tr th td colgroup col img figure figcaption a'.split(
    ' ',
  ),
);
const VOID = new Set(['br', 'hr', 'col', 'img']);
const ATTRS = new Set([
  'class',
  'id',
  'style',
  'title',
  'lang',
  'dir',
  'colspan',
  'rowspan',
  'scope',
  'width',
  'height',
  'alt',
]);
const CSP =
  "default-src 'none'; script-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
const escape = (text: string) =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function safeHtml(source: string): {
  html: string;
  links: { label: string; url: string }[];
  dashboard?: DashboardData;
  warning?: string;
} {
  if (source.length > 2 * 1024 * 1024) throw new Error('网页超过预览上限');
  const root = parse(source);
  const links: { label: string; url: string }[] = [];
  let dashboard: DashboardData | undefined;
  let warning: string | undefined;
  let count = 0;
  const textOf = (node: Node): string =>
    'value' in node ? node.value : 'childNodes' in node ? node.childNodes.map(textOf).join('') : '';
  function render(node: Node, depth = 0): string {
    if (++count > 50_000 || depth > 100) throw new Error('网页结构超过预览上限');
    if (node.nodeName === '#text' && 'value' in node) return escape(node.value);
    if (!('tagName' in node))
      return 'childNodes' in node ? node.childNodes.map((n) => render(n, depth + 1)).join('') : '';
    if (node.namespaceURI !== 'http://www.w3.org/1999/xhtml') return '';
    const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
    if (
      node.tagName === 'script' &&
      attrs.get('id') === 'oasis-dashboard' &&
      attrs.get('type') === 'application/json'
    ) {
      try {
        dashboard = DashboardData.parse(JSON.parse(textOf(node)));
      } catch {
        warning = '看板数据无效，已显示静态内容；请下载原文件查看。';
      }
      return '';
    }
    if (!TAGS.has(node.tagName)) return '';
    if (node.tagName === 'a') {
      try {
        const url = new URL(attrs.get('href') ?? '');
        if (
          ['http:', 'https:'].includes(url.protocol) &&
          !url.username &&
          !url.password &&
          links.length < 100 &&
          !links.some((l) => l.url === url.href)
        )
          links.push({ label: textOf(node).trim().slice(0, 200) || url.hostname, url: url.href });
      } catch {
        /* 相对链接在单文件预览中没有可信的来源。 */
      }
    }
    let attributes = '';
    for (const [name, value] of attrs) {
      if (ATTRS.has(name)) attributes += ` ${name}="${escape(value)}"`;
      else if (
        node.tagName === 'img' &&
        name === 'src' &&
        /^data:image\/(png|jpeg|webp);base64,[a-z\d+/=\s]+$/i.test(value)
      )
        attributes += ` src="${escape(value)}"`;
    }
    const children =
      node.tagName === 'style'
        ? textOf(node).replace(/</g, '\\3c ')
        : node.childNodes.map((n) => render(n, depth + 1)).join('');
    return `<${node.tagName}${attributes}>${VOID.has(node.tagName) ? '' : `${children}</${node.tagName}>`}`;
  }
  const content = render(root);
  // CSP 必须在任何用户样式或图像前。清洗后的根文档只插入这一份可信 meta。
  const html = content.replace(
    /<head(?:\s[^>]*)?>/,
    (match) =>
      `${match}<meta http-equiv="Content-Security-Policy" content="${escape(CSP)}"><meta charset="utf-8">`,
  );
  return { html, links, ...(dashboard ? { dashboard } : {}), ...(warning ? { warning } : {}) };
}
