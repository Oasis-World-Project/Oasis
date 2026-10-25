import { extname } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { FilePreviewBody } from '@oasis/contracts/canvas';
import { Unzip, UnzipInflate } from 'fflate';
import type { PreviewLimits } from './preview-service.ts';

const data = workerData as { name: string; content: Uint8Array; limits: PreviewLimits };
globalThis.fetch = async () => {
  throw new Error('预览转换不允许联网');
};

/** 对全部条目计数并实际解压计量，不能信任 ZIP 头里的原始长度。 */
function checkOffice(bytes: Buffer): void {
  let count = 0;
  let size = 0;
  const unzip = new Unzip((file) => {
    if (++count > data.limits.entries) throw new Error('Office 条目过多');
    if (
      file.name.includes('\\') ||
      file.name.startsWith('/') ||
      file.name.split('/').includes('..')
    )
      throw new Error('Office 包含不安全路径');
    const xml: Uint8Array[] = [];
    file.ondata = (error, chunk, final) => {
      if (error) throw error;
      size += chunk.length;
      if (size > data.limits.unzipBytes) {
        file.terminate();
        throw new Error('Office 解压体积过大');
      }
      if (/\.(xml|rels)$/i.test(file.name)) {
        xml.push(chunk);
        if (final && /<!DOCTYPE|<!ENTITY/i.test(Buffer.concat(xml).toString('utf8')))
          throw new Error('Office 不允许 DTD 或自定义实体');
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let n = 0; n < bytes.length; n += 4096)
    unzip.push(bytes.subarray(n, n + 4096), n + 4096 >= bytes.length);
  if (!count) throw new Error('Office 文件损坏');
}

function cell(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (typeof value === 'boolean') return value;
  return (
    value instanceof Date
      ? value.toISOString()
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)
  ).slice(0, 20_000);
}

function sheet(name: string, rows: unknown[][]) {
  if (rows.some((row) => row.length > 100) || rows.reduce((n, row) => n + row.length, 0) > 100_000)
    throw new Error('表格超过 100 列或 100000 个单元格');
  return {
    name: name.slice(0, 200),
    rows: rows.slice(0, 1000).map((row) => row.map(cell)),
    truncated: rows.length > 1000,
  };
}

/** CSV 双引号、双写引号、引号内换行；行列上限在解析时执行。 */
function delimited(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    value = '',
    quoted = false,
    closed = false;
  const field = () => {
    row.push(value);
    value = '';
    closed = false;
    if (row.length > 100) throw new Error('表格超过 100 列');
  };
  for (let n = 0; n < text.length; n++) {
    const c = text[n]!;
    if (c === '"') {
      if (quoted && text[n + 1] === '"') {
        value += '"';
        n++;
      } else if (quoted) {
        quoted = false;
        closed = true;
      } else if (closed || value.length) throw new Error('CSV 引号位置无效');
      else quoted = true;
    } else if (!quoted && c === delimiter) field();
    else if (!quoted && (c === '\n' || c === '\r')) {
      field();
      rows.push(row);
      row = [];
      if (c === '\r' && text[n + 1] === '\n') n++;
      if (rows.length > 1000) return rows;
    } else {
      if (closed) throw new Error('CSV 引号结束后有多余内容');
      value += c;
    }
    if (value.length > 20_000) throw new Error('单元格文字过长');
  }
  if (quoted) throw new Error('CSV 引号未闭合');
  if (value || row.length) {
    field();
    rows.push(row);
  }
  return rows;
}

async function convert(): Promise<FilePreviewBody> {
  const bytes = Buffer.from(data.content);
  const ext = extname(data.name).toLowerCase();
  if (ext === '.docx' || ext === '.xlsx') checkOffice(bytes);
  if (ext === '.docx') {
    const { default: mammoth } = await import('mammoth');
    const result = await mammoth.convertToHtml({ buffer: bytes }, { externalFileAccess: false });
    if (Buffer.byteLength(result.value) > 2 * 1024 * 1024) throw new Error('Word 正文超过预览上限');
    return { kind: 'html', html: result.value };
  }
  if (ext === '.xlsx') {
    const { default: readXlsxFile } = await import('read-excel-file/node');
    const sheets = await readXlsxFile(bytes);
    if (!sheets.length || sheets.length > 20) throw new Error('工作表数量为空或超过 20');
    return {
      kind: 'table',
      sheets: sheets.map((s) => sheet(s.sheet, s.data)),
      warning: '显示已保存的公式缓存值；预览不会重算公式。',
    };
  }
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
  if (text.includes('\0')) throw new Error('文件不是 UTF-8 文本');
  if (ext === '.csv' || ext === '.tsv')
    return {
      kind: 'table',
      sheets: [sheet(data.name, delimited(text, ext === '.tsv' ? '\t' : ','))],
    };
  if (ext === '.jsonl') {
    const lines = text.split(/\r?\n/).filter((line) => line.trim());
    const records: unknown[] = lines.slice(0, 1001).map((line) => JSON.parse(line));
    const keys = [
      ...new Set(
        records.flatMap((value) =>
          value && typeof value === 'object' && !Array.isArray(value) ? Object.keys(value) : ['值'],
        ),
      ),
    ];
    const rows = records.map((value) =>
      keys.map((key) =>
        value && typeof value === 'object' && !Array.isArray(value)
          ? (value as Record<string, unknown>)[key]
          : key === '值'
            ? value
            : null,
      ),
    );
    const result = sheet(data.name, [keys, ...rows]);
    result.truncated = lines.length > 999;
    return { kind: 'table', sheets: [result] };
  }
  throw new Error('此格式暂不支持转换预览');
}

void convert()
  .then((result) => parentPort!.postMessage({ result }))
  .catch(() => {
    parentPort!.postMessage({ error: '文件格式损坏、不受支持或超过安全解析上限，请下载查看。' });
  });
