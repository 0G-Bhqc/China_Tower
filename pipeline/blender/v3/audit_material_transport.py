#!/usr/bin/env python3
"""Audit what material, UV, image, and normal data survived an FBX transport.

The audit is read-only with respect to the source asset and refuses to write into a
non-empty evidence directory. It deliberately makes no artistic-quality claim.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import bpy


SCRIPT_VERSION = "1.0.0"


def parse_args() -> argparse.Namespace:
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--source-manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(argv)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict:
    with path.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def vec(values) -> list[float]:
    return [round(float(value), 7) for value in values]


def custom_properties(value) -> dict:
    result = {}
    for key in value.keys():
        if key == "_RNA_UI":
            continue
        raw = value[key]
        if isinstance(raw, (str, int, float, bool)) or raw is None:
            result[key] = raw
        else:
            try:
                result[key] = list(raw)
            except TypeError:
                result[key] = repr(raw)
    return result


def audit_uv_layer(layer) -> dict:
    minimum = [math.inf, math.inf]
    maximum = [-math.inf, -math.inf]
    finite = 0
    outside_unit = 0
    for datum in layer.data:
        u, v = float(datum.uv[0]), float(datum.uv[1])
        if math.isfinite(u) and math.isfinite(v):
            finite += 1
            minimum[0] = min(minimum[0], u)
            minimum[1] = min(minimum[1], v)
            maximum[0] = max(maximum[0], u)
            maximum[1] = max(maximum[1], v)
            if u < 0.0 or u > 1.0 or v < 0.0 or v > 1.0:
                outside_unit += 1
    return {
        "name": layer.name,
        "coordinates": len(layer.data),
        "finiteCoordinates": finite,
        "outsideUnitSquare": outside_unit,
        "bounds": None if finite == 0 else {"min": vec(minimum), "max": vec(maximum)},
    }


def image_record(image) -> dict:
    resolved = Path(bpy.path.abspath(image.filepath)) if image.filepath else None
    packed = image.packed_file is not None
    return {
        "name": image.name_full,
        "filepath": image.filepath,
        "resolvedPath": str(resolved) if resolved else None,
        "exists": bool(resolved and resolved.is_file()),
        "packed": packed,
        "source": image.source,
        "size": [int(image.size[0]), int(image.size[1])],
        "colorspace": image.colorspace_settings.name,
    }


def main() -> None:
    args = parse_args()
    input_path = args.input.resolve()
    manifest_path = args.source_manifest.resolve()
    output_path = args.output.resolve()
    if input_path.suffix.lower() != ".fbx" or not input_path.is_file():
        raise RuntimeError("Input must be an existing sanitized FBX file.")
    if output_path.exists() and any(output_path.iterdir()):
        raise RuntimeError(f"Evidence directory is not empty: {output_path}")
    output_path.mkdir(parents=True, exist_ok=True)

    source_manifest = load_json(manifest_path)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(input_path), use_custom_normals=True)

    material_objects: dict[str, set[str]] = defaultdict(set)
    material_polygons: Counter[str] = Counter()
    mesh_records = []
    total_uv_layers = 0
    meshes_with_uv = 0
    total_loops = 0
    smooth_polygons = 0
    flat_polygons = 0
    sharp_edges = 0

    for obj in sorted((item for item in bpy.context.scene.objects if item.type == "MESH"), key=lambda item: item.name_full.casefold()):
        mesh = obj.data
        total_loops += len(mesh.loops)
        uv_layers = [audit_uv_layer(layer) for layer in mesh.uv_layers]
        total_uv_layers += len(uv_layers)
        meshes_with_uv += int(bool(uv_layers))
        smooth_count = sum(1 for polygon in mesh.polygons if polygon.use_smooth)
        local_sharp_edges = sum(1 for edge in mesh.edges if getattr(edge, "use_edge_sharp", False))
        smooth_polygons += smooth_count
        flat_polygons += len(mesh.polygons) - smooth_count
        sharp_edges += local_sharp_edges
        material_counts: Counter[str] = Counter()
        for polygon in mesh.polygons:
            if polygon.material_index < len(obj.material_slots):
                material = obj.material_slots[polygon.material_index].material
                material_name = material.name_full if material else "<empty>"
            else:
                material_name = "<out-of-range>"
            material_counts[material_name] += 1
            material_objects[material_name].add(obj.name_full)
            material_polygons[material_name] += 1
        has_custom_normals = getattr(mesh, "has_custom_normals", None)
        corner_normals = getattr(mesh, "corner_normals", None)
        mesh_records.append({
            "object": obj.name_full,
            "mesh": mesh.name_full,
            "vertices": len(mesh.vertices),
            "polygons": len(mesh.polygons),
            "loops": len(mesh.loops),
            "uvLayers": uv_layers,
            "activeUv": mesh.uv_layers.active.name if mesh.uv_layers.active else None,
            "colorAttributes": [
                {"name": attribute.name, "domain": attribute.domain, "dataType": attribute.data_type}
                for attribute in mesh.color_attributes
            ],
            "materialPolygonCounts": dict(sorted(material_counts.items())),
            "normalEvidence": {
                "hasCustomNormalsApi": has_custom_normals,
                "cornerNormalCount": len(corner_normals) if corner_normals is not None else None,
                "smoothPolygons": smooth_count,
                "flatPolygons": len(mesh.polygons) - smooth_count,
                "sharpEdges": local_sharp_edges,
            },
            "customProperties": custom_properties(obj),
        })

    material_records = []
    for material in sorted(bpy.data.materials, key=lambda item: item.name_full.casefold()):
        nodes = list(material.node_tree.nodes) if material.use_nodes and material.node_tree else []
        image_nodes = [node for node in nodes if node.type == "TEX_IMAGE"]
        material_records.append({
            "name": material.name_full,
            "useNodes": material.use_nodes,
            "diffuseColor": vec(material.diffuse_color),
            "metallic": float(material.metallic),
            "roughness": float(material.roughness),
            "nodeTypes": [node.type for node in nodes],
            "imageTextureNodes": [
                {"node": node.name, "image": image_record(node.image) if node.image else None}
                for node in image_nodes
            ],
            "objects": sorted(material_objects.get(material.name_full, set())),
            "polygonCount": material_polygons.get(material.name_full, 0),
            "customProperties": custom_properties(material),
        })

    companion_records = []
    workspace = manifest_path.parents[4]
    for companion in source_manifest.get("companions", []):
        path = workspace / companion["workspaceRelativePath"]
        companion_records.append({
            **companion,
            "resolvedPath": str(path),
            "exists": path.is_file(),
            "verifiedSha256": sha256(path) if path.is_file() else None,
        })

    image_records = [image_record(image) for image in sorted(bpy.data.images, key=lambda item: item.name_full.casefold())]
    referenced_images = [record for record in image_records if record["filepath"] or record["packed"]]
    total_meshes = len(mesh_records)
    verdict = {
        "fbxContainsImageBindings": bool(referenced_images or any(record["imageTextureNodes"] for record in material_records)),
        "fbxContainsUvLayers": total_uv_layers > 0,
        "allImportedMeshesHaveUv": total_meshes > 0 and meshes_with_uv == total_meshes,
        "customNormalTransportProven": any(record["normalEvidence"]["hasCustomNormalsApi"] is True for record in mesh_records),
        "normalDataPresentButProvenanceAmbiguous": total_loops > 0,
        "safeConclusion": "UV coordinates can be evaluated independently, but texture and custom-normal recovery must not be claimed unless their bindings/provenance are present in this report.",
    }
    payload = {
        "schemaVersion": 1,
        "auditVersion": SCRIPT_VERSION,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "assetId": source_manifest["assetId"],
        "inputs": {
            "sourceManifest": {"path": str(manifest_path), "sha256": sha256(manifest_path)},
            "sourceMax": source_manifest["source"],
            "sanitizedFbx": {"path": str(input_path), "bytes": input_path.stat().st_size, "sha256": sha256(input_path)},
            "companions": companion_records,
        },
        "runtime": {"blenderVersion": bpy.app.version_string},
        "summary": {
            "meshObjects": total_meshes,
            "materials": len(material_records),
            "images": len(image_records),
            "referencedImages": len(referenced_images),
            "meshesWithUv": meshes_with_uv,
            "uvLayers": total_uv_layers,
            "loops": total_loops,
            "smoothPolygons": smooth_polygons,
            "flatPolygons": flat_polygons,
            "sharpEdges": sharp_edges,
        },
        "verdict": verdict,
        "materials": material_records,
        "images": image_records,
        "meshes": mesh_records,
    }
    report_path = output_path / "material-transport-audit.json"
    write_json(report_path, payload)
    write_json(output_path / "run-manifest.json", {
        "schemaVersion": 1,
        "status": "audit-complete-no-artistic-claim",
        "assetId": source_manifest["assetId"],
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        "output": {"path": report_path.name, "sha256": sha256(report_path)},
        "verdict": verdict,
    })


if __name__ == "__main__":
    main()
