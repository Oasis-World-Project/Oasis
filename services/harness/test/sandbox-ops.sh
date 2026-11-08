# 沙箱镜像里的本地操作和工具步骤执行器验收（ADR 0025），离线跑：pnpm sandbox:check:ops
# 用 ffmpeg 现做几段测试素材（大小、帧率不同，有的没声音），把 6 个操作都跑一遍，再用执行器跑一个只有本地操作的工具节点。
set -eu
work="$(mktemp -d)"
cd "$work"
mkdir -p in/shots out
ff() { ffmpeg -hide_banner -loglevel error -y "$@"; }
duration() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
streams() { ffprobe -v error -show_entries stream=codec_type -of csv=p=0 "$1" | sort | tr '\n' ' '; }
size() { ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 "$1"; }
between() { awk -v d="$1" -v lo="$2" -v hi="$3" 'BEGIN { exit !(d >= lo && d <= hi) }'; }
check() { test -s "$1" || { echo "缺少 $1"; exit 1; }; }

ff -f lavfi -i testsrc=size=640x360:rate=25:duration=2 -f lavfi -i sine=frequency=440:duration=2 \
  -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac in/shots/1.mp4
ff -f lavfi -i testsrc2=size=320x240:rate=30:duration=1.5 -c:v libx264 -pix_fmt yuv420p in/shots/2.mp4
ff -f lavfi -i sine=frequency=660:duration=1 in/beep.mp3

echo "== video.concat（第二段大小、帧率不同，没有声音）"
oasis-op video.concat --in in/shots/1.mp4,in/shots/2.mp4 --out out/cut.mp4
between "$(duration out/cut.mp4)" 3.3 3.8
test "$(size out/cut.mp4)" = "640x360"
test "$(streams out/cut.mp4)" = "audio video "

echo "== video.trim"
oasis-op video.trim --in out/cut.mp4 --start 1 --duration 1.5 --out out/trim.mp4
between "$(duration out/trim.mp4)" 1.3 1.7

echo "== video.frames"
oasis-op video.frames --in out/cut.mp4 --every 1 --format jpg --out out/frames
test "$(ls out/frames | wc -l)" -ge 3
oasis-op video.frames --in out/cut.mp4 --at 0.5,2.5 --out out/at
check out/at/frame-0001.png
check out/at/frame-0002.png

echo "== video.audio"
oasis-op video.audio --video out/cut.mp4 --audio in/beep.mp3 --mode mix --volume 0.8 --out out/mixed.mp4
between "$(duration out/mixed.mp4)" 3.3 3.8
oasis-op video.audio --video in/shots/2.mp4 --audio in/beep.mp3 --out out/voiced.mp4
test "$(streams out/voiced.mp4)" = "audio video "

echo "== audio.concat"
oasis-op audio.concat --in in/beep.mp3,in/beep.mp3 --out out/beeps.wav
between "$(duration out/beeps.wav)" 1.9 2.2

echo "== media.convert"
oasis-op media.convert --in out/cut.mp4 --width 160 --out out/preview.gif
check out/preview.gif
oasis-op media.convert --in out/cut.mp4 --out out/sound.m4a
test "$(streams out/sound.m4a)" = "audio "
oasis-op media.convert --in out/at/frame-0001.png --width 100 --out out/thumb.webp
test "$(size out/thumb.webp)" = "100x56"
oasis-op media.convert --in out/cut.mp4 --width 320 --height 320 --out out/fit.webm
test "$(size out/fit.webm)" = "320x180"

echo "== 参数错了在调 ffmpeg 之前说清楚"
if oasis-op video.concat --in in/shots/1.mp4 --out out/bad.mp4 2> err.txt; then exit 1; fi
grep -q "参数 in 要写 2–50 项" err.txt

echo "== oasis-tool op.* 转给 oasis-op"
oasis-tool op.video.trim --in out/cut.mp4 --start 0 --end 1 --out out/via-tool.mp4
between "$(duration out/via-tool.mp4)" 0.8 1.2

echo "== 工具步骤执行器：只有本地操作的工具节点"
cat > in/.oasis-steps.json <<'EOF'
[{"tool":"op.video.concat","args":{"in":["in/shots/1.mp4","in/shots/2.mp4"]},"out":"out/steps/cut.mp4"},
 {"tool":"op.media.convert","args":{"in":"out/steps/cut.mp4","width":320},"out":"out/steps/small.mp4"}]
EOF
node --no-warnings /opt/oasis/services/harness/sandbox/oasis-steps.ts < /dev/null > steps.jsonl
grep -q '"type":"done","ok":true' steps.jsonl || { cat steps.jsonl; exit 1; }
test "$(size out/steps/small.mp4)" = "320x180"
grep -q '"done":\[0,1\]' out/.oasis-steps/progress.json
# 再跑一次：做完的步骤不重做
node --no-warnings /opt/oasis/services/harness/sandbox/oasis-steps.ts < /dev/null > again.jsonl
grep -q '前面做完的 2 步不再重做' again.jsonl
test "$(grep -c '"type":"tool_call"' again.jsonl)" = "0"

echo OPS_OK
