import { describe, expect, it } from 'vitest';
import { fileResponseHeaders as fileHeaders, parseRange } from '../src/file-headers.ts';

describe('成果文件的响应头', () => {
  it('网页和 SVG 加沙箱，脚本不跑', () => {
    expect(fileHeaders('text/html; charset=utf-8', 'site/index.html', false)).toMatchObject({
      'content-security-policy': 'sandbox',
      'x-content-type-options': 'nosniff',
      'content-disposition': "inline; filename*=UTF-8''index.html",
    });
    expect(fileHeaders('image/svg+xml', 'a.svg', false)['content-security-policy']).toBe('sandbox');
  });

  it('PDF 不加沙箱，浏览器自带的阅读器才能打开', () => {
    expect(fileHeaders('application/pdf', 'r.pdf', false)).not.toHaveProperty(
      'content-security-policy',
    );
  });

  it('下载时让浏览器另存，中文文件名编码好', () => {
    expect(fileHeaders('text/markdown', '文案/首页.md', true)['content-disposition']).toBe(
      `attachment; filename*=UTF-8''${encodeURIComponent('首页.md')}`,
    );
  });
});

describe('分段请求（拖动视频进度）', () => {
  it('支持 a-b、a-、-n 三种写法，超出文件的截到末尾', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange('bytes=500-5000', 1000)).toEqual({ start: 500, end: 999 });
  });

  it('看不懂的整个返回，超出范围的 416', () => {
    expect(parseRange(undefined, 10)).toBeUndefined();
    expect(parseRange('bytes=0-1,5-6', 10)).toBeUndefined();
    expect(parseRange('items=0-1', 10)).toBeUndefined();
    expect(parseRange('bytes=10-', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=5-2', 10)).toBe('unsatisfiable');
    expect(parseRange('bytes=-0', 10)).toBe('unsatisfiable');
  });
});
