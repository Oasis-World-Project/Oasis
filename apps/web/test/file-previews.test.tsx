import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeHtml } from '../src/canvas/safe-html.ts';
import { PreviewBody } from '../src/chat/FilePreview.tsx';
import { readPreviewFile } from '../src/api/file-preview.ts';
import { syncOnce } from '../src/desktop/sync.ts';
import type { OasisDesktop } from '@oasis/contracts/desktop';
import type { ArtifactBody } from '@oasis/contracts/canvas';
import { ModelPreview } from '../src/canvas/ModelPreview.tsx';

afterEach(() => vi.unstubAllGlobals());
const file = {
  path: '报告.html',
  size: 100,
  url: '/api/canvas/v1/artifacts/1/content',
  downloadUrl: '/api/canvas/v1/artifacts/1/content?download=1',
};
describe('安全格式预览', () => {
  it('没有授权同步文件夹时，即使有新成果也不下载或写入用户电脑', async () => {
    const fetcher = vi.fn();
    const beginSyncedFile = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    await syncOnce(
      { beginSyncedFile } as unknown as OasisDesktop,
      [{ id: 'new-artifact' }] as ArtifactBody[],
      { folder: null, synced: [] },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(beginSyncedFile).not.toHaveBeenCalled();
  });
  it('重建 HTML 去除脚本、事件、资源、跳转和嵌套内容；外链只留给父应用', () => {
    const result = safeHtml(
      '<head class="x"><meta http-equiv="refresh" content="0;url=https://evil.test"><base href="https://evil.test"><style>@import "https://evil.test/css";</style></head><body onload="fetch(1)"><script>window.top.x=1</script><img src="https://evil.test/pixel" onerror="alert(1)"><a href="https://example.com/a" ping="https://evil.test/ping" target="_top">来源</a><a href="javascript:alert(1)">坏链接</a><iframe src="https://evil.test"></iframe><form action="https://evil.test"><button>提交</button></form><svg><script>alert(1)</script></svg><p>保留正文</p></body>',
    );
    expect(result.html).toContain('default-src &#39;none&#39;'.replace(/&#39;/g, "'"));
    expect(result.html).not.toMatch(
      /<script|onload|onerror|<iframe|<form|<svg|href=|src=|http-equiv="refresh"|<base|ping=/,
    );
    expect(result.html).toContain('保留正文');
    expect(result.links).toEqual([{ label: '来源', url: 'https://example.com/a' }]);
  });
  it('只接受固定图表结构和有限数值，禁止长度不匹配、超长与脚本配置', () => {
    const data = {
      title: '销售',
      charts: [
        {
          title: '按月',
          type: 'bar',
          labels: ['一月'],
          series: [{ name: '金额', values: [123] }],
          formatter: 'alert(1)',
        },
      ],
    };
    const result = safeHtml(
      `<script id="oasis-dashboard" type="application/json">${JSON.stringify(data)}</script>`,
    );
    expect(result.dashboard?.charts[0]).not.toHaveProperty('formatter');
    expect(result.dashboard?.charts[0]?.series[0]?.values).toEqual([123]);
    data.charts[0]!.labels.push('二月');
    expect(
      safeHtml(
        `<script id="oasis-dashboard" type="application/json">${JSON.stringify(data)}</script>`,
      ).warning,
    ).toContain('无效');
    expect(() => safeHtml('x'.repeat(2 * 1024 * 1024 + 1))).toThrow();
  });
  it('表格的多工作表切换与截断提示；单元格按文字显示不注入 HTML', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'POST'
          ? Response.json({
              kind: 'table',
              sheets: [
                {
                  name: '一月',
                  rows: [
                    ['名称', '值'],
                    ['<img onerror=alert(1)>', 123],
                  ],
                  truncated: true,
                },
                { name: '二月', rows: [['金额'], [456]], truncated: false },
              ],
            })
          : new Response('xlsx-bytes'),
      ),
    );
    const { container } = render(<PreviewBody file={{ ...file, path: '销售.xlsx' }} />);
    expect(await screen.findByText('<img onerror=alert(1)>')).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText(/仅显示前 1000 行/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('工作表'), { target: { value: '1' } });
    expect(screen.getByText('456')).toBeTruthy();
  });
  it('HTML 通过 srcdoc 和空 sandbox，超大下载在读取时取消', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<h1>报告</h1><script>alert(1)</script>')),
    );
    render(<PreviewBody file={file} />);
    const frame = await screen.findByTitle('报告.html');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute('srcdoc')).not.toContain('<script');
    await expect(readPreviewFile(file.url, new AbortController().signal, 3)).rejects.toThrow(
      '上限',
    );
  });
  it('PPT 仅匹配同一节点的配套 PDF，上传缺少 PDF 时可下载', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('%PDF-1.7')),
    );
    const { rerender } = render(
      <PreviewBody
        file={{ ...file, path: '汇报.pptx', url: '/api/task/v1/tasks/t/files/node/out/汇报.pptx' }}
      />,
    );
    expect((await screen.findByTitle('汇报.pptx')).getAttribute('src')).toBe(
      '/api/task/v1/tasks/t/files/node/out/汇报.pdf',
    );
    rerender(
      <PreviewBody file={{ ...file, path: '上传.pptx', url: '/api/canvas/v1/uploads/id' }} />,
    );
    expect(screen.getByText(/未找到同一来源/)).toBeTruthy();
  });
});

describe('模型预览降级与生命周期', () => {
  const modelFile = {
    ...file,
    path: 'model.glb',
    url: '/api/canvas/v1/artifacts/11111111-1111-4111-8111-111111111111/content',
  };
  const descriptor = {
    source: { name: 'source.blend', url: modelFile.url, size: 10, sha256: 'a'.repeat(64) },
    simplified: true,
    glb: {
      name: 'preview.glb',
      url: modelFile.url,
      size: 10,
      sha256: 'a'.repeat(64),
      report: {
        vertices: 3,
        triangles: 1,
        nodes: 1,
        images: 0,
        texturePixels: 0,
        animations: [],
        meshLocalBounds: { min: [0, 0, 0], max: [1, 1, 1] },
        unchecked: ['真实尺寸'],
      },
    },
    poster: {
      name: 'poster.png',
      url: '/api/canvas/v1/artifacts/11111111-1111-4111-8111-111111111111/model-poster',
      size: 10,
      sha256: 'b'.repeat(64),
    },
    turntable: {
      name: 'turn.webm',
      url: '/api/canvas/v1/artifacts/22222222-2222-4222-8222-222222222222/content',
      size: 10,
      sha256: 'c'.repeat(64),
    },
  };
  it('弱设备只请求描述和静态预览，不启动 worker 或获取 GLB；视频不自动播放', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
    const fetcher = vi.fn(async (_url: string) => Response.json(descriptor)),
      worker = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    vi.stubGlobal('Worker', worker);
    const { container } = render(<ModelPreview file={modelFile} />);
    expect(await screen.findByAltText('模型配套渲染图')).toBeTruthy();
    expect(screen.getByText('轻量预览 · 原件未替换')).toBeTruthy();
    expect(container.querySelector('iframe')).toBeNull();
    expect(worker).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0]?.[0]).toBe('/api/canvas/v1/model-previews');
    fireEvent.click(screen.getByText('转台视频'));
    expect(container.querySelector('video')?.autoplay).toBe(false);
    expect(container.querySelector('a[download]')).toBeNull();
  });
  it('关闭预览取消在途请求；不信任任意外部文件 URL', async () => {
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetcher);
    const { unmount } = render(<ModelPreview file={modelFile} />);
    expect(signal?.aborted).toBe(false);
    unmount();
    expect(signal?.aborted).toBe(true);
    render(<ModelPreview file={{ ...modelFile, url: 'https://evil.test/model.glb' }} />);
    expect(screen.getByText('此文件暂不支持受保护的模型预览。')).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('断网后允许重试；损坏配套图片和视频有明确的最终降级', async () => {
    vi.stubGlobal('navigator', { hardwareConcurrency: 1 });
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(Response.json({ ...descriptor, glb: undefined }));
    vi.stubGlobal('fetch', fetcher);
    const { container } = render(<ModelPreview file={modelFile} />);
    fireEvent.click(await screen.findByText('重试预览'));
    fireEvent.error(await screen.findByAltText('模型配套渲染图'));
    expect(container.querySelector('video')).toBeTruthy();
    fireEvent.error(container.querySelector('video')!);
    expect(screen.getByText(/没有可用的配套图片/)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
