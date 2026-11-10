# 网页、小游戏与小程序 H5

> 适用：多文件网页、交互工具、小游戏、需要临时 Node API 的前端作品、小程序的 H5 预览。

- 作品放在一个目录（如 `out/site/`），里面放 `oasis-app.json`（格式见 in/.oasis-formats.json），deliver 写 `site/**`。要后端时用 `kind:"node"`，监听 `127.0.0.1:$PORT`；带后端的作品画布里不能运行，用户只能下载；静态作品可以在画布里直接运行。
- 用户在画布里看静态作品：入口页面放进不联网的隔离框运行，只运行入口这一页。`<script>`、`<link>`、`<img>` 和 ES 模块 `import`（含 importmap 里的裸名字）引用同目录文件都可以；fetch/XHR 读本地文件、CDN、localStorage、跳到别的页面都不行，模型等数据要内嵌成 data: 地址或 JS 里的常量。
- 沙箱里没有浏览器：用 `oasis-tool app.check --dir out/site` 按画布的方式打开检查，画面一直是一整片纯色也算没通过。`oasis-test.json` 要和 `oasis-app.json` 放在同一目录才会执行。
- 外站测试用 `website.test`；Android 真机测试用 `android.test`（上传的 APK，免费计划）。
