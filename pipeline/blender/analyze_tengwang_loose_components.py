"""Dissect the Tengwang Pavilion main-tower candidate into loose mesh parts.

This operates solely on the independently verified FBX conversion.  The source
Max file is never opened.  Loose-part separation is diagnostic: the source
meshes may pack the landmark, its neighbouring pavilions, roads, and unrelated
modern massing into a single object.  The emitted catalog retains provenance so
the later Three.js asset can admit only architectural evidence.
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Vector


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 4:
        raise SystemExit("expected: <input-fbx> <group-json> <group-id> <output-dir>")
    return values[0], values[1], values[2], values[3]


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def combined_bounds(objects):
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def point_camera(camera, target, distance, azimuth=(0.94, -1.06)):
    camera.location = target + Vector((distance * azimuth[0], distance * azimuth[1], distance * 0.34))
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def component_record(obj):
    minimum, maximum = world_bounds(obj)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    horizontal = max(dimensions.x, dimensions.y)
    vertical = dimensions.z
    triangles = len(obj.data.polygons)
    # Ranking only informs which dissection views to inspect; it makes no
    # architectural claim.  It prefers meaningful, vertically articulated mesh
    # parts while retaining the dense surfaces where roof/detail evidence lives.
    score = math.log10(triangles + 10) * 2.0 + min(vertical / max(horizontal, 0.5), 1.4) * 4.0 + min(vertical / 12.0, 2.0)
    return {
        "object": obj,
        "sourceObject": obj.get("sourceObject", obj.name),
        "triangles": triangles,
        "minimum": minimum,
        "maximum": maximum,
        "dimensions": dimensions,
        "center": center,
        "verticality": vertical / max(horizontal, 0.001),
        "inspectionScore": score,
    }


def serialise(record, component_id):
    return {
        "id": component_id,
        "objectName": record["object"].name,
        "sourceObject": record["sourceObject"],
        "triangles": record["triangles"],
        "centerMeters": [round(value, 4) for value in record["center"]],
        "dimensionsMeters": [round(value, 4) for value in record["dimensions"]],
        "boundsMeters": {
            "minimum": [round(value, 4) for value in record["minimum"]],
            "maximum": [round(value, 4) for value in record["maximum"]],
        },
        "verticality": round(record["verticality"], 4),
        "inspectionScore": round(record["inspectionScore"], 4),
    }


def main():
    fbx_path, group_path, group_id, output_dir = cli_args()
    fbx_path = os.path.abspath(fbx_path)
    group_path = os.path.abspath(group_path)
    output_dir = os.path.abspath(output_dir)
    with open(group_path, encoding="utf-8") as handle:
        contract = json.load(handle)
    group = next((item for item in contract["groups"] if item["id"] == group_id), None)
    if not group:
        raise RuntimeError(f"group id not found: {group_id}")
    os.makedirs(output_dir, exist_ok=True)
    isolations_dir = os.path.join(output_dir, "isolations")
    os.makedirs(isolations_dir, exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    mesh_by_name = {obj.name: obj for obj in bpy.context.scene.objects if obj.type == "MESH"}
    source_objects = [mesh_by_name[name] for name in group["members"] if name in mesh_by_name]
    missing = [name for name in group["members"] if name not in mesh_by_name]
    if not source_objects:
        raise RuntimeError("No selected group members found after FBX import")

    # Preserve provenance before Blender creates newly named loose-part objects.
    for obj in source_objects:
        obj["sourceObject"] = obj.name
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="LOOSE")
        bpy.ops.object.mode_set(mode="OBJECT")

    selected_sources = set(group["members"])
    components = [
        component_record(obj)
        for obj in bpy.context.scene.objects
        if obj.type == "MESH" and obj.get("sourceObject") in selected_sources and len(obj.data.polygons) > 0
    ]
    components.sort(key=lambda item: item["inspectionScore"], reverse=True)
    ids = {record["object"].name: f"tower-part-{index:03d}" for index, record in enumerate(components, start=1)}
    # The FBX contains an entire city district.  Rendering only the dissected
    # source objects is essential: otherwise unrelated buildings and modern
    # placeholder volumes appear to be part of the tower candidate.
    component_objects = {record["object"] for record in components}
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj not in component_objects:
            obj.hide_render = True

    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "SINGLE"
    scene.display.shading.single_color = (0.68, 0.77, 0.90)
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.curvature_ridge_factor = 1.8
    scene.display.shading.curvature_valley_factor = 1.35
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.04, 0.05, 0.075)
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.data.lens = 50
    scene.camera = camera

    # Context is useful for verifying that selected pieces still form a tower.
    minimum, maximum = combined_bounds([record["object"] for record in components])
    target = (minimum + maximum) * 0.5
    span = max(*(maximum - minimum), 1.0)
    point_camera(camera, target, span * 1.55 + 8.0)
    scene.render.filepath = os.path.join(output_dir, "tower-dissection-context.png")
    bpy.ops.render.render(write_still=True)

    # Render a bounded, auditable inspection set: the top score items plus the
    # densest pieces, deduplicated.  The later admission contract is based on
    # these visual records, never on names alone.
    dense = sorted(components, key=lambda item: item["triangles"], reverse=True)[:18]
    visual_candidates = []
    seen = set()
    for record in components[:24] + dense:
        key = record["object"].name
        if key in seen:
            continue
        seen.add(key)
        visual_candidates.append(record)
        if len(visual_candidates) == 28:
            break
    for obj in component_objects:
        obj.hide_render = True
    visual_index = []
    for ordinal, record in enumerate(visual_candidates, start=1):
        obj = record["object"]
        obj.hide_render = False
        minimum, maximum = record["minimum"], record["maximum"]
        target = (minimum + maximum) * 0.5
        dimensions = maximum - minimum
        span = max(dimensions.x, dimensions.y, dimensions.z, 0.4)
        point_camera(camera, target, span * 1.72 + 1.0)
        filename = f"{ordinal:02d}-{ids[obj.name]}.png"
        scene.render.filepath = os.path.join(isolations_dir, filename)
        bpy.ops.render.render(write_still=True)
        visual_index.append({"id": ids[obj.name], "file": os.path.join("isolations", filename)})
        obj.hide_render = True

    catalog = {
        "schemaVersion": 1,
        "assetId": "tengwang",
        "source": os.path.basename(fbx_path),
        "groupId": group_id,
        "groupLabel": group.get("label"),
        "selectionMethod": "loose-part dissection of an audited main-tower candidate",
        "sourceMemberCount": len(source_objects),
        "missingSourceMembers": missing,
        "componentCount": len(components),
        "contextRender": "tower-dissection-context.png",
        "visualInspectionSet": visual_index,
        "components": [serialise(record, ids[record["object"].name]) for record in components],
    }
    with open(os.path.join(output_dir, "component-catalog.json"), "w", encoding="utf-8") as handle:
        json.dump(catalog, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"components": len(components), "inspectionRenders": len(visual_index)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
