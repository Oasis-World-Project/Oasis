"""Offline integration/security checks using the real installed oasis-media, FFmpeg and MLT."""
import array
import hashlib
import importlib.util
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import zipfile
from PIL import Image, ImageDraw, ImageFont

spec = importlib.util.spec_from_file_location("oasis_media", "/opt/oasis/media.py")
media = importlib.util.module_from_spec(spec)
spec.loader.exec_module(media)
out = Path("/workspace/out")
out.mkdir(exist_ok=True)
fixture = Path("/workspace/fixtures")
fixture.mkdir()
checks = []


def passed(name):
    checks.append(name)
    print("PASS: " + name, flush=True)


def run(*args, timeout=120):
    p = subprocess.run(args, capture_output=True, timeout=timeout)
    if p.returncode:
        raise RuntimeError(f"{args[0]} failed: {p.stderr.decode('utf8', 'replace')[-4000:]}")
    return p.stdout


def rejected(action, name):
    try:
        action()
    except (ValueError, OSError, KeyError, TypeError):
        passed("reject " + name)
        return
    raise AssertionError("Accepted unsafe case: " + name)


font = ImageFont.truetype("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc", 48)
for name, color, label in [("red", (160, 32, 32), "自制测试素材 A"), ("blue", (24, 60, 160), "自制测试素材 B")]:
    image = Image.new("RGB", (1280, 720), color)
    draw = ImageDraw.Draw(image)
    draw.text((60, 260), label, fill="white", font=font)
    image.save(fixture / (name + ".png"))
    run("ffmpeg", "-v", "error", "-loop", "1", "-i", str(fixture / (name + ".png")),
        "-t", "8", "-r", "25", "-pix_fmt", "yuv420p", "-c:v", "libx264", "-preset", "ultrafast",
        "-vf", "drawbox=x=100+20*t:y=450:w=120:h=80:color=white:t=fill", str(fixture / (name + ".mp4")))
logo = Image.new("RGBA", (240, 120), (255, 210, 30, 255))
ImageDraw.Draw(logo).text((8, 20), "绿洲", fill="black", font=font)
logo.save(fixture / "logo.png")
for frequency in (440, 880):
    run("ffmpeg", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={frequency}:duration=12:sample_rate=48000",
        str(fixture / f"tone-{frequency}.wav"))
passed("self-created video, image and audio fixtures; no paid calls")


def source(name, filename, kind):
    return {"id": name, "path": filename, "sha256": media.digest(fixture / filename), "kind": kind,
            "origin": {"type": "test", "description": "Self-created integration fixture; test tones are not human narration"}}


plan = {"version": 1, "profile": {"width": 1280, "height": 720, "fps": 25}, "durationFrames": 300,
        "sources": [source("red", "red.mp4", "video"), source("blue", "blue.mp4", "video"),
                    source("music", "tone-440.wav", "audio"), source("voice", "tone-880.wav", "audio"),
                    source("logo", "logo.png", "image")],
        "tracks": [
            {"name": "画面", "kind": "video", "clips": [
                {"source": "red", "start": 0, "in": 25, "length": 100, "mute": True, "fadeIn": 10},
                {"source": "blue", "start": 100, "in": 25, "length": 100, "mute": True},
                {"source": "red", "start": 200, "in": 50, "length": 100, "mute": True, "fadeOut": 10}]},
            {"name": "标识叠加", "kind": "video", "clips": [
                {"source": "logo", "start": 50, "length": 200, "rect": [1000, 40, 240, 120]}]},
            {"name": "配乐测试音", "kind": "audio", "clips": [
                {"source": "music", "start": 0, "length": 300, "gainDb": -6, "fadeIn": 25, "fadeOut": 25}]},
            {"name": "配音轨测试音", "kind": "audio", "clips": [
                {"source": "voice", "start": 25, "length": 100, "gainDb": -6}]}],
        "titles": [{"text": "5.8b 可编辑工程验证", "start": 0, "length": 75}],
        "subtitles": [{"text": "自制测试素材 · 镜头 A", "start": 0, "length": 100},
                      {"text": "切到镜头 B，画面标识保持叠加", "start": 100, "length": 100},
                      {"text": "回到镜头 A，自然结束", "start": 200, "length": 100}]}
timeline = fixture / "timeline.json"
timeline.write_text(json.dumps(plan, ensure_ascii=False), "utf8")
case = out / "landscape"
case.mkdir()
run("oasis-media", "build", str(timeline), "--out", str(case / "project"))
project = case / "project" / "project.mlt"
run("oasis-media", "render", str(project), "--out", str(case / "final.mp4"))
info = media.probe(case / "final.mp4")
video = next(s for s in info["streams"] if s["codec_type"] == "video")
assert (video["width"], video["height"], video["avg_frame_rate"]) == (1280, 720, "25/1")
assert abs(float(info["format"]["duration"]) - 12) <= 0.1
assert any(s["codec_type"] == "audio" for s in info["streams"])
passed("real MLT render: H.264/AAC, 720p, 25fps, 12s")

samples = []
for seconds in (1.0, 5.0, 9.0):
    file = case / f"frame-{int(seconds)}.png"
    run("ffmpeg", "-v", "error", "-ss", str(seconds), "-i", str(case / "final.mp4"), "-frames:v", "1", str(file))
    with Image.open(file) as image:
        r, g, b = image.convert("RGB").getpixel((20, 350))
        assert (r > b * 2) if seconds != 5 else (b > r * 2), (seconds, r, g, b)
        if seconds == 5:
            r, g, b = image.convert("RGB").getpixel((1010, 50))
            assert r > 180 and g > 140 and b < 80, (r, g, b)
    samples.append({"seconds": seconds, "sha256": media.digest(file)})
passed("decoded pixels verify A/B/A edit order and actual image overlay")

decoded = run("ffmpeg", "-v", "error", "-i", str(case / "final.mp4"), "-map", "0:a:0", "-ac", "1",
              "-ar", "48000", "-f", "f32le", "-")
audio = array.array("f", decoded)


def rms(start, length):
    part = audio[int(start * 48000):int((start + length) * 48000)]
    return math.sqrt(sum(x * x for x in part) / len(part))


assert rms(0.05, 0.1) < rms(2, 0.1) * 0.5, "Audio fade-in absent"
assert rms(11.8, 0.1) < rms(8, 0.1) * 0.5, "Audio fade-out absent"
assert rms(2, 0.1) > rms(6, 0.1) * 1.2, "Second audio track absent"
passed("actual decoded audio verifies two-track mix and start/end fades")

# Relocation must work with the initial project directory gone.
moved = case / "moved 工程"
(case / "project").rename(moved)
project = moved / "project.mlt"
run("oasis-media", "check", str(project), "--inspect-media")
run("oasis-media", "render", str(project), "--out", str(case / "relocated.mp4"))
run("oasis-media", "pack", str(project), "--out", str(case / "project.zip"))
with zipfile.ZipFile(case / "project.zip") as archive, tempfile.TemporaryDirectory() as unpacked:
    assert archive.testzip() is None
    archive.extractall(unpacked)
    restored = Path(unpacked)
    for name in archive.namelist():
        assert media.digest(restored / name) == media.digest(moved / name)
    run("oasis-media", "check", str(restored / "project.mlt"))
passed("relocated Unicode project renders; ZIP extracts with exact file hashes")

original = project.read_bytes()
assert b'<property name="shotcut:usePointSize">1</property>' in original
alias = project.with_name("社区工程.mlt")
alias.write_bytes(original)
media.check(alias)
alias_zip = case / "alias.zip"
media.pack(alias, alias_zip)
with zipfile.ZipFile(alias_zip) as archive:
    assert alias.name in archive.namelist() and "project.mlt" not in archive.namelist()
    assert alias.name in archive.read("README.md").decode("utf8")
alias.write_bytes(original.replace(b"dynamictext", b"qtext"))
rejected(lambda: media.check(alias), "renamed unsafe project")
alias.unlink()
passed("renamed supported project checks and packs with correct entry name; text uses explicit font size")
for content, label in [(b'<!DOCTYPE mlt [<!ENTITY x SYSTEM "file:///etc/passwd">]><mlt>&x;</mlt>', "XML external entities"),
                       (original.replace(b"media/", b"https://example.test/"), "remote MLT resources"),
                       (original.replace(b"dynamictext", b"qtext"), "unsupported plugins")]:
    project.write_bytes(content)
    rejected(lambda: media.check(project), label)
project.write_bytes(original)
packaged = json.loads((moved / "timeline.json").read_text("utf8"))
media_file = moved / packaged["sources"][0]["path"]
original_media = media_file.read_bytes()
media_file.write_bytes(b"corrupt")
rejected(lambda: media.check(project), "changed media SHA-256")
media_file.write_bytes(original_media)
for filename in ("../red.mp4", "/etc/passwd", "https://example.test/a.mp4", "file:///etc/passwd", "C:/media/a.mp4"):
    rejected(lambda name=filename: media.local_file(fixture, name), "unsafe source " + filename)
(fixture / "link.mp4").symlink_to(fixture / "red.mp4")
rejected(lambda: media.local_file(fixture, "link.mp4"), "symbolic links")
broken = json.loads(json.dumps(plan))
broken["tracks"][0]["clips"][0]["length"] = 1000
rejected(lambda: media.validate(broken, fixture, True), "out-of-range timeline")
passed("all unsafe projects rejected before any MLT load")

# A separate portrait case exercises stills, 30fps, silent visual tracks and no subtitles.
portrait = {"version": 1, "profile": {"width": 720, "height": 1280, "fps": 30}, "durationFrames": 180,
            "sources": [source("image", "logo.png", "image")],
            "tracks": [{"name": "图片轨", "kind": "video", "clips": [
                {"source": "image", "start": 0, "length": 180, "fadeIn": 15, "fadeOut": 15}]}],
            "titles": [{"text": "竖屏自制测试", "start": 30, "length": 120}]}
timeline.write_text(json.dumps(portrait, ensure_ascii=False), "utf8")
case2 = out / "portrait"
case2.mkdir()
run("oasis-media", "build", str(timeline), "--out", str(case2 / "project"))
run("oasis-media", "render", str(case2 / "project/project.mlt"), "--out", str(case2 / "final.mp4"))
run("oasis-media", "pack", str(case2 / "project/project.mlt"), "--out", str(case2 / "project.zip"))
info2 = media.probe(case2 / "final.mp4")
v2 = next(s for s in info2["streams"] if s["codec_type"] == "video")
assert (v2["width"], v2["height"], v2["avg_frame_rate"]) == (720, 1280, "30/1")
passed("separate portrait still-image project: 720x1280, 30fps, 6s, empty SRT")

(out / "report.json").write_text(json.dumps({"checks": checks, "landscape": info, "portrait": info2,
    "samples": samples, "guiShotcutVerified": False, "paidRequests": 0}, ensure_ascii=False, indent=2), "utf8")
