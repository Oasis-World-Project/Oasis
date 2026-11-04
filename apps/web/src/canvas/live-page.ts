// 网页成果在画布里真正运行（ADR 0009 §17）：放进不带同源权限的 sandbox 框，脚本照常执行、用用户本机显卡渲染；
// 框是不透明来源，读不到 Oasis 的登录状态和接口。最前面插入一条 CSP：不联网、不加载外部资源、不提交表单、不嵌套页面。
// 同一成果里的图片、脚本、样式、字体按相对路径内嵌成 data: 地址，这样多文件网页也能在框里离线打开。
import {
  defaultTreeAdapter,
  html as spec,
  parse,
  serialize,
  type DefaultTreeAdapterMap,
} from 'parse5';

type Node = DefaultTreeAdapterMap['node'];
type Element = DefaultTreeAdapterMap['element'];
type ParentNode = DefaultTreeAdapterMap['parentNode'];

export const LIVE_CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' data: blob:; " +
  "style-src 'unsafe-inline' data: blob:; img-src data: blob:; media-src data: blob:; font-src data: blob:; " +
  "connect-src data: blob:; worker-src data: blob:; child-src blob:; frame-src 'none'; object-src 'none'; " +
  "base-uri 'none'; form-action 'none'";

/** 只给脚本运行权限：没有 allow-same-origin，框就是不透明来源；不给弹窗、表单、跳顶层页面和下载。 */
export const LIVE_SANDBOX = 'allow-scripts allow-pointer-lock';

const HTML_NS = spec.NS.HTML;
const META = `<meta http-equiv="Content-Security-Policy" content="${LIVE_CSP}">`;
const DOCTYPE = /^\uFEFF?\s*<!doctype[^>]*>/i;

/**
 * 把 CSP 放在文档最前面（doctype 之后、任何脚本之前）。解析器会自动补出 head 并把它放进去；
 * 原文自己的 <html>/<head> 标签照常合并，不改动原文其余部分。
 */
export function withPolicy(source: string): string {
  const doctype = DOCTYPE.exec(source);
  return doctype
    ? `${doctype[0]}${META}${source.slice(doctype[0].length)}`
    : `${META}${source.replace(/^\uFEFF/, '')}`;
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  css: 'text/css',
  js: 'text/javascript',
  mjs: 'text/javascript',
  json: 'application/json',
  glb: 'model/gltf-binary',
  gltf: 'model/gltf+json',
  wasm: 'application/wasm',
  txt: 'text/plain',
};
const mimeOf = (path: string) =>
  MIME[path.split('.').at(-1)?.toLowerCase() ?? ''] ?? 'application/octet-stream';

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
const dataUrl = (path: string, bytes: Uint8Array) => `data:${mimeOf(path)};base64,${base64(bytes)}`;
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/**
 * 网页里写的相对地址 → 成果里的文件路径。外部地址、锚点和 data:/blob: 不处理（外部的本来就被 CSP 拦下）。
 * 以 / 开头的按应用根目录算。
 */
export function resolveRef(ref: string, from: string, root: string): string | null {
  const value = ref.trim();
  if (
    !value ||
    value.startsWith('#') ||
    value.startsWith('//') ||
    /^[a-z][a-z\d+.-]*:/i.test(value)
  )
    return null;
  let clean = value.split(/[?#]/)[0]!;
  try {
    clean = decodeURIComponent(clean);
  } catch {
    return null;
  }
  const dir = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  const start = clean.startsWith('/') ? root : dir;
  const parts = start ? start.split('/') : [];
  for (const part of clean.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') {
      if (!parts.length) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join('/') || null;
}

/** 读取同一成果里的文件；不存在时返回 undefined。 */
export type LoadFile = (path: string) => Promise<Uint8Array | undefined>;

export interface LivePage {
  html: string;
  /** 网页引用了、但成果里没找到或没法在框里离线加载的文件 */
  missing: string[];
}

const attr = (el: Element, name: string) => el.attrs.find((a) => a.name === name)?.value;
const setAttr = (el: Element, name: string, value: string) => {
  const found = el.attrs.find((a) => a.name === name);
  if (found) found.value = value;
  else el.attrs.push({ name, value });
};
const dropAttr = (el: Element, name: string) => {
  el.attrs = el.attrs.filter((a) => a.name !== name);
};
const textOf = (node: Node): string =>
  'value' in node && node.nodeName === '#text'
    ? node.value
    : 'childNodes' in node
      ? node.childNodes.map(textOf).join('')
      : '';
function setText(el: Element, value: string) {
  el.childNodes = [];
  defaultTreeAdapter.insertText(el, value);
}

const RELATIVE_IMPORT =
  /(?:\bimport\s*(?:[\w*{}\s,]+from\s*)?|\bimport\s*\(\s*)['"](\.{1,2}\/|\/)[^'"]*['"]/;
const MEDIA = new Set(['img', 'audio', 'video', 'source', 'track', 'input', 'embed']);

/**
 * 生成在 sandbox 框里运行的整份文档。没有任何本地引用的网页（如单文件 3D 页面）只插入 CSP，不重写原文。
 */
export async function livePage(
  source: string,
  path: string,
  root: string,
  load: LoadFile,
): Promise<LivePage> {
  const missing = new Set<string>();
  const cache = new Map<string, Promise<Uint8Array | undefined>>();
  const read = (file: string) => {
    if (!cache.has(file)) cache.set(file, load(file));
    return cache.get(file)!;
  };
  const document = parse(source);
  const jobs: Promise<void>[] = [];

  /** CSS 里的 url(...)：相对 CSS 文件自己的位置内嵌 */
  const inlineCss = async (css: string, from: string): Promise<string> => {
    const found = [...css.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)];
    const replaced = new Map<string, string>();
    await Promise.all(
      found.map(async (match) => {
        const target = resolveRef(match[2]!, from, root);
        if (!target) return;
        const bytes = await read(target);
        if (bytes) replaced.set(match[0], `url("${dataUrl(target, bytes)}")`);
        else missing.add(target);
      }),
    );
    return css.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (whole) => replaced.get(whole) ?? whole);
  };

  const embed = (el: Element, name: string) => {
    const value = attr(el, name);
    const target = value ? resolveRef(value, path, root) : null;
    if (!target) return;
    jobs.push(
      read(target).then((bytes) => {
        if (bytes) setAttr(el, name, dataUrl(target, bytes));
        else missing.add(target);
      }),
    );
  };

  const visit = (node: Node) => {
    if ('tagName' in node && node.namespaceURI === HTML_NS) {
      const el = node;
      const style = attr(el, 'style');
      if (style?.includes('url('))
        jobs.push(inlineCss(style, path).then((css) => setAttr(el, 'style', css)));
      if (el.tagName === 'script') {
        const src = attr(el, 'src');
        const target = src ? resolveRef(src, path, root) : null;
        const module = attr(el, 'type') === 'module';
        if (target)
          jobs.push(
            read(target).then((bytes) => {
              if (!bytes) return void missing.add(target);
              const code = text(bytes);
              if (module && RELATIVE_IMPORT.test(code))
                missing.add(`${target}（模块引用其他文件）`);
              dropAttr(el, 'src');
              setText(el, code.replace(/<\/script/gi, '<\\/script'));
            }),
          );
        else if (module && RELATIVE_IMPORT.test(textOf(el)))
          missing.add(`${path}（模块引用其他文件）`);
      } else if (el.tagName === 'link') {
        const rel = (attr(el, 'rel') ?? '').toLowerCase().split(/\s+/);
        const href = attr(el, 'href');
        const target = href ? resolveRef(href, path, root) : null;
        if (target && rel.includes('stylesheet'))
          jobs.push(
            read(target).then(async (bytes) => {
              if (!bytes) return void missing.add(target);
              const css = await inlineCss(text(bytes), target);
              const styleEl = defaultTreeAdapter.createElement('style', HTML_NS, []);
              setText(styleEl, css.replace(/<\/style/gi, '<\\/style'));
              const parent = el.parentNode as ParentNode | null;
              if (!parent) return;
              const index = parent.childNodes.indexOf(el);
              styleEl.parentNode = parent;
              parent.childNodes.splice(index, 1, styleEl);
            }),
          );
        else if (
          target &&
          rel.some((r) => r === 'icon' || r === 'preload' || r === 'modulepreload')
        )
          embed(el, 'href');
      } else if (el.tagName === 'style') {
        const css = textOf(el);
        if (css.includes('url('))
          jobs.push(
            inlineCss(css, path).then((next) =>
              setText(el, next.replace(/<\/style/gi, '<\\/style')),
            ),
          );
      } else if (MEDIA.has(el.tagName)) {
        embed(el, 'src');
        if (el.tagName === 'video') embed(el, 'poster');
      }
    }
    const children =
      'content' in node && node.content
        ? node.content.childNodes
        : 'childNodes' in node
          ? node.childNodes
          : [];
    for (const child of [...children]) visit(child);
  };
  visit(document);
  if (!jobs.length) return { html: withPolicy(source), missing: [...missing] };
  await Promise.all(jobs);
  return { html: withPolicy(serialize(document)), missing: [...missing] };
}
