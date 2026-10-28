import { useEffect, useRef, useState } from 'react';
import {
  ModelPreviewBody,
  ModelPreviewSource,
  MODEL_PREVIEW_LIMITS as L,
  type ModelPreviewBody as Descriptor,
} from '@oasis/contracts/model-preview';
import { readPreviewFile } from '../api/file-preview.ts';
import type { PreviewFile } from '../chat/files.ts';

function sourceOf(url: string) {
  const artifact = /^\/api\/canvas\/v1\/artifacts\/([^/?]+)\/content(?:\?|$)/.exec(url);
  const upload = /^\/api\/canvas\/v1\/uploads\/([^/?]+)(?:\?|$)/.exec(url);
  const task = /^\/api\/task\/v1\/tasks\/([^/]+)\/files\/([^/]+)\/([^?#]+)/.exec(url);
  try {
    const parsed = ModelPreviewSource.safeParse(
      artifact
        ? { kind: 'artifact', id: artifact[1] }
        : upload
          ? { kind: 'upload', id: upload[1] }
          : task
            ? { kind: 'task', taskId: task[1], nodeId: task[2], path: decodeURIComponent(task[3]!) }
            : null,
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
function weakDevice() {
  const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  return (
    (memory !== undefined && memory <= 2) ||
    (navigator.hardwareConcurrency > 0 && navigator.hardwareConcurrency <= 2)
  );
}
const button =
  'rounded-full border border-hairline bg-glass-active px-3 py-1.5 text-xs text-ink disabled:opacity-40';

function ModelPreviewSession({ file }: { file: PreviewFile }) {
  const [descriptor, setDescriptor] = useState<Descriptor | null>(null);
  const [error, setError] = useState(() =>
    sourceOf(file.url) ? '' : '此文件暂不支持受保护的模型预览。',
  );
  const [mode, setMode] = useState<'auto' | 'static' | 'interactive'>('auto');
  const [media, setMedia] = useState<'poster' | 'video'>('poster');
  const [frame, setFrame] = useState<{ html: string; bytes: ArrayBuffer; nonce: string } | null>(
    null,
  );
  const [ready, setReady] = useState(false),
    [playing, setPlaying] = useState(false);
  const [structure, setStructure] = useState(false);
  const [dimensions, setDimensions] = useState<number[] | null>(null);
  const [released, setReleased] = useState(false);
  const [releaseReport, setReleaseReport] = useState<Record<string, unknown> | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failedMedia, setFailedMedia] = useState<string[]>([]);
  const frameRef = useRef<HTMLIFrameElement>(null),
    portRef = useRef<MessagePort | null>(null);
  const releaseRef = useRef<(() => void) | null>(null);
  const fallbackAvailable =
    (!!descriptor?.poster && !failedMedia.includes('poster')) ||
    (!!descriptor?.turntable && !failedMedia.includes('video'));
  const interactive =
    !!descriptor?.glb &&
    mode !== 'static' &&
    (mode === 'interactive' || !weakDevice() || !fallbackAvailable);
  useEffect(() => {
    const controller = new AbortController(),
      source = sourceOf(file.url);
    if (!source) return;
    void fetch('/api/canvas/v1/model-previews', {
      method: 'POST',
      credentials: 'same-origin',
      redirect: 'error',
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(source),
    })
      .then(async (response) => {
        if (!response.ok) throw new Error('Preview unavailable');
        return ModelPreviewBody.parse(await response.json());
      })
      .then((data) => {
        if (!controller.signal.aborted) setDescriptor(data);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setError('暂时无法打开模型预览，请稍后重试或手动下载原件。');
      });
    return () => controller.abort();
  }, [file.url, attempt]);
  useEffect(() => {
    if (!interactive || !descriptor?.glb) return;
    const controller = new AbortController();
    let worker: Worker | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    void (async () => {
      const [content, script] = await Promise.all([
        readPreviewFile(
          descriptor.glb!.url,
          AbortSignal.any([controller.signal, AbortSignal.timeout(20000)]),
          L.bytes,
        ),
        import('virtual:oasis-model-viewer'),
      ]);
      if (controller.signal.aborted) return;
      const checked = await new Promise<ArrayBuffer>((resolve, reject) => {
        worker = new Worker(new URL('./model-parser.worker.ts', import.meta.url), {
          type: 'module',
        });
        timeout = setTimeout(() => {
          worker?.terminate();
          reject(new Error('Model parsing timeout'));
        }, 10000);
        controller.signal.addEventListener(
          'abort',
          () => {
            worker?.terminate();
            reject(new Error('Aborted'));
          },
          { once: true },
        );
        worker.onmessage = (event) => {
          clearTimeout(timeout);
          worker?.terminate();
          if (event.data.error) reject(new Error('Model rejected'));
          else resolve(event.data.bytes as ArrayBuffer);
        };
        worker.onerror = () => {
          clearTimeout(timeout);
          worker?.terminate();
          reject(new Error('Model worker failed'));
        };
        worker.postMessage({ bytes: content.buffer, sha256: descriptor.glb!.sha256 }, [
          content.buffer,
        ]);
      });
      if (controller.signal.aborted) return;
      const nonce = crypto.randomUUID();
      const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src blob:; connect-src blob:; worker-src 'none'; base-uri 'none'; form-action 'none'`;
      const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style nonce="${nonce}">html,body{margin:0;width:100%;height:100%;overflow:hidden}canvas{display:block;touch-action:none}</style><script nonce="${nonce}">window.__OASIS_MODEL_NONCE__=${JSON.stringify(nonce)};${script.default.replace(/<\/script/gi, '<\\/script')}</script>`;
      setFrame({ html, bytes: checked, nonce });
    })().catch(() => {
      if (!controller.signal.aborted) {
        setError('交互预览不可用，已切换配套图片/视频。');
        setFrame(null);
        setReady(false);
        setMode('static');
      }
    });
    return () => {
      controller.abort();
      clearTimeout(timeout);
      worker?.terminate();
      portRef.current?.postMessage({ type: 'dispose' });
      portRef.current?.close();
      portRef.current = null;
    };
  }, [descriptor, interactive]);
  function connect() {
    if (!frame || !frameRef.current?.contentWindow) return;
    const channel = new MessageChannel();
    portRef.current?.close();
    portRef.current = channel.port1;
    channel.port1.onmessage = (event) => {
      const data = event.data as Record<string, unknown>;
      if (data.type === 'ready') {
        if (
          Array.isArray(data.dimensions) &&
          data.dimensions.length === 3 &&
          data.dimensions.every((v) => typeof v === 'number' && Number.isFinite(v))
        )
          setDimensions(data.dimensions as number[]);
        setReady(true);
        setStructure(data.structure === true);
      }
      if (data.type === 'error') {
        setError('交互预览不可用，已切换配套图片/视频。');
        setFrame(null);
        setReady(false);
        setMode('static');
      }
      if (data.type === 'disposed') {
        setReleaseReport(data);
        const memory = data.memory as { geometries?: number; textures?: number } | undefined;
        // Three retains its internal DFG LUT in info.memory; losing this isolated
        // context releases that GPU allocation too. Do not rewrite the raw counter.
        setReleased(
          data.urls === 0 &&
            data.frame === 0 &&
            data.contextLost === true &&
            (memory?.geometries === 0 || data.structure === true),
        );
        releaseRef.current?.();
        releaseRef.current = null;
      }
    };
    channel.port1.start();
    frameRef.current.contentWindow.postMessage({ type: 'connect', nonce: frame.nonce }, '*', [
      channel.port2,
    ]);
    const style = getComputedStyle(document.documentElement);
    channel.port1.postMessage(
      {
        type: 'load',
        bytes: frame.bytes,
        structure: weakDevice() && mode !== 'interactive',
        fallbackAvailable,
        theme: {
          light: style.getPropertyValue('--oasis-on-solid').trim(),
          ground: style.getPropertyValue('--oasis-ground').trim(),
        },
      },
      [frame.bytes],
    );
  }
  async function staticMode() {
    setPlaying(false);
    if (portRef.current)
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(resolve, 1000);
        releaseRef.current = () => {
          clearTimeout(timeout);
          resolve();
        };
        portRef.current!.postMessage({ type: 'dispose' });
      });
    setMode('static');
    setReady(false);
    setFrame(null);
  }
  const send = (type: string) => portRef.current?.postMessage({ type });
  const fallback =
    descriptor?.turntable &&
    !failedMedia.includes('video') &&
    (media === 'video' || !descriptor.poster || failedMedia.includes('poster')) ? (
      <video
        key={descriptor.turntable.url}
        src={descriptor.turntable.url}
        controls
        playsInline
        preload="metadata"
        onError={() => setFailedMedia((previous) => [...previous, 'video'])}
        className="max-h-full max-w-full rounded-item"
      />
    ) : descriptor?.poster && !failedMedia.includes('poster') ? (
      <img
        src={descriptor.poster.url}
        alt="模型配套渲染图"
        onError={() => setFailedMedia((previous) => [...previous, 'poster'])}
        className="max-h-full max-w-full rounded-item object-contain"
      />
    ) : (
      <p className="p-6 text-sm text-ink-muted">没有可用的配套图片/视频，可手动下载原件查看。</p>
    );
  return (
    <section
      aria-label="3D 模型预览"
      data-model-released={released ? 'true' : undefined}
      data-model-release={releaseReport ? JSON.stringify(releaseReport) : undefined}
      className="flex h-full min-h-[360px] flex-col"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-4 py-3">
        <span className="mr-auto text-sm text-ink">
          {descriptor?.simplified ? '轻量预览 · 原件未替换' : '模型预览'}
        </span>
        {descriptor?.glb && (
          <button
            type="button"
            className={button}
            onClick={() => {
              setError('');
              setReleased(false);
              setReady(false);
              setFrame(null);
              setMode('interactive');
            }}
            disabled={interactive}
          >
            交互预览
          </button>
        )}
        <button
          type="button"
          className={button}
          onClick={() => void staticMode()}
          disabled={!interactive}
        >
          静态预览
        </button>
        {descriptor?.poster && descriptor.turntable && !interactive && (
          <>
            <button type="button" className={button} onClick={() => setMedia('poster')}>
              图片
            </button>
            <button type="button" className={button} onClick={() => setMedia('video')}>
              转台视频
            </button>
          </>
        )}
      </div>
      <div className="relative min-h-[280px] flex-1 overflow-hidden">
        {interactive && frame ? (
          <iframe
            ref={frameRef}
            title="3D 模型查看器"
            sandbox="allow-scripts"
            referrerPolicy="no-referrer"
            srcDoc={frame.html}
            onLoad={connect}
            className="absolute inset-0 size-full border-0"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center p-4">
            {descriptor ? (
              fallback
            ) : (
              <p className="text-sm text-ink-muted">{error || '正在检查模型…'}</p>
            )}
          </div>
        )}
        {interactive && !ready && (
          <p
            role="status"
            className="absolute left-4 top-0 rounded-item bg-glass-active p-3 text-sm text-ink-muted"
          >
            正在准备交互预览…
          </p>
        )}
      </div>
      {interactive && ready && (
        <div className="flex flex-wrap items-center justify-center gap-2 border-t border-hairline px-4 py-2">
          {(
            [
              ['left', '向左旋转'],
              ['right', '向右旋转'],
              ['zoom-in', '放大'],
              ['zoom-out', '缩小'],
              ['pan-left', '向左平移'],
              ['pan-right', '向右平移'],
              ['reset', '复位'],
              ['fit', '适配画面'],
            ] as const
          ).map(([type, text]) => (
            <button key={type} className={button} type="button" onClick={() => send(type)}>
              {text}
            </button>
          ))}
          {!structure && !!descriptor?.glb?.report.animations.length && (
            <>
              <select
                aria-label="模型动画"
                className={button}
                onChange={(event) =>
                  portRef.current?.postMessage({ type: 'clip', index: Number(event.target.value) })
                }
              >
                {descriptor.glb.report.animations.map((clip, i) => (
                  <option key={i} value={i}>
                    {clip.name}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className={button}
                onClick={() => {
                  portRef.current?.postMessage({ type: 'play', playing: !playing });
                  setPlaying(!playing);
                }}
              >
                {playing ? '暂停动画' : '播放动画'}
              </button>
            </>
          )}
        </div>
      )}
      <div className="border-t border-hairline px-4 py-2 text-xs leading-relaxed text-ink-muted">
        {descriptor && error && (
          <p role="status" className="m-0 text-accent">
            {error}
          </p>
        )}
        {!descriptor && error && sourceOf(file.url) && (
          <button
            type="button"
            className={button}
            onClick={() => {
              setError('');
              setAttempt((value) => value + 1);
            }}
          >
            重试预览
          </button>
        )}
        {descriptor?.warning && <p className="m-0">{descriptor.warning}</p>}
        {interactive && ready && structure && (
          <p className="m-0">
            低负载结构预览：最多抽样显示 4000 个三角面，不呈现完整贴图、灯光或动画，不作为成品验收。
          </p>
        )}
        <p className="m-0">
          {interactive ? '拖动旋转，滚轮缩放，Shift + 拖动平移。' : '静态模式不启动 WebGL。'}{' '}
          预览不会自动保存到电脑。
        </p>
        {dimensions && (
          <p className="m-0">
            显示范围 {dimensions.map((n) => Number(n.toPrecision(4))).join(' × ')} m（glTF
            坐标）；原件的真实尺寸尚未核验。
          </p>
        )}
        {descriptor?.glb && (
          <details>
            <summary>查看检查范围</summary>
            <p>
              {descriptor.glb.report.vertices.toLocaleString()} 顶点 ·{' '}
              {descriptor.glb.report.triangles.toLocaleString()} 三角面；未检查：
              {descriptor.glb.report.unchecked.join('、')}。
            </p>
          </details>
        )}
      </div>
    </section>
  );
}

export function ModelPreview({ file }: { file: PreviewFile }) {
  return <ModelPreviewSession key={file.url} file={file} />;
}
