"""Oasis sandbox guard: Blender here is CPU-only and for drafts. Loaded as a bundled startup script, so it
also applies with --factory-startup. Any still render is capped at 640x480 pixels and 32 Cycles samples;
the scene's own settings are restored afterwards, so saved .blend files keep what the author chose.
Final images go through `oasis-tool 3d.render` on the cloud GPU. This is a cost/time guard, not a
security boundary."""
import math
import sys

import bpy
from bpy.app.handlers import persistent

MAX_PIXELS = 640 * 480
MAX_SAMPLES = 32
_saved = {}


@persistent
def _cap(scene, *_):
    render = scene.render
    _saved[scene.name] = (render.resolution_percentage, scene.cycles.samples)
    pixels = render.resolution_x * render.resolution_y * (render.resolution_percentage / 100) ** 2
    notes = []
    if pixels > MAX_PIXELS:
        render.resolution_percentage = max(1, int(100 * math.sqrt(MAX_PIXELS / (render.resolution_x * render.resolution_y))))
        notes.append("resolution %d%%" % render.resolution_percentage)
    if render.engine == "CYCLES" and scene.cycles.samples > MAX_SAMPLES:
        scene.cycles.samples = MAX_SAMPLES
        notes.append("samples %d" % MAX_SAMPLES)
    if notes:
        print("Oasis sandbox: CPU draft render capped (" + ", ".join(notes) + "); final images: "
              "oasis-tool 3d.render --scene <scene.json>", file=sys.stderr, flush=True)


@persistent
def _restore(scene, *_):
    saved = _saved.pop(scene.name, None)
    if saved:
        scene.render.resolution_percentage, scene.cycles.samples = saved


def register():
    bpy.app.handlers.render_init.append(_cap)
    bpy.app.handlers.render_complete.append(_restore)
    bpy.app.handlers.render_cancel.append(_restore)


def unregister():
    for handlers, handler in ((bpy.app.handlers.render_init, _cap), (bpy.app.handlers.render_complete, _restore),
                              (bpy.app.handlers.render_cancel, _restore)):
        if handler in handlers:
            handlers.remove(handler)
