"""Oasis video timeline -> portable Shotcut project -> render; Python standard library only."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
import xml.etree.ElementTree as ET
import zipfile

MAX_FILE = 512 * 1024 * 1024
MAX_TOTAL = 1024 * 1024 * 1024
KINDS = {
    "video": {".mp4", ".mov", ".mkv", ".webm"},
    "audio": {".mp3", ".wav", ".m4a", ".flac", ".ogg", ".aac"},
    "image": {".png", ".jpg", ".jpeg", ".webp"},
}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def integer(value, low, high, name):
    require(type(value) is int and low <= value <= high, f"{name}: integer {low}..{high} required")
    return value


def text(value, limit, name):
    require(isinstance(value, str) and 0 < len(value) <= limit and "\x00" not in value,
            f"{name}: nonempty text <= {limit} required")
    return value


def fields(value, allowed):
    require(isinstance(value, dict) and not (set(value) - set(allowed)), "Unknown fields")


def local_file(root, name):
    text(name, 400, "path")
    p = PurePosixPath(name)
    require(not p.is_absolute() and ".." not in p.parts and "\\" not in name
            and ":" not in name and not name.startswith(".") and "\n" not in name,
            "Only relative local paths without traversal are allowed")
    current = root.resolve()
    for part in p.parts:
        current = current / part
        require(not current.is_symlink(), "Symbolic links are forbidden")
    require(current.is_file() and current.resolve().is_relative_to(root.resolve()), "Missing local media")
    require(0 < current.stat().st_size <= MAX_FILE, "Media size exceeds limit or is empty")
    return current


def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            h.update(chunk)
    return h.hexdigest()


def run(command, timeout=60, cwd=None):
    # No shell, inherited HTTP proxy, application credentials or arbitrary plugin search paths.
    env = {"PATH": os.environ.get("PATH", ""), "LC_ALL": "C", "QT_QPA_PLATFORM": "offscreen",
           "HOME": tempfile.gettempdir(), "MLT_NO_VDPAU": "1"}
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        child = subprocess.Popen(command, cwd=cwd, env=env, stdout=output, stderr=errors)
        try:
            child.wait(timeout=timeout)
        except BaseException:
            child.kill()
            child.wait()
            raise
        for stream in (output, errors):
            require(stream.tell() <= 2 * 1024 * 1024, "Media command output exceeds limit")
            stream.seek(0)
        stdout, stderr = output.read().decode("utf8", "replace"), errors.read().decode("utf8", "replace")
        require(child.returncode == 0, "Media command failed: " + stderr[-2000:])
        return stdout


def probe(file):
    value = json.loads(run(["ffprobe", "-v", "error", "-protocol_whitelist", "file,pipe",
                            "-show_format", "-show_streams", "-of", "json", str(file)]))
    require(len(value.get("streams", [])) <= 16, "Too many streams")
    for stream in value.get("streams", []):
        if stream.get("codec_type") == "video":
            require(0 < stream.get("width", 0) * stream.get("height", 0) <= 25_000_000,
                    "Source image/video exceeds pixel limit")
    return value


def load_json(file):
    require(file.stat().st_size <= 1024 * 1024, "Timeline exceeds 1 MiB")
    return json.loads(file.read_text("utf8"))


def validate(plan, root, inspect=False):
    fields(plan, ["version", "profile", "durationFrames", "sources", "tracks", "titles", "subtitles"])
    require(plan.get("version") == 1, "Unsupported timeline version")
    profile = plan.get("profile")
    fields(profile, ["width", "height", "fps"])
    width = integer(profile.get("width"), 128, 1920, "width")
    height = integer(profile.get("height"), 128, 1920, "height")
    require(width % 2 == 0 and height % 2 == 0 and width * height <= 1920 * 1080, "Invalid output dimensions")
    fps = integer(profile.get("fps"), 24, 30, "fps")
    require(fps in (24, 25, 30), "Only 24/25/30 fps supported")
    duration = integer(plan.get("durationFrames"), 1, fps * 180, "durationFrames")
    sources = plan.get("sources")
    require(isinstance(sources, list) and 1 <= len(sources) <= 100, "Need 1..100 sources")
    by_id, total = {}, 0
    for source in sources:
        fields(source, ["id", "path", "sha256", "kind", "origin"])
        identifier = text(source.get("id"), 80, "source.id")
        require(identifier not in by_id, "Duplicate source id")
        require(source.get("kind") in KINDS, "Invalid source kind")
        file = local_file(root, source.get("path"))
        require(file.suffix.lower() in KINDS[source["kind"]], "Unsupported media extension")
        total += file.stat().st_size
        require(total <= MAX_TOTAL, "Source files exceed 1 GiB")
        require(digest(file) == source.get("sha256"), "Source SHA-256 mismatch")
        origin = source.get("origin")
        fields(origin, ["type", "description", "model", "jobId"])
        require(origin.get("type") in ("upload", "generated", "test"), "Invalid source origin")
        text(origin.get("description"), 2000, "origin.description")
        for key in ("model", "jobId"):
            if key in origin:
                text(origin[key], 300, f"origin.{key}")
        info = probe(file) if inspect else None
        if info:
            expected = "video" if source["kind"] == "image" else source["kind"]
            require(any(s.get("codec_type") == expected for s in info["streams"]), "Source lacks expected stream")
            if source["kind"] != "image":
                seconds = float(info.get("format", {}).get("duration", 0))
                require(math.isfinite(seconds) and 0 < seconds <= 1200, "Invalid source duration")
        by_id[identifier] = (source, info)
    tracks = plan.get("tracks")
    require(isinstance(tracks, list) and 1 <= len(tracks) <= 12, "Need 1..12 tracks")
    count, visual, used = 0, False, set()
    for track in tracks:
        fields(track, ["name", "kind", "clips"])
        text(track.get("name"), 80, "track.name")
        require(track.get("kind") in ("audio", "video"), "Invalid track kind")
        require(isinstance(track.get("clips"), list) and track["clips"], "Track needs clips")
        end = 0
        for clip in track["clips"]:
            fields(clip, ["source", "start", "in", "length", "gainDb", "mute", "fadeIn", "fadeOut", "rect"])
            require(clip.get("source") in by_id, "Unknown source")
            source, info = by_id[clip["source"]]
            used.add(source["id"])
            require(track["kind"] == "audio" or source["kind"] != "audio", "Audio on visual track")
            visual |= track["kind"] == "video"
            start = integer(clip.get("start"), end, duration - 1, "clip.start (ordered, nonoverlapping)")
            source_in = integer(clip.get("in", 0), 0, fps * 1200, "clip.in")
            length = integer(clip.get("length"), 1, duration - start, "clip.length")
            if source["kind"] == "image":
                require(source_in == 0, "Still image in must be zero")
            elif info:
                available = float(info["format"]["duration"]) * fps
                require(source_in + length <= available + 1, "Source trim exceeds actual duration")
            if "gainDb" in clip:
                require(type(clip["gainDb"]) in (int, float) and -60 <= clip["gainDb"] <= 12, "gainDb -60..12 required")
            if "mute" in clip:
                require(type(clip["mute"]) is bool, "mute must be boolean")
            for fade in ("fadeIn", "fadeOut"):
                integer(clip.get(fade, 0), 0, length, fade)
            require(clip.get("fadeIn", 0) + clip.get("fadeOut", 0) <= length, "Fades overlap")
            if "rect" in clip:
                rect = clip["rect"]
                require(track["kind"] == "video" and isinstance(rect, list) and len(rect) == 4, "Invalid rect")
                x, y, w, h = rect
                integer(x, 0, width - 1, "rect.x")
                integer(y, 0, height - 1, "rect.y")
                integer(w, 1, width - x, "rect.width")
                integer(h, 1, height - y, "rect.height")
            end = start + length
            count += 1
    require(visual and count <= 100 and used == set(by_id), "Need visual track, <=100 clips and no unused sources")
    for kind in ("titles", "subtitles"):
        cues = plan.get(kind, [])
        require(isinstance(cues, list) and len(cues) <= 200, "Too many text cues")
        end = 0
        for cue in cues:
            fields(cue, ["text", "start", "length"])
            text(cue.get("text"), 500, "cue.text")
            start = integer(cue.get("start"), end if kind == "subtitles" else 0, duration - 1, "cue.start")
            length = integer(cue.get("length"), 1, duration - start, "cue.length")
            end = start + length
    return plan


def prop(element, name, value):
    ET.SubElement(element, "property", name=name).text = str(value)


def effect(parent, service, identifier, start, end, properties):
    element = ET.SubElement(parent, "filter", {"in": str(start), "out": str(end)})
    prop(element, "mlt_service", service)
    prop(element, "shotcut:filter", identifier)
    for name, value in properties.items():
        prop(element, name, value)


def project_xml(plan):
    profile, duration = plan["profile"], plan["durationFrames"]
    width, height = profile["width"], profile["height"]
    mlt = ET.Element("mlt", {"LC_NUMERIC": "C", "producer": "tractor", "version": "7.30.0"})
    ET.SubElement(mlt, "profile", {"description": "Oasis", "width": str(width), "height": str(height),
                                 "frame_rate_num": str(profile["fps"]), "frame_rate_den": "1", "progressive": "1",
                                 "sample_aspect_num": "1", "sample_aspect_den": "1",
                                 "display_aspect_num": str(width), "display_aspect_den": str(height), "colorspace": "709"})
    black = ET.SubElement(mlt, "producer", {"id": "black", "in": "0", "out": str(duration - 1)})
    prop(black, "resource", "0")
    prop(black, "mlt_service", "color")
    prop(black, "mlt_image_format", "rgba")
    prop(black, "set.test_audio", 1)
    background = ET.SubElement(mlt, "playlist", id="background")
    ET.SubElement(background, "entry", producer="black", **{"in": "0", "out": str(duration - 1)})
    sources = {source["id"]: source for source in plan["sources"]}
    track_names = []
    # Audio tracks first, video tracks bottom-to-top; Shotcut uses the same order.
    tracks = sorted(plan["tracks"], key=lambda t: t["kind"] != "audio")
    for index, track in enumerate(tracks):
        producer_ids = []
        for number, clip in enumerate(track["clips"]):
            source = sources[clip["source"]]
            identifier = f"clip_{index}_{number}"
            producer_ids.append(identifier)
            source_in, length = clip.get("in", 0), clip["length"]
            node = ET.SubElement(mlt, "producer" if source["kind"] == "image" else "chain", id=identifier)
            prop(node, "resource", source["path"])
            prop(node, "mlt_service", "qimage" if source["kind"] == "image" else "avformat")
            prop(node, "shotcut:caption", source["id"])
            if source["kind"] == "image":
                prop(node, "length", duration)
                prop(node, "eof", "pause")
            if track["kind"] == "audio":
                prop(node, "set.test_image", 1)
            if clip.get("mute") or source["kind"] == "image":
                prop(node, "set.test_audio", 1)
            if "gainDb" in clip:
                effect(node, "volume", "audioGain", source_in, source_in + length - 1,
                       {"level": f"{clip['gainDb']}dB"})
            if "rect" in clip:
                effect(node, "affine", "affineSizePosition", source_in, source_in + length - 1,
                       {"transition.rect": " ".join(map(str, clip["rect"])) + " 1", "background": "color:#00000000", "distort": 0,
                        "transition.distort": 0, "transition.valign": "middle", "transition.halign": "center"})
            for direction in ("In", "Out"):
                fade = clip.get("fade" + direction, 0)
                if not fade:
                    continue
                begin = source_in if direction == "In" else source_in + length - fade
                keyframes = f"0={0 if direction == 'In' else 1};{max(1, fade - 1)}={1 if direction == 'In' else 0}"
                if track["kind"] == "video":
                    effect(node, "brightness", "fade" + direction + "Brightness", begin, begin + fade - 1,
                           {"alpha": 1, "level": keyframes})
                if source["kind"] != "image" and not clip.get("mute"):
                    audio_frames = f"0={'-60dB' if direction == 'In' else '0dB'};{max(1, fade - 1)}={'0dB' if direction == 'In' else '-60dB'}"
                    effect(node, "volume", "fade" + direction + "Volume", begin, begin + fade - 1,
                           {"level": audio_frames, "shotcut:anim" + direction: fade})
        playlist = ET.SubElement(mlt, "playlist", id=f"track_{index}")
        prop(playlist, "shotcut:name", track["name"])
        prop(playlist, "shotcut:" + track["kind"], 1)
        end = 0
        for clip, identifier in zip(track["clips"], producer_ids):
            if clip["start"] > end:
                ET.SubElement(playlist, "blank", length=str(clip["start"] - end))
            source_in = clip.get("in", 0)
            ET.SubElement(playlist, "entry", producer=identifier,
                          **{"in": str(source_in), "out": str(source_in + clip["length"] - 1)})
            end = clip["start"] + clip["length"]
        track_names.append((f"track_{index}", track["kind"]))
    main_bin = ET.SubElement(mlt, "playlist", id="main_bin")
    prop(main_bin, "xml_retain", 1)
    tractor = ET.SubElement(mlt, "tractor", id="tractor", **{"in": "0", "out": str(duration - 1)})
    prop(tractor, "shotcut", 1)
    prop(tractor, "shotcut:projectAudioChannels", 2)
    ET.SubElement(tractor, "track", producer="background")
    visual_tracks = []
    for index, (identifier, kind) in enumerate(track_names, 1):
        ET.SubElement(tractor, "track", producer=identifier, **({"hide": "video"} if kind == "audio" else {}))
        transition = ET.SubElement(tractor, "transition", **{"in": "0", "out": str(duration - 1)})
        for key, value in {"mlt_service": "mix", "a_track": 0, "b_track": index, "always_active": 1,
                           "sum": 1}.items():
            prop(transition, key, value)
        if kind == "video":
            blend = ET.SubElement(tractor, "transition", **{"in": "0", "out": str(duration - 1)})
            for key, value in {"mlt_service": "frei0r.cairoblend", "a_track": visual_tracks[0] if visual_tracks else 0,
                               "b_track": index, "disable": 0 if visual_tracks else 1}.items():
                prop(blend, key, value)
            visual_tracks.append(index)
    for kind in ("titles", "subtitles"):
        for cue in plan.get(kind, []):
            effect(tractor, "dynamictext", "dynamicText", cue["start"], cue["start"] + cue["length"] - 1,
                   {"argument": cue["text"], "geometry": f"0 {int(height * (0.12 if kind == 'titles' else 0.78))} {width} {int(height * 0.16)}",
                    "family": "Noto Sans CJK JP", "size": max(18, round(height / 24)), "weight": 600,
                    "fgcolour": "#ffffffff", "bgcolour": "#00000000", "outlinecolour": "#ff000000",
                    "outlinewidth": 2, "halign": "center", "valign": "middle"})
    ET.indent(mlt)
    return ET.tostring(mlt, encoding="utf-8", xml_declaration=True) + b"\n"


def srt(plan):
    def timestamp(frame):
        milliseconds = round(frame * 1000 / plan["profile"]["fps"])
        seconds, milliseconds = divmod(milliseconds, 1000)
        minutes, seconds = divmod(seconds, 60)
        hours, minutes = divmod(minutes, 60)
        return f"{hours:02}:{minutes:02}:{seconds:02},{milliseconds:03}"
    return "\n\n".join(f"{index}\n{timestamp(cue['start'])} --> {timestamp(cue['start'] + cue['length'])}\n{cue['text']}"
                       for index, cue in enumerate(plan.get("subtitles", []), 1)) + "\n"


def check(project, inspect=False):
    require(project.name == "project.mlt" and not project.is_symlink(), "Expected local project.mlt")
    root = project.parent.resolve()
    plan = validate(load_json(local_file(root, "timeline.json")), root, inspect)
    require(project.stat().st_size <= 1024 * 1024 and project.read_bytes() == project_xml(plan),
            "Project differs from supported timeline; arbitrary MLT XML is not rendered")
    require(local_file(root, "subtitles.srt").read_text("utf8") == srt(plan), "Subtitle timeline mismatch")
    return plan


def build(input_file, destination):
    require(not destination.exists(), "Output project already exists")
    plan = validate(load_json(input_file), input_file.parent.resolve(), inspect=True)
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".oasis-media-", dir=destination.parent) as temp:
        root = Path(temp)
        (root / "media").mkdir()
        # Copy verified bytes; validate again after copying to catch changing sources.
        packaged = json.loads(json.dumps(plan))
        for source in packaged["sources"]:
            original = local_file(input_file.parent.resolve(), source["path"])
            relative = "media/" + source["sha256"] + original.suffix.lower()
            shutil.copyfile(original, root / relative)
            source["path"] = relative
        validate(packaged, root)
        (root / "timeline.json").write_text(json.dumps(packaged, ensure_ascii=False, indent=2), "utf8")
        (root / "project.mlt").write_bytes(project_xml(packaged))
        (root / "subtitles.srt").write_text(srt(packaged), "utf8")
        (root / "README.md").write_text(
            "# Shotcut 可编辑工程\n\n完整解压后，用 Shotcut 打开 project.mlt；media/ 必须一起移动。\n"
            "轨道、剪辑、字幕文字和音量可编辑，导出请选择 H.264/AAC MP4。\n"
            "timeline.json 记录整数帧时间轴、素材来源和 SHA-256；素材仅按摘要重命名，未转码。\n"
            "平台渲染使用同一 project.mlt；手动修改工程后可直接在 Shotcut 导出。\n"
            "平台自动渲染只接受与受支持 timeline.json 一致的 XML，不加载任意插件工程。\n", "utf8")
        check(root / "project.mlt")
        # TemporaryDirectory owns only the staging tree, never a pre-existing user directory.
        root.rename(destination)
    return {"project": str(destination / "project.mlt"), "sources": len(plan["sources"]),
            "durationFrames": plan["durationFrames"]}


def render(project, output):
    plan = check(project, inspect=True)
    require(not output.exists() and output.suffix.lower() == ".mp4", "New .mp4 output required")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".oasis-render-", dir=output.parent) as temp:
        target = Path(temp).resolve() / "render.mp4"
        run(["melt", str(project.resolve()), "-consumer", f"avformat:{target}", "vcodec=libx264", "acodec=aac",
             "crf=20", "preset=fast", "pix_fmt=yuv420p", "ar=48000", "ac=2", "movflags=+faststart",
             "threads=2", "real_time=-2", "terminate_on_pause=1"],
            timeout=min(900, 60 + plan["durationFrames"] / plan["profile"]["fps"] * 5), cwd=project.parent)
        info = probe(target)
        expected = plan["durationFrames"] / plan["profile"]["fps"]
        require(abs(float(info["format"]["duration"]) - expected) <= 0.15, "Rendered duration mismatch")
        run(["ffmpeg", "-v", "error", "-xerror", "-protocol_whitelist", "file,pipe", "-i", str(target),
             "-f", "null", "-"], timeout=180)
        target.rename(output)
    return {"output": str(output), "sha256": digest(output), "durationSeconds": expected}


def pack(project, output):
    plan = check(project)
    require(not output.exists() and output.suffix.lower() == ".zip", "New .zip output required")
    output.parent.mkdir(parents=True, exist_ok=True)
    names = {"project.mlt", "timeline.json", "subtitles.srt", "README.md"} | {s["path"] for s in plan["sources"]}
    require(sum(local_file(project.parent, name).stat().st_size for name in names) <= MAX_TOTAL + 4 * 1024 * 1024,
            "Project exceeds package limit")
    with tempfile.TemporaryDirectory(prefix=".oasis-pack-", dir=output.parent) as temp:
        target = Path(temp) / "project.zip"
        with zipfile.ZipFile(target, "w", compression=zipfile.ZIP_STORED) as archive:
            for name in sorted(names):
                archive.write(local_file(project.parent, name), name)
        target.rename(output)
    return {"output": str(output), "files": len(names), "sha256": digest(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["build", "check", "render", "pack"])
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--inspect-media", action="store_true")
    args = parser.parse_args()
    if args.command == "check":
        plan = check(args.input, args.inspect_media)
        result = {"valid": True, "sources": len(plan["sources"]), "tracks": len(plan["tracks"]),
                  "durationFrames": plan["durationFrames"], "profile": plan["profile"],
                  "subtitleCues": len(plan.get("subtitles", []))}
    else:
        require(args.out is not None, "--out required")
        result = {"build": build, "render": render, "pack": pack}[args.command](args.input, args.out)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.SubprocessError, KeyError, TypeError) as error:
        import sys
        print("oasis-media: " + str(error), file=sys.stderr)
        sys.exit(1)
