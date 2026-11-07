// 网页在画布里运行（ADR 0009 §17、ADR 0021）：CSP 插在一切脚本之前；同成果文件按相对地址内嵌；
// ES 模块改写成框里的地址并由 importmap 加载；找不到的列出来。
import { describe, expect, it } from 'vitest';
import { LIVE_CSP, LIVE_SANDBOX, livePage, resolveRef, withPolicy } from '../src/index.ts';

const files = (entries: Record<string, string>) => async (path: string) =>
  path in entries ? new TextEncoder().encode(entries[path]) : undefined;

/** 取出框里的模块表（键是 oasis-file:/ 地址，值是改写后的原文） */
function modulesOf(html: string): Record<string, string> {
  const match = /<script type="application\/json" id="oasis-modules">([\s\S]*?)<\/script>/.exec(
    html,
  );
  return match ? (JSON.parse(match[1]!) as Record<string, string>) : {};
}

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

  it('多文件 ES 模块：相对引用、importmap 裸名字、前缀映射、动态 import、循环引用都改写成框里的地址', async () => {
    const page = await livePage(
      `<!doctype html><html><head>
       <script type="importmap">{"imports":{"three":"./js/three.module.js","three/addons/":"./js/addons/"}}</script>
       <link rel="modulepreload" href="./js/app.js">
       </head><body><script type="module" src="./js/app.js"></script>
       <script type="module">import { boot } from './js/app.js'; boot('go');</script></body></html>`,
      'site/index.html',
      'site',
      files({
        'site/js/app.js':
          "import * as THREE from 'three';\nimport { OrbitControls } from 'three/addons/controls/OrbitControls.js';\n" +
          "export const boot = async () => (await import('./lazy.js')).go(THREE, OrbitControls);",
        'site/js/three.module.js': "export * from './three.core.js';",
        'site/js/three.core.js': "import { later } from './three.module.js'; export const X = 1;",
        'site/js/addons/controls/OrbitControls.js':
          "import { X } from 'three'; export class OrbitControls {}",
        'site/js/lazy.js': 'export const go = () => 1;',
      }),
    );
    expect(page.missing).toEqual([]);
    const modules = modulesOf(page.html);
    expect(Object.keys(modules).sort()).toEqual([
      'oasis-file:/site/js/addons/controls/OrbitControls.js',
      'oasis-file:/site/js/app.js',
      'oasis-file:/site/js/lazy.js',
      'oasis-file:/site/js/three.core.js',
      'oasis-file:/site/js/three.module.js',
    ]);
    const app = modules['oasis-file:/site/js/app.js']!;
    expect(app).toContain("from 'oasis-file:/site/js/three.module.js'");
    expect(app).toContain("from 'oasis-file:/site/js/addons/controls/OrbitControls.js'");
    expect(app).toContain('import("oasis-file:/site/js/lazy.js")');
    expect(modules['oasis-file:/site/js/three.core.js']).toContain(
      "from 'oasis-file:/site/js/three.module.js'",
    );
    // 入口脚本改成从框里的地址加载；内联模块就地改写；原 importmap 和预加载提示去掉
    expect(page.html).toContain(
      '<script type="module">import "oasis-file:/site/js/app.js";</script>',
    );
    expect(page.html).toContain("from 'oasis-file:/site/js/app.js'; boot('go')");
    expect(page.html).not.toContain('"three":"./js/three.module.js"');
    expect(page.html).not.toContain('modulepreload');
    // 模块表和启动脚本在 head 最前面（CSP 之后），早于任何模块脚本
    const html = page.html;
    expect(html.indexOf('Content-Security-Policy')).toBeLessThan(
      html.indexOf('id="oasis-modules"'),
    );
    expect(html.indexOf('id="oasis-modules"')).toBeLessThan(html.indexOf('type="module"'));
  });

  it('模块原文里的 </script> 不会提前结束模块表', async () => {
    const page = await livePage(
      '<script type="module" src="a.js"></script>',
      'index.html',
      '',
      files({ 'a.js': "const s = '</script><!--';" }),
    );
    expect(page.html).not.toContain("'</script>");
    expect(modulesOf(page.html)['oasis-file:/a.js']).toBe("const s = '</script><!--';");
  });

  it('找不到的模块文件和没映射的裸名字如实列出', async () => {
    const page = await livePage(
      '<script type="module" src="main.js"></script>',
      'app/index.html',
      'app',
      files({
        'app/main.js':
          "import { x } from './lib.js'; import * as T from 'three'; import 'https://cdn.example/x.js';",
      }),
    );
    expect(page.missing.sort()).toEqual(['app/lib.js', 'app/main.js 引用的「three」']);
    // 外部地址原样保留，交给 CSP 拦下
    expect(modulesOf(page.html)['oasis-file:/app/main.js']).toContain("'https://cdn.example/x.js'");
  });
});
