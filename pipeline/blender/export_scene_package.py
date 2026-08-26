"""Export a source-backed environment package for the poetic pavilion viewer.

The exporter deliberately does not infer historical meaning from imported names.
It uses a reviewed spatial envelope and an explicit exclusion list supplied by the
job configuration. Every admitted mesh is kept as a separate scene node and is
annotated with its source object, source material, spatial layer and source bounds.
The resulting GLB is an environment companion to the audited tower GLB; the tower
objects are excluded to prevent coplanar duplicate geometry.

Usage (from the project root):
  blender --background --factory-startup --python pipeline/blender/export_scene_package.py -- \
    <input-fbx> <output-glb> <report-json> <config-json>

Config shape:
  {
    "assetId": "yueyang",
    "sourceScale": 0.9925,
    "sourceCenter": [13.196891, 9.179454, 0],
    "sourceAxes": {"x": 0.9925, "y": 1, "z": 0.79},
    "envelope": {"x": [-20, 45], "y": [-20, 45], "z": [-5, 6]},
    "excludeNames": ["..."],
    "excludeNamePrefixes": ["..."],
    "layerRules": [{"id":"near","maxDistance":18}, ...]
  }

Coordinates in the config are the imported FBX coordinates. The exported GLB is
normalized to the same gallery coordinate system used by the tower runtime.
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import sys
from typing import Any

import bpy
from mathutils import Vector, Matrix


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 5:
        raise SystemExit("expected: <input-fbx> <output-glb> <report-json> <config-json> <package-id>")
    return tuple(os.path.abspath(value) if index != 4 else value
                 for index, value in enumerate(values))


def config_args(path: str, package_id: str) -> dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        config = json.load(handle)
    if "packages" in config:
        if package_id not in config["packages"]:
            raise RuntimeError(f"scene package config has no package {package_id}")
        config = config["packages"][package_id]
    for key in ("assetId", "envelope", "layerRules"):
        if key not in config:
            raise RuntimeError(f"scene package config is missing {key}")

    return config


def world_bounds(obj, vertices=False):
    """Return world-space bounds without relying on a stale bound_box cache.

    The exporter edits source vertices in-place during normalization. Blender's
    Object.bound_box can retain its pre-edit cache until a later dependency-graph
    evaluation, which previously made every runtime bounds record collapse to a
    single point even though the exported GLB still contained geometry.
    """
    if vertices and obj.type == "MESH" and len(obj.data.vertices) > 0:
        points = [obj.matrix_world @ vertex.co for vertex in obj.data.vertices]
    else:
        points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def runtime_bounds_record(minimum, maximum):
    """Map Blender's imported FBX x/y/z contract to glTF Y-up x/y/z."""
    return bounds_record(
        Vector((minimum.x, minimum.z, minimum.y)),
        Vector((maximum.x, maximum.z, maximum.y)),
    )


def material_name(obj):
    if not obj.data.materials:
        return "__unassigned__"
    return obj.data.materials[0].name


def scalar(value, fallback=0.0):
    return value if isinstance(value, (int, float)) and math.isfinite(value) else fallback


def bounds_record(minimum, maximum):
    return {
        "minimum": [round(scalar(value), 5) for value in minimum],
        "maximum": [round(scalar(value), 5) for value in maximum],
        "dimensions": [round(scalar(maximum[index] - minimum[index]), 5) for index in range(3)],
    }


def point_in_envelope(center, envelope):
    return (
        envelope["x"][0] <= center.x <= envelope["x"][1]
        and envelope["y"][0] <= center.y <= envelope["y"][1]
        and envelope["z"][0] <= center.z <= envelope["z"][1]
    )


def layer_for(center, rules, origin):
    distance = math.hypot(center.x - origin.x, center.y - origin.y)
    for rule in sorted(rules, key=lambda item: scalar(item.get("maxDistance"), float("inf"))):
        if distance <= scalar(rule.get("maxDistance"), float("inf")):
            return str(rule["id"])
    return str(rules[-1]["id"])


def ancestor_names(obj):
    names = []
    parent = obj.parent
    while parent is not None:
        names.append(parent.name)
        parent = parent.parent
    return names


def source_transform(config):
    axes = config.get("sourceAxes", {})
    scale = config.get("sourceScale", 1.0)
    center = config.get("sourceCenter", [0.0, 0.0, 0.0])
    return Matrix.Diagonal((scalar(axes.get("x"), scale), scalar(axes.get("y"), 1.0), scalar(axes.get("z"), 1.0), 1.0)), Vector((scalar(center[0]), scalar(center[1]), scalar(center[2])))


def transform_object(obj, axis_matrix, center, offset):
    # Blender's FBX import keeps x/y horizontal and z vertical. Let the glTF
    # exporter perform its normal Y-up conversion (source z -> runtime y and
    # source y -> runtime z); applying the offset before export keeps the
    # package in exactly the same coordinate contract as the tower GLB.
    for vertex in obj.data.vertices:
        source = obj.matrix_world @ vertex.co
        local = source - center
        vertex.co = Vector((
            axis_matrix[0][0] * local.x + offset.x,
            axis_matrix[1][1] * local.y + offset.y,
            axis_matrix[2][2] * local.z + offset.z,
        ))
    obj.matrix_world = Matrix.Identity(4)
    obj.data.update()


def normalization_transform(config):
    axis_matrix, center = source_transform(config)
    normalization = config.get("normalization", {})
    mode = normalization.get("mode", "explicit")
    if mode == "center-ground":
        # Compute this from the reviewed source bounds in the caller; the
        # placeholder is replaced before objects are transformed.
        return axis_matrix, center, Vector((0, 0, 0))
    offset_values = normalization.get("offset", [0.0, 0.0, 0.0])
    return axis_matrix, center, Vector(tuple(scalar(value) for value in offset_values))


def material_record(material):
    return {
        "name": material.name if material else "__unassigned__",
        "diffuseColor": [round(float(value), 5) for value in (material.diffuse_color if material else (0, 0, 0, 1))],
        "usesNodes": bool(material and material.use_nodes),
    }


def main():
    fbx_path, output_path, report_path, config_path, package_id = cli_args()
    config = config_args(config_path, package_id)
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    axis_matrix, source_center, transform_offset = normalization_transform(config)
    envelope = config["envelope"]
    excludes = set(config.get("excludeNames", []))
    prefixes = tuple(config.get("excludeNamePrefixes", []))
    include_parents = set(config.get("includeParentNames", []))
    admission_center_values = config.get("admissionCenter", config.get("sourceCenter", [0.0, 0.0, 0.0]))
    admission_center = Vector((scalar(admission_center_values[0]), scalar(admission_center_values[1]), scalar(admission_center_values[2] if len(admission_center_values) > 2 else 0.0)))
    exclude_radius = config.get("excludeCenterRadius")
    max_object_span = config.get("maxObjectSpan")
    rules = config["layerRules"]

    admitted = []
    rejected = {"nonMesh": 0, "empty": 0, "excludedName": 0, "outsideEnvelope": 0, "outsideParentSelection": 0, "excludedCenterRadius": 0, "oversized": 0}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH":
            rejected["nonMesh"] += 1
            continue
        if not obj.data.vertices or not obj.data.polygons:
            rejected["empty"] += 1
            continue
        if obj.name in excludes or obj.name.startswith(prefixes):
            rejected["excludedName"] += 1
            continue
        if include_parents and not (set(ancestor_names(obj)) & include_parents):
            rejected["outsideParentSelection"] += 1
            continue
        minimum, maximum = world_bounds(obj)
        center = (minimum + maximum) * 0.5
        if exclude_radius is not None and math.hypot(center.x - admission_center.x, center.y - admission_center.y) <= scalar(exclude_radius):
            rejected["excludedCenterRadius"] += 1
            continue
        if max_object_span is not None:
            dimensions = maximum - minimum
            if max(dimensions.x, dimensions.y, dimensions.z) > scalar(max_object_span):
                rejected["oversized"] += 1
                continue
        if not point_in_envelope(center, envelope):
            rejected["outsideEnvelope"] += 1
            continue
        source_bounds = bounds_record(minimum, maximum)
        layer = layer_for(center, rules, admission_center)
        obj["sourceObject"] = obj.name
        obj["sourceMaterial"] = material_name(obj)
        obj["sceneLayer"] = layer
        obj["sourceBounds"] = json.dumps(source_bounds, ensure_ascii=False)
        admitted.append((obj, source_bounds, layer))

    if not admitted:
        report = {
            "schemaVersion": 1,
            "assetId": config["assetId"],
            "source": {"file": os.path.basename(fbx_path), "coordinateNote": "FBX x/y horizontal, z vertical; no independent environment mesh passed the reviewed admission envelope."},
            "admission": {"method": "reviewed source-object spatial envelope", "envelope": envelope, "admissionCenter": list(admission_center), "excludeCenterRadius": exclude_radius, "includeParentNames": sorted(include_parents), "maxObjectSpan": max_object_span, "excludedNames": sorted(excludes), "excludedNamePrefixes": list(prefixes), "admittedObjects": 0, "rejected": rejected, "status": "source-scene-has-no-independent-environment-mesh"},
            "output": {"file": None, "sha256": None, "meshCount": 0, "triangles": 0, "bounds": None, "materials": []},
            "nodes": [],
        }
        with open(report_path, "w", encoding="utf-8") as handle:
            json.dump(report, handle, ensure_ascii=False, indent=2)
        print(json.dumps({"assetId": config["assetId"], "admittedObjects": 0, "triangles": 0, "status": "no-independent-environment-mesh"}, ensure_ascii=False))
        return

    admitted_set = {item[0] for item in admitted}
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj not in admitted_set:
            bpy.data.objects.remove(obj, do_unlink=True)

    if config.get("normalization", {}).get("mode") == "center-ground":
        normalized_min = Vector((float("inf"), float("inf"), float("inf")))
        normalized_max = Vector((float("-inf"), float("-inf"), float("-inf")))
        for obj, _, _ in admitted:
            minimum, maximum = world_bounds(obj, vertices=True)
            for index in range(3):
                normalized_min[index] = min(normalized_min[index], axis_matrix[index][index] * (minimum[index] - source_center[index]))
                normalized_max[index] = max(normalized_max[index], axis_matrix[index][index] * (maximum[index] - source_center[index]))
        transform_offset = Vector((-(normalized_min.x + normalized_max.x) * 0.5, -(normalized_min.y + normalized_max.y) * 0.5, -normalized_min.z + 0.025))
    for obj, _, _ in admitted:
        transform_object(obj, axis_matrix, source_center, transform_offset)
        obj.name = f"scene-{obj.get('sceneLayer', 'near')}-{obj.get('sourceObject', 'mesh')}"
        obj["sourceObject"] = obj.get("sourceObject") or obj.name
        obj["sourceMaterial"] = obj.get("sourceMaterial") or material_name(obj)
        obj["sourceAsset"] = config["assetId"]
        obj["sourceFile"] = os.path.basename(fbx_path)
        obj["provenanceStatus"] = "source-backed-spatial-admission"
        obj.select_set(True)

    # Keep each source object separate for auditability, but normalize transforms
    # and apply them before export so the browser sees a stable gallery-space GLB.
    bpy.ops.object.select_all(action="DESELECT")
    for obj, _, _ in admitted:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = admitted[0][0]
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
        export_normals=True,
        export_tangents=True,
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
        export_image_format="AUTO",
    )

    all_min = Vector((float("inf"), float("inf"), float("inf")))
    all_max = Vector((float("-inf"), float("-inf"), float("-inf")))
    nodes = []
    materials = {}
    for obj, source_bounds, layer in admitted:
        minimum, maximum = world_bounds(obj, vertices=True)
        all_min.x = min(all_min.x, minimum.x); all_min.y = min(all_min.y, minimum.y); all_min.z = min(all_min.z, minimum.z)
        all_max.x = max(all_max.x, maximum.x); all_max.y = max(all_max.y, maximum.y); all_max.z = max(all_max.z, maximum.z)
        for material in obj.data.materials:
            if material and material.name not in materials:
                materials[material.name] = material_record(material)
        nodes.append({
            "sceneNode": obj.name,
            "sourceObject": obj.get("sourceObject"),
            "sourceMaterial": obj.get("sourceMaterial"),
            "layer": layer,
            "sourceBounds": source_bounds,
            "runtimeBounds": runtime_bounds_record(minimum, maximum),
            "triangles": len(obj.data.polygons),
        })

    with open(output_path, "rb") as handle:
        digest = hashlib.sha256(handle.read()).hexdigest()
    report = {
        "schemaVersion": 1,
        "assetId": config["assetId"],
        "source": {"file": os.path.basename(fbx_path), "coordinateNote": "FBX x/y horizontal, z vertical; normalized to Three.js x/z horizontal, y vertical."},
        "admission": {"method": "reviewed source-object spatial envelope", "envelope": envelope, "admissionCenter": list(admission_center), "excludeCenterRadius": exclude_radius, "includeParentNames": sorted(include_parents), "maxObjectSpan": max_object_span, "excludedNames": sorted(excludes), "excludedNamePrefixes": list(prefixes), "admittedObjects": len(admitted), "rejected": rejected},
        "output": {"file": os.path.basename(output_path), "sha256": digest, "meshCount": len(admitted), "triangles": sum(item["triangles"] for item in nodes), "bounds": runtime_bounds_record(all_min, all_max), "materials": list(materials.values())},
        "nodes": nodes,
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"assetId": config["assetId"], "admittedObjects": len(admitted), "triangles": report["output"]["triangles"], "output": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
