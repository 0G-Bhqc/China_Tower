"""Render auditable named groups from a sanitized FBX in Blender workbench mode."""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 3:
        raise SystemExit("expected: <input-fbx> <group-json> <output-dir>")
    return tuple(os.path.abspath(value) for value in values)


def bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def aim(camera, target, distance, azimuth):
    camera.location = target + Vector((distance * azimuth[0], distance * azimuth[1], distance * 0.34))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main():
    fbx_path, group_path, output_dir = cli_args()
    with open(group_path, encoding="utf-8") as handle:
        contract = json.load(handle)
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 760
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (0.62, 0.72, 0.86)
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.curvature_ridge_factor = 1.6
    scene.display.shading.curvature_valley_factor = 1.2
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.045, 0.055, 0.08)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.lens = 50
    scene.camera = camera
    mesh_by_name = {obj.name: obj for obj in scene.objects if obj.type == "MESH"}
    for obj in mesh_by_name.values():
        obj.hide_render = True
    missing = []
    index = []
    views = (("a", (0.94, -1.06)), ("b", (-0.96, -0.72)))
    for ordinal, group in enumerate(contract["groups"], start=1):
        objects = [mesh_by_name[name] for name in group["members"] if name in mesh_by_name]
        missing.extend(name for name in group["members"] if name not in mesh_by_name)
        if not objects:
            continue
        for obj in objects:
            obj.hide_render = False
        minimum, maximum = bounds(objects)
        target = (minimum + maximum) * 0.5
        dimensions = maximum - minimum
        span = max(dimensions.x, dimensions.y, dimensions.z, 1.0)
        distance = span * 1.55 + 8.0
        files = []
        for suffix, azimuth in views:
            aim(camera, target, distance, azimuth)
            filename = f"{ordinal:02d}-{group['id']}-{suffix}.png"
            scene.render.filepath = os.path.join(output_dir, filename)
            bpy.ops.render.render(write_still=True)
            files.append(filename)
        for obj in objects:
            obj.hide_render = True
        index.append({
            "id": group["id"],
            "label": group["label"],
            "files": files,
            "resolvedMembers": [obj.name for obj in objects],
            "missingMembers": [name for name in group["members"] if name not in mesh_by_name],
            "triangles": sum(len(obj.data.polygons) for obj in objects),
            "boundsMeters": {
                "minimum": [round(value, 3) for value in minimum],
                "maximum": [round(value, 3) for value in maximum],
                "dimensions": [round(value, 3) for value in dimensions],
            },
        })
    with open(os.path.join(output_dir, "index.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "schemaVersion": 1,
            "source": os.path.basename(fbx_path),
            "groupContract": os.path.basename(group_path),
            "groups": index,
            "unresolvedObjectNames": sorted(set(missing)),
        }, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"groups": len(index), "missing": len(set(missing))}, ensure_ascii=False))


if __name__ == "__main__":
    main()
