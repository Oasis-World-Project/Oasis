# 网页、小游戏与小程序 H5

> 适用：多文件网页、交互工具、小游戏、需要临时 Node API 的前端作品、小程序的 H5 预览。

- 简单作品优先一个干活节点完成，不为了页面数量拆节点。需要独立内容或素材时再加节点，并让最终节点汇总完整可运行包。
- 把完整作品放在 `out/site/`（或一个明确的根目录），最终节点的 `deliver` 包含 `site/**`，`expects` 至少包含 `site/oasis-app.json` 和入口文件。`**` 包括嵌套资源；不要只交付首页 HTML。
- 应用目录 `out/site/oasis-app.json` 写 `{ "version":1, "kind":"static", "root":"site", "entry":"index.html" }`；清单与入口同属 `out/site/`，`root` 相对 `out/`，不在 `out/` 根保留第二份清单。返工时移动到正确位置并删除错误位置的旧清单。有必要的临时 API 时用 `kind:"node"`，入口如 `server.mjs`。Node 服务必须监听 `127.0.0.1` 和环境变量 `PORT`，并同时提供页面与同源 API。
- 交付可离线运行的文件：脚本、样式、图片、字体、声音、构建产物及必要的 Node 运行文件。不能依赖 CDN、在线字体、远程接口或预览时安装依赖。打包依赖须在执行阶段完成；锁文件、源码和简短运行说明随作品交付。
- 静态作品的根路径应打开入口；多页面链接、前端路由和嵌套资源应在离线条件下实际运行。Node 作品从根路径返回页面，后端 API 仅提供本作品需要的临时功能，不设计长期账号、持久数据库或发布托管。
- 交付前验证实际交互：打开页面、导航、按钮、表单、API、游戏键盘操作和重开；检查控制台错误与失败请求。音频作品还须实际听到声音。不能把源码存在或“理论可运行”写成通过。无法运行的检查要如实列入说明。
- 同根目录交付 `oasis-test.json`，由平台在隔离浏览器实际执行，不能自己编造通过结果。交付前运行 `oasis-tool app.check --dir out/<应用目录>` 自查：它用和交付检查同一个隔离浏览器打开当前文件、执行 oasis-test.json，当场返回页面报错和没通过的步骤；按报错修好再交，交付后关卡复跑同一套检查。格式为 `{"version":1,"steps":[{"action":"click","selector":"button"},{"action":"text","selector":"#result","text":"成功"},{"action":"screenshot"}]}`。最多 20 步，支持 navigate（path 为同源绝对路径）、click、fill（selector/text）、press（selector/key）、visible（selector）、text（selector/text，包含匹配）、count（selector/count）、screenshot。按用户要求写真实业务断言，截图至少保留关键流程结束状态；失败后剩余步骤标记未检查。不要把测试文件当成应用运行依赖。
- 小程序额外交付目标平台代码和 H5 预览；H5 验证不代表平台真机、审核或发布通过。
- 外站验收使用 `website.test --url … --plan '{"version":1,"steps":[…]}'`，只访问管理员已在 `WEBSITE_TEST_ORIGINS` 放行的目标与资源来源；声明只读流程，不把登录、写请求或 WebSocket 写成通过。工具输出 `website-check.json` 和截图，应随验收材料交付。
- Android 原生验收使用 `android.test --uploadId <本人 APK 素材ID> --device <设备名> --osVersion <系统版本> --steps '[…]'`。步骤支持 click、fill、visible、text、screenshot；控件 selector 为 `{using:"id"|"accessibility id"|"xpath",value:"…"}`。当前仅支持 BrowserStack Free 计划和不超过 25 MiB 的上传 APK。长任务完成后保留 `android-check.json` 和截图，检查报告里的未检查项；不得以 H5 结果替代原生验收，不重复提交 uncertain 任务。
