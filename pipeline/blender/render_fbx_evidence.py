#!/usr/bin/env python3
"""Render six non-runtime inspection views from an approved sanitized FBX."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import bpy
from mathutils import Vector

VIEWS = [
    ("front", (0, -1, 0), "ORTHO"), ("right", (1, 0, 0), "ORTHO"),
    ("rear", (0, 1, 0), "ORTHO"), ("left", (-1, 0, 0), "ORTHO"),
    ("top", (0, 0, 1), "ORTHO"), ("three-quarter", (1, -1, 0.55), "PERSP"),
]


def arguments():
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--max-horizontal-span", type=float, default=None,
                        help="Hide scene/background meshes whose world X or Y span exceeds this value before framing.")
    parser.add_argument("--diagnostic-override", action="store_true",
                        help="Render neutral clay material evidence when legacy source materials are unavailable.")
    return parser.parse_args(values)


def object_bounds(obj):
    return [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]


def bounds(max_horizontal_span=None):
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.data.vertices:
            corners = object_bounds(obj)
            dimensions = [max(point[index] for point in corners) - min(point[index] for point in corners) for index in range(3)]
            if max_horizontal_span is not None and max(dimensions[0], dimensions[1]) > max_horizontal_span:
                obj.hide_render = True
                continue
            points.extend(corners)
    if not points:
        raise RuntimeError("FBX does not contain renderable mesh bounds")
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def add_area(name, position, target, energy, size):
    data = bpy.data.lights.new(name, "AREA")
    data.energy, data.shape, data.size = energy, "DISK", size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = position
    light.rotation_euler = (target - light.location).to_track_quat("-Z", "Y").to_euler()


def main():
    args = arguments()
    bpy.ops.import_scene.fbx(filepath=str(args.input.resolve()), use_custom_normals=True)
    low, high = bounds(args.max_horizontal_span)
    centre, dimensions = (low + high) / 2, high - low
    span = max(dimensions) * 1.16
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.world.color = (0.055, 0.065, 0.08)
    scene.view_settings.look = "AgX - Medium High Contrast"
    # Blender area light watts need to scale with architectural scene size; a
    # fixed 2,400 W key that works for a 20 m prop leaves a 200 m pavilion black.
    energy_scale = max(1.0, (span / 20.0) ** 2)
    add_area("Evidence_Key", centre + Vector((span, -span, span * 1.25)), centre, 2400 * energy_scale, span * 0.8)
    add_area("Evidence_Fill", centre + Vector((-span, -span * 0.25, span * 0.65)), centre, 1200 * energy_scale, span * 0.65)
    add_area("Evidence_Rim", centre + Vector((span * 0.1, span, span)), centre, 1800 * energy_scale, span * 0.7)
    if args.diagnostic_override:
        clay = bpy.data.materials.new("evidence-clay-override")
        clay.diffuse_color = (0.62, 0.66, 0.72, 1)
        clay.roughness = 0.72
        scene.view_layers[0].material_override = clay
    camera_data = bpy.data.cameras.new("EvidenceCamera")
    camera = bpy.data.objects.new("EvidenceCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    output = args.output.resolve()
    result = []
    for name, vector, projection in VIEWS:
        direction = Vector(vector).normalized()
        camera.data.type = projection
        camera.location = centre + direction * span * (2.1 if projection == "PERSP" else 2.0)
        camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
        if projection == "ORTHO":
            camera.data.ortho_scale = span
        else:
            camera.data.lens = 54
        path = output / "views" / name / "beauty.png"
        path.parent.mkdir(parents=True, exist_ok=True)
        scene.render.filepath = str(path)
        bpy.ops.render.render(write_still=True)
        result.append({"view": name, "path": str(path.relative_to(output)), "status": "rendered"})
    (output / "render-evidence.json").write_text(json.dumps({"schemaVersion": 1, "status": "six-view-beauty-complete", "views": result}, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
