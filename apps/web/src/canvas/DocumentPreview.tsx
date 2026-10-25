import type { FilePreviewBody } from '@oasis/contracts/canvas';
import { useEffect, useState } from 'react';
import { convertPreview, readPreviewFile } from '../api/file-preview.ts';
import { Dashboard } from './Dashboard.tsx';
import { safeHtml } from './safe-html.ts';

function HtmlPreview({ source, name }: { source: string; name: string }) {
  const result = safeHtml(source);
  return (
    <div className="flex min-h-full flex-col">
      {result.warning && <p className="px-6 text-sm text-accent">{result.warning}</p>}
      {result.dashboard && <Dashboard data={result.dashboard} />}
      <iframe
        title={name}
        srcDoc={result.html}
        sandbox=""
        referrerPolicy="no-referrer"
        className="min-h-[600px] w-full flex-1 border-0 bg-glass-active"
      />
      {result.links.length > 0 && (
        <nav aria-label="报告中的外链" className="border-t border-hairline p-6">
          <h2 className="m-0 mb-3 text-sm font-medium">报告中的外链</h2>
          <ul className="m-0 space-y-2 pl-5 text-sm">
            {result.links.map((link) => (
              <li key={link.url}>
                <a
                  href={link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent"
                >
                  {link.label}
                </a>
                <span className="ml-2 break-all text-xs text-ink-muted">
                  {new URL(link.url).hostname}
                </span>
              </li>
            ))}
          </ul>
        </nav>
      )}
    </div>
  );
}

function TablePreview({ data }: { data: Extract<FilePreviewBody, { kind: 'table' }> }) {
  const [index, setIndex] = useState(0);
  const sheet = data.sheets[index] ?? data.sheets[0];
  return (
    <div className="p-6">
      {data.sheets.length > 1 && (
        <label className="text-sm">
          工作表{' '}
          <select
            aria-label="工作表"
            value={index}
            onChange={(e) => setIndex(Number(e.target.value))}
            className="mb-4 rounded-item border border-hairline bg-glass-active px-3 py-2 text-ink"
          >
            {data.sheets.map((s, i) => (
              <option key={i} value={i}>
                {s.name}
              </option>
            ))}
          </select>
        </label>
      )}
      {data.warning && <p className="text-sm text-ink-muted">{data.warning}</p>}
      {sheet?.truncated && (
        <p className="text-sm text-accent">仅显示前 1000 行，完整内容请下载。</p>
      )}
      {!sheet?.rows.length ? (
        <p className="text-sm text-ink-muted">此表没有数据。</p>
      ) : (
        <div className="overflow-auto">
          <table aria-label={sheet.name} className="w-full border-collapse text-left text-sm">
            <tbody>
              {sheet.rows.map((row, i) => (
                <tr key={i}>
                  {row.map((cell, j) => (
                    <td
                      key={j}
                      className={`max-w-[480px] whitespace-pre-wrap break-words border border-hairline px-3 py-2 ${i === 0 ? 'bg-glass-strong font-medium' : ''}`}
                    >
                      {cell === null ? '' : String(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function DocumentPreview({
  url,
  name,
  html = false,
}: {
  url: string;
  name: string;
  html?: boolean;
}) {
  const [state, setState] = useState<{ url: string; data?: FilePreviewBody; error?: string }>({
    url,
  });
  useEffect(() => {
    const controller = new AbortController();
    const run = async () => {
      const data: FilePreviewBody = html
        ? {
            kind: 'html',
            html: new TextDecoder().decode(
              await readPreviewFile(url, controller.signal, 2 * 1024 * 1024),
            ),
          }
        : await convertPreview(url, name, controller.signal);
      if (data.kind === 'html') safeHtml(data.html); // 解析异常也走同一个下载提示。
      if (!controller.signal.aborted) setState({ url, data });
    };
    void run().catch(() => {
      if (!controller.signal.aborted) setState({ url, error: '文件没能安全预览，请下载后查看。' });
    });
    return () => controller.abort();
  }, [url, name, html]);
  if (state.url !== url || (!state.data && !state.error))
    return <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>;
  if (state.error) return <p className="m-0 p-6 text-sm text-accent">{state.error}</p>;
  const data = state.data!;
  return data.kind === 'html' ? (
    <>
      {!html && (
        <p className="m-0 border-b border-hairline px-6 py-3 text-xs text-ink-muted">
          Word 正文预览，原始版式请下载查看。
        </p>
      )}
      <HtmlPreview source={data.html} name={name} />
    </>
  ) : (
    <TablePreview key={url} data={data} />
  );
}
