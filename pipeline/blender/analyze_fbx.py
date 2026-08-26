#!/usr/bin/env python3
"""Read a sanitized FBX in Blender and emit non-destructive reconstruction evidence.

This runner deliberately accepts FBX only.  It is never a path for importing original
3ds Max scenes or reusing their mesh topology in the Three.js deliverable.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector

ANALYZER_VERSION = "1.0.0"
PROFILE_VERSION = 1
PASS_NAMES = ["beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "material-id"]
VIEW_DEFINITIONS = [
    ("front", (0.0, -1.0, 0.0)),
    ("right", (1.0, 0.0, 0.0)),
    ("rear", (0.0, 1.0, 0.0)),
    ("left", (-1.0, 0.0, 0.0)),
    ("top", (0.0, 0.0, 1.0)),
    ("three-quarter", (1.0, -1.0, 0.5)),
]


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--job", required=True, type=Path, help="conversion-job.json")
    parser.add_argument("--input", required=True, type=Path, help="sanitized full-scene.fbx")
    parser.add_argument("--output", required=True, type=Path, help="analysis output directory")
    return parser.parse_args(argv)


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def assert_approved_job(job: dict, input_path: Path) -> None:
    required_safety = ("sourceReadOnly", "networkDisabled", "scriptExecutionDisabled", "customAttributesSanitized")
    if job.get("state") != "converted":
        raise RuntimeError("Conversion job is not approved: state must be 'converted'.")
    if not all(job.get("safety", {}).get(name) is True for name in required_safety):
        raise RuntimeError("Conversion job safety assertions are incomplete.")
    if input_path.suffix.lower() != ".fbx":
        raise RuntimeError("Only sanitized FBX input is accepted by this analyzer.")
    if not input_path.is_file():
        raise RuntimeError(f"Missing FBX input: {input_path}")


def vec(values: Vector) -> list[float]:
    return [round(float(value), 7) for value in values]


def bounds_for_object(obj: bpy.types.Object) -> tuple[Vector, Vector] | None:
    if obj.type != "MESH" or not obj.data.vertices:
        return None
    corners = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    return (
        Vector((min(point.x for point in corners), min(point.y for point in corners), min(point.z for point in corners))),
        Vector((max(point.x for point in corners), max(point.y for point in corners), max(point.z for point in corners))),
    )


def mesh_triangle_count(mesh: bpy.types.Mesh) -> int:
    return sum(max(0, len(poly.vertices) - 2) for poly in mesh.polygons)


def scene_inventory() -> tuple[dict, list[dict], list[dict]]:
    objects = sorted(bpy.context.scene.objects, key=lambda item: item.name.casefold())
    mesh_objects = [obj for obj in objects if obj.type == "MESH"]
    mesh_users: dict[str, int] = {}
    for obj in mesh_objects:
        mesh_users[obj.data.name_full] = mesh_users.get(obj.data.name_full, 0) + 1

    world_mins: list[Vector] = []
    world_maxs: list[Vector] = []
    hierarchy: list[dict] = []
    material_to_objects: dict[str, list[str]] = {}
    total_vertices = 0
    total_triangles = 0
    for obj in objects:
        object_bounds = bounds_for_object(obj)
        mesh = obj.data if obj.type == "MESH" else None
        material_names = [slot.material.name_full if slot.material else None for slot in obj.material_slots]
        for name in filter(None, material_names):
            material_to_objects.setdefault(name, []).append(obj.name_full)
        if mesh:
            total_vertices += len(mesh.vertices)
            total_triangles += mesh_triangle_count(mesh)
        record = {
            "name": obj.name_full,
            "type": obj.type,
            "parent": obj.parent.name_full if obj.parent else None,
            "worldMatrix": [round(float(value), 7) for row in obj.matrix_world for value in row],
            "materialSlots": material_names,
            "mesh": None if mesh is None else {
                "name": mesh.name_full,
                "vertices": len(mesh.vertices),
                "polygons": len(mesh.polygons),
                "triangles": mesh_triangle_count(mesh),
                "sharedByObjects": mesh_users[mesh.name_full],
            },
            "boundsMeters": None,
        }
        if object_bounds:
            minimum, maximum = object_bounds
            world_mins.append(minimum)
            world_maxs.append(maximum)
            record["boundsMeters"] = {"min": vec(minimum), "max": vec(maximum)}
        hierarchy.append(record)

    if not world_mins:
        raise RuntimeError("Imported FBX does not contain any non-empty mesh objects.")
    minimum = Vector((min(point.x for point in world_mins), min(point.y for point in world_mins), min(point.z for point in world_mins)))
    maximum = Vector((max(point.x for point in world_maxs), max(point.y for point in world_maxs), max(point.z for point in world_maxs)))
    dimensions = maximum - minimum
    inventory = {
        "objects": len(objects),
        "meshes": len({obj.data.name_full for obj in mesh_objects}),
        "materials": len({material.name_full for material in bpy.data.materials}),
        "instances": sum(users - 1 for users in mesh_users.values() if users > 1),
        "vertices": total_vertices,
        "triangles": total_triangles,
        "boundsMeters": {"width": round(dimensions.x, 7), "depth": round(dimensions.y, 7), "height": round(dimensions.z, 7)},
        "worldBoundsMeters": {"min": vec(minimum), "max": vec(maximum)},
    }
    clusters = [
        {
            "id": f"material-{index:03d}",
            "label": f"material grouping: {name}",
            "status": "hypothesis",
            "confidence": 0.2,
            "evidenceRefs": sorted(names),
            "reason": "Automatic grouping by imported material slot; it is not an architectural label.",
        }
        for index, (name, names) in enumerate(sorted(material_to_objects.items(), key=lambda item: item[0].casefold()), start=1)
    ]
    return inventory, hierarchy, clusters


def render_plan(inventory: dict) -> list[dict]:
    bounds = inventory["worldBoundsMeters"]
    minimum, maximum = Vector(bounds["min"]), Vector(bounds["max"])
    centre = (minimum + maximum) / 2
    radius = max(inventory["boundsMeters"].values()) * 1.35
    return [
        {
            "name": name,
            "camera": {
                "projection": "orthographic" if name != "three-quarter" else "perspective",
                "targetMeters": vec(centre),
                "direction": list(direction),
                "distanceMeters": round(radius, 7),
                "framing": "fit-world-bounds-with-8-percent-margin",
            },
            "passes": {pass_name: {"status": "planned", "path": f"views/{name}/{pass_name}.png"} for pass_name in PASS_NAMES},
        }
        for name, direction in VIEW_DEFINITIONS
    ]


def main() -> None:
    args = parse_args()
    job = load_json(args.job.resolve())
    input_path = args.input.resolve()
    output_path = args.output.resolve()
    assert_approved_job(job, input_path)

    bpy.ops.import_scene.fbx(filepath=str(input_path), use_custom_normals=True)
    inventory, hierarchy, clusters = scene_inventory()
    measurements = [
        {"id": "overall-width", "value": inventory["boundsMeters"]["width"], "unit": "meter", "source": "mesh", "confidence": 0.9},
        {"id": "overall-depth", "value": inventory["boundsMeters"]["depth"], "unit": "meter", "source": "mesh", "confidence": 0.9},
        {"id": "overall-height", "value": inventory["boundsMeters"]["height"], "unit": "meter", "source": "mesh", "confidence": 0.9},
        {"id": "mesh-object-count", "value": sum(1 for obj in bpy.context.scene.objects if obj.type == "MESH"), "unit": "count", "source": "hierarchy", "confidence": 1.0},
    ]
    provenance = {
        "sourceSha256": job["sourceSha256"],
        "jobId": job["jobId"],
        "analyzerVersion": ANALYZER_VERSION,
        "profileVersion": PROFILE_VERSION,
        "blenderVersion": bpy.app.version_string,
        "input": str(input_path),
    }
    output_path.mkdir(parents=True, exist_ok=True)
    write_json(output_path / "blender-inventory.json", {"schemaVersion": 1, "assetId": job["assetId"], "provenance": provenance, "inventory": inventory})
    write_json(output_path / "hierarchy.json", {"schemaVersion": 1, "assetId": job["assetId"], "objects": hierarchy})
    write_json(output_path / "cluster-hypotheses.json", {"schemaVersion": 1, "assetId": job["assetId"], "clusters": clusters})
    write_json(output_path / "measurement-candidates.json", {"schemaVersion": 1, "assetId": job["assetId"], "measurements": measurements})
    write_json(output_path / "render-plan.json", {"schemaVersion": 1, "assetId": job["assetId"], "views": render_plan(inventory)})
    write_json(output_path / "analysis-run.json", {
        "schemaVersion": 1,
        "status": "inventory-complete-render-evidence-pending",
        "assetId": job["assetId"],
        "provenance": provenance,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "nextGate": "Render all six evidence passes, review cluster hypotheses, then create a complete BlenderAnalysis record.",
        "issues": [
            {"severity": "info", "code": "semantic-labels-pending", "message": "Automatic material groups are hypotheses, not architectural semantics."},
            {"severity": "info", "code": "render-evidence-pending", "message": "This pass produces a render plan; it does not treat planned images as evidence."},
        ],
    })


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Blender analysis failed: {error}", file=sys.stderr)
        raise
