"""Render the most repeated sanitized-FBX mesh families in isolation for labelling."""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Vector


def args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 3:
        raise SystemExit("expected: <input-fbx> <catalog-json> <output-dir>")
    return values


def bounds(objects):
    points = []
    for obj in objects:
        points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def point_camera(camera, target, distance):
    camera.location = target + Vector((distance * 0.82, distance * 0.58, distance * 0.82))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def main():
    fbx_path, catalog_path, output_dir = args()
    # Blender starts from its own install directory in background mode.  Resolve
    # paths now so generated evidence remains inside the workspace.
    fbx_path = os.path.abspath(fbx_path)
    catalog_path = os.path.abspath(catalog_path)
    output_dir = os.path.abspath(output_dir)
    with open(catalog_path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.world.color = (0.045, 0.045, 0.045)
    override = bpy.data.materials.new("component-isolation-override")
    override.diffuse_color = (0.72, 0.76, 0.82, 1)
    scene.view_layers[0].material_override = override

    bpy.ops.object.light_add(type="AREA", location=(12, 16, 10))
    bpy.context.object.data.energy = 1800
    bpy.context.object.data.shape = "DISK"
    bpy.context.object.data.size = 8
    bpy.ops.object.light_add(type="AREA", location=(-10, 8, -8))
    bpy.context.object.data.energy = 900
    bpy.context.object.data.size = 6
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    scene.camera = camera

    mesh_objects = [obj for obj in scene.objects if obj.type == "MESH"]
    for obj in mesh_objects:
        obj.hide_render = True
    os.makedirs(output_dir, exist_ok=True)
    selected = [family for family in catalog["families"] if family["instanceCount"] > 1][:12]
    index = []
    for position, family in enumerate(selected, start=1):
        members = [obj for obj in mesh_objects if obj.data.name == family["familyId"]]
        if not members:
            continue
        for obj in members:
            obj.hide_render = False
        minimum, maximum = bounds(members)
        target = (minimum + maximum) * 0.5
        size = maximum - minimum
        distance = max(size.x, size.y, size.z) * 2.6 + 1.5
        point_camera(camera, target, distance)
        filename = f"{position:02d}-family.png"
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
        index.append({
            "file": filename,
            "familyId": family["familyId"],
            "inferredRole": family["inferredRole"],
            "instanceCount": family["instanceCount"],
            "medianDimensionsMeters": family["medianDimensionsMeters"],
            "verticalBands": family["verticalBands"],
        })
        for obj in members:
            obj.hide_render = True
    with open(os.path.join(output_dir, "index.json"), "w", encoding="utf-8") as handle:
        json.dump(index, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"isolations": len(index)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
