// 标注 PDF 和演示文稿时才用到的 pdf.js（ADR 0012 §9）：按需加载，worker 随应用打包，不走 CDN；
// 6.x 本身不再用 eval；不渲染 XFA 表单、不执行 PDF 里的脚本，只把页面画到画布上。
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

GlobalWorkerOptions.workerSrc = workerUrl;

export type PdfDocument = PDFDocumentProxy;

/** 同源地址（成果内容接口），带登录 Cookie */
export function openPdf(url: string): { promise: Promise<PdfDocument>; destroy: () => void } {
  const task = getDocument({
    url,
    withCredentials: true,
    enableXfa: false,
    disableFontFace: false,
    useSystemFonts: true,
  });
  return { promise: task.promise, destroy: () => void task.destroy() };
}

/** 把第 page 页画到画布上，宽度不超过 maxWidth（像素） */
export async function renderPage(
  doc: PdfDocument,
  page: number,
  canvas: HTMLCanvasElement,
  maxWidth: number,
): Promise<void> {
  const pdfPage = await doc.getPage(page);
  const base = pdfPage.getViewport({ scale: 1 });
  const viewport = pdfPage.getViewport({ scale: Math.min(3, maxWidth / base.width) });
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  await pdfPage.render({ canvas, viewport }).promise;
}
