# 网页、小游戏与小程序 H5

> 适用：多文件网页、交互工具、小游戏、需要临时 Node API 的前端作品、小程序的 H5 预览。

- 作品放在一个目录（如 `out/site/`），里面放 `oasis-app.json`（格式见 in/.oasis-formats.json），deliver 写 `site/**`。要后端时用 `kind:"node"`，监听 `127.0.0.1:$PORT`。
- 预览环境不联网：脚本、样式、字体、图片都要打包进去，不能依赖 CDN。
- 沙箱里没有浏览器：用 `oasis-tool app.check --dir out/site` 在独立浏览器里跑；同目录可放 `oasis-test.json` 写交互步骤。
- 外站测试用 `website.test`；Android 真机测试用 `android.test`（上传的 APK，免费计划）。
