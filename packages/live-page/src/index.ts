// 网页成果在画布里怎么运行（ADR 0009 §17、ADR 0021）。画布预览和节点的 app.check 共用这一份规则，
// 检查过了的网页，用户在画布里一定打得开。
//
// - 放进不带同源权限的 sandbox 框：脚本照常执行、用用户本机显卡渲染；框是不透明来源，读不到 Oasis 的登录状态和接口。
// - 最前面插入一条 CSP：不联网、不加载外部资源、不提交表单、不嵌套页面。
// - 同一成果里的图片、脚本、样式、字体按相对地址内嵌成 data: 地址。
// - ES 模块（含 importmap 里的裸名字，如 "three"）：每个模块的引用改写成 oasis-file:/<路径>，
//   框里启动时把模块原文做成 blob 地址，再插一份 importmap 把 oasis-file:/ 映射过去。循环引用、动态 import 都照常。
// 纯 JS 版：不用 WebAssembly（画布页面和沙箱都不必放开 wasm），同步可用，不需要 init
import { parse as parseImports } from 'es-module-lexer/js';
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
const EXTERNAL = /^[a-z][a-z\d+.-]*:/i;

/**
 * 网页里写的相对地址 → 成果里的文件路径。外部地址、锚点和 data:/blob: 不处理（外部的本来就被 CSP 拦下）。
 * 以 / 开头的按应用根目录算。
 */
export function resolveRef(ref: string, from: string, root: string): string | null {
  const value = ref.trim();
  if (!value || value.startsWith('#') || value.startsWith('//') || EXTERNAL.test(value))
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
function detach(el: Element) {
  const parent = el.parentNode as ParentNode | null;
  if (parent) parent.childNodes.splice(parent.childNodes.indexOf(el), 1);
}
const scriptSafe = (code: string) => code.replace(/<\/script/gi, '<\\/script');
const MEDIA = new Set(['img', 'audio', 'video', 'source', 'track', 'input', 'embed']);

/** 框里模块的地址：不会和真实地址冲突，也不含引号，能直接写进 import 的引号里 */
export const MODULE_SCHEME = 'oasis-file:';
const moduleKey = (path: string) =>
  `${MODULE_SCHEME}/${path
    .split('/')
    .map((part) => encodeURIComponent(part).replace(/'/g, '%27'))
    .join('/')}`;

/** 框里第一段脚本：把模块原文做成 blob，插入 importmap。只用框自己的不透明来源，不碰外面。 */
const MODULE_BOOT =
  "(()=>{const el=document.getElementById('oasis-modules');const src=JSON.parse(el.textContent);el.remove();" +
  "const imports={};for(const k in src)imports[k]=URL.createObjectURL(new Blob([src[k]],{type:'text/javascript'}));" +
  "const map=document.createElement('script');map.type='importmap';map.textContent=JSON.stringify({imports});" +
  'document.currentScript.after(map);})()';

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
  const moduleScripts: Element[] = [];
  const importMaps: Element[] = [];

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
        const type = (attr(el, 'type') ?? '').trim().toLowerCase();
        if (type === 'module') moduleScripts.push(el);
        else if (type === 'importmap') importMaps.push(el);
        else {
          const src = attr(el, 'src');
          const target = src ? resolveRef(src, path, root) : null;
          if (target)
            jobs.push(
              read(target).then((bytes) => {
                if (!bytes) return void missing.add(target);
                dropAttr(el, 'src');
                setText(el, scriptSafe(text(bytes)));
              }),
            );
        }
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
        // 模块由 importmap 统一加载，预加载提示没有用处
        else if (target && rel.includes('modulepreload')) detach(el);
        else if (target && rel.some((r) => r === 'icon' || r === 'preload')) embed(el, 'href');
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

  if (moduleScripts.length) jobs.push(bundleModules());
  if (!jobs.length) return { html: withPolicy(source), missing: [...missing] };
  await Promise.all(jobs);
  return { html: withPolicy(serialize(document)), missing: [...missing] };

  /** 网页自己的 importmap（只用 imports；scopes 很少见，不处理） */
  function pageImportMap(): [string, string][] {
    const entries: [string, string][] = [];
    for (const el of importMaps) {
      try {
        const value = JSON.parse(textOf(el)) as { imports?: Record<string, unknown> };
        for (const [key, target] of Object.entries(value.imports ?? {}))
          if (typeof target === 'string') entries.push([key, target]);
      } catch {
        missing.add(`${path} 里的 importmap（不是合法 JSON）`);
      }
      // 网页里的映射已经折算进改写后的地址；原样留着反而会和框里的 importmap 冲突
      detach(el);
    }
    return entries;
  }

  async function bundleModules(): Promise<void> {
    const mapped = pageImportMap();
    const sources = new Map<string, string>();
    const started = new Map<string, Promise<void>>();
    const pending: Promise<void>[] = [];

    /** 引用 → 成果里的文件；null = 外部地址，原样留着交给 CSP；undefined = 找不到 */
    const resolveSpecifier = (specifier: string, from: string): string | null | undefined => {
      if (specifier.startsWith('//') || EXTERNAL.test(specifier)) return null;
      if (/^\.{0,2}\//.test(specifier)) return resolveRef(specifier, from, root) ?? undefined;
      const exact = mapped.find(([key]) => key === specifier);
      const prefix = mapped
        .filter(([key]) => key.endsWith('/') && specifier.startsWith(key))
        .sort((a, b) => b[0].length - a[0].length)[0];
      const target = exact
        ? exact[1]
        : prefix
          ? prefix[1] + specifier.slice(prefix[0].length)
          : null;
      if (target === null) return undefined;
      if (target.startsWith('//') || EXTERNAL.test(target)) return null;
      return resolveRef(target, path, root) ?? undefined;
    };

    /** 把一段模块代码里的本地引用改写成框里的地址，并把被引用的模块加进来 */
    const rewrite = (code: string, from: string): string => {
      let imports;
      try {
        [imports] = parseImports(code);
      } catch {
        missing.add(`${from}（模块代码解析失败）`);
        return code;
      }
      const edits: { s: number; e: number; value: string }[] = [];
      for (const item of imports) {
        // import.meta 和拼出来的动态 import 不是固定地址，跳过
        if (item.n === undefined || item.d === -2) continue;
        const target = resolveSpecifier(item.n, from);
        if (target === null) continue;
        if (target === undefined) {
          missing.add(`${from} 引用的「${item.n}」`);
          continue;
        }
        include(target);
        const key = moduleKey(target);
        // 静态 import 的 s..e 不含引号；动态 import 的 s..e 是整个字符串字面量
        const quoted = ['"', "'", '`'].includes(code[item.s] ?? '');
        edits.push({ s: item.s, e: item.e, value: quoted ? JSON.stringify(key) : key });
      }
      let out = code;
      for (const edit of edits.sort((a, b) => b.s - a.s))
        out = out.slice(0, edit.s) + edit.value + out.slice(edit.e);
      return out;
    };

    const include = (file: string) => {
      if (started.has(file)) return;
      const job = read(file).then((bytes) => {
        if (!bytes) return void missing.add(file);
        sources.set(moduleKey(file), rewrite(text(bytes), file));
      });
      started.set(file, job);
      pending.push(job);
    };

    for (const el of moduleScripts) {
      const src = attr(el, 'src');
      if (src === undefined) {
        setText(el, scriptSafe(rewrite(textOf(el), path)));
        continue;
      }
      const target = resolveRef(src, path, root);
      if (!target) continue;
      include(target);
      dropAttr(el, 'src');
      setText(el, `import ${JSON.stringify(moduleKey(target))};`);
    }
    // 被引用的模块又会引用别的：直到不再有新的读取
    for (let seen = -1; seen !== pending.length;) {
      seen = pending.length;
      await Promise.all(pending);
    }
    if (!sources.size) return;

    const head = findHead(document);
    if (!head) return;
    const data = defaultTreeAdapter.createElement('script', HTML_NS, [
      { name: 'type', value: 'application/json' },
      { name: 'id', value: 'oasis-modules' },
    ]);
    // JSON 里的 < 一律转义：原文里的 </script> 和 <!-- 都不会提前结束这段数据
    setText(data, JSON.stringify(Object.fromEntries(sources)).replace(/</g, '\\u003c'));
    const boot = defaultTreeAdapter.createElement('script', HTML_NS, []);
    setText(boot, MODULE_BOOT);
    for (const el of [boot, data]) {
      el.parentNode = head;
      head.childNodes.unshift(el);
    }
  }
}

function findHead(node: Node): Element | undefined {
  if ('tagName' in node && node.tagName === 'head') return node;
  if (!('childNodes' in node)) return undefined;
  for (const child of node.childNodes) {
    const found = findHead(child);
    if (found) return found;
  }
  return undefined;
}
