// 网页和静态应用在画布里直接运行（ADR 0009 §17）：sandbox 框只给脚本权限，CSP 禁网；画面由本机浏览器渲染，可直接拖动、点选、键盘操作。
// 报告类网页可以切到「只看内容」：沿用清洗后的无脚本预览（含看板）。
import { RotateCcw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { readPreviewFile } from '../api/file-preview.ts';
import { DocumentPreview } from './DocumentPreview.tsx';
import { LIVE_SANDBOX, livePage, type LivePage } from './live-page.ts';

/** 单个文件和整个网页的读取上限：保护本机内存，不是时限 */
const FILE_LIMIT = 64 * 1024 * 1024;
const TOTAL_LIMIT = 256 * 1024 * 1024;
/** 网页自己连续跳走这么多次就不再拉回，避免来回重载 */
const MAX_RETURNS = 3;

export interface LiveAsset {
  path: string;
  url: string;
}

const button =
  'inline-flex h-8 shrink-0 items-center gap-1 rounded-full border-0 bg-glass-active px-3 text-[12.5px] text-ink shadow-edge-strong';

export function LivePreview({
  file,
  name,
  root,
  assets = [],
  allowStatic = false,
  onFallback,
}: {
  file: LiveAsset;
  name: string;
  /** 以 / 开头的地址从这里算（应用根目录或网页所在目录） */
  root: string;
  /** 同一成果里能被网页引用的其他文件 */
  assets?: LiveAsset[];
  /** 报告类网页可切到无脚本的静态内容 */
  allowStatic?: boolean;
  /** 本机框里加载不全时，改用平台容器预览 */
  onFallback?: () => void;
}) {
  const [state, setState] = useState<{
    url: string;
    page?: LivePage;
    error?: string;
    dashboard?: boolean;
  }>({
    url: file.url,
  });
  const [mode, setMode] = useState<'live' | 'static' | null>(null);
  const [run, setRun] = useState(0);
  const [returns, setReturns] = useState(0);
  const [stopped, setStopped] = useState(false);
  const loads = useRef(0);
  const assetKey = assets.map((a) => `${a.path}\n${a.url}`).join('\n');

  useEffect(() => {
    const controller = new AbortController();
    const urls = new Map(assets.map((a) => [a.path, a.url]));
    let total = 0;
    const take = async (url: string) => {
      const bytes = await readPreviewFile(url, controller.signal, FILE_LIMIT);
      total += bytes.length;
      if (total > TOTAL_LIMIT) throw new Error('网页文件合计超过预览上限，请下载查看');
      return bytes;
    };
    const go = async () => {
      const source = new TextDecoder().decode(await take(file.url));
      const page = await livePage(source, file.path, root, async (path) => {
        const url = urls.get(path);
        return url ? take(url) : undefined;
      });
      if (!controller.signal.aborted)
        setState({ url: file.url, page, dashboard: /id=["']?oasis-dashboard/.test(source) });
    };
    void go().catch((err: unknown) => {
      if (controller.signal.aborted) return;
      setState({
        url: file.url,
        error:
          err instanceof Error && err.message.includes('上限')
            ? err.message
            : '网页没能打开，请下载后查看。',
      });
    });
    return () => controller.abort();
    // assets 以 assetKey 比较内容，避免每次渲染新数组都重读
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.url, file.path, root, assetKey]);

  useEffect(() => {
    loads.current = 0;
  }, [run]);

  const restart = () => {
    setReturns(0);
    setStopped(false);
    setRun((r) => r + 1);
  };

  if (state.url !== file.url || (!state.page && !state.error))
    return <p className="m-0 p-6 text-sm text-ink-muted">正在打开…</p>;
  if (state.error) return <p className="m-0 p-6 text-sm text-accent">{state.error}</p>;
  const page = state.page!;
  const shown = mode ?? (allowStatic && state.dashboard ? 'static' : 'live');

  return (
    <div className="flex h-full min-h-[600px] flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-2">
        <span className="min-w-0 flex-1 text-[12px] text-ink-muted">
          {shown === 'live'
            ? '在隔离环境中运行：不能联网，读不到你的账号和其他数据。'
            : '只看内容：不运行网页里的脚本。'}
        </span>
        {shown === 'live' && (
          <button type="button" className={button} onClick={restart}>
            <RotateCcw size={13} aria-hidden="true" />
            重新运行
          </button>
        )}
        {allowStatic && (
          <button
            type="button"
            className={button}
            onClick={() => setMode(shown === 'live' ? 'static' : 'live')}
          >
            {shown === 'live' ? '只看内容' : '运行网页'}
          </button>
        )}
        {onFallback && (
          <button type="button" className={button} onClick={onFallback}>
            平台容器预览
          </button>
        )}
      </div>
      {shown === 'live' && page.missing.length > 0 && (
        <p role="status" className="m-0 border-b border-hairline px-4 py-2 text-[12px] text-accent">
          有 {page.missing.length} 个文件没能在这里加载，画面可能不完整：
          {page.missing.slice(0, 5).join('、')}
          {page.missing.length > 5 ? ' 等' : ''}
          {onFallback ? '。可以改用平台容器预览。' : '。'}
        </p>
      )}
      {shown === 'live' && stopped ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 p-10 text-center">
          <p className="m-0 text-sm text-accent">网页一直试图打开别的地址，已停止运行。</p>
          <button type="button" className={button} onClick={restart}>
            再运行一次
          </button>
        </div>
      ) : shown === 'live' ? (
        <iframe
          key={run}
          title={name}
          srcDoc={page.html}
          sandbox={LIVE_SANDBOX}
          allow="autoplay; fullscreen"
          referrerPolicy="no-referrer"
          onLoad={() => {
            // 第一次是自己的内容；之后再加载说明网页把框导航到了别处，拉回原页面
            loads.current += 1;
            if (loads.current <= 1) return;
            if (returns < MAX_RETURNS) {
              setReturns((n) => n + 1);
              setRun((r) => r + 1);
            } else setStopped(true);
          }}
          className="min-h-0 w-full flex-1 border-0 bg-white"
        />
      ) : (
        <DocumentPreview url={file.url} name={name} html />
      )}
    </div>
  );
}
