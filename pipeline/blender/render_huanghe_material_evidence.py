"""Render a source-material diagnostic for the isolated Huanghe Tower FBX."""

from __future__ import annotations

import os
import sys

import bpy
from mathutils import Vector


def args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 2:
        raise SystemExit("expected: <input-fbx> <output-png>")
    return tuple(os.path.abspath(value) for value in values)


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def main():
    fbx_path, output_path = args()
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    selected = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.data.vertices:
            continue
        center = obj.matrix_world.translation
        visible = 115.0 < center.x < 210.0 and -530.0 < center.y < -435.0
        obj.hide_render = not visible
        if visible:
            selected.append(obj)
    low, high = bounds(selected)
    center, size = (low + high) * 0.5, high - low
    span = max(size) * 1.42
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 900
    scene.render.resolution_y = 900
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.045, 0.055, 0.08)
    camera_data = bpy.data.cameras.new("HuangheMaterialEvidenceCamera")
    camera = bpy.data.objects.new("HuangheMaterialEvidenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    camera.location = center + Vector((span * 0.92, -span * 1.05, span * 0.56))
    camera.rotation_euler = (center - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 52
    scene.render.filepath = output_path
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.render.render(write_still=True)


if __name__ == "__main__":
    main()
