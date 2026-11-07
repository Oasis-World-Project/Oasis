"""Bounded scene -> editable Blender/GLB package. No cloud calls or arbitrary renderer scripts."""
import argparse
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import shutil
import struct
import subprocess
import sys
import tempfile
import zipfile


def require(condition, message):
    if not condition:
        raise ValueError(message)


def fields(value, names):
    require(isinstance(value, dict) and not (set(value) - set(names)), "Unknown scene fields")


def vector(value, size, name, low=-10000, high=10000):
    require(isinstance(value, list) and len(value) == size and all(
        type(v) in (int, float) and math.isfinite(v) and low <= v <= high for v in value),
        name + ": invalid finite vector")
    return value


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def local(root, name):
    require(isinstance(name, str) and 0 < len(name) <= 400, "Invalid asset path")
    p = PurePosixPath(name)
    require(not p.is_absolute() and ".." not in p.parts and "\\" not in name
            and ":" not in name and not name.startswith(".") and "\n" not in name,
            "Only relative local asset paths")
    target = root.resolve()
    for part in p.parts:
        target = target / part
        require(not target.is_symlink(), "Symlinks forbidden")
    require(target.is_file() and target.resolve().is_relative_to(root.resolve()), "Missing local asset")
    require(0 < target.stat().st_size <= 100 * 1024 ** 2, "Asset exceeds byte limit")
    return target


def glb_resources(file):
    with file.open("rb") as stream:
        header = stream.read(20)
        require(len(header) == 20, "Incomplete GLB")
        magic, version, size, n, kind = struct.unpack("<4sIIII", header)
        require(magic == b"glTF" and version == 2 and size == file.stat().st_size
                and kind == 0x4e4f534a and 0 < n <= 4 * 1024 ** 2, "Invalid GLB")
        data = json.loads(stream.read(n))
    pending = [data]
    visited = 0
    while pending:
        visited += 1
        require(visited <= 200000, "GLB structure limit")
        value = pending.pop()
        if isinstance(value, dict):
            require("uri" not in value, "GLB external/data URI forbidden; use embedded resources")
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    # WebP textures only change the embedded image codec (fal Trellis output); compression and other
    # required extensions stay rejected because the importer/renderer cannot be assumed to decode them.
    required = data.get("extensionsRequired") or []
    require(isinstance(required, list) and set(required) <= {"EXT_texture_webp"}, "Required GLB extensions unsupported")
    return data


# Mirrors the canvas interactive-preview limits (packages/contracts/src/model-preview.ts).
PREVIEW_LIMITS = {"bytes": 16 * 1024 ** 2, "vertices": 200000, "triangles": 200000, "nodes": 2000,
                  "images": 32, "side": 2048, "pixels": 8 * 1024 ** 2, "primitives": 256}
SIDECAR = "oasis-model-preview.json"


def read_glb(file):
    raw = file.read_bytes()
    require(len(raw) >= 28 and raw[:4] == b"glTF", "Invalid GLB")
    n = struct.unpack("<I", raw[12:16])[0]
    data = json.loads(raw[20:20 + n])
    rest = raw[20 + n:]
    binary = rest[8:8 + struct.unpack("<I", rest[:4])[0]] if len(rest) >= 8 and rest[4:8] == b"BIN\0" else b""
    return data, binary


def image_size(blob):
    if blob[:8] == b"\x89PNG\r\n\x1a\n" and len(blob) >= 24:
        return struct.unpack(">II", blob[16:24])
    i = 2
    while blob[:2] == b"\xff\xd8" and i + 9 < len(blob):
        if blob[i] != 0xFF:
            i += 1
            continue
        marker = blob[i + 1]
        if marker in (0xD8, 0x01, 0xFF) or 0xD0 <= marker <= 0xD7:
            i += 1 if marker == 0xFF else 2
            continue
        if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
            height, width = struct.unpack(">HH", blob[i + 5:i + 9])
            return width, height
        i += 2 + struct.unpack(">H", blob[i + 2:i + 4])[0]
    return None


def preview_problems(file):
    """Reasons the canvas viewer would refuse this GLB; empty means it previews interactively."""
    problems = []
    if file.stat().st_size > PREVIEW_LIMITS["bytes"]:
        problems.append("bytes")
    data, binary = read_glb(file)
    pending, extensions = [data], False
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            extensions |= bool(value.get("extensions")) or bool(value.get("extensionsUsed"))
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    if extensions or data.get("extensionsRequired"):
        problems.append("extensions")
    if data.get("skins") or any(p.get("targets") for m in data.get("meshes", []) for p in m.get("primitives", [])):
        problems.append("skin/morph")
    accessors, counts = data.get("accessors", []), []
    for mesh in data.get("meshes", []):
        vertices = triangles = 0
        for p in mesh.get("primitives", []):
            if p.get("mode", 4) != 4:
                problems.append("non-triangle")
            vertices += accessors[p["attributes"]["POSITION"]]["count"]
            triangles += accessors[p["indices"]]["count"] // 3 if "indices" in p else accessors[p["attributes"]["POSITION"]]["count"] // 3
        counts.append((vertices, triangles))
    if sum(len(m.get("primitives", [])) for m in data.get("meshes", [])) > PREVIEW_LIMITS["primitives"]:
        problems.append("primitives")
    nodes = data.get("nodes", [])
    instanced = [counts[n["mesh"]] for n in nodes if "mesh" in n]
    if sum(v for v, _ in counts) > PREVIEW_LIMITS["vertices"] or sum(t for _, t in instanced) > PREVIEW_LIMITS["triangles"]:
        problems.append("geometry")
    if len(nodes) > PREVIEW_LIMITS["nodes"]:
        problems.append("nodes")
    images, pixels = data.get("images", []), 0
    if len(images) > PREVIEW_LIMITS["images"]:
        problems.append("images")
    for image in images:
        if image.get("mimeType") not in ("image/png", "image/jpeg") or "bufferView" not in image:
            problems.append("texture format")
            continue
        view = data["bufferViews"][image["bufferView"]]
        start = view.get("byteOffset", 0)
        size = image_size(binary[start:start + view["byteLength"]])
        if not size or max(size) > PREVIEW_LIMITS["side"]:
            problems.append("texture size")
            continue
        pixels += size[0] * size[1]
    if pixels > PREVIEW_LIMITS["pixels"]:
        problems.append("texture pixels")
    return sorted(set(problems))


def strip_extensions(file):
    """Drop optional glTF extensions (e.g. emissive strength) from a preview copy; geometry is unchanged."""
    data, binary = read_glb(file)
    require(not data.get("extensionsRequired"), "Preview still requires extensions")
    pending = [data]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            value.pop("extensions", None)
            value.pop("extensionsUsed", None)
            pending.extend(value.values())
        elif isinstance(value, list):
            pending.extend(value)
    text = json.dumps(data, separators=(",", ":")).encode()
    text += b" " * (-len(text) % 4)
    binary += b"\0" * (-len(binary) % 4)
    chunks = struct.pack("<I4s", len(text), b"JSON") + text
    if binary:
        chunks += struct.pack("<I4s", len(binary), b"BIN\0") + binary
    file.write_bytes(struct.pack("<4sII", b"glTF", 2, 12 + len(chunks)) + chunks)


def blender_preview(source, target, triangle_budget):
    """Import a GLB, decimate to the budget, shrink textures and export a plain PNG/JPEG GLB."""
    import bpy
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(source))
    meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    counts = {}
    for obj in meshes:
        obj.data.calc_loop_triangles()
        counts[obj.name] = len(obj.data.loop_triangles)
    total = sum(counts.values())
    if total > triangle_budget:
        # Only dense meshes are reduced; collapsing low-poly walls/boxes would mangle their shape.
        heavy = [o for o in meshes if counts[o.name] > 5000]
        light = total - sum(counts[o.name] for o in heavy)
        ratio = max(0.01, (triangle_budget - light) / max(1, total - light))
        for obj in heavy:
            modifier = obj.modifiers.new("Preview decimate", "DECIMATE")
            modifier.ratio = ratio
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=modifier.name)
    images = [i for i in bpy.data.images if i.size[0] and i.size[1]]
    pixels = sum(i.size[0] * i.size[1] for i in images)
    scale = min(1.0, math.sqrt(PREVIEW_LIMITS["pixels"] * 0.8 / pixels)) if pixels else 1.0
    for image in images:
        factor = min(scale, 1024 / max(image.size))
        if factor < 1:
            image.scale(max(1, int(image.size[0] * factor)), max(1, int(image.size[1] * factor)))
    for material in bpy.data.materials:
        for node in (material.node_tree.nodes if material.use_nodes else []):
            if node.type == "BSDF_PRINCIPLED":
                strength = node.inputs["Emission Strength"]
                strength.default_value = min(strength.default_value, 1.0)
    bpy.ops.export_scene.gltf(filepath=str(target), export_format="GLB", export_cameras=False, export_lights=False,
                              export_extras=False, export_image_format="JPEG", export_image_quality=80)


def make_preview(source):
    """Write <name>-preview.glb and the canvas sidecar next to an over-limit GLB. Returns None if not needed."""
    problems = preview_problems(source)
    if not problems:
        return None
    target = source.with_name(source.stem + "-preview.glb")
    sidecar = source.parent / SIDECAR
    require(not target.exists() and not sidecar.exists(), "Preview files already exist")
    budget = 150000
    for _ in range(3):
        target.unlink(missing_ok=True)
        result = subprocess.run(["blender", "--background", "--factory-startup", "--disable-autoexec",
            "--threads", "2", "--python-exit-code", "1", "--python", str(Path(__file__).resolve()),
            "--", "internal-preview", str(source), str(target), str(budget)], capture_output=True, timeout=600)
        require(result.returncode == 0, "Preview simplification failed: " + result.stderr.decode("utf8", "replace")[-2000:])
        strip_extensions(target)
        remaining = preview_problems(target)
        if not remaining:
            break
        budget = int(budget * 0.6)
    require(not remaining, "Preview still over limits: " + ", ".join(remaining))
    sidecar.write_text(json.dumps({"version": 1,
        "source": {"path": source.name, "sha256": digest(source)},
        "glb": {"path": target.name, "sha256": digest(target)}, "simplified": True}, indent=2), "utf8")
    return {"reasons": problems, "preview": target.name, "sidecar": SIDECAR}


def validate(scene, root):
    fields(scene, ["version", "units", "objects", "camera", "lights", "background", "assets"])
    require(scene.get("version") == 1 and scene.get("units") == "m", "Scene version 1, units m required")
    objects = scene.get("objects")
    require(isinstance(objects, list) and 1 <= len(objects) <= 100, "1..100 objects required")
    assets, ids = {}, set()
    for asset in scene.get("assets", []):
        fields(asset, ["id", "path", "sha256", "origin"])
        require(isinstance(asset.get("id"), str) and asset["id"] not in assets, "Duplicate/invalid asset id")
        path = local(root, asset.get("path"))
        require(path.suffix.lower() == ".glb" and digest(path) == asset.get("sha256"), "Asset type/hash mismatch")
        glb_resources(path)
        require(isinstance(asset.get("origin"), str) and 0 < len(asset["origin"]) <= 1000, "Asset origin required")
        assets[asset["id"]] = path
        require(len(assets) <= 20, "Too many assets")
    for obj in objects:
        fields(obj, ["id", "kind", "asset", "size", "position", "rotation", "color", "roughness", "metallic", "emission"])
        require(isinstance(obj.get("id"), str) and 0 < len(obj["id"]) <= 100 and obj["id"] not in ids,
                "Unique object id required")
        ids.add(obj["id"])
        require(obj.get("kind") in ["box", "sphere", "cylinder", "asset"], "Unknown object kind")
        vector(obj.get("position"), 3, "position")
        vector(obj.get("rotation", [0, 0, 0]), 3, "rotation", -3600, 3600)
        vector(obj.get("size"), 3, "size", .0001, 10000)
        vector(obj.get("color", [0.6, 0.6, 0.6, 1]), 4, "color", 0, 1)
        for key, default, maximum in [("roughness", .5, 1), ("metallic", 0, 1), ("emission", 0, 100)]:
            value = obj.get(key, default)
            require(type(value) in (int, float) and math.isfinite(value) and 0 <= value <= maximum,
                    "Invalid material scalar")
        if obj["kind"] == "asset":
            require(obj.get("asset") in assets, "Unknown asset reference")
            require(not any(key in obj for key in ["color", "roughness", "metallic", "emission"]),
                    "Imported asset material overrides are not yet supported")
    camera = scene.get("camera")
    fields(camera, ["position", "target", "lens"])
    vector(camera.get("position"), 3, "camera position")
    vector(camera.get("target"), 3, "camera target")
    require(camera["position"] != camera["target"], "Camera target equals position")
    lens = camera.get("lens", 50)
    require(type(lens) in (int, float) and math.isfinite(lens) and 10 <= lens <= 200, "Invalid lens")
    vector(scene.get("background", [.05, .05, .05]), 3, "background", 0, 1)
    lights = scene.get("lights", [])
    require(isinstance(lights, list) and len(lights) <= 8, "Too many lights")
    for light in lights:
        fields(light, ["position", "target", "power", "size", "color"])
        vector(light.get("position"), 3, "light position")
        vector(light.get("color", [1, 1, 1]), 3, "light color", 0, 1)
        vector(light.get("target", [0, 0, 0]), 3, "light target")
        require(light["position"] != light.get("target", [0, 0, 0]), "Light direction undefined")
        for key, default, maximum in [("power", 500, 100000), ("size", 5, 100)]:
            value = light.get(key, default)
            require(type(value) in (int, float) and math.isfinite(value) and 0 < value <= maximum,
                    "Invalid light setting")
    return assets


def blender_build(root):
    import bpy
    from mathutils import Vector
    scene = json.loads((root / "scene.json").read_text("utf8"))
    assets = validate(scene, root)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.context.scene.unit_settings.system = "METRIC"
    bpy.context.scene.unit_settings.scale_length = 1
    for spec in scene["objects"]:
        kind = spec["kind"]
        if kind == "asset":
            before = set(bpy.data.objects)
            bpy.ops.import_scene.gltf(filepath=str(assets[spec["asset"]]))
            imported = [o for o in bpy.data.objects if o not in before]
            require(imported and all(o.type in ["MESH", "EMPTY"] for o in imported), "Asset objects unsupported")
            meshes = [o for o in imported if o.type == "MESH"]
            require(meshes and sum(len(o.data.vertices) for o in meshes) <= 1000000, "Imported geometry limit")
            # Preserve source mesh hierarchy; normalize its combined world bounds via a root empty.
            points = [o.matrix_world @ Vector(p) for o in meshes for p in o.bound_box]
            minimum = Vector(tuple(min(p[i] for p in points) for i in range(3)))
            maximum = Vector(tuple(max(p[i] for p in points) for i in range(3)))
            require(all(maximum[i] > minimum[i] for i in range(3)), "Degenerate asset dimensions")
            obj = bpy.data.objects.new(spec["id"], None)
            bpy.context.collection.objects.link(obj)
            for child in imported:
                if child.parent is None:
                    child.parent = obj
                    child.location -= (minimum + maximum) / 2
            obj.scale = tuple(spec["size"][i] / (maximum[i] - minimum[i]) for i in range(3))
        else:
            if kind == "box":
                bpy.ops.mesh.primitive_cube_add(size=1)
            elif kind == "sphere":
                bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=16, radius=.5)
            else:
                bpy.ops.mesh.primitive_cylinder_add(vertices=32, radius=.5, depth=1)
            obj = bpy.context.object
            obj.name = spec["id"]
            obj.scale = spec["size"]
            material = bpy.data.materials.new(spec["id"] + " material")
            material.use_nodes = True
            shader = material.node_tree.nodes.get("Principled BSDF")
            shader.inputs["Base Color"].default_value = spec.get("color", [.6, .6, .6, 1])
            shader.inputs["Roughness"].default_value = spec.get("roughness", .5)
            shader.inputs["Metallic"].default_value = spec.get("metallic", 0)
            if spec.get("emission", 0) > 0:
                # Self-lit surfaces (lamp shades, screens) glow in the object's own colour.
                shader.inputs["Emission Color"].default_value = spec.get("color", [.6, .6, .6, 1])
                shader.inputs["Emission Strength"].default_value = spec["emission"]
            obj.data.materials.append(material)
        obj.location = spec["position"]
        obj.rotation_euler = tuple(math.radians(v) for v in spec.get("rotation", [0, 0, 0]))
        bpy.context.view_layer.update()
    camera = bpy.data.cameras.new("Camera")
    obj = bpy.data.objects.new("Camera", camera)
    bpy.context.collection.objects.link(obj)
    obj.location = scene["camera"]["position"]
    obj.rotation_euler = (Vector(scene["camera"]["target"]) - obj.location).to_track_quat("-Z", "Y").to_euler()
    camera.lens = scene["camera"].get("lens", 50)
    bpy.context.scene.camera = obj
    for i, light in enumerate(scene.get("lights", [])):
        data = bpy.data.lights.new("Area " + str(i), "AREA")
        data.energy, data.shape, data.size = light.get("power", 500), "DISK", light.get("size", 5)
        data.color = light.get("color", [1, 1, 1])
        obj = bpy.data.objects.new(data.name, data)
        bpy.context.collection.objects.link(obj)
        obj.location = light["position"]
        obj.rotation_euler = (Vector(light.get("target", [0, 0, 0])) - obj.location).to_track_quat("-Z", "Y").to_euler()
    bpy.context.scene.world.color = scene.get("background", [.05, .05, .05])
    bpy.ops.file.pack_all()
    bpy.ops.wm.save_as_mainfile(filepath=str(root / "scene.blend"))
    bpy.ops.export_scene.gltf(filepath=str(root / "model.glb"), export_format="GLB", export_cameras=False,
                              export_lights=False, export_extras=False)


def build(source, output):
    require(not source.is_symlink() and source.is_file() and source.stat().st_size <= 1024 ** 2, "Invalid scene input")
    scene = json.loads(source.read_text("utf8"))
    assets = validate(scene, source.parent)
    require(not output.exists(), "Output already exists; choose a new directory")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix=".oasis-3d-", dir=output.parent) as temp:
        root = Path(temp)
        (root / "assets").mkdir()
        for i, asset in enumerate(scene.get("assets", [])):
            target = root / "assets" / (str(i) + ".glb")
            shutil.copyfile(assets[asset["id"]], target)
            asset["path"] = target.relative_to(root).as_posix()
        (root / "scene.json").write_text(json.dumps(scene, ensure_ascii=False, indent=2), "utf8")
        result = subprocess.run(["blender", "--background", "--factory-startup", "--disable-autoexec",
            "--threads", "2", "--python-exit-code", "1", "--python", str(Path(__file__).resolve()),
            "--", "internal-build", str(root)], capture_output=True, timeout=180)
        require(result.returncode == 0, "Blender build failed: " + result.stderr.decode("utf8", "replace")[-2000:])
        glb_resources(root / "model.glb")
        preview = make_preview(root / "model.glb")
        (root / "README.md").write_text("# Oasis 3D scene\n\nOpen scene.blend in Blender with automatic script execution disabled. "
            "The editable scene and embedded GLB use metres. The source scene.json and assets/ are included. "
            "This package has not been cloud rendered or validated for manufacturing, printing or visual quality.\n", "utf8")
        entries = [{"path": p.relative_to(root).as_posix(), "size": p.stat().st_size, "sha256": digest(p)}
                   for p in sorted(root.rglob("*")) if p.is_file()]
        (root / "manifest.json").write_text(json.dumps({"version": 1, "files": entries}, indent=2), "utf8")
        root.rename(output)
    return {"path": str(output), "files": entries, "cloudRendered": False, "preview": preview}


def inspect_package(root):
    require(root.is_dir() and not root.is_symlink(), "Invalid project directory")
    manifest = json.loads(local(root, "manifest.json").read_text("utf8"))
    require(manifest.get("version") == 1 and 1 <= len(manifest.get("files", [])) <= 50, "Invalid manifest")
    names = [item["path"] for item in manifest["files"]]
    require(len(names) == len(set(names)) and {"scene.json", "scene.blend", "model.glb", "README.md"}.issubset(names),
            "Project closure incomplete")
    require(set(names) == {p.relative_to(root).as_posix() for p in root.rglob("*") if p.is_file()} - {"manifest.json"},
            "Project has missing or undeclared files")
    for item in manifest["files"]:
        file = local(root, item["path"])
        require(file.stat().st_size == item["size"] and digest(file) == item["sha256"], "Project hash mismatch")
    validate(json.loads((root / "scene.json").read_text("utf8")), root)
    glb_resources(root / "model.glb")
    return {"valid": True, "files": manifest["files"], "unchecked": ["native Blender semantic integrity", "visual quality", "cloud GPU"]}


MODEL_FORMATS = (".glb", ".gltf", ".fbx", ".obj", ".stl", ".ply", ".blend")
SNAPSHOT_VIEWS = ("front3q", "front", "side", "back3q", "top")
JSON_MARK = "OASIS_JSON:"


def blender_run(*command):
    """在无界面 Blender 里跑本文件的内部命令，取回它打印的 JSON。"""
    result = subprocess.run(["blender", "--background", "--factory-startup", "--disable-autoexec",
        "--threads", "2", "--python-exit-code", "1", "--python", str(Path(__file__).resolve()),
        "--", *command], capture_output=True, timeout=900)
    out = result.stdout.decode("utf8", "replace")
    require(result.returncode == 0, "Blender failed: " + (result.stderr.decode("utf8", "replace") + out)[-2000:])
    lines = [line[len(JSON_MARK):] for line in out.splitlines() if line.startswith(JSON_MARK)]
    require(lines, "Blender returned no result")
    return json.loads(lines[-1])


def model_input(file):
    require(file.is_file() and not file.is_symlink(), "A local model file is required")
    require(file.suffix.lower() in MODEL_FORMATS, "Supported: " + ", ".join(MODEL_FORMATS))
    require(file.stat().st_size <= 200 * 1024 ** 2, "Model files up to 200 MiB")


def contact_sheet(files, target):
    """几张视角图拼成一张（每格标上视角名），方便一次看完。"""
    from PIL import Image, ImageDraw
    images = [Image.open(f).convert("RGB") for f in files]
    width, height = images[0].size
    columns = 2 if len(images) > 1 else 1
    rows = math.ceil(len(images) / columns)
    sheet = Image.new("RGB", (width * columns, height * rows), (255, 255, 255))
    draw = ImageDraw.Draw(sheet)
    for index, (image, file) in enumerate(zip(images, files)):
        x, y = (index % columns) * width, (index // columns) * height
        sheet.paste(image, (x, y))
        draw.text((x + 12, y + 10), Path(file).stem, fill=(40, 40, 52))
    sheet.save(target)


def snapshot(source, folder, views, size):
    """自动取景出几张视角图和一张拼图（Cycles CPU，几秒到几十秒）。"""
    model_input(source)
    require(all(v in SNAPSHOT_VIEWS for v in views), "Views: " + ", ".join(SNAPSHOT_VIEWS))
    width, height = (int(n) for n in size.lower().split("x"))
    require(64 <= width <= 1920 and 64 <= height <= 1920, "Size between 64x64 and 1920x1920")
    folder.mkdir(parents=True, exist_ok=True)
    result = blender_run("internal-snapshot", str(source.resolve()), str(folder.resolve()), ",".join(views), f"{width}x{height}")
    contact_sheet(result["views"], folder / "sheet.png")
    return {"views": [str(Path(folder) / Path(f).name) for f in result["views"]],
            "sheet": str(folder / "sheet.png"), "size_m": result["size_m"],
            "note": "视角：front3q 前方 3/4、front 正前（-Y）、side 右侧（+X）、back3q 后方 3/4、top 俯视；地面和灯光是看图用的，不在模型里。"}


def check(source):
    """一次报告尺寸、离地、三角面、材质、焊点后的拓扑问题，以及画布能否直接预览。"""
    model_input(source)
    report = blender_run("internal-check", str(source.resolve()))
    notes = ["拓扑按位置焊点后统计；开口边常见于单面的薄片（窗格、布），不一定是错。"]
    if source.suffix.lower() == ".glb":
        try:
            glb_resources(source)
            report["preview_problems"] = preview_problems(source)
        except Exception as error:
            report["preview_problems"] = [str(error)]
        notes.append("preview_problems 为空表示画布能直接交互预览；不为空可用 oasis-3d preview 生成配套预览。")
        if shutil.which("gltf-transform"):
            result = subprocess.run(["gltf-transform", "validate", str(source)], capture_output=True, timeout=300)
            report["gltf_validator"] = {"exit_code": result.returncode,
                "output": (result.stdout + result.stderr).decode("utf8", "replace")[-3000:]}
    else:
        notes.append("不是 GLB：画布不能直接预览，要预览请同时交付 GLB（oasis_blender.export_glb）。")
    report["notes"] = notes
    return report


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "inspect", "pack", "preview", "snapshot", "check"])
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--views", default="front3q,side,front,back3q")
    parser.add_argument("--size", default="960x720")
    args = parser.parse_args()
    if args.command == "snapshot":
        require(args.out is not None, "--out <folder> required")
        result = snapshot(args.input, args.out, args.views.split(","), args.size)
    elif args.command == "check":
        result = check(args.input)
    elif args.command == "build":
        require(args.out is not None, "--out required")
        result = build(args.input, args.out)
    elif args.command == "preview":
        require(args.input.suffix.lower() == ".glb" and args.input.is_file() and not args.input.is_symlink()
                and args.input.stat().st_size <= 100 * 1024 ** 2, "A local GLB up to 100 MiB is required")
        glb_resources(args.input)
        result = make_preview(args.input) or {"preview": None, "reason": "GLB already previews interactively"}
    else:
        result = inspect_package(args.input)
        if args.command == "pack":
            require(args.out is not None and not args.out.exists(), "New --out ZIP required")
            with zipfile.ZipFile(args.out, "x", compression=zipfile.ZIP_STORED) as archive:
                for file in sorted(args.input.rglob("*")):
                    if file.is_file():
                        archive.write(file, file.relative_to(args.input))
            result["archive"] = str(args.out)
    print(json.dumps(result, ensure_ascii=False))


if __name__ == "__main__":
    command = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    if command[:1] == ["internal-build"]:
        blender_build(Path(sys.argv[-1]))
    elif command[:1] == ["internal-preview"]:
        blender_preview(Path(command[1]), Path(command[2]), int(command[3]))
    elif command[:1] in (["internal-snapshot"], ["internal-check"]):
        sys.path.insert(0, str(Path(__file__).resolve().parent))
        import oasis_blender
        oasis_blender.load(command[1])
        if command[0] == "internal-check":
            print(JSON_MARK + json.dumps(oasis_blender.survey(), ensure_ascii=False))
        else:
            report = oasis_blender.survey()
            width, height = (int(n) for n in command[4].split("x"))
            views = oasis_blender.render_views(command[2], command[3].split(","), (width, height))
            print(JSON_MARK + json.dumps({"views": views, "size_m": report["size_m"]}, ensure_ascii=False))
    else:
        main()
