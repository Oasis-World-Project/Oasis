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
        (root / "README.md").write_text("# Oasis 3D scene\n\nOpen scene.blend in Blender with automatic script execution disabled. "
            "The editable scene and embedded GLB use metres. The source scene.json and assets/ are included. "
            "This package has not been cloud rendered or validated for manufacturing, printing or visual quality.\n", "utf8")
        entries = [{"path": p.relative_to(root).as_posix(), "size": p.stat().st_size, "sha256": digest(p)}
                   for p in sorted(root.rglob("*")) if p.is_file()]
        (root / "manifest.json").write_text(json.dumps({"version": 1, "files": entries}, indent=2), "utf8")
        root.rename(output)
    return {"path": str(output), "files": entries, "cloudRendered": False}


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


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "inspect", "pack"])
    parser.add_argument("input", type=Path)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    if args.command == "build":
        require(args.out is not None, "--out required")
        result = build(args.input, args.out)
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
    if "--" in sys.argv and sys.argv[sys.argv.index("--") + 1:][:1] == ["internal-build"]:
        blender_build(Path(sys.argv[-1]))
    else:
        main()
