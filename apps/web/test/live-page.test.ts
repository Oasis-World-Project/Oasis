// 网页在画布里运行（ADR 0009 §17）：CSP 插在一切脚本之前；同成果文件按相对地址内嵌；找不到的列出来。
import { describe, expect, it } from 'vitest';
import {
  LIVE_CSP,
  LIVE_SANDBOX,
  livePage,
  resolveRef,
  withPolicy,
} from '../src/canvas/live-page.ts';

const files = (entries: Record<string, string>) => async (path: string) =>
  path in entries ? new TextEncoder().encode(entries[path]) : undefined;

describe('网页运行文档', () => {
  it('隔离框只给脚本权限；CSP 禁网、禁外部资源、禁表单和嵌套页面', () => {
    expect(LIVE_SANDBOX.split(' ')).not.toContain('allow-same-origin');
    expect(LIVE_SANDBOX.split(' ')).not.toContain('allow-top-navigation');
    expect(LIVE_SANDBOX.split(' ')).not.toContain('allow-popups');
    expect(LIVE_CSP).toContain("default-src 'none'");
    expect(LIVE_CSP).toContain('connect-src data: blob:');
    expect(LIVE_CSP).not.toMatch(/https?:|\*/);
    expect(LIVE_CSP).toContain("form-action 'none'");
    expect(LIVE_CSP).toContain("frame-src 'none'");
  });

  it('CSP 紧跟 doctype，排在原文所有脚本之前，原文其余不动', () => {
    const source = '<!DOCTYPE html>\n<html lang="zh"><head><script>go()</script></head></html>';
    const out = withPolicy(source);
    expect(out.startsWith('<!DOCTYPE html><meta http-equiv="Content-Security-Policy"')).toBe(true);
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<script'));
    expect(out.endsWith(source.slice('<!DOCTYPE html>'.length))).toBe(true);
    expect(withPolicy('\uFEFF<p>hi</p>').startsWith('<meta http-equiv')).toBe(true);
  });

  it('相对地址按网页位置和应用根目录解析；外部地址、锚点、越界一律不处理', () => {
    expect(resolveRef('./js/app.js?v=2', 'site/index.html', 'site')).toBe('site/js/app.js');
    expect(resolveRef('../img/a%20b.png', 'site/pages/x.html', 'site')).toBe('site/img/a b.png');
    expect(resolveRef('/style.css', 'site/pages/x.html', 'site')).toBe('site/style.css');
    expect(resolveRef('https://cdn.example/three.js', 'site/index.html', 'site')).toBeNull();
    expect(resolveRef('//cdn.example/x.js', 'site/index.html', 'site')).toBeNull();
    expect(resolveRef('data:image/png;base64,AA', 'site/index.html', 'site')).toBeNull();
    expect(resolveRef('#top', 'site/index.html', 'site')).toBeNull();
    expect(resolveRef('../../etc/passwd', 'index.html', '')).toBeNull();
  });

  it('没有本地引用的单文件网页只插入 CSP，原文逐字保留', async () => {
    const source = '<!doctype html><canvas></canvas><script>const s = "</div>"; draw(s)</script>';
    const page = await livePage(source, 'site/index.html', 'site', files({}));
    expect(page.html).toBe(withPolicy(source));
    expect(page.missing).toEqual([]);
  });

  it('脚本、样式（含其中的图片和字体）、图片按相对地址内嵌；缺的文件和外部地址分开对待', async () => {
    const page = await livePage(
      `<!doctype html><html><head><link rel="stylesheet" href="css/a.css"><script src="https://cdn.example/x.js"></script></head>
       <body><img src="logo.png"><img src="gone.png"><div style="background:url(bg.png)"></div><script src="js/app.js"></script></body></html>`,
      'site/index.html',
      'site',
      files({
        'site/css/a.css': '@font-face{src:url("../f.woff2")} body{color:red}',
        'site/f.woff2': 'F',
        'site/logo.png': 'P',
        'site/bg.png': 'B',
        'site/js/app.js': 'if (a </script> b) run()',
      }),
    );
    const html = page.html;
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<style'));
    expect(html).toContain('body{color:red}');
    expect(html).toContain('url("data:font/woff2;base64,Rg==")');
    expect(html).not.toContain('css/a.css');
    expect(html).toContain('src="data:image/png;base64,UA=="');
    expect(html).toContain('url(&quot;data:image/png;base64,Qg==&quot;)');
    expect(html).toContain('if (a <\\/script> b) run()');
    expect(html).not.toContain('js/app.js');
    // 外部脚本原样保留，交给 CSP 拦下，不算缺文件
    expect(html).toContain('https://cdn.example/x.js');
    expect(page.missing).toEqual(['site/gone.png']);
  });

  it('模块脚本引用其他文件时如实提示可能不完整', async () => {
    const page = await livePage(
      '<script type="module" src="main.js"></script>',
      'app/index.html',
      'app',
      files({ 'app/main.js': "import { x } from './lib.js'; x()" }),
    );
    expect(page.missing).toEqual(['app/main.js（模块引用其他文件）']);
  });
});
