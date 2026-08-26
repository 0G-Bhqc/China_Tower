"""Extract reusable architectural component families from a sanitized FBX in Blender.

Usage from Blender: --background --python extract_architecture_components.py -- <fbx> <out.json>
The source .max is never opened here; this only consumes the verified FBX conversion.
"""

from __future__ import annotations

import json
import math
import os
import statistics
import sys

import bpy
from mathutils import Vector


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    args = sys.argv[marker + 1 :]
    if len(args) != 2:
        raise SystemExit("expected: <input-fbx> <output-json>")
    return args[0], args[1]


def rounded(values):
    return [round(float(value), 6) for value in values]


def bounds_for(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    mins = [min(point[index] for point in points) for index in range(3)]
    maxs = [max(point[index] for point in points) for index in range(3)]
    return mins, maxs


def band_for(z, height):
    # The Max-to-FBX import is Z-up in Blender.  All architectural storey bands
    # must be calculated from world Z rather than horizontal world Y.
    ratio = 0 if height <= 0 else z / height
    if ratio < 0.11:
        return "stone-base"
    if ratio < 0.31:
        return "lower-storey"
    if ratio < 0.42:
        return "lower-eave-and-brackets"
    if ratio < 0.58:
        return "middle-storey-and-gallery"
    if ratio < 0.69:
        return "middle-eave-and-brackets"
    if ratio < 0.82:
        return "upper-storey"
    if ratio < 0.93:
        return "top-roof-and-brackets"
    return "finial-and-ridge"


def classify_family(instances, dimensions, scene_height):
    dx, dy, dz = dimensions
    count = len(instances)
    z = statistics.median(item["center"][2] for item in instances)
    horizontal = max(dx, dy)
    thin = min(dx, dy)
    if dz > max(horizontal, 0.001) * 1.75 and thin < 1.2:
        return "column-or-post"
    if dz < max(horizontal, 0.001) * 0.24 and horizontal > 0.7:
        return "plate-tile-or-eave-course"
    if count >= 12 and horizontal < 1.0 and dz < 1.0:
        return "repeated-bracket-or-lattice-member"
    if z / max(scene_height, 0.001) > 0.78 and horizontal > 1.0:
        return "roof-or-ridge-shell"
    if count >= 4:
        return "repeated-timber-detail"
    return "unique-architectural-shell"


def main():
    input_path, output_path = cli_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=os.path.abspath(input_path))
    bpy.context.view_layer.update()

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    all_bounds = [bounds_for(obj) for obj in meshes]
    world_min = [min(item[0][index] for item in all_bounds) for index in range(3)]
    world_max = [max(item[1][index] for item in all_bounds) for index in range(3)]
    world_size = [world_max[index] - world_min[index] for index in range(3)]
    scene_height = world_size[2]

    families = {}
    for obj in meshes:
        mins, maxs = bounds_for(obj)
        center = [(mins[index] + maxs[index]) * 0.5 for index in range(3)]
        dimensions = [maxs[index] - mins[index] for index in range(3)]
        mesh = obj.data
        key = mesh.name
        materials = [slot.material.name if slot.material else None for slot in obj.material_slots]
        family = families.setdefault(key, {"mesh": mesh, "instances": [], "materials": set()})
        family["instances"].append({
            "sourceObject": obj.name,
            "center": rounded(center),
            "dimensions": rounded(dimensions),
            "location": rounded(obj.location),
            "rotationEuler": rounded(obj.rotation_euler),
            "scale": rounded(obj.scale),
            "verticalBand": band_for(center[2] - world_min[2], scene_height),
        })
        family["materials"].update(material for material in materials if material)

    results = []
    for key, family in families.items():
        instances = family["instances"]
        medians = [statistics.median(item["dimensions"][index] for item in instances) for index in range(3)]
        vertical_bands = {}
        for item in instances:
            vertical_bands[item["verticalBand"]] = vertical_bands.get(item["verticalBand"], 0) + 1
        polygon_count = len(family["mesh"].polygons)
        results.append({
            "familyId": key,
            "inferredRole": classify_family(instances, medians, scene_height),
            "instanceCount": len(instances),
            "trianglesPerInstance": polygon_count,
            "triangleBudget": polygon_count * len(instances),
            "medianDimensionsMeters": rounded(medians),
            "materials": sorted(family["materials"]),
            "verticalBands": vertical_bands,
            "instances": instances,
        })
    results.sort(key=lambda item: (item["instanceCount"], item["triangleBudget"]), reverse=True)
    output = {
        "schemaVersion": 1,
        "assetId": "yueyang",
        "source": {"fbx": os.path.abspath(input_path), "blenderVersion": bpy.app.version_string},
        "worldBoundsMeters": {"min": rounded(world_min), "max": rounded(world_max), "size": rounded(world_size)},
        "summary": {
            "meshObjects": len(meshes),
            "uniqueMeshFamilies": len(results),
            "repeatedFamilies": sum(1 for item in results if item["instanceCount"] > 1),
            "instanceCount": sum(item["instanceCount"] for item in results),
        },
        "families": results,
        "translationContract": {
            "use": "Map each repeated family to a Three.js InstancedMesh; use median dimensions and recorded transforms as geometry constraints.",
            "doNotUse": "Do not load this high-poly FBX into the browser runtime or claim mesh extraction equals procedural reconstruction.",
        },
    }
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as handle:
        json.dump(output, handle, ensure_ascii=False, indent=2)
    print(json.dumps(output["summary"], ensure_ascii=False))


if __name__ == "__main__":
    main()
