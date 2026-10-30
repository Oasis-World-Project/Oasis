"""Real Blender offline foundation checks. No model or cloud calls."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shutil
import subprocess
import zipfile
from PIL import Image

spec = importlib.util.spec_from_file_location("geometry", "/opt/oasis/geometry.py")
geometry = importlib.util.module_from_spec(spec)
spec.loader.exec_module(geometry)
root = Path("/workspace/evidence")
checks = []


def passed(text):
    checks.append(text)
    print("PASS: " + text, flush=True)


def run(*args):
    result = subprocess.run(args, capture_output=True, timeout=180)
    if result.returncode:
        raise RuntimeError(result.stderr.decode("utf8", "replace")[-3000:])
    return result.stdout.decode("utf8", "replace")


def rejected(action, label):
    try:
        action()
    except (ValueError, OSError, KeyError, TypeError):
        passed("reject " + label)
        return
    raise AssertionError("Accepted " + label)


scene = {"version": 1, "units": "m", "objects": [
    {"id": "台座", "kind": "box", "size": [3, 3, .2], "position": [0, 0, -.1], "color": [.3, .3, .3, 1]},
    {"id": "红色盒子", "kind": "box", "size": [1, 1, 1], "position": [-.6, 0, .5], "color": [.8, .05, .02, 1]},
    {"id": "蓝色球", "kind": "sphere", "size": [.8, .8, .8], "position": [.6, 0, .4], "color": [.02, .1, .8, 1]}],
    "camera": {"position": [5, -7, 5], "target": [0, 0, .4], "lens": 45},
    "lights": [{"position": [1, -3, 6], "power": 800, "size": 5}]}
source = root / "input.json"
source.write_text(json.dumps(scene, ensure_ascii=False), "utf8")
result = geometry.build(source, root / "原工程")
assert result["cloudRendered"] is False
passed("real Blender creates editable .blend, embedded GLB and declared source")
geometry.inspect_package(root / "原工程")
passed("project manifest bytes and SHA-256 match; no missing closure")
asset_scene = {"version": 1, "units": "m", "assets": [{"id": "source", "path": "原工程/model.glb",
    "sha256": geometry.digest(root / "原工程/model.glb"), "origin": "Self-created test scene"}],
    "objects": [{"id": "imported", "kind": "asset", "asset": "source", "size": [2, 2, 1], "position": [0, 0, 0]}],
    "camera": scene["camera"], "lights": scene["lights"]}
(root / "asset-input.json").write_text(json.dumps(asset_scene, ensure_ascii=False), "utf8")
geometry.build(root / "asset-input.json", root / "资产组合")
geometry.inspect_package(root / "资产组合")
passed("authorized GLB asset is imported with verified SHA and portable source closure")
shutil.copytree(root / "原工程", root / "搬移工程")
before = {p.name: geometry.digest(p) for p in (root / "搬移工程").iterdir() if p.is_file()}
for name in ["原工程", "搬移工程"]:
    # Trusted fixture script, not an application feature allowing arbitrary GPU/renderer commands.
    script = root / (name + "-verify.py")
    target = root / (name + ".png")
    script.write_text("\n".join([
        "import bpy, json",
        "s=bpy.context.scene",
        "assert len([o for o in s.objects if o.type=='MESH'])==3",
        "assert abs(bpy.data.objects['红色盒子'].dimensions.x-1)<0.0001",
        "s.render.engine='CYCLES'; s.cycles.device='CPU'; s.cycles.samples=8; s.cycles.use_denoising=False; s.cycles.seed=0",
        "s.render.resolution_x=128; s.render.resolution_y=128; s.render.resolution_percentage=100",
        "s.render.image_settings.file_format='PNG'",
        "s.render.filepath=" + repr(str(target)),
        "bpy.ops.render.render(write_still=True)",
    ]), "utf8")
    run("blender", "--background", "--factory-startup", "--disable-autoexec", str(root / name / "scene.blend"),
        "--threads", "2", "--python-exit-code", "1", "--python", str(script))
    with Image.open(target) as image:
        image.load()
        assert image.size == (128, 128)
        assert len(set(image.convert("RGB").tobytes())) > 50
assert before == {p.name: geometry.digest(p) for p in (root / "搬移工程").iterdir() if p.is_file()}
assert Image.open(root / "原工程.png").tobytes() == Image.open(root / "搬移工程.png").tobytes()
passed("moved Unicode project reopens with editable objects and reproduces same CPU render")
run("oasis-3d", "pack", str(root / "搬移工程"), "--out", str(root / "project.zip"))
with zipfile.ZipFile(root / "project.zip") as archive:
    assert archive.testzip() is None
    assert set(archive.namelist()) == {str(p.relative_to(root / "搬移工程")) for p in (root / "搬移工程").rglob("*") if p.is_file()}
passed("ZIP exact closure and CRC, no invented files")
bad = json.loads(json.dumps(scene)); bad["objects"][0]["position"] = [float("nan"), 0, 0]
rejected(lambda: geometry.validate(bad, root), "nonfinite geometry")
bad = json.loads(json.dumps(scene)); bad["command"] = "print('no')"
rejected(lambda: geometry.validate(bad, root), "arbitrary script field")
rejected(lambda: geometry.local(root, "../outside.glb"), "path traversal")
rejected(lambda: geometry.local(root, "https://example.com/a.glb"), "remote resource")
(root / "link.glb").symlink_to(root / "原工程/model.glb")
rejected(lambda: geometry.local(root, "link.glb"), "symbolic link")
(root / "link.glb").unlink()
(root / "搬移工程/model.glb").write_bytes(b"changed")
rejected(lambda: geometry.inspect_package(root / "搬移工程"), "tampered final file")
shutil.rmtree(root / "搬移工程")
lit = json.loads(json.dumps(scene))
lit["objects"].append({"id": "lamp shade", "kind": "cylinder", "size": [.3, .3, .25], "position": [0, 1, 1],
                       "color": [1, .7, .4, 1], "emission": 12})
lit["lights"].append({"position": [0, 1, 1.5], "target": [0, 1, 0], "power": 60, "size": .3, "color": [1, .75, .45]})
lit["background"] = [.01, .01, .02]
(root / "lit-input.json").write_text(json.dumps(lit, ensure_ascii=False), "utf8")
geometry.build(root / "lit-input.json", root / "lit-project")
script = root / "lit-verify.py"
script.write_text("\n".join([
    "import bpy",
    "l=[o for o in bpy.data.objects if o.type=='LIGHT']",
    "assert any(abs(o.data.color[1]-0.75)<1e-4 and abs(o.data.color[2]-0.45)<1e-4 for o in l), [tuple(o.data.color) for o in l]",
    "n=bpy.data.materials['lamp shade material'].node_tree.nodes['Principled BSDF']",
    "assert abs(n.inputs['Emission Strength'].default_value-12)<1e-4",
]), "utf8")
run("blender", "--background", "--factory-startup", "--disable-autoexec", str(root / "lit-project/scene.blend"),
    "--python-exit-code", "1", "--python", str(script))
passed("light colour and emissive surfaces survive into the editable .blend")
bad = json.loads(json.dumps(lit)); bad["lights"][1]["color"] = [2, 0, 0]
rejected(lambda: geometry.validate(bad, root), "out-of-range light colour")
bad = json.loads(json.dumps(asset_scene)); bad["objects"][0]["emission"] = 5
rejected(lambda: geometry.validate(bad, root), "emission override on imported asset")
shutil.rmtree(root / "lit-project")
passed("no cloud GPU was requested or claimed")
(root / "checks.json").write_text(json.dumps({"checks": checks, "paidCalls": 0, "cloudGpu": False,
    "blender": run("blender", "--version").splitlines()[0]}, ensure_ascii=False, indent=2), "utf8")
