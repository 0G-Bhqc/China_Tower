#!/usr/bin/env python3
"""Validate a materialized semantic GLB without treating it as production runtime."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy


def arguments() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--hierarchy", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(values)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> None:
    options = arguments()
    input_path = options.input.resolve()
    hierarchy_path = options.hierarchy.resolve()
    output_path = options.output.resolve()
    if output_path.exists() and any(output_path.iterdir()):
        raise RuntimeError(f"Evidence directory is not empty: {output_path}")
    output_path.mkdir(parents=True, exist_ok=True)
    hierarchy = json.loads(hierarchy_path.read_text(encoding="utf-8"))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(input_path))
    meshes = sorted((obj for obj in bpy.context.scene.objects if obj.type == "MESH"), key=lambda obj: obj.name_full.casefold())
    triangles = sum(sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons) for obj in meshes)
    runtime_ids = [obj.get("runtimeStableId") for obj in meshes]
    source_objects = [obj.get("sourceObject") for obj in meshes]
    source_materials = [obj.get("sourceMaterial") for obj in meshes]
    mesh_records = [{
        "name": obj.name_full,
        "runtimeStableId": obj.get("runtimeStableId"),
        "semanticNode": obj.get("semanticNode"),
        "sourceObject": obj.get("sourceObject"),
        "sourceMaterial": obj.get("sourceMaterial"),
        "triangles": sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons),
        "uvLayers": [layer.name for layer in obj.data.uv_layers],
        "hasCustomNormals": getattr(obj.data, "has_custom_normals", None),
        "materialSlots": [slot.material.name_full if slot.material else None for slot in obj.material_slots],
    } for obj in meshes]
    materials = []
    for material in sorted(bpy.data.materials, key=lambda item: item.name_full.casefold()):
        nodes = list(material.node_tree.nodes) if material.use_nodes and material.node_tree else []
        images = []
        for node in nodes:
            if node.type == "TEX_IMAGE" and node.image:
                images.append({
                    "name": node.image.name_full,
                    "size": [int(node.image.size[0]), int(node.image.size[1])],
                    "packed": node.image.packed_file is not None,
                })
        materials.append({"name": material.name_full, "images": images})

    expected_chunks = len(hierarchy["chunks"])
    expected_triangles = sum(int(chunk["triangles"]) for chunk in hierarchy["chunks"])
    checks = {
        "meshNodeCount": len(meshes) == expected_chunks,
        "triangleCount": triangles == expected_triangles,
        "allMeshNodesHaveStableId": all(runtime_ids),
        "stableIdsUnique": len(set(runtime_ids)) == len(runtime_ids),
        "allMeshNodesHaveSourceObject": all(source_objects),
        "sourceObjectCount": len(set(source_objects)) == 30,
        "allMeshNodesHaveSourceMaterial": all(source_materials),
        "sourceMaterials": set(source_materials) == {"Material #26", "Material #27", "Material #28"},
        "allMeshNodesHaveUv": all(obj.data.uv_layers for obj in meshes),
        "allMeshNodesHaveCustomNormals": all(getattr(obj.data, "has_custom_normals", False) for obj in meshes),
        "threeRecoveredImageMaterials": len(materials) == 3 and all(len(material["images"]) == 1 for material in materials),
    }
    report = {
        "schemaVersion": 1,
        "status": "passed" if all(checks.values()) else "failed",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "reviewOnly": True,
        "inputs": {
            "glb": {"path": str(input_path), "sha256": sha256(input_path), "bytes": input_path.stat().st_size},
            "hierarchy": {"path": str(hierarchy_path), "sha256": sha256(hierarchy_path)},
            "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        },
        "expected": {"meshNodes": expected_chunks, "triangles": expected_triangles, "components": len(hierarchy["components"])},
        "observed": {
            "meshNodes": len(meshes),
            "triangles": triangles,
            "sourceObjects": len(set(source_objects)),
            "runtimeStableIds": len(set(runtime_ids)),
            "materials": materials,
        },
        "checks": checks,
        "meshes": mesh_records,
        "runtimeReplacement": False,
    }
    report_path = output_path / "materialized-semantic-glb-audit.json"
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    manifest = {
        "schemaVersion": 1,
        "status": report["status"],
        "reviewOnly": True,
        "report": {"path": report_path.name, "sha256": sha256(report_path)},
        "checks": checks,
        "runtimeReplacement": False,
    }
    (output_path / "run-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if report["status"] != "passed":
        raise RuntimeError(f"Materialized semantic GLB audit failed: {checks}")


if __name__ == "__main__":
    main()
