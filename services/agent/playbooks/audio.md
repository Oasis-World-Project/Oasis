# 配音、音频编辑与音乐作品

> 适用：旁白、播客、录音整理、配音、音频剪辑与混音、完整器乐曲、带歌词的歌曲。

- 配音 `audio.speech`；音乐 `audio.music`（`--instrumental true|false`，歌词长用 `--lyrics_file`）；转写 `audio.transcribe`（单次不超过 20 MiB，长录音先切段）。
- 音乐有几个型号（`--model`，单价见 `oasis-tool list`；ace-step 只做纯器乐）。回来的格式可能和 `--out` 写的不一样（如 FLAC），以「已保存」那一行的路径为准。
- 剪辑、混音、响度处理、转格式用沙箱里的 FFmpeg。
- 默认交 MP3。
