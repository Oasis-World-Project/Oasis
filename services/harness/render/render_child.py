"""Fixed renderer entrypoint. Called only after kernel restrictions are active."""
import json
import os
from pathlib import Path
import socket
import sys
import time


def boundary(root):
    forbidden = ["/proc/self/environ", "/proc/1/environ", "/jobs/other/private", "/etc/passwd"]
    for name in forbidden:
        try:
            Path(name).read_bytes()
        except PermissionError:
            continue
        except FileNotFoundError:
            # An absent canary does not prove isolation; the worker creates a real one.
            if name == "/jobs/other/private":
                raise RuntimeError("Missing isolation canary")
            continue
        raise RuntimeError("Filesystem boundary failed")
    for family in (socket.AF_INET, socket.AF_INET6, socket.AF_UNIX):
        try:
            sock = socket.socket(family)
        except PermissionError:
            continue
        sock.close()
        raise RuntimeError("Network boundary failed")
    try:
        os.kill(os.getppid(), 0)
    except PermissionError:
        pass
    else:
        raise RuntimeError("Process boundary failed")
    if any(k.endswith(("KEY", "TOKEN", "SECRET")) for k in os.environ):
        raise RuntimeError("Secret environment inherited")
    (root / "boundary.json").write_text(json.dumps({"filesystem": True, "socketsDenied": True, "parentSignalDenied": True, "secretEnvironmentEmpty": True}))


def main(root, mode):
    boundary(root)
    if mode != "cpu-test":
        from worker import cuda_status
        (root / "cuda.txt").write_text(cuda_status())
    import bpy
    from geometry import blender_build
    bpy.context.preferences.filepaths.use_scripts_auto_execute = False
    bpy.ops.wm.read_factory_settings(use_empty=True)
    # Factory empty scenes do not carry a World; geometry builder expects one.
    bpy.context.scene.world = bpy.data.worlds.new("World")
    settings = json.loads((root / "render.json").read_text())
    backend = settings["backend"]
    devices = []
    if mode != "cpu-test":
        preferences = bpy.context.preferences.addons["cycles"].preferences
        preferences.compute_device_type = backend
        preferences.get_devices()
        for device in preferences.devices:
            device.use = device.type == backend
            if device.use:
                devices.append({"name": device.name, "type": device.type, "id": device.id})
        if not devices:
            raise RuntimeError("Required GPU unavailable; CPU fallback forbidden")
    start = time.monotonic()
    blender_build(root)
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    scene.cycles.device = "CPU" if mode == "cpu-test" else "GPU"
    scene.cycles.samples = settings["samples"]
    scene.cycles.use_denoising = False
    scene.render.threads_mode, scene.render.threads = "FIXED", 2
    scene.render.resolution_x, scene.render.resolution_y = settings["width"], settings["height"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(root / "image.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(root / "scene.blend"))
    bpy.ops.render.render(write_still=True)
    (root / "device.json").write_text(json.dumps({"blender": bpy.app.version_string, "backend": backend,
        "gpuUsed": mode != "cpu-test", "devices": devices, "renderSeconds": time.monotonic() - start,
        "width": settings["width"], "height": settings["height"], "samples": settings["samples"]}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2])
