"""Render dense local regions of the sanitized Tengwang Pavilion FBX.

The delivered Max scene contains a very large presentation environment.  This
diagnostic deliberately ignores its landscape-sized meshes and renders only
compact groups of architectural meshes.  It does not alter, reopen, or execute
anything in the original Max file.
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Vector


MAX_ENVIRONMENT_SPAN = 500.0
LOCAL_RADIUS = 128.0
SEED_SEPARATION = 112.0
MAX_REGIONS = 8


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 2:
        raise SystemExit("expected: <input-fbx> <output-dir>")
    return tuple(os.path.abspath(value) for value in values)


def object_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def combined_bounds(records):
    minimum = Vector((
        min(record["minimum"].x for record in records),
        min(record["minimum"].y for record in records),
        min(record["minimum"].z for record in records),
    ))
    maximum = Vector((
        max(record["maximum"].x for record in records),
        max(record["maximum"].y for record in records),
        max(record["maximum"].z for record in records),
    ))
    return minimum, maximum


def point_camera(camera, target, distance):
    # A shallow inspection angle exposes elevations, bracket sets and eaves.
    # The earlier birds-eye angle made an already broad site model unreadable.
    camera.location = target + Vector((distance * 0.94, -distance * 1.06, distance * 0.34))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_record(record):
    return {
        "name": record["obj"].name,
        "triangles": record["triangles"],
        "centerMeters": [round(value, 3) for value in record["center"]],
        "dimensionsMeters": [round(value, 3) for value in record["dimensions"]],
    }


def main():
    fbx_path, output_dir = cli_args()
    os.makedirs(output_dir, exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    scene = bpy.context.scene
    # Workbench studio lighting is intentionally used for the inspection pass:
    # it is immune to missing legacy renderer lights/materials in an imported
    # Max scene and gives the analyser a reliable clay-model read.
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
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

    clay = bpy.data.materials.new("tengwang-spatial-cluster-clay")
    clay.diffuse_color = (0.64, 0.70, 0.78, 1.0)
    scene.view_layers[0].material_override = clay

    records = []
    for obj in scene.objects:
        if obj.type != "MESH" or not obj.data.vertices:
            continue
        minimum, maximum = object_bounds(obj)
        dimensions = maximum - minimum
        if max(dimensions.x, dimensions.y) > MAX_ENVIRONMENT_SPAN:
            continue
        records.append({
            "obj": obj,
            "minimum": minimum,
            "maximum": maximum,
            "dimensions": dimensions,
            "center": (minimum + maximum) * 0.5,
            "triangles": len(obj.data.polygons),
        })
    if not records:
        raise RuntimeError("No compact mesh objects found after environment filtering")

    # Discover high-density local groupings.  Triangle-weighting stops dozens of
    # tiny loose props from outvoting a roof, balcony, or bracket assembly.
    ranked_candidates = []
    for seed in records:
        nearby = [
            record for record in records
            if math.hypot(record["center"].x - seed["center"].x, record["center"].y - seed["center"].y) <= LOCAL_RADIUS
        ]
        score = sum(min(record["triangles"], 250000) for record in nearby)
        ranked_candidates.append((score, seed["center"], nearby))
    ranked_candidates.sort(key=lambda item: item[0], reverse=True)

    selected_regions = []
    for score, center, nearby in ranked_candidates:
        if any(math.hypot(center.x - region["seed"].x, center.y - region["seed"].y) < SEED_SEPARATION for region in selected_regions):
            continue
        selected_regions.append({"score": score, "seed": center.copy(), "records": nearby})
        if len(selected_regions) == MAX_REGIONS:
            break

    for obj in scene.objects:
        if obj.type == "MESH":
            obj.hide_render = True

    bpy.ops.object.light_add(type="AREA")
    key = bpy.context.object
    key.data.shape = "DISK"
    bpy.ops.object.light_add(type="AREA")
    fill = bpy.context.object
    bpy.ops.object.light_add(type="AREA")
    rim = bpy.context.object
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.lens = 48
    scene.camera = camera

    index = []
    for ordinal, region in enumerate(selected_regions, start=1):
        members = region["records"]
        for record in members:
            record["obj"].hide_render = False
        minimum, maximum = combined_bounds(members)
        target = (minimum + maximum) * 0.5
        dimensions = maximum - minimum
        span = max(dimensions.x, dimensions.y, dimensions.z, 1.0)
        distance = span * 1.68 + 12.0
        point_camera(camera, target, distance)
        # Use local, scale-aware lighting.  This avoids the old global-scene
        # lights becoming ineffective when the FBX includes kilometre-scale props.
        light_energy = 680.0 * (max(span, 20.0) / 20.0) ** 2
        key.location = target + Vector((span * 0.75, -span * 0.6, span * 1.25))
        key.data.energy = light_energy
        key.data.size = span * 0.8
        key.rotation_euler = (target - key.location).to_track_quat("-Z", "Y").to_euler()
        fill.location = target + Vector((-span * 0.95, -span * 0.35, span * 0.5))
        fill.data.energy = light_energy * 0.44
        fill.data.size = span * 0.7
        fill.rotation_euler = (target - fill.location).to_track_quat("-Z", "Y").to_euler()
        rim.location = target + Vector((span * 0.1, span * 1.0, span * 1.25))
        rim.data.energy = light_energy * 0.72
        rim.data.size = span * 0.5
        rim.rotation_euler = (target - rim.location).to_track_quat("-Z", "Y").to_euler()
        filename = f"{ordinal:02d}-spatial-cluster.png"
        scene.render.filepath = os.path.join(output_dir, filename)
        bpy.ops.render.render(write_still=True)
        index.append({
            "id": f"spatial-{ordinal:02d}",
            "file": filename,
            "selectionMethod": "compact-mesh spatial density; landscape meshes excluded",
            "seedMeters": [round(region["seed"].x, 3), round(region["seed"].y, 3), round(region["seed"].z, 3)],
            "triangleScore": region["score"],
            "memberCount": len(members),
            "boundsMeters": {
                "minimum": [round(value, 3) for value in minimum],
                "maximum": [round(value, 3) for value in maximum],
                "dimensions": [round(value, 3) for value in dimensions],
            },
            "members": [render_record(record) for record in sorted(members, key=lambda item: item["triangles"], reverse=True)],
        })
        for record in members:
            record["obj"].hide_render = True

    with open(os.path.join(output_dir, "spatial-clusters.json"), "w", encoding="utf-8") as handle:
        json.dump({
            "schemaVersion": 1,
            "source": os.path.basename(fbx_path),
            "compactObjectCount": len(records),
            "environmentFilter": {"maxHorizontalSpanMeters": MAX_ENVIRONMENT_SPAN},
            "regions": index,
        }, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"compactObjects": len(records), "regions": len(index)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
