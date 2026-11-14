# 视频成片与 Shotcut 可编辑工程

> 适用：上传素材剪辑、图文短片、生成镜头参与的影片、字幕、配音与配乐合成。

- 剪辑用 `oasis-media`：写 `timeline.json`（格式见 `oasis-media --help` 和 `/opt/oasis/media.py`，最高 1080p、最长 180 秒），`build` 出 Shotcut 工程，`render` 出 MP4，`pack` 打包。成片和工程来自同一份时间轴。
- 生成镜头：`oasis-tool video.generate`（可带首帧图），要等几分钟，没等到用 `oasis-tool wait`。
- 沙箱有 FFmpeg / FFprobe。
