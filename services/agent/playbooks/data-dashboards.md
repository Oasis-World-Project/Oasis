# 数据与看板

> 适用：Excel 汇总、销售或运营分析、数据核对、单文件交互看板。

- 沙箱有 pandas、openpyxl、LibreOffice（可无界面重算公式）。
- 看板交单文件 HTML，所有资源内嵌，不依赖 CDN。
- 要在画布里交互：在 HTML 里放 `<script id="oasis-dashboard" type="application/json">`，内容 `{title,charts:[{title,type:"bar"|"line"|"pie",labels:[…],series:[{name,values:[…]}]}]}`（最多 20 图、每图 200 个标签、10 个系列；JSON 里的 `<` 写成 `<`）。
