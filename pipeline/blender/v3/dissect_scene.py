"""Audit a verified FBX without flattening its semantic structure.

This V3 pass is diagnostic. It catalogs every loose connected component,
generates low-confidence geometry hypotheses, preserves source-object mapping,
and renders seven review views. It never approves an architectural label and
never exports a production GLB.
"""

from __future__ import annotations

from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
from hashlib import sha1, sha256
import colorsys
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
        raise SystemExit("expected: <asset-id> <input-fbx> <output-dir> <job-json>")
    return values[0], *(os.path.abspath(value) for value in values[1:])


def write_json(pathname, value):
    os.makedirs(os.path.dirname(pathname), exist_ok=True)
    with open(pathname, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def file_sha256(pathname):
    digest = sha256()
    with open(pathname, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def rounded(values, digits=5):
    return [round(float(value), digits) for value in values]


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    maximum = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return minimum, maximum


def combined_bounds(objects):
    minima, maxima = zip(*(world_bounds(obj) for obj in objects))
    minimum = Vector(tuple(min(value[index] for value in minima) for index in range(3)))
    maximum = Vector(tuple(max(value[index] for value in maxima) for index in range(3)))
    return minimum, maximum


def stable_color(name):
    digest = sha1(name.encode("utf-8")).digest()
    hue = int.from_bytes(digest[:2], "big") / 65535.0
    red, green, blue = colorsys.hsv_to_rgb(hue, 0.72, 0.92)
    return (red, green, blue, 1.0)


def find(parent, index):
    while parent[index] != index:
        parent[index] = parent[parent[index]]
        index = parent[index]
    return index


def union(parent, rank, left, right):
    left_root = find(parent, left)
    right_root = find(parent, right)
    if left_root == right_root:
        return
    if rank[left_root] < rank[right_root]:
        parent[left_root] = right_root
    elif rank[left_root] > rank[right_root]:
        parent[right_root] = left_root
    else:
        parent[right_root] = left_root
        rank[left_root] += 1


def component_hypotheses(minimum, maximum, triangle_count, overall_minimum, overall_maximum):
    dimensions = maximum - minimum
    overall = overall_maximum - overall_minimum
    height = max(float(overall.z), 1e-6)
    width = max(float(overall.x), float(overall.y), 1e-6)
    horizontal = max(float(dimensions.x), float(dimensions.y), 1e-6)
    horizontal_min = max(min(float(dimensions.x), float(dimensions.y)), 1e-6)
    vertical = max(float(dimensions.z), 1e-6)
    bottom = (float(minimum.z) - float(overall_minimum.z)) / height
    top = (float(maximum.z) - float(overall_minimum.z)) / height
    center = (bottom + top) * 0.5
    footprint_ratio = horizontal / width
    verticality = vertical / horizontal
    flatness = horizontal / vertical
    thin_wall = max(float(dimensions.x), float(dimensions.y)) / horizontal_min

    candidates = []

    def add(node, confidence, reason):
        candidates.append({
            "semanticNode": node,
            "status": "hypothesis",
            "confidence": round(min(confidence, 0.55), 3),
            "reason": reason,
        })

    if bottom <= 0.08 and top <= 0.24 and flatness >= 2.2 and footprint_ratio >= 0.12:
        add("podium", 0.48, "low, broad connected component; requires isolation-render approval")
    if verticality >= 3.4 and footprint_ratio <= 0.09:
        add("structural-frame/columns", 0.46, "vertically slender connected component; geometry-only hypothesis")
    if flatness >= 5.0 and 0.12 <= center <= 0.82 and vertical / height <= 0.09:
        add("structural-frame/beams", 0.4, "horizontally slender component within the occupied storey range")
    if center >= 0.48 and flatness >= 1.8:
        add("roof-system/tiles", 0.38, "upper broad/flat component; may also be eave sheathing or a merged roof chunk")
    if center >= 0.55 and flatness >= 3.4 and footprint_ratio >= 0.08:
        add("roof-system/eaves", 0.42, "upper thin overhanging geometry candidate")
    if center >= 0.68 and verticality >= 1.25 and footprint_ratio <= 0.08:
        add("roof-system/ornaments-finial", 0.34, "upper narrow component candidate")
    if 0.12 <= center <= 0.78 and thin_wall >= 4.0 and vertical / height >= 0.04:
        add("facade/walls", 0.34, "thin vertical enclosure-like component; doors/windows remain unresolved")
    if triangle_count <= 96 or max(dimensions) / max(overall) <= 0.035:
        add("secondary-details", 0.3, "small connected component; exact architectural role needs close-up evidence")
    if not candidates:
        add("secondary-details", 0.15, "unresolved geometry; retained for review instead of being discarded")
    return candidates


def dissect_object(obj, overall_minimum, overall_maximum):
    mesh = obj.data
    vertex_count = len(mesh.vertices)
    parent = array("I", range(vertex_count))
    rank = bytearray(vertex_count)
    for edge in mesh.edges:
        union(parent, rank, edge.vertices[0], edge.vertices[1])

    records = {}
    for polygon in mesh.polygons:
        if not polygon.vertices:
            continue
        root = find(parent, polygon.vertices[0])
        record = records.setdefault(root, {
            "triangles": 0,
            "polygons": 0,
            "materials": Counter(),
            "edgeLengths": [],
            "minimum": Vector((math.inf, math.inf, math.inf)),
            "maximum": Vector((-math.inf, -math.inf, -math.inf)),
        })
        record["polygons"] += 1
        record["triangles"] += max(1, len(polygon.vertices) - 2)
        record["materials"][polygon.material_index] += 1

    matrix = obj.matrix_world
    world_basis = matrix.to_3x3()
    for edge in mesh.edges:
        root = find(parent, edge.vertices[0])
        if root not in records:
            continue
        delta = mesh.vertices[edge.vertices[1]].co - mesh.vertices[edge.vertices[0]].co
        records[root]["edgeLengths"].append(round(float((world_basis @ delta).length), 5))

    vertex_totals = Counter()
    for vertex in mesh.vertices:
        root = find(parent, vertex.index)
        if root not in records:
            continue
        point = matrix @ vertex.co
        record = records[root]
        for index in range(3):
            record["minimum"][index] = min(record["minimum"][index], point[index])
            record["maximum"][index] = max(record["maximum"][index], point[index])
        vertex_totals[root] += 1

    material_names = [material.name if material else "__unassigned__" for material in mesh.materials]
    output = []
    for root, record in records.items():
        minimum, maximum = record["minimum"], record["maximum"]
        fingerprint = json.dumps({
            "source": obj.name,
            "triangles": record["triangles"],
            "minimum": rounded(minimum, 4),
            "maximum": rounded(maximum, 4),
        }, sort_keys=True)
        component_id = f"component-{sha1(fingerprint.encode('utf-8')).hexdigest()[:14]}"
        edge_lengths = sorted(record["edgeLengths"])
        shape_fingerprint_source = json.dumps({
            "vertices": int(vertex_totals[root]),
            "polygons": int(record["polygons"]),
            "triangles": int(record["triangles"]),
            "edgeLengths": edge_lengths,
        }, separators=(",", ":"))
        output.append({
            "id": component_id,
            "sourceObject": obj.name,
            "blenderObject": obj.name,
            "sourceRootVertex": int(root),
            "vertices": int(vertex_totals[root]),
            "polygons": int(record["polygons"]),
            "triangles": int(record["triangles"]),
            "shapeFingerprint": sha1(shape_fingerprint_source.encode("utf-8")).hexdigest(),
            "edgeLengthStatsMeters": {
                "count": len(edge_lengths),
                "minimum": edge_lengths[0] if edge_lengths else 0,
                "median": edge_lengths[len(edge_lengths) // 2] if edge_lengths else 0,
                "maximum": edge_lengths[-1] if edge_lengths else 0,
            },
            "boundsMeters": {
                "minimum": rounded(minimum),
                "maximum": rounded(maximum),
                "dimensions": rounded(maximum - minimum),
                "center": rounded((minimum + maximum) * 0.5),
            },
            "materials": [
                {
                    "slot": int(slot),
                    "name": material_names[slot] if slot < len(material_names) else "__unassigned__",
                    "polygons": int(count),
                }
                for slot, count in sorted(record["materials"].items())
            ],
            "semanticHypotheses": component_hypotheses(minimum, maximum, record["triangles"], overall_minimum, overall_maximum),
            "glbNode": None,
            "runtimeStableId": None,
        })
    output.sort(key=lambda item: (-item["triangles"], item["id"]))
    return output


def point_camera(camera, target, position):
    camera.location = position
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def render_views(objects, minimum, maximum, output_dir):
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.display.shading.light = "STUDIO"
    scene.display.shading.show_shadows = True
    scene.display.shading.show_cavity = True
    scene.display.shading.cavity_type = "WORLD"
    scene.display.shading.curvature_ridge_factor = 1.7
    scene.display.shading.curvature_valley_factor = 1.25
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.035, 0.045, 0.065)

    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "v3-review-camera"
    camera.data.lens = 52
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 1.0)
    camera.data.clip_start = max(0.02, span / 2000.0)
    camera.data.clip_end = span * 24.0
    scene.camera = camera

    distance = span * 1.62
    directions = {
        "front": Vector((0.0, -1.0, 0.2)),
        "three-quarter": Vector((0.78, -0.78, 0.42)),
        "right": Vector((1.0, 0.0, 0.2)),
        "rear": Vector((0.0, 1.0, 0.2)),
        "left": Vector((-1.0, 0.0, 0.2)),
        "elevated": Vector((0.72, -0.72, 0.92)),
    }

    render_index = []
    for pass_id in ("beauty", "source-id"):
        scene.display.shading.color_type = "MATERIAL" if pass_id == "beauty" else "OBJECT"
        scene.display.shading.show_shadows = pass_id == "beauty"
        scene.display.shading.show_cavity = pass_id == "beauty"
        if pass_id == "source-id":
            for obj in objects:
                obj.color = stable_color(obj.name)
        pass_dir = os.path.join(output_dir, "renders", pass_id)
        os.makedirs(pass_dir, exist_ok=True)
        for view_id, direction in directions.items():
            direction.normalize()
            point_camera(camera, center, center + direction * distance)
            pathname = os.path.join(pass_dir, f"{view_id}.png")
            scene.render.filepath = pathname
            bpy.ops.render.render(write_still=True)
            render_index.append({"pass": pass_id, "view": view_id, "file": os.path.relpath(pathname, output_dir).replace("\\", "/")})

        eye_height = min(max(float(dimensions.z) * 0.065, 1.2), 2.2)
        low_target = Vector((center.x, center.y, minimum.z + dimensions.z * 0.58))
        horizontal = Vector((0.72, -1.0, 0.0)).normalized()
        low_position = Vector((center.x, center.y, minimum.z + eye_height)) + horizontal * (distance * 0.72)
        point_camera(camera, low_target, low_position)
        pathname = os.path.join(pass_dir, "low-angle.png")
        scene.render.filepath = pathname
        bpy.ops.render.render(write_still=True)
        render_index.append({"pass": pass_id, "view": "low-angle", "file": os.path.relpath(pathname, output_dir).replace("\\", "/")})
    return render_index


def main():
    asset_id, fbx_path, output_dir, job_path = cli_args()
    with open(job_path, encoding="utf-8-sig") as handle:
        job = json.load(handle)
    if job.get("assetId") != asset_id or job.get("track") != "dcc-highmodel-v3":
        raise RuntimeError("V3 job identity mismatch")
    if os.path.exists(output_dir):
        raise RuntimeError(f"Output directory already exists: {output_dir}")
    os.makedirs(output_dir, exist_ok=False)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    object_map_path = os.path.join(os.path.dirname(fbx_path), "object-map.json")
    with open(object_map_path, encoding="utf-8-sig") as handle:
        object_map = json.load(handle)
    source_mesh_names = {
        entry["name"]
        for entry in object_map.get("objects", [])
        if entry.get("class") in {"Editable_mesh", "PolyMeshObject", "Editable_Poly"}
    }
    mesh_objects = sorted(
        [
            obj
            for obj in bpy.context.scene.objects
            if obj.type == "MESH" and len(obj.data.polygons) > 0 and obj.name in source_mesh_names
        ],
        key=lambda obj: obj.name,
    )
    if not mesh_objects:
        raise RuntimeError("Verified FBX contains no mesh geometry")
    for obj in mesh_objects:
        obj["v3SourceObject"] = obj.name

    minimum, maximum = combined_bounds(mesh_objects)
    render_index = render_views(mesh_objects, minimum, maximum, output_dir)

    all_components = []
    source_mapping = []
    for index, obj in enumerate(mesh_objects, start=1):
        components = dissect_object(obj, minimum, maximum)
        all_components.extend(components)
        source_mapping.append({
            "sourceObject": obj.name,
            "blenderObject": obj.name,
            "componentIds": [component["id"] for component in components],
            "semanticNodes": sorted({
                candidate["semanticNode"]
                for component in components
                for candidate in component["semanticHypotheses"]
            }),
            "glbNodes": [],
            "runtimeStableIds": [],
        })
        print(json.dumps({"progress": f"{index}/{len(mesh_objects)}", "object": obj.name, "components": len(components)}))

    all_components.sort(key=lambda item: (-item["triangles"], item["id"]))
    semantic_groups = defaultdict(list)
    for component in all_components:
        for candidate in component["semanticHypotheses"]:
            semantic_groups[candidate["semanticNode"]].append((component, candidate))

    semantic_review = []
    for node in job["semanticContract"]["requiredNodes"]:
        candidates = semantic_groups.get(node, [])
        ordered = sorted(candidates, key=lambda pair: (-pair[1]["confidence"], -pair[0]["triangles"]))
        semantic_review.append({
            "semanticNode": node,
            "status": "hypothesis",
            "candidateCount": len(ordered),
            "candidateTriangles": sum(pair[0]["triangles"] for pair in ordered),
            "candidateComponentIds": [pair[0]["id"] for pair in ordered[:200]],
            "candidateListTruncated": len(ordered) > 200,
            "reviewDecision": None,
            "reviewEvidence": [],
            "evidenceGap": None if ordered else "No geometry-only candidate; requires manual isolation review or explicit not-present evidence.",
        })

    observed_triangles = sum(component["triangles"] for component in all_components)
    project_root = os.path.abspath(os.path.join(os.path.dirname(job_path), "..", "..", ".."))
    hierarchy_path = os.path.join(project_root, job["source"]["legacyHierarchy"])
    with open(hierarchy_path, encoding="utf-8-sig") as handle:
        hierarchy = json.load(handle)
    hierarchy_by_name = {entry["name"]: entry for entry in hierarchy.get("objects", [])}
    expected_meshes = len(source_mesh_names)
    expected_triangles = sum(
        int((((hierarchy_by_name.get(name) or {}).get("mesh")) or {}).get("triangles", 0))
        for name in source_mesh_names
    )
    baseline_inventory_meshes = int(job["source"]["inventory"]["meshes"])
    baseline_inventory_triangles = int(job["source"]["inventory"]["triangles"])
    triangle_delta_ratio = abs(observed_triangles - expected_triangles) / max(expected_triangles, 1)
    issues = []
    if baseline_inventory_meshes != expected_meshes or baseline_inventory_triangles != expected_triangles:
        issues.append({
            "severity": "info",
            "code": "legacy-inventory-non-source-geometry-excluded",
            "legacyMeshes": baseline_inventory_meshes,
            "sourceMappedMeshes": expected_meshes,
            "legacyTriangles": baseline_inventory_triangles,
            "sourceMappedTriangles": expected_triangles,
            "reason": "V3 admits only objects present in the isolated conversion object-map; Blender defaults or unrelated helpers are excluded.",
        })
    if len(mesh_objects) != expected_meshes:
        issues.append({"severity": "blocking", "code": "mesh-count-mismatch", "expected": expected_meshes, "observed": len(mesh_objects)})
    if triangle_delta_ratio > 0.01:
        issues.append({"severity": "blocking", "code": "triangle-count-mismatch", "expected": expected_triangles, "observed": observed_triangles, "deltaRatio": triangle_delta_ratio})
    missing_candidates = [entry["semanticNode"] for entry in semantic_review if entry["candidateCount"] == 0]
    if missing_candidates:
        issues.append({"severity": "review", "code": "missing-semantic-candidates", "nodes": missing_candidates})

    catalog = {
        "schemaVersion": 1,
        "assetId": asset_id,
        "method": "non-destructive edge-connected-component audit; labels are geometry-only hypotheses",
        "sourceObjectCount": len(mesh_objects),
        "componentCount": len(all_components),
        "triangles": observed_triangles,
        "boundsMeters": {"minimum": rounded(minimum), "maximum": rounded(maximum), "dimensions": rounded(maximum - minimum)},
        "components": all_components,
    }
    write_json(os.path.join(output_dir, "component-catalog.json"), catalog)
    write_json(os.path.join(output_dir, "source-runtime-map.json"), {
        "schemaVersion": 1,
        "assetId": asset_id,
        "mappingChain": job["semanticContract"]["mappingChain"],
        "status": "source-and-blender-mapped; GLB/runtime mappings pending approved export",
        "sources": source_mapping,
    })
    write_json(os.path.join(output_dir, "semantic-review.json"), {
        "schemaVersion": 1,
        "assetId": asset_id,
        "automaticLabelsAreApproved": False,
        "requiredNodes": semantic_review,
    })
    write_json(os.path.join(output_dir, "issues.json"), {"schemaVersion": 1, "assetId": asset_id, "issues": issues})

    run_manifest = {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3",
        "assetId": asset_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "blenderVersion": bpy.app.version_string,
        "input": {"file": fbx_path, "sha256": file_sha256(fbx_path), "job": job_path, "jobSha256": file_sha256(job_path)},
        "integrity": {
            "legacyInventoryMeshes": baseline_inventory_meshes,
            "legacyInventoryTriangles": baseline_inventory_triangles,
            "expectedMeshes": expected_meshes,
            "observedMeshes": len(mesh_objects),
            "expectedTriangles": expected_triangles,
            "observedTriangles": observed_triangles,
            "triangleDeltaRatio": triangle_delta_ratio,
            "passed": not any(issue["severity"] == "blocking" for issue in issues),
        },
        "outputs": {
            "componentCatalog": "component-catalog.json",
            "semanticReview": "semantic-review.json",
            "sourceRuntimeMap": "source-runtime-map.json",
            "issues": "issues.json",
            "renders": render_index,
        },
        "reviewState": "needs-human-semantic-review",
        "reviewPassCoverage": {
            "complete": ["beauty"],
            "diagnosticOnly": ["source-id"],
            "pending": ["alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id"],
        },
        "nextAction": "Review seven-view renders and approve/reject semantic candidates before any runtime GLB export.",
    }
    write_json(os.path.join(output_dir, "run-manifest.json"), run_manifest)
    print(json.dumps({
        "assetId": asset_id,
        "sourceObjects": len(mesh_objects),
        "components": len(all_components),
        "triangles": observed_triangles,
        "integrityPassed": run_manifest["integrity"]["passed"],
        "reviewState": run_manifest["reviewState"],
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
