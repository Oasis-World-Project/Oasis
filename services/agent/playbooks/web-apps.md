# 网页、小游戏与小程序 H5

> 适用：多文件网页、交互工具、小游戏、需要临时 Node API 的前端作品、小程序的 H5 预览。

- 作品放在一个目录（如 `out/site/`），里面放 `oasis-app.json`（格式见 in/.oasis-formats.json），deliver 写 `site/**`。要后端时用 `kind:"node"`，监听 `127.0.0.1:$PORT`；带后端的作品画布里不能运行，用户只能下载；静态作品可以在画布里直接运行。
- 用户在画布里看静态作品：入口页面放进不联网的隔离框运行，只运行入口这一页，地址上的查询参数和 # 片段到不了页面（`?debug=1` 这类页面读不到）。同目录文件写在 HTML 标签里引用都可以：`<script>`、`<link>`、`<img>`、`<audio>`、`<video>`（含 `<source>`）和 ES 模块 `import`（含 importmap 里的裸名字）；在 JS 里按路径加载的读不到（`new Audio('a.mp3')`、`img.src = 'a.png'`、fetch/XHR 读本地文件），CDN、localStorage、跳到别的页面也不行，模型等数据要内嵌成 data: 地址或 JS 里的常量。
- 沙箱里没有浏览器：用 `oasis-tool app.check --dir out/site` 按画布的方式打开检查，画面一直是一整片纯色也算没通过。`oasis-test.json` 要和 `oasis-app.json` 放在同一目录才会执行。加 `--out out/检查报告.json` 会存下完整报告，平台截的画面（打开后的首屏、`screenshot` 步骤和没通过那一步）存在报告旁边（`检查报告-opening.jpg`、`检查报告-step-N.jpg`），想看画面就看它们。每一步都等到条件满足为止：页面安定后（连续 30 帧 DOM 不变）仍不满足就判没通过；页面一直在变（计时、动画文字）时最多等 600 帧。页面报错、控制台报错也算没通过。
- 外站测试用 `website.test`；Android 真机测试用 `android.test`（上传的 APK，免费计划）。
