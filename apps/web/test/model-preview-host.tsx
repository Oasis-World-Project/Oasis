// Browser/Electron fixture entry; served only by scripts/model-preview.mjs, absent from production routes.
import { createRoot } from 'react-dom/client';
import { useEffect, useState } from 'react';
import { PreviewBody, type PreviewFile } from '../src/chat/FilePreview.tsx';
import '../src/styles.css';

function Host() {
  const [files, setFiles] = useState<(PreviewFile & { label: string })[]>([]);
  const [selected, setSelected] = useState<PreviewFile | null>(null);
  useEffect(() => {
    void fetch('/model-preview-fixtures')
      .then((response) => response.json())
      .then(setFiles);
  }, []);
  return (
    <main className="h-screen bg-ground p-5 font-sans text-ink">
      <h1 className="m-0 text-xl">Oasis · 3D 预览验证</h1>
      <div className="flex gap-2 py-3">
        {files.map((file) => (
          <button
            key={file.label}
            className="rounded-full border border-hairline bg-glass-active px-4 py-2 text-sm"
            type="button"
            onClick={() => setSelected(file)}
          >
            {file.label}
          </button>
        ))}
        <button
          type="button"
          className="rounded-full border border-hairline bg-glass-active px-4 py-2 text-sm"
          onClick={() => setSelected(null)}
        >
          关闭模型
        </button>
      </div>
      <div className="h-[calc(100%-100px)] overflow-hidden rounded-panel bg-glass-active shadow-panel">
        {selected ? (
          <PreviewBody file={selected} />
        ) : (
          <p className="p-6 text-sm text-ink-muted">选择模型开始验证。列表不启动 WebGL。</p>
        )}
      </div>
    </main>
  );
}
if (new URLSearchParams(location.search).has('weak'))
  Object.defineProperty(navigator, 'hardwareConcurrency', { configurable: true, value: 1 });
createRoot(document.getElementById('root')!).render(<Host />);
