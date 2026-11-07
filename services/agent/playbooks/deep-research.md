# 深度研究

> 适用：竞品研究、行业分析、情报简报、财报或资料综述，以及需要可追溯引用的报告。

- `web.search` 找来源，`web.fetch --out 目录` 存全文。结论标注出处，不凭摘要编引用。
- 音视频资料用 `audio.transcribe`（不带时间戳，要时间就先用 FFmpeg 切段再分段转写）。
- 要 PDF 时用 WeasyPrint 从同一份 HTML 生成。
