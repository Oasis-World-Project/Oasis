// Runs the production Electron shell against a disposable local fixture page/profile.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const evidence = process.env.OASIS_MODEL_EVIDENCE,
  mode = process.env.OASIS_MODEL_MODE;
if (!evidence || !mode) throw new Error('Missing fixture configuration');
app.setPath('userData', path.join(evidence, `.profile-${mode}`));
app.setPath('downloads', evidence);
let window;
app.on('browser-window-created', (_event, win) => {
  window = win;
  win.hide();
});
const deadline = setTimeout(() => {
  process.stderr.write('Electron smoke timeout\n');
  app.exit(1);
}, 60000);
async function wait(code) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (window && !window.webContents.isLoadingMainFrame()) {
      try {
        if (await window.webContents.executeJavaScript(code)) return;
      } catch {
        /* A navigating/detached page will be retried. */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('UI expectation failed: ' + code);
}
async function click(text) {
  await window.webContents.executeJavaScript(
    `Array.from(document.querySelectorAll('button')).find(b=>b.textContent===${JSON.stringify(text)})?.click()`,
  );
}
(async () => {
  await import(pathToFileURL(path.join(__dirname, '../dist/main.js')).href);
  await app.whenReady();
  if (mode === 'no-webgl') {
    const fallback = new BrowserWindow({
      show: false,
      width: 1440,
      height: 900,
      webPreferences: {
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        webSecurity: true,
        webgl: false,
        preload: path.join(__dirname, '../dist/preload.cjs'),
      },
    });
    await fallback.loadURL(process.env.OASIS_WEB_URL);
    window = fallback;
  }
  await wait('document.querySelector("main") !== null');
  let downloads = 0;
  const network = [];
  session.defaultSession.on('will-download', () => {
    downloads++;
  });
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!/^(http|ws):\/\/127\.0\.0\.1:/.test(details.url) && !details.url.startsWith('blob:'))
      network.push(details.url);
    callback({ cancel: network.length > 0 });
  });
  await wait('Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="纹理模型")');
  await click('轻量配套预览');
  if (mode === 'no-webgl') {
    if (
      await window.webContents.executeJavaScript(
        '!!document.createElement("canvas").getContext("webgl2")',
      )
    )
      throw new Error('WebGL disable flag was ineffective');
    await wait('document.body.textContent.includes("交互预览不可用")');
    await wait('document.querySelector("img[alt=模型配套渲染图]")?.naturalWidth > 0');
    await click('纹理模型');
    await wait('document.body.textContent.includes("低负载结构预览")');
    const viewer = window.webContents.mainFrame.frames.find(
      (frame) => frame.url === 'about:srcdoc',
    );
    if (
      !viewer ||
      !(await viewer.executeJavaScript(
        'document.querySelectorAll("svg path").length > 0 && document.querySelectorAll("canvas").length === 0',
      ))
    )
      throw new Error('No-WebGL structure preview missing');
    await fs.writeFile(
      path.join(evidence, 'electron-structure-dom.json'),
      JSON.stringify(
        await viewer.executeJavaScript(
          'Array.from(document.querySelectorAll("svg path")).slice(0,5).map(p=>({fill:p.getAttribute("fill"),style:p.getAttribute("style"),d:p.getAttribute("d")}))',
        ),
        null,
        2,
      ),
    );
  } else {
    await wait(
      'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="向左旋转")',
    );
    if (
      await window.webContents.executeJavaScript(
        '(()=>{try{return !!document.querySelector("iframe").contentWindow.document}catch{return false}})()',
      )
    )
      throw new Error('Viewer origin was not isolated');
    await click('向左旋转');
    await click('放大');
    await click('向左平移');
    await click('复位');
    await click('播放动画');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await click('暂停动画');
    await fs.writeFile(
      path.join(evidence, 'electron-interactive.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await click('静态预览');
    await wait('document.querySelector("[data-model-released=true]") !== null');
    const release = await window.webContents.executeJavaScript(
      'document.querySelector("[data-model-release]").getAttribute("data-model-release")',
    );
    await fs.writeFile(path.join(evidence, 'electron-release.json'), release);
    await click('转台视频');
    await wait('document.querySelector("video")?.readyState >= 2');
    await window.webContents.executeJavaScript('document.querySelector("video").play()');
    await wait('document.querySelector("video")?.currentTime > 0');
    await window.webContents.executeJavaScript('document.querySelector("video").pause()');
    await click('关闭模型');
    await window.webContents.executeJavaScript(
      'fetch("/model-preview-fault",{method:"POST"}).then(response=>response.text())',
    );
    await click('轻量配套预览');
    await wait('document.body.textContent.includes("交互预览不可用")');
    await wait('document.querySelector("img[alt=模型配套渲染图]")?.naturalWidth > 0');
    await click('交互预览');
    await wait(
      'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="向左旋转")',
    );
    await click('外部 URI 拒绝');
    await wait('document.body.textContent.includes("URI")');
    if (await window.webContents.executeJavaScript('document.querySelectorAll("iframe").length'))
      throw new Error('Unsafe model opened a viewer');
    await click('关闭模型');
    await window.loadURL(process.env.OASIS_WEB_URL + '?weak=1');
    await wait(
      'Array.from(document.querySelectorAll("button")).some(b=>b.textContent==="轻量配套预览")',
    );
    await click('轻量配套预览');
    await wait('document.querySelector("img[alt=模型配套渲染图]")?.naturalWidth > 0');
    if (await window.webContents.executeJavaScript('document.querySelectorAll("iframe").length'))
      throw new Error('Weak device auto-started WebGL');
    await click('纹理模型');
    await wait('document.body.textContent.includes("低负载结构预览")');
    await click('向左旋转');
    await fs.writeFile(
      path.join(evidence, 'electron-structure.png'),
      (await window.webContents.capturePage()).toPNG(),
    );
    await click('静态预览');
    await wait('document.querySelector("[data-model-released=true]") !== null');
  }
  if (mode === 'normal')
    await fs.writeFile(
      path.join(evidence, `electron-${mode}-fallback.png`),
      (await window.webContents.capturePage()).toPNG(),
    );
  if (downloads || network.length)
    throw new Error('Unexpected download or external resource request');
  const sync = await window.webContents.executeJavaScript('window.oasisDesktop.syncStatus()');
  if (sync.folder !== null || sync.synced.length) throw new Error('Fixture wrote synced artifacts');
  await fs.writeFile(
    path.join(evidence, `electron-${mode}.json`),
    JSON.stringify(
      {
        passed: true,
        downloads,
        externalRequests: network,
        folder: sync.folder,
        mode,
        productionShell: mode === 'normal',
        webglDisabled: mode === 'no-webgl',
      },
      null,
      2,
    ),
  );
  clearTimeout(deadline);
  BrowserWindow.getAllWindows().forEach((win) => win.close());
  app.quit();
})().catch(async (error) => {
  process.stderr.write(`${error.stack}\n`);
  if (window && mode === 'normal')
    await fs
      .writeFile(
        path.join(evidence, `electron-${mode}-failure.png`),
        (await window.webContents.capturePage()).toPNG(),
      )
      .catch(() => {});
  app.exit(1);
});
