import { extname, posix } from 'node:path';
import { createHash } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { parentPort, workerData } from 'node:worker_threads';
import { DashboardData } from '@oasis/contracts/canvas';
import { parse as parseHtml, type DefaultTreeAdapterMap } from 'parse5';
import { Unzip, UnzipInflate } from 'fflate';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import sharp from 'sharp';
import { getDocumentProxy } from 'unpdf';
import type { InspectionLimits, InspectedFile } from './file-inspection.ts';
import { GeometryLimit, inspectGlb } from './geometry-inspection.ts';

class IncompleteInspection extends Error {}

const data = workerData as {
  path: string;
  content: Uint8Array;
  limits: InspectionLimits;
  maxChars: number;
};

function htmlContent(bytes: Buffer): { text: string; warning?: string } {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const root = parseHtml(source);
  const pieces: string[] = [];
  let warning: string | undefined;
  let count = 0;
  function visit(node: DefaultTreeAdapterMap['node'], depth = 0): void {
    if (++count > 100_000 || depth > 100) throw new IncompleteInspection('HTML 结构超过解析上限');
    if (node.nodeName === '#text' && 'value' in node) {
      pieces.push(node.value);
      return;
    }
    if ('tagName' in node) {
      if (['style', 'template', 'noscript'].includes(node.tagName)) return;
      if (node.tagName === 'script') {
        const attrs = new Map(node.attrs.map((a) => [a.name, a.value]));
        if (attrs.get('id') === 'oasis-dashboard' && attrs.get('type') === 'application/json') {
          try {
            pieces.push(
              '\n【看板数据】\n' +
                JSON.stringify(
                  DashboardData.parse(
                    JSON.parse(node.childNodes.map((n) => ('value' in n ? n.value : '')).join('')),
                  ),
                ),
            );
          } catch {
            warning = '看板数据无效，未完成图表内容检查';
          }
        }
        return;
      }
      if (
        ['p', 'div', 'section', 'article', 'tr', 'h1', 'h2', 'h3', 'li', 'br'].includes(
          node.tagName,
        )
      )
        pieces.push('\n');
      if (node.tagName === 'a') {
        const href = node.attrs.find((a) => a.name === 'href')?.value;
        if (href && /^https?:\/\//i.test(href)) pieces.push(`【来源：${href}】`);
      }
    }
    if ('childNodes' in node) for (const child of node.childNodes) visit(child, depth + 1);
  }
  visit(root);
  const text = pieces
    .join('')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n/g, '\n')
    .trim();
  return {
    text,
    ...(warning ? { warning } : !text ? { warning: 'HTML 未提取到正文，内容检查未完成' } : {}),
  };
}
type XmlNode = Record<string, unknown>;
const node = (value: unknown): XmlNode =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as XmlNode) : {};
const array = (value: unknown): XmlNode[] =>
  (value === undefined ? [] : Array.isArray(value) ? value : [value]).map(node);
const child = (value: unknown, ...keys: string[]): unknown =>
  keys.reduce((value, key) => node(value)[key], value);
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : String(node(value)['#text'] ?? '');
const runsText = (value: unknown) =>
  textOf(child(value, 't')) ||
  array(child(value, 'r'))
    .map((run) => textOf(run.t))
    .join('');
globalThis.fetch = () => Promise.reject(new Error('文件解析不允许网络访问'));

function xml(bytes: Uint8Array, ordered = false, removeNSPrefix = true): unknown {
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (/<!\s*(DOCTYPE|ENTITY)/i.test(source)) throw new Error('不接受含 DTD 或自定义实体的 XML');
  if (XMLValidator.validate(source) !== true) throw new Error('XML 结构损坏');
  return new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@',
    removeNSPrefix,
    preserveOrder: ordered,
    parseTagValue: false,
    trimValues: false,
  }).parse(source);
}

function officeParts(
  bytes: Uint8Array,
  limits: InspectionLimits,
  all = false,
): Map<string, Uint8Array> {
  const parts = new Map<string, Uint8Array>();
  let entries = 0;
  let size = 0;
  const unzip = new Unzip((file) => {
    if (++entries > limits.entries) throw new IncompleteInspection('ZIP 条目超过上限');
    if (file.originalSize !== undefined && file.originalSize > limits.unzipBytes)
      throw new IncompleteInspection('ZIP 解压体积超过上限');
    if (
      all &&
      (file.name.startsWith('/') ||
        file.name.includes('\\') ||
        file.name.includes(':') ||
        file.name.split('/').some((s) => s === '..' || s === '.') ||
        file.name.includes('\0'))
    )
      throw new Error('ZIP 成员路径不安全');
    if (file.name.endsWith('/')) return;
    if (!all && !/^(word|ppt|xl)\/.+\.(xml|rels)$/.test(file.name)) return;
    if (parts.has(file.name)) throw new Error('ZIP 成员重复');
    const chunks: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      if (size > limits.unzipBytes) {
        file.terminate();
        throw new IncompleteInspection('ZIP 解压体积超过上限');
      }
      chunks.push(chunk);
      if (final) parts.set(file.name, Buffer.concat(chunks));
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  // 小块输入，避免一个压缩块在回调前生成巨量输出。
  for (let i = 0; i < bytes.length; i += 4096)
    unzip.push(bytes.subarray(i, i + 4096), i + 4096 >= bytes.length);
  return parts;
}

/** 只读取受限 ZIP 内容，核对中央目录、大小和 CRC；绝不执行或落盘成员。 */
function archiveText(bytes: Buffer, limits: InspectionLimits): string {
  let end = bytes.length - 22;
  while (end >= Math.max(0, bytes.length - 65557) && bytes.readUInt32LE(end) !== 0x06054b50) end--;
  if (
    end < 0 ||
    bytes.readUInt32LE(end) !== 0x06054b50 ||
    end + 22 + bytes.readUInt16LE(end + 20) !== bytes.length
  )
    throw new Error('ZIP 中央目录缺失或不完整');
  const count = bytes.readUInt16LE(end + 10);
  if (
    bytes.readUInt16LE(end + 4) ||
    bytes.readUInt16LE(end + 6) ||
    count === 65535 ||
    count > limits.entries
  )
    throw new IncompleteInspection('ZIP 分卷、ZIP64 或成员数量不受支持');
  let cursor = bytes.readUInt32LE(end + 16);
  const directoryEnd = cursor + bytes.readUInt32LE(end + 12);
  if (directoryEnd !== end) throw new Error('ZIP 中央目录位置不符');
  const records = new Map<string, { size: number; crc: number }>();
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50)
      throw new Error('ZIP 中央目录损坏');
    const length = bytes.readUInt16LE(cursor + 28);
    const extra = bytes.readUInt16LE(cursor + 30) + bytes.readUInt16LE(cursor + 32);
    const mode = bytes.readUInt32LE(cursor + 38) >>> 16;
    if ((mode & 0xf000) === 0xa000 || bytes.readUInt16LE(cursor + 8) & 1)
      throw new Error('ZIP 不接受链接或加密成员');
    if (cursor + 46 + length + extra > end) throw new Error('ZIP 成员头损坏');
    const name = new TextDecoder('utf8', { fatal: true }).decode(
      bytes.subarray(cursor + 46, cursor + 46 + length),
    );
    if (records.has(name)) throw new Error('ZIP 成员重复');
    records.set(name, {
      size: bytes.readUInt32LE(cursor + 24),
      crc: bytes.readUInt32LE(cursor + 16),
    });
    cursor += 46 + length + extra;
  }
  if (cursor !== directoryEnd) throw new Error('ZIP 条目数不符');
  const parts = officeParts(bytes, limits, true);
  const lines = ['【ZIP 实际成员清单：路径 / 字节数 / SHA-256】'];
  for (const [name, content] of parts) {
    const entry = records.get(name);
    if (!entry || content.length !== entry.size || crc32(content) !== entry.crc)
      throw new Error('ZIP 成员大小或 CRC 不符');
    lines.push(`${name}\t${content.length}\t${createHash('sha256').update(content).digest('hex')}`);
  }
  if ([...records].some(([name]) => !name.endsWith('/') && !parts.has(name)))
    throw new Error('ZIP 成员缺失');
  for (const [name, content] of parts)
    if (/(^|\/)README[^/]*\.(md|txt)$/i.test(name) && content.length <= 16000)
      lines.push(`【包内 ${name}】\n${new TextDecoder('utf8', { fatal: true }).decode(content)}`);
  return lines.join('\n');
}

function paragraphs(tree: unknown): string {
  if (!Array.isArray(tree)) return '';
  return tree
    .map((item: unknown) =>
      Object.entries(node(item))
        .map(([tag, value]) => {
          if (tag === '#text') return String(value);
          if (tag === ':@') return '';
          if (tag === 'tab') return '\t';
          if (tag === 'br') return '\n';
          return paragraphs(value) + (['p', 'tr'].includes(tag) ? '\n' : tag === 'tc' ? '\t' : '');
        })
        .join(''),
    )
    .join('');
}

function spreadsheet(
  parts: Map<string, Uint8Array>,
  limits: InspectionLimits,
): { text: string; warning?: string } {
  const read = (name: string) => {
    const bytes = parts.get(name);
    if (!bytes) throw new Error(`缺少 Office 部件 ${name}`);
    return xml(bytes);
  };
  const workbook = child(read('xl/workbook.xml'), 'workbook');
  const relationships = array(
    child(read('xl/_rels/workbook.xml.rels'), 'Relationships', 'Relationship'),
  );
  const shared = parts.has('xl/sharedStrings.xml')
    ? array(child(read('xl/sharedStrings.xml'), 'sst', 'si')).map(runsText)
    : [];
  let cells = 0;
  let missingCache = false;
  const lines: string[] = [];
  for (const sheet of array(child(workbook, 'sheets', 'sheet'))) {
    const rel = relationships.find((r) => r['@Id'] === sheet['@id']);
    if (!rel || rel['@TargetMode'] === 'External') throw new Error('工作表引用无效');
    const target = String(rel['@Target'] ?? '');
    const name = posix.normalize(
      target.startsWith('/') ? target.slice(1) : posix.join('xl', target),
    );
    if (!name.startsWith('xl/worksheets/')) throw new Error('工作表引用超出允许范围');
    lines.push(`【工作表：${sheet['@name']}】`);
    for (const row of array(child(read(name), 'worksheet', 'sheetData', 'row')))
      for (const cell of array(row.c)) {
        if (++cells > limits.cells) throw new IncompleteInspection('单元格数量超过解析上限');
        const type = cell['@t'];
        let value = textOf(cell.v);
        if (type === 's') {
          const index = Number(value);
          if (!Number.isInteger(index) || shared[index] === undefined)
            throw new Error('共享字符串引用无效');
          value = shared[index]!;
        } else if (type === 'inlineStr') value = runsText(cell.is);
        const formula = cell.f === undefined ? '' : textOf(cell.f);
        if (cell.f !== undefined && (cell.v === undefined || value === '' || type === 'e'))
          missingCache = true;
        lines.push(`${cell['@r'] ?? '?'}：${formula ? `公式 =${formula}；缓存值 ` : ''}${value}`);
      }
  }
  if (!lines.length) throw new Error('工作簿没有可读取的工作表');
  return {
    text: lines.join('\n'),
    ...(missingCache
      ? { warning: '公式缓存缺失或错误，尚未验证计算结果；须在沙箱重算后核对' }
      : {}),
  };
}

async function inspect(): Promise<InspectedFile & { truncated?: boolean }> {
  const bytes = Buffer.from(data.content);
  const ext = extname(data.path).toLowerCase();
  let text = '';
  let warning: string | undefined;
  let dimensions: { width?: number; height?: number } = {};
  if (['.png', '.jpg', '.jpeg', '.webp'].includes(ext)) {
    const image = sharp(bytes, { limitInputPixels: data.limits.pixels, failOn: 'warning' });
    const meta = await image.metadata();
    const expected = ext === '.jpg' || ext === '.jpeg' ? 'jpeg' : ext.slice(1);
    if (meta.format !== expected || !meta.width || !meta.height || (meta.pages ?? 1) > 1)
      throw new Error('图片格式与扩展名不符或不是单帧图片');
    await image.stats();
    dimensions = { width: meta.width, height: meta.height };
  } else if (ext === '.zip') {
    text = archiveText(bytes, data.limits);
  } else if (['.docx', '.pptx', '.xlsx'].includes(ext)) {
    const parts = officeParts(bytes, data.limits);
    if (ext === '.xlsx') ({ text, warning } = spreadsheet(parts, data.limits));
    else if (ext === '.docx') {
      const document = parts.get('word/document.xml');
      if (!document) throw new Error('缺少 Word 正文');
      text = paragraphs(xml(document, true));
    } else {
      let slides = [...parts.keys()]
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort(
          (a, b) => Number(a.match(/slide(\d+)\.xml/)![1]) - Number(b.match(/slide(\d+)\.xml/)![1]),
        );
      if (parts.has('ppt/presentation.xml') && parts.has('ppt/_rels/presentation.xml.rels')) {
        const local = (value: unknown, name: string) =>
          Object.entries(node(value)).find(
            ([key]) => key === name || key.endsWith(`:${name}`),
          )?.[1];
        const presentation = local(
          xml(parts.get('ppt/presentation.xml')!, false, false),
          'presentation',
        );
        const ids = array(local(local(presentation, 'sldIdLst'), 'sldId'));
        const relationships = array(
          child(
            xml(parts.get('ppt/_rels/presentation.xml.rels')!),
            'Relationships',
            'Relationship',
          ),
        );
        slides = ids.map((slide) => {
          const id = Object.entries(slide).find(
            ([key]) => key.startsWith('@') && key.endsWith(':id'),
          )?.[1];
          const relation = relationships.find((r) => r['@Id'] === id);
          if (!relation || relation['@TargetMode'] === 'External')
            throw new Error('幻灯片引用无效');
          const target = String(relation['@Target'] ?? '');
          const name = posix.normalize(
            target.startsWith('/') ? target.slice(1) : posix.join('ppt', target),
          );
          if (!name.startsWith('ppt/slides/') || !parts.has(name))
            throw new Error('幻灯片引用超出范围或部件缺失');
          return name;
        });
      }
      if (!slides.length) throw new Error('PPT 页数为空');
      if (slides.length > data.limits.pages) throw new IncompleteInspection('PPT 页数超过上限');
      text = slides
        .map((name, i) => `【幻灯片 ${i + 1}】\n${paragraphs(xml(parts.get(name)!, true))}`)
        .join('\n');
    }
    if (!text.trim()) warning = '未提取到正文，内容检查未完成';
  } else if (ext === '.glb') {
    text = await inspectGlb(bytes, data.limits.pixels);
    warning = '只完成几何结构与资源检查；外观、尺寸用途和动画仍需独立核验';
  } else if (ext === '.pdf') {
    const pdf = await getDocumentProxy(new Uint8Array(bytes), {
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
      verbosity: 0,
    });
    try {
      if (pdf.numPages > data.limits.pages) throw new IncompleteInspection('PDF 页数超过上限');
      const pages: string[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        const page = await pdf.getPage(n);
        const content = await page.getTextContent();
        pages.push(
          `【第 ${n} 页】\n${content.items.map((item) => ('str' in item ? item.str : '')).join(' ')}`,
        );
        page.cleanup();
      }
      text = pages.join('\n');
      if (!text.replace(/【第 \d+ 页】/g, '').trim())
        warning = 'PDF 无可提取正文（可能为扫描件），内容检查未完成';
    } finally {
      await pdf.loadingTask.destroy();
    }
  } else if (ext === '.html' || ext === '.htm') {
    ({ text, warning } = htmlContent(bytes));
  } else if (
    /\.(md|markdown|txt|html?|css|js|mjs|ts|tsx|jsx|jsonl?|csv|tsv|xml|ya?ml|py|sql|svg)$/.test(ext)
  ) {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) throw new Error('文本包含二进制内容');
    if (ext === '.json') JSON.parse(text);
    if (ext === '.jsonl')
      for (const line of text.split(/\r?\n/).filter((line) => line.trim())) JSON.parse(line);
  } else
    return {
      path: data.path,
      text: '',
      valid: false,
      warning: '此格式未解析，需查看配套说明或人工核对',
    };
  const truncated = text.length > data.maxChars;
  return {
    path: data.path,
    text: text.slice(0, data.maxChars),
    valid: true,
    ...dimensions,
    ...(warning ? { warning } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

void inspect()
  .then((result) => parentPort!.postMessage(result))
  .catch((error: unknown) => {
    parentPort!.postMessage({
      path: data.path,
      text: '',
      valid: false,
      error: error instanceof Error ? error.message : '文件解析失败',
      errorKind:
        error instanceof IncompleteInspection ||
        error instanceof GeometryLimit ||
        (error instanceof Error && error.message.includes('pixel limit'))
          ? 'incomplete'
          : 'invalid',
    });
  });
