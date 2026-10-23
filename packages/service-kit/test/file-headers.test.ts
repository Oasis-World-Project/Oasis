import { describe, expect, it } from 'vitest';
import { fileResponseHeaders as fileHeaders } from '../src/file-headers.ts';

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
