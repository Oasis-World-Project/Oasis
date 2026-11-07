"""Oasis 的 Blender 小工具（ADR 0020）。在 Blender 脚本里直接 `import oasis_blender as ob`：

    ob.reset()                                    清空场景，单位米，Z 轴向上
    wood = ob.material("wood", "#C89A6B", roughness=0.7)   只用基础色/粗糙度/金属度，导出不带扩展
    problems = ob.export_glb("out/模型.glb")       导出画布能直接交互预览的 GLB；返回不能直接预览的原因，空列表就是能
    ob.stage(objects)                             按物体大小摆好地面、三点光和中性背景
    ob.aim(camera, view="front3q", objects=...)   自动取景：front3q / front / side / back3q / top

截图和检查用命令行更省事：`oasis-3d snapshot 模型.glb --out 目录`、`oasis-3d check 模型.glb`。
"""
import math
import sys
from pathlib import Path

import bpy
from mathutils import Vector

sys.path.insert(0, str(Path(__file__).resolve().parent))
# 与 oasis-3d 同目录：画布预览的限制和判定只有一份
import geometry  # noqa: E402

# 视角：方位角（0 = 正前方，即从 -Y 看向 +Y）、仰角，单位度
VIEWS = {
    "front3q": (-35, 18),
    "front": (0, 8),
    "side": (90, 8),
    "back3q": (145, 22),
    "top": (0, 88),
}


def reset():
    """清空场景（不加载用户设置），单位米。"""
    bpy.ops.wm.read_factory_settings(use_empty=True)
    units = bpy.context.scene.unit_settings
    units.system = "METRIC"
    units.scale_length = 1.0


def _linear(channel):
    return channel / 12.92 if channel <= 0.04045 else ((channel + 0.055) / 1.055) ** 2.4


def color(value):
    """'#RRGGBB' 或 (r, g, b)（0–1，sRGB）→ Blender 用的线性 RGBA。"""
    if isinstance(value, str):
        value = value.lstrip("#")
        value = tuple(int(value[i:i + 2], 16) / 255 for i in (0, 2, 4))
    return (*(_linear(c) for c in value[:3]), 1.0)


def material(name, base="#BBBBBB", roughness=0.6, metallic=0.0):
    """只设基础色、粗糙度、金属度的材质；其余保持默认，导出 glTF 时不会带材质扩展。"""
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = color(base)
    bsdf.inputs["Roughness"].default_value = roughness
    bsdf.inputs["Metallic"].default_value = metallic
    # 这两项偏离默认值时导出器会加 KHR_materials_ior / KHR_materials_specular
    bsdf.inputs["IOR"].default_value = 1.5
    bsdf.inputs["Specular IOR Level"].default_value = 0.5
    return mat


def meshes(objects=None):
    return [o for o in (objects or bpy.context.scene.objects) if o.type == "MESH" and o.visible_get()]


def bounds(objects=None):
    """世界坐标下的包围盒：(最小角, 最大角)。"""
    corners = [o.matrix_world @ Vector(c) for o in meshes(objects) for c in o.bound_box]
    if not corners:
        raise ValueError("场景里没有可见的网格")
    low = Vector((min(c.x for c in corners), min(c.y for c in corners), min(c.z for c in corners)))
    high = Vector((max(c.x for c in corners), max(c.y for c in corners), max(c.z for c in corners)))
    return low, high


def export_glb(path, export_animations=True):
    """导出自包含 GLB（不带相机、灯光、扩展、Draco 压缩），返回画布不能直接预览的原因（空列表 = 能）。"""
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(target),
        export_format="GLB",
        export_yup=True,
        export_apply=True,
        export_cameras=False,
        export_lights=False,
        export_extras=False,
        export_draco_mesh_compression_enable=False,
        export_animations=export_animations,
    )
    return geometry.preview_problems(target)


def stage(objects=None, background="#E6E6EA", ground="#D2D2D8"):
    """按物体大小摆地面、三点光（太阳光，强度和大小无关）和中性背景。"""
    low, high = bounds(objects)
    size = max((high - low).length, 0.01)
    center = (low + high) / 2
    bpy.ops.mesh.primitive_plane_add(size=size * 20, location=(center.x, center.y, low.z))
    floor = bpy.context.object
    floor.name = "oasis_ground"
    floor.data.materials.append(material("oasis_ground", ground, roughness=1.0))
    for name, energy, rotation in (
        ("oasis_key", 3.0, (50, 0, -35)),
        ("oasis_fill", 1.0, (65, 0, 60)),
        ("oasis_rim", 1.6, (35, 0, 160)),
    ):
        light = bpy.data.lights.new(name, "SUN")
        light.energy = energy
        light.angle = math.radians(8)
        obj = bpy.data.objects.new(name, light)
        obj.rotation_euler = [math.radians(a) for a in rotation]
        bpy.context.scene.collection.objects.link(obj)
    world = bpy.context.scene.world or bpy.data.worlds.new("oasis_world")
    bpy.context.scene.world = world
    world.use_nodes = True
    node = world.node_tree.nodes["Background"]
    node.inputs["Color"].default_value = color(background)
    node.inputs["Strength"].default_value = 0.6
    return floor


def aim(camera, view="front3q", objects=None, margin=1.15):
    """把相机摆到某个视角并让物体整个落在画面里。"""
    azimuth, elevation = (math.radians(a) for a in VIEWS[view])
    low, high = bounds(objects)
    center = (low + high) / 2
    radius = max((high - low).length / 2, 0.01)
    fov = min(camera.data.angle_x, camera.data.angle_y)
    distance = radius / math.sin(fov / 2) * margin
    direction = Vector((
        math.sin(azimuth) * math.cos(elevation),
        -math.cos(azimuth) * math.cos(elevation),
        math.sin(elevation),
    ))
    camera.location = center + direction * distance
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.clip_start = distance / 100
    camera.data.clip_end = distance * 10


def render_views(folder, views=("front3q", "side", "front", "back3q"), size=(960, 720), samples=24):
    """在当前场景加地面和灯光，按各视角用 Cycles CPU 渲图，返回写出的文件。"""
    folder = Path(folder)
    folder.mkdir(parents=True, exist_ok=True)
    subjects = meshes()
    stage(subjects)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU"
    scene.cycles.samples = samples
    # 沙箱里的 Blender 没有 OpenImageDenoise，开着会直接报错
    scene.cycles.use_denoising = False
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x, scene.render.resolution_y = size
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    data = bpy.data.cameras.new("oasis_camera")
    data.lens = 50
    data.sensor_fit = "AUTO"
    camera = bpy.data.objects.new("oasis_camera", data)
    scene.collection.objects.link(camera)
    scene.camera = camera
    written = []
    for view in views:
        aim(camera, view, subjects)
        scene.render.filepath = str(folder / f"{view}.png")
        bpy.ops.render.render(write_still=True)
        written.append(scene.render.filepath)
    return written


def load(path):
    """把模型文件读进当前场景（glb/gltf/fbx/obj/stl/ply/blend）。"""
    path = Path(path)
    suffix = path.suffix.lower()
    if suffix == ".blend":
        bpy.ops.wm.open_mainfile(filepath=str(path))
        return
    reset()
    if suffix in (".glb", ".gltf"):
        # 按位置焊点导入：glTF 按法线拆开的顶点合回来，拓扑检查不会误报开口
        bpy.ops.import_scene.gltf(filepath=str(path), merge_vertices=True)
    elif suffix == ".fbx":
        bpy.ops.import_scene.fbx(filepath=str(path))
    elif suffix == ".obj":
        bpy.ops.wm.obj_import(filepath=str(path))
    elif suffix == ".stl":
        bpy.ops.wm.stl_import(filepath=str(path))
    elif suffix == ".ply":
        bpy.ops.wm.ply_import(filepath=str(path))
    else:
        raise ValueError(f"不支持的格式：{suffix}")


def survey(objects=None):
    """几何概况：尺寸、离地、三角面、对象和材质，以及按焊点后的拓扑问题计数。"""
    import bmesh

    found = meshes(objects)
    low, high = bounds(found)
    report = {
        "size_m": [round(v, 4) for v in (high - low)],
        "lowest_z_m": round(low.z, 4),
        "objects": len(found),
        "triangles": 0,
        "materials": sorted({s.material.name for o in found for s in o.material_slots if s.material}),
        "non_manifold_edges": 0,
        "open_edges": 0,
        "loose_vertices": 0,
        "degenerate_faces": 0,
        "armatures": sum(1 for o in bpy.context.scene.objects if o.type == "ARMATURE"),
        "shape_keys": sum(1 for o in found if o.data.shape_keys),
        "animations": len(bpy.data.actions),
    }
    for obj in found:
        mesh = bmesh.new()
        mesh.from_mesh(obj.data)
        bmesh.ops.remove_doubles(mesh, verts=mesh.verts, dist=1e-5)
        report["triangles"] += sum(len(f.verts) - 2 for f in mesh.faces)
        report["open_edges"] += sum(1 for e in mesh.edges if e.is_boundary)
        report["non_manifold_edges"] += sum(1 for e in mesh.edges if not e.is_manifold and not e.is_boundary)
        report["loose_vertices"] += sum(1 for v in mesh.verts if not v.link_edges)
        report["degenerate_faces"] += sum(1 for f in mesh.faces if f.calc_area() < 1e-10)
        mesh.free()
    return report
