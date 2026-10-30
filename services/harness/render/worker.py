"""Runpod queue shell. No long-lived storage credentials; fixed JSON scene contract."""
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.parse
import urllib.request
import zipfile

from geometry import digest, fields, glb_resources, inspect_package, require, validate

LOCK = threading.Lock()
MAX_ASSET = 100 * 1024 ** 2
MAX_TOTAL = 200 * 1024 ** 2


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def signed_url(value, transfer):
    require(isinstance(value, str) and len(value) <= 8192, "Invalid object URL")
    url = urllib.parse.urlsplit(value)
    host, bucket = os.environ.get("RENDER_STAGING_HOST"), os.environ.get("RENDER_STAGING_BUCKET")
    require(host and re.fullmatch(r"[a-f0-9]{32}\.r2\.cloudflarestorage\.com", host), "R2 host not configured")
    require(bucket and url.scheme == "https" and url.netloc == host and not url.fragment,
            "Only configured HTTPS R2 host allowed")
    decoded = urllib.parse.unquote(url.path)
    require(decoded.startswith("/" + bucket + "/jobs/" + transfer + "/")
            and not any(p in (".", "..", "") for p in decoded[1:].split("/")) and "%" not in decoded,
            "Object outside this transfer")
    query = urllib.parse.parse_qs(url.query)
    require(all(len(query.get(k, [])) == 1 for k in ["X-Amz-Signature", "X-Amz-Expires", "X-Amz-Credential"]),
            "Presigned S3 object required")
    require(query["X-Amz-Expires"][0].isdigit() and 1 <= int(query["X-Amz-Expires"][0]) <= 3600,
            "Signature lifetime exceeds bound")
    return value


def request(url, method, file, expected_size=None):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
    try:
        if method == "GET":
            with opener.open(urllib.request.Request(url, method=method), timeout=30) as response, file.open("xb") as output:
                count = 0
                while chunk := response.read(1024 * 1024):
                    count += len(chunk)
                    require(count <= expected_size, "Asset download exceeds declared size")
                    output.write(chunk)
                require(count == expected_size, "Asset download size mismatch")
        else:
            require(0 < file.stat().st_size <= MAX_TOTAL, "Output exceeds byte limit")
            with file.open("rb") as data:
                req = urllib.request.Request(url, data=data, method="PUT", headers={"Content-Length": str(file.stat().st_size)})
                with opener.open(req, timeout=60) as response:
                    require(200 <= response.status < 300, "Object write failed")
    except (urllib.error.URLError, OSError):
        # Never include signed URLs or provider response bodies in logs/errors.
        raise RuntimeError("Object transfer failed; retry same transfer with fresh signatures") from None


def render_settings(value):
    fields(value, ["width", "height", "samples", "backend"])
    for key, low, high in [("width", 64, 2048), ("height", 64, 2048), ("samples", 1, 128)]:
        require(type(value.get(key)) is int and low <= value[key] <= high, "Invalid render " + key)
    require(value.get("backend") in ("CUDA", "OPTIX"), "CUDA or OPTIX required")


def canary():
    root = Path("/jobs/other")
    root.mkdir(exist_ok=True)
    (root / "private").write_text("isolation-canary-not-user-data")


def failure_reason(root, code):
    # Never return raw child output: it can include user paths, assets or credentials.
    with (root / "process.txt").open("rb") as log:
        head = log.read(16384).decode("utf8", "replace")
    markers = {
        "Landlock ABI >=3 required": "landlock_unsupported",
        "isolation identity/path": "identity_or_path",
        "no_new_privs": "no_new_privileges",
        "isolation ruleset": "landlock_ruleset",
        "isolation rule:": "landlock_rule",
        "isolation enforce": "landlock_enforce",
        "isolation seccomp": "seccomp",
        "isolation exec": "child_exec",
        "Filesystem boundary failed": "filesystem_boundary",
        "Network boundary failed": "network_boundary",
        "Process boundary failed": "process_boundary",
        "Secret environment inherited": "environment_boundary",
        "Required GPU unavailable; CPU fallback forbidden": "gpu_unavailable",
    }
    stage = next((value for marker, value in markers.items() if marker in head), "unclassified_child_failure")
    return "Isolated renderer failed; stage=" + stage + "; exit=" + str(code) + "; no CPU fallback"


def execute(root, mode):
    # No provider input can change the executable, script, environment or process limits.
    with (root / "process.txt").open("wb") as log:
        child = subprocess.Popen(["/opt/oasis/isolate", str(root), mode, str(os.getpid())], stdin=subprocess.DEVNULL,
            stdout=log, stderr=log, env={}, start_new_session=True, close_fds=True)
        try:
            code = child.wait(timeout=600)
        except BaseException:
            os.killpg(child.pid, signal.SIGKILL)
            child.wait()
            raise
    if code != 0 and os.environ.get("RENDER_TEST_OUTPUT"):
        import shutil
        shutil.copyfile(root / "process.txt", Path(os.environ["RENDER_TEST_OUTPUT"]) / (mode + "-failure.txt"))
    if code != 0:
        raise ValueError(failure_reason(root, code))
    require((root / "boundary.json").is_file() and (root / "device.json").is_file(), "Missing render evidence")


def fixture():
    return {"version": 1, "units": "m", "objects": [
        {"id": "red cube", "kind": "box", "size": [1, 1, 1], "position": [0, 0, .5], "color": [.8, .03, .02, 1]},
        {"id": "floor", "kind": "box", "size": [5, 5, .1], "position": [0, 0, -.1]}],
        "camera": {"position": [4, -6, 4], "target": [0, 0, .4]},
        "lights": [{"position": [2, -3, 5], "power": 800, "size": 4}]}


def package(root):
    (root / "README.md").write_text("# Oasis rendered 3D scene\n\nOpen scene.blend in Blender with automatic script execution disabled. "
        "The scene uses metres; scene.json and embedded GLB assets are editable source inputs. "
        "image.png is the rendered still. device.json records whether GPU or the internal CPU test was used. "
        "boundary.json records local boundary probes; it does not certify the cloud host or provider bill. "
        "Visual requirements, manufacturing/printability and final archive ownership require independent checks.\n")
    names = ["scene.json", "scene.blend", "model.glb", "README.md", "device.json", "boundary.json", "image.png"]
    names += [p.relative_to(root).as_posix() for p in (root / "assets").glob("*.glb")]
    for name in names:
        require((root / name).is_file() and not (root / name).is_symlink(), "Missing render artifact")
    require(sum((root / name).stat().st_size for name in names) <= MAX_TOTAL, "Project exceeds byte limit")
    glb_resources(root / "model.glb")
    manifest = [{"path": name, "size": (root / name).stat().st_size, "sha256": digest(root / name)} for name in names]
    (root / "manifest.json").write_text(json.dumps({"version": 1, "files": manifest}, indent=2))
    with zipfile.ZipFile(root / "project.zip", "x", compression=zipfile.ZIP_STORED) as archive:
        for name in names + ["manifest.json"]:
            archive.write(root / name, name)
    return {key: {"size": (root / name).stat().st_size, "sha256": digest(root / name)}
            for key, name in [("image", "image.png"), ("project", "project.zip")]}


def handler(job):
    with LOCK:
        value = job.get("input")
        fields(value, ["version", "operation", "transferId", "scene", "assets", "render", "outputs"])
        require(type(value.get("version")) is int and value["version"] == 1, "Protocol version 1 required")
        require(value.get("operation") in ("render", "probe"), "Unknown operation")
        transfer = value.get("transferId")
        require(isinstance(transfer, str) and re.fullmatch(r"[a-f0-9]{32}", transfer), "Random transfer ID required")
        settings = value.get("render")
        render_settings(settings)
        outputs = value.get("outputs")
        fields(outputs, ["image", "project"])
        urls = {key: signed_url(outputs.get(key), transfer) for key in ("image", "project")}
        require(urls["image"].split("?")[0] != urls["project"].split("?")[0], "Distinct output objects required")
        assets = value.get("assets", [])
        require(isinstance(assets, list) and len(assets) <= 20, "Asset count limit")
        scene = fixture() if value["operation"] == "probe" else value.get("scene")
        require(isinstance(scene, dict) and len(json.dumps(scene)) <= 1024 ** 2, "Invalid scene")
        canary()
        with tempfile.TemporaryDirectory(prefix="render-", dir="/jobs") as directory:
            root = Path(directory)
            (root / "assets").mkdir()
            source_assets = scene.get("assets", [])
            require(isinstance(source_assets, list) and len(assets) == len(source_assets), "Scene asset closure mismatch")
            require(sum(a.get("size", 0) for a in assets if isinstance(a, dict) and type(a.get("size")) is int) <= MAX_TOTAL,
                    "Aggregate asset byte limit")
            for i, asset in enumerate(assets):
                fields(asset, ["id", "url", "size", "sha256"])
                require(type(asset.get("size")) is int and 0 < asset["size"] <= MAX_ASSET, "Asset byte limit")
                source = source_assets[i]
                require(source.get("id") == asset.get("id") and source.get("sha256") == asset.get("sha256"), "Asset identity mismatch")
                # All local paths are assigned here, never accepted from a provider URL or ZIP.
                source["path"] = "assets/" + str(i) + ".glb"
                target = root / source["path"]
                request(signed_url(asset.get("url"), transfer), "GET", target, asset["size"])
                require(digest(target) == asset["sha256"], "Asset hash mismatch")
            validate(scene, root)
            (root / "scene.json").write_text(json.dumps(scene))
            (root / "render.json").write_text(json.dumps(settings))
            execute(root, value["operation"])
            artifacts = package(root)
            for key, name in [("image", "image.png"), ("project", "project.zip")]:
                request(urls[key], "PUT", root / name)
            return {"version": 1, "transferId": transfer, "artifacts": artifacts,
                    "device": json.loads((root / "device.json").read_text()),
                    "boundary": json.loads((root / "boundary.json").read_text()),
                    "unchecked": ["provider bill", "final private archive", "visual requirements"]}


def self_test():
    canary()
    with tempfile.TemporaryDirectory(prefix="render-", dir="/jobs") as directory:
        root = Path(directory)
        (root / "assets").mkdir()
        (root / "scene.json").write_text(json.dumps(fixture()))
        (root / "render.json").write_text(json.dumps({"width": 128, "height": 128, "samples": 8, "backend": "CUDA"}))
        execute(root, "cpu-test")
        artifacts = package(root)
        require((root / "image.png").read_bytes().startswith(b"\x89PNG\r\n\x1a\n"), "Not a PNG")
        with zipfile.ZipFile(root / "project.zip") as archive:
            require(archive.testzip() is None, "Invalid project ZIP")
            with tempfile.TemporaryDirectory(prefix="verify-", dir="/jobs") as extracted:
                # The archive was created here from fixed names, never supplied by a caller.
                archive.extractall(extracted)
                inspect_package(Path(extracted))
        if os.environ.get("RENDER_TEST_OUTPUT"):
            import shutil
            for name in ["image.png", "project.zip", "device.json", "boundary.json", "manifest.json"]:
                shutil.copyfile(root / name, Path(os.environ["RENDER_TEST_OUTPUT"]) / name)
        print(json.dumps({"passed": True, "gpuTested": False, "artifacts": artifacts,
                          "boundary": json.loads((root / "boundary.json").read_text())}))


if __name__ == "__main__":
    if sys.argv[1:] == ["--self-test"]:
        self_test()
    else:
        # The SDK defaults to DEBUG and logs local job bodies. Force INFO before import.
        os.environ["RUNPOD_LOG_LEVEL"] = "INFO"
        import runpod
        # Never let the SDK expose job input (including signed object URLs) in logs.
        runpod.serverless.start({"handler": handler})
