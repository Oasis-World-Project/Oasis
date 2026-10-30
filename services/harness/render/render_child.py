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
    # AF_UNIX stays available because cuInit needs it; Landlock blocks creating socket files.
    for family in (socket.AF_INET, socket.AF_INET6, socket.AF_NETLINK, socket.AF_PACKET):
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
    (root / "boundary.json").write_text(json.dumps({"filesystem": True, "networkSocketsDenied": True, "parentSignalDenied": True, "secretEnvironmentEmpty": True}))


def guard_exposure(scene, root, settings):
    """Lower exposure while a small probe render shows blown highlights. Never brightens, so dim/night
    scenes keep their mood. Returns the EV change, which is saved in scene.blend and device.json."""
    import bpy
    import numpy
    render = scene.render
    render.resolution_x = 96
    render.resolution_y = max(16, round(96 * settings["height"] / settings["width"]))
    scene.cycles.samples = 16
    scene.cycles.use_denoising = False
    render.filepath = str(root / "probe.png")
    change = 0
    for _ in range(3):
        bpy.ops.render.render(write_still=True)
        image = bpy.data.images.load(str(root / "probe.png"))
        pixels = numpy.array(image.pixels[:], dtype=numpy.float32).reshape(-1, 4)
        bpy.data.images.remove(image)
        luma = pixels[:, :3] @ numpy.array([0.2126, 0.7152, 0.0722], dtype=numpy.float32)
        if (luma >= 0.98).mean() <= 0.03 and luma.mean() <= 0.72:
            break
        scene.view_settings.exposure -= 1
        change -= 1
    return change


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
    scene.render.threads_mode, scene.render.threads = "FIXED", 2
    exposure = guard_exposure(scene, root, settings)
    scene.cycles.samples = settings["samples"]
    # OIDN on the worker CPU threads: deterministic under isolation and removes low-sample grain.
    scene.cycles.use_denoising = True
    scene.cycles.denoiser = "OPENIMAGEDENOISE"
    scene.cycles.denoising_input_passes = "RGB_ALBEDO_NORMAL"
    scene.cycles.denoising_prefilter = "ACCURATE"
    scene.cycles.denoising_use_gpu = False
    scene.render.resolution_x, scene.render.resolution_y = settings["width"], settings["height"]
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.filepath = str(root / "image.png")
    bpy.ops.wm.save_as_mainfile(filepath=str(root / "scene.blend"))
    bpy.ops.render.render(write_still=True)
    (root / "device.json").write_text(json.dumps({"blender": bpy.app.version_string, "backend": backend,
        "gpuUsed": mode != "cpu-test", "devices": devices, "renderSeconds": time.monotonic() - start,
        "width": settings["width"], "height": settings["height"], "samples": settings["samples"],
        "denoiser": "OPENIMAGEDENOISE", "exposureAdjustEv": exposure}))


if __name__ == "__main__":
    main(Path(sys.argv[1]), sys.argv[2])
