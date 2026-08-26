#!/usr/bin/env python3
"""Export immutable V3 preview/semantic runtime packs and a stable-ID picking proxy."""

from __future__ import annotations

import argparse
import bmesh
import hashlib
import json
import math
import os
import shutil
import subprocess
import sys
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


SCRIPT_VERSION = "1.1.0"
PACKAGE_BY_SEMANTIC = {
    "foundation": "core",
    "podium": "core",
    "structural-frame/columns": "core",
    "facade/walls": "core",
    "roof-system/rafters": "roof",
    "roof-system/sheathing": "roof",
    "roof-system/tiles": "roof",
    "roof-system/eaves": "roof",
    "roof-system/ridges": "roof",
    "roof-system/ornaments-finial": "roof",
    "structural-frame/beams": "detail",
    "structural-frame/brackets-dougong": "detail",
    "facade/doors-windows": "detail",
    "facade/railings": "detail",
    "secondary-details": "detail",
    "plaques": "plaque",
}
DETAIL_WEIGHTS = {
    "foundation": 0.55,
    "podium": 0.60,
    "facade/walls": 0.65,
    "roof-system/sheathing": 0.72,
    "structural-frame/columns": 1.35,
    "facade/doors-windows": 1.65,
    "facade/railings": 2.10,
    "structural-frame/brackets-dougong": 2.20,
    "roof-system/tiles": 2.00,
    "roof-system/eaves": 2.20,
    "roof-system/ridges": 2.25,
    "roof-system/ornaments-finial": 2.40,
    "secondary-details": 1.75,
}
TIERS = {
    "hero": {"texture": 2048, "floor": 256, "targets": {"core": 290000, "roof": 760000, "detail": 570000}},
    "standard": {"texture": 1024, "floor": 96, "targets": {"core": 200000, "roof": 380000, "detail": 270000}},
    "mobile": {
        "texture": 512,
        "floor": 12,
        "targets": {"core": 60000, "roof": 120000, "detail": 85000},
        "componentCaps": {"core": 6500, "roof": 13000, "detail": 9000},
    },
}
PREVIEW_TARGET = 50000
PREVIEW_TEXTURE = 512
PREVIEW_COMPONENT_CAP = 6500
GLTF_TRANSFORM_VERSION = "4.3.0"


def arguments() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--asset", required=True)
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


def load_source(path: Path) -> list[bpy.types.Object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(path))
    meshes = sorted((obj for obj in bpy.context.scene.objects if obj.type == "MESH"), key=lambda obj: obj.name_full.casefold())
    if not meshes or any(not obj.get("runtimeStableId") or not obj.get("semanticNode") for obj in meshes):
        raise RuntimeError("Input GLB lacks semantic mesh nodes or stable IDs.")
    return meshes


def triangle_count(obj: bpy.types.Object) -> int:
    return sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons)


def package_for(obj: bpy.types.Object) -> str:
    semantic = obj.get("semanticNode")
    if semantic not in PACKAGE_BY_SEMANTIC:
        raise RuntimeError(f"Unmapped semantic node: {semantic}")
    return PACKAGE_BY_SEMANTIC[semantic]


def resize_images(size: int) -> None:
    for image in bpy.data.images:
        if image.type != "IMAGE" or image.size[0] == 0 or image.size[1] == 0:
            continue
        if image.size[0] != size or image.size[1] != size:
            image.scale(size, size)


def stable_id_set_sha256(stable_ids: list[str]) -> str:
    return hashlib.sha256(("\n".join(sorted(stable_ids)) + "\n").encode("utf-8")).hexdigest()


def join_render_batch(objects: list[bpy.types.Object], name: str, stable_ids: list[str]) -> bpy.types.Object:
    """Weld semantic slices into one render surface without losing source material IDs."""
    if not objects:
        raise RuntimeError(f"Cannot create empty render batch: {name}")

    # Blender 5.2's object join keeps the material slots but can collapse every
    # joined face to slot zero when these GLB semantic slices each have one
    # local slot. Build the combined mesh explicitly so every face is remapped
    # from its local slot to the shared source-material table before welding.
    materials = sorted(
        {material for obj in objects for material in obj.data.materials if material},
        key=lambda material: material.name_full.casefold(),
    )
    material_indexes = {material.as_pointer(): index for index, material in enumerate(materials)}
    combined = bmesh.new()
    for obj in objects:
        temporary_mesh = obj.data.copy()
        local_to_global = {
            index: material_indexes[material.as_pointer()]
            for index, material in enumerate(obj.data.materials)
            if material
        }
        for polygon in temporary_mesh.polygons:
            polygon.material_index = local_to_global.get(polygon.material_index, 0)
        vertex_start = len(combined.verts)
        combined.from_mesh(temporary_mesh)
        combined.verts.ensure_lookup_table()
        added_vertices = list(combined.verts)[vertex_start:]
        if added_vertices:
            bmesh.ops.transform(combined, matrix=obj.matrix_world, verts=added_vertices)
        bpy.data.meshes.remove(temporary_mesh)

    batch_mesh = bpy.data.meshes.new(f"{name}/mesh")
    combined.to_mesh(batch_mesh)
    combined.free()
    batch = bpy.data.objects.new(name, batch_mesh)
    bpy.context.scene.collection.objects.link(batch)
    for material in materials:
        batch.data.materials.append(material)
    for obj in objects:
        bpy.data.objects.remove(obj, do_unlink=True)

    corners = [batch.matrix_world @ Vector(corner) for corner in batch.bound_box]
    span = max(
        max(point[index] for point in corners) - min(point[index] for point in corners)
        for index in range(3)
    )
    weld_distance = max(span * 1e-7, 1e-8)
    edit_mesh = bmesh.new()
    edit_mesh.from_mesh(batch.data)
    bmesh.ops.remove_doubles(edit_mesh, verts=list(edit_mesh.verts), dist=weld_distance)
    edit_mesh.to_mesh(batch.data)
    edit_mesh.free()
    batch.data.update()

    batch["runtimeStableId"] = name
    batch["renderBatch"] = True
    batch["sourceRuntimeStableIdsJson"] = json.dumps(sorted(stable_ids), ensure_ascii=False, separators=(",", ":"))
    batch["stableIdSetSha256"] = stable_id_set_sha256(stable_ids)
    batch["pickingIdentity"] = "external-one-to-one-proxy"
    return batch


def material_triangle_inventory(objects: list[bpy.types.Object]) -> dict[str, int]:
    inventory: Counter[str] = Counter()
    for obj in objects:
        materials = list(obj.data.materials)
        for polygon in obj.data.polygons:
            material = materials[polygon.material_index] if polygon.material_index < len(materials) else None
            name = material.name_full if material else "__unassigned__"
            inventory[name] += max(len(polygon.vertices) - 2, 0)
    return dict(sorted(inventory.items()))


def _component_inventory(obj: bpy.types.Object) -> tuple[list[dict], list[int]]:
    """Return connected-face islands without changing source topology or material data."""
    mesh = obj.data
    parents = list(range(len(mesh.vertices)))
    ranks = [0] * len(parents)

    def find(index: int) -> int:
        while parents[index] != index:
            parents[index] = parents[parents[index]]
            index = parents[index]
        return index

    def union(left: int, right: int) -> None:
        left_root = find(left)
        right_root = find(right)
        if left_root == right_root:
            return
        if ranks[left_root] < ranks[right_root]:
            left_root, right_root = right_root, left_root
        parents[right_root] = left_root
        if ranks[left_root] == ranks[right_root]:
            ranks[left_root] += 1

    for polygon in mesh.polygons:
        vertices = polygon.vertices
        if not vertices:
            continue
        anchor = vertices[0]
        for vertex in vertices[1:]:
            union(anchor, vertex)

    bounds: dict[int, list[float]] = {}
    for vertex in mesh.vertices:
        root = find(vertex.index)
        x, y, z = vertex.co
        if root not in bounds:
            bounds[root] = [x, y, z, x, y, z]
        else:
            box = bounds[root]
            box[0] = min(box[0], x)
            box[1] = min(box[1], y)
            box[2] = min(box[2], z)
            box[3] = max(box[3], x)
            box[4] = max(box[4], y)
            box[5] = max(box[5], z)

    stats: dict[int, dict] = {}
    face_roots: list[int] = []
    for polygon in mesh.polygons:
        root = find(polygon.vertices[0])
        face_roots.append(root)
        record = stats.setdefault(root, {"root": root, "triangles": 0, "area": 0.0})
        record["triangles"] += max(len(polygon.vertices) - 2, 0)
        record["area"] += polygon.area

    weight = DETAIL_WEIGHTS.get(obj.get("semanticNode"), 1.0)
    components = []
    for root, record in stats.items():
        box = bounds[root]
        diagonal = math.sqrt(
            (box[3] - box[0]) ** 2 + (box[4] - box[1]) ** 2 + (box[5] - box[2]) ** 2
        )
        record["diagonal"] = diagonal
        record["score"] = weight * (math.sqrt(max(record["area"], 0.0)) + 0.15 * diagonal) * math.log2(
            record["triangles"] + 1
        )
        components.append(record)
    return components, face_roots


def filter_micro_components(objects: list[bpy.types.Object], component_cap: int, mode: str) -> list[dict]:
    """Drop the least-readable disconnected islands while retaining one island per stable ID."""
    inventories: dict[str, tuple[list[dict], list[int]]] = {}
    candidates = []
    mandatory: set[tuple[str, int]] = set()
    for obj in objects:
        components, face_roots = _component_inventory(obj)
        inventories[obj.name_full] = (components, face_roots)
        if not components:
            continue
        largest = max(components, key=lambda item: (item["score"], item["triangles"], -item["root"]))
        mandatory.add((obj.name_full, largest["root"]))
        for component in components:
            candidates.append((component["score"], component["triangles"], obj.name_full, component["root"]))

    keep = set(mandatory)
    for _, _, object_name, root in sorted(candidates, key=lambda item: (-item[0], -item[1], item[2], item[3])):
        if len(keep) >= component_cap:
            break
        keep.add((object_name, root))

    records = []
    for obj in objects:
        components, face_roots = inventories[obj.name_full]
        kept_roots = {root for object_name, root in keep if object_name == obj.name_full}
        dropped_roots = {item["root"] for item in components if item["root"] not in kept_roots}
        dropped_triangles = sum(item["triangles"] for item in components if item["root"] in dropped_roots)
        before = triangle_count(obj)
        if dropped_roots:
            mesh = obj.data
            edit_mesh = bmesh.new()
            edit_mesh.from_mesh(mesh)
            edit_mesh.faces.ensure_lookup_table()
            edit_mesh.faces.index_update()
            doomed = [face for face in edit_mesh.faces if face.index < len(face_roots) and face_roots[face.index] in dropped_roots]
            bmesh.ops.delete(edit_mesh, geom=doomed, context="FACES")
            edit_mesh.to_mesh(mesh)
            edit_mesh.free()
            mesh.update()
        records.append({
            "runtimeStableId": obj.get("runtimeStableId"),
            "semanticNode": obj.get("semanticNode"),
            "mode": mode,
            "beforeComponents": len(components),
            "keptComponents": len(kept_roots),
            "droppedComponents": len(dropped_roots),
            "beforeTriangles": before,
            "droppedTriangles": dropped_triangles,
            "afterTriangles": triangle_count(obj),
            "uvLayersAfter": len(obj.data.uv_layers),
        })
    return records


def allocate_targets(objects: list[bpy.types.Object], target_total: int, minimum: int) -> dict[str, int]:
    original = {obj.name_full: triangle_count(obj) for obj in objects}
    floors = {name: min(count, minimum) for name, count in original.items()}
    if sum(floors.values()) > target_total:
        floors = {name: min(count, 4) for name, count in original.items()}
    targets = dict(floors)
    remaining = max(0, target_total - sum(targets.values()))
    active = {name for name, count in original.items() if targets[name] < count}
    by_name = {obj.name_full: obj for obj in objects}
    while remaining > 0 and active:
        weighted = {
            name: max(1.0, (original[name] - targets[name]) * DETAIL_WEIGHTS.get(by_name[name].get("semanticNode"), 1.0))
            for name in active
        }
        total_weight = sum(weighted.values())
        distributed = 0
        for name in sorted(active):
            room = original[name] - targets[name]
            addition = min(room, max(1, int(remaining * weighted[name] / total_weight)))
            targets[name] += addition
            distributed += addition
        remaining -= distributed
        active = {name for name in active if targets[name] < original[name]}
        if distributed == 0:
            break
    return targets


def decimate(objects: list[bpy.types.Object], target_total: int, minimum: int) -> list[dict]:
    targets = allocate_targets(objects, target_total, minimum)
    records = []
    for obj in objects:
        before = triangle_count(obj)
        target = targets[obj.name_full]
        if target < before and before >= 8:
            modifier = obj.modifiers.new(name="v3-b4-quality-weighted-lod", type="DECIMATE")
            modifier.decimate_type = "COLLAPSE"
            modifier.ratio = max(0.001, min(1.0, target / before))
            modifier.use_collapse_triangulate = True
            bpy.context.view_layer.objects.active = obj
            obj.select_set(True)
            try:
                bpy.ops.object.modifier_apply(modifier=modifier.name)
            finally:
                obj.select_set(False)
        after = triangle_count(obj)
        records.append({
            "runtimeStableId": obj.get("runtimeStableId"),
            "semanticNode": obj.get("semanticNode"),
            "sourceObject": obj.get("sourceObject"),
            "beforeTriangles": before,
            "targetTriangles": target,
            "afterTriangles": after,
            "protectedWeight": DETAIL_WEIGHTS.get(obj.get("semanticNode"), 1.0),
        })
    return records


def export_selected(objects: list[bpy.types.Object], temporary_path: Path, quality: int) -> None:
    bpy.ops.object.select_all(action="DESELECT")
    for obj in objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = objects[0]
    bpy.ops.export_scene.gltf(
        filepath=str(temporary_path),
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_materials="EXPORT",
        export_normals=True,
        export_yup=True,
        export_image_format="JPEG",
        export_jpeg_quality=quality,
    )


def content_address(temporary_path: Path, prefix: str) -> tuple[Path, str]:
    digest = sha256(temporary_path)
    final_path = temporary_path.with_name(f"{prefix}.{digest[:12]}.glb")
    os.replace(temporary_path, final_path)
    return final_path, digest


def meshopt_preview(source: Path, target: Path) -> dict:
    corepack = shutil.which("corepack.cmd") or shutil.which("corepack")
    if not corepack:
        raise RuntimeError("corepack is required for deterministic Meshopt preview compression")
    command = [
        corepack, "pnpm", "dlx", f"@gltf-transform/cli@{GLTF_TRANSFORM_VERSION}",
        "optimize", str(source), str(target),
        "--compress", "meshopt",
        "--flatten", "false",
        "--join", "false",
        "--instance", "false",
        "--palette", "false",
        "--simplify", "false",
        "--texture-compress", "false",
    ]
    subprocess.run(command, check=True)
    before = source.stat().st_size
    after = target.stat().st_size
    source.unlink()
    return {
        "method": "EXT_meshopt_compression",
        "decoder": "MeshoptDecoder",
        "tool": f"@gltf-transform/cli@{GLTF_TRANSFORM_VERSION}",
        "uncompressedBytes": before,
        "compressedBytes": after,
        "compressionRatio": round(after / before, 6),
        "preserveSemanticNodes": True,
    }


def package_record(
    path: Path,
    digest: str,
    render_objects: list[bpy.types.Object],
    stable_ids: list[str],
    source_triangles: int,
    target: int,
    texture_size: int,
) -> dict:
    material_triangles = material_triangle_inventory(render_objects)
    return {
        "status": "exported",
        "file": path.name,
        "bytes": path.stat().st_size,
        "sha256": digest,
        "targetTriangles": target,
        "sourceTriangles": source_triangles,
        "triangles": sum(triangle_count(obj) for obj in render_objects),
        "meshNodes": len(render_objects),
        "textureSize": texture_size,
        "materialInventory": {
            "names": sorted(material_triangles),
            "trianglesByMaterial": material_triangles,
        },
        "runtimeStableIds": sorted(stable_ids),
        "renderBatch": {
            "nodes": len(render_objects),
            "stableIdSetSha256": stable_id_set_sha256(stable_ids),
            "pickingIdentity": "external-one-to-one-proxy",
        },
    }


def export_preview(asset: str, source: Path, output: Path) -> tuple[dict, list[dict], list[dict]]:
    objects = load_source(source)
    stable_ids = sorted(obj.get("runtimeStableId") for obj in objects)
    source_triangles = sum(triangle_count(obj) for obj in objects)
    batch = join_render_batch(objects, f"{asset}/render-batch/preview", stable_ids)
    resize_images(PREVIEW_TEXTURE)
    component_records = filter_micro_components([batch], PREVIEW_COMPONENT_CAP, "preview-loading-placeholder")
    lod_records = decimate([batch], PREVIEW_TARGET, 12)
    uncompressed = output / f"{asset}-preview.uncompressed.tmp.glb"
    temporary = output / f"{asset}-preview.tmp.glb"
    export_selected([batch], uncompressed, 82)
    compression = meshopt_preview(uncompressed, temporary)
    final, digest = content_address(temporary, f"{asset}-preview")
    record = package_record(final, digest, [batch], stable_ids, source_triangles, PREVIEW_TARGET, PREVIEW_TEXTURE)
    record["role"] = "loading-placeholder-lod-not-highmodel"
    record["geometryCompression"] = compression
    record["componentFilter"] = {
        "cap": PREVIEW_COMPONENT_CAP,
        "before": sum(item["beforeComponents"] for item in component_records),
        "kept": sum(item["keptComponents"] for item in component_records),
        "dropped": sum(item["droppedComponents"] for item in component_records),
        "droppedTriangles": sum(item["droppedTriangles"] for item in component_records),
    }
    return record, lod_records, component_records


def export_tier(asset: str, source: Path, output: Path, tier: str, config: dict) -> tuple[dict, list[dict], list[dict]]:
    objects = load_source(source)
    resize_images(config["texture"])
    before = {obj.name_full: triangle_count(obj) for obj in objects}
    members_by_package = {
        package_name: [obj for obj in objects if package_for(obj) == package_name]
        for package_name in ("core", "roof", "detail")
    }
    all_lod_records = []
    all_component_records = []
    packages = {}
    for package_name in ("core", "roof", "detail"):
        members = members_by_package[package_name]
        stable_ids = sorted(obj.get("runtimeStableId") for obj in members)
        source_triangles = sum(before[obj.name_full] for obj in members)
        batch = join_render_batch(members, f"{asset}/render-batch/{tier}/{package_name}", stable_ids)
        if "componentCaps" in config:
            all_component_records.extend(
                filter_micro_components([batch], config["componentCaps"][package_name], f"{tier}-{package_name}")
            )
        all_lod_records.extend(decimate([batch], config["targets"][package_name], config["floor"]))
        temporary = output / f"{asset}-{tier}-{package_name}.tmp.glb"
        export_selected([batch], temporary, 86 if tier == "hero" else 82)
        final, digest = content_address(temporary, f"{asset}-{tier}-{package_name}")
        packages[package_name] = package_record(
            final,
            digest,
            [batch],
            stable_ids,
            source_triangles,
            config["targets"][package_name],
            config["texture"],
        )
        if "componentCaps" in config:
            matching = [item for item in all_component_records if item["mode"] == f"{tier}-{package_name}"]
            packages[package_name]["componentFilter"] = {
                "cap": config["componentCaps"][package_name],
                "before": sum(item["beforeComponents"] for item in matching),
                "kept": sum(item["keptComponents"] for item in matching),
                "dropped": sum(item["droppedComponents"] for item in matching),
                "droppedTriangles": sum(item["droppedTriangles"] for item in matching),
            }
    packages["plaque"] = {
        "status": "not-present",
        "reason": "G2 approved explicit not-present; no source plaque geometry may be invented in B4.",
        "triangles": 0,
        "meshNodes": 0,
        "runtimeStableIds": [],
    }
    return packages, all_lod_records, all_component_records


def box_mesh(name: str, low: Vector, high: Vector) -> bpy.types.Mesh:
    vertices = [
        (x, y, z)
        for x, y, z in (
            (low.x, low.y, low.z), (high.x, low.y, low.z), (high.x, high.y, low.z), (low.x, high.y, low.z),
            (low.x, low.y, high.z), (high.x, low.y, high.z), (high.x, high.y, high.z), (low.x, high.y, high.z),
        )
    ]
    faces = [(0, 2, 1), (0, 3, 2), (4, 5, 6), (4, 6, 7), (0, 1, 5), (0, 5, 4),
             (1, 2, 6), (1, 6, 5), (2, 3, 7), (2, 7, 6), (3, 0, 4), (3, 4, 7)]
    mesh = bpy.data.meshes.new(name)
    mesh.from_pydata(vertices, [], faces)
    mesh.update()
    return mesh


def export_picking_proxy(asset: str, source: Path, output: Path) -> tuple[dict, list[dict]]:
    source_objects = load_source(source)
    proxies = []
    contract = []
    for source_obj in source_objects:
        corners = [source_obj.matrix_world @ Vector(corner) for corner in source_obj.bound_box]
        low = Vector(tuple(min(point[index] for point in corners) for index in range(3)))
        high = Vector(tuple(max(point[index] for point in corners) for index in range(3)))
        stable_id = source_obj.get("runtimeStableId")
        proxy = bpy.data.objects.new(f"proxy__{hashlib.sha256(stable_id.encode()).hexdigest()[:16]}", box_mesh("proxy-box", low, high))
        bpy.context.scene.collection.objects.link(proxy)
        proxy["runtimeStableId"] = stable_id
        proxy["proxyForRuntimeStableId"] = stable_id
        proxy["semanticNode"] = source_obj.get("semanticNode")
        proxy["sourceObject"] = source_obj.get("sourceObject")
        proxy["pickingProxy"] = True
        proxies.append(proxy)
        contract.append({
            "runtimeStableId": stable_id,
            "proxyNode": proxy.name_full,
            "semanticNode": source_obj.get("semanticNode"),
            "sourceObject": source_obj.get("sourceObject"),
            "shape": "world-axis-aligned-bounds-box",
            "triangles": 12,
            "boundsMeters": {"minimum": list(low), "maximum": list(high)},
            "explodeWithParent": stable_id,
        })
    for obj in source_objects:
        bpy.data.objects.remove(obj, do_unlink=True)
    temporary = output / f"{asset}-picking-proxy.tmp.glb"
    export_selected(proxies, temporary, 75)
    final, digest = content_address(temporary, f"{asset}-picking-proxy")
    return {
        "file": final.name,
        "bytes": final.stat().st_size,
        "sha256": digest,
        "meshNodes": len(proxies),
        "triangles": 12 * len(proxies),
        "precision": "coarse bounds proxy; semantic one-to-one contract, not final G7 picking precision",
    }, contract


def instance_candidates(hierarchy: dict) -> dict:
    groups: dict[str, list[dict]] = defaultdict(list)
    for component in hierarchy["components"]:
        groups[component["sourceGeometryFingerprint"]].append(component)
    repeated = []
    for fingerprint, components in groups.items():
        if len(components) < 2:
            continue
        repeated.append({
            "shapeFingerprint": fingerprint,
            "count": len(components),
            "semanticNodes": sorted({item["semanticNode"] for item in components}),
            "sourceObjects": sorted({item["sourceObject"] for item in components}),
            "representativeRuntimeStableId": components[0]["runtimeStableId"],
            "status": "candidate-only-transform-reconstruction-required",
        })
    repeated.sort(key=lambda item: (-item["count"], item["shapeFingerprint"]))
    return {
        "schemaVersion": 1,
        "policy": "Only exact fingerprint groups are candidates; no instance is claimed without per-component transforms.",
        "appliedInstances": 0,
        "candidateGroups": len(repeated),
        "candidateComponents": sum(item["count"] for item in repeated),
        "groups": repeated,
    }


def main() -> None:
    options = arguments()
    source = options.input.resolve()
    hierarchy_path = options.hierarchy.resolve()
    output = options.output.resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite B4 review directory: {output}")
    output.mkdir(parents=True, exist_ok=False)
    hierarchy = json.loads(hierarchy_path.read_text(encoding="utf-8"))
    if hierarchy.get("assetId") != options.asset:
        raise RuntimeError("Hierarchy identity mismatch.")

    preview, preview_lod, preview_components = export_preview(options.asset, source, output)
    tiers = {}
    lod_records = {"preview": preview_lod}
    component_records = {"preview": preview_components}
    for tier, config in TIERS.items():
        tiers[tier], lod_records[tier], component_records[tier] = export_tier(options.asset, source, output, tier, config)
    proxy, proxy_contract = export_picking_proxy(options.asset, source, output)
    instances = instance_candidates(hierarchy)

    proxy_path = output / "picking-proxy-contract.json"
    proxy_path.write_text(json.dumps({
        "schemaVersion": 1,
        "assetId": options.asset,
        "mapping": "runtimeStableId -> proxyNode -> semanticNode",
        "oneToOne": len(proxy_contract) == len({item["runtimeStableId"] for item in proxy_contract}),
        "entries": sorted(proxy_contract, key=lambda item: item["runtimeStableId"]),
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    instances_path = output / "instance-candidates.json"
    instances_path.write_text(json.dumps(instances, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lod_path = output / "lod-policy.json"
    lod_path.write_text(json.dumps({
        "schemaVersion": 1,
        "assetId": options.asset,
        "method": "weld semantic slices into render batches, audit micro-island filtering for preview/mobile, then collapse; picking identity stays in the one-to-one proxy",
        "weights": DETAIL_WEIGHTS,
        "records": lod_records,
        "componentFiltering": component_records,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    manifest = {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3-runtime-packs",
        "assetId": options.asset,
        "stage": "B4",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "reviewOnly": True,
        "runtimeReplacement": False,
        "exportOrder": ["preview", "core", "roof", "detail", "plaque"],
        "inputs": {
            "materializedSemanticGlb": {"path": str(source), "sha256": sha256(source)},
            "hierarchy": {"path": str(hierarchy_path), "sha256": sha256(hierarchy_path)},
            "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        },
        "preview": preview,
        "tiers": tiers,
        "pickingProxy": {**proxy, "contract": proxy_path.name, "contractSha256": sha256(proxy_path)},
        "instances": {"manifest": instances_path.name, "sha256": sha256(instances_path), **{k: instances[k] for k in ("appliedInstances", "candidateGroups", "candidateComponents")}},
        "lodPolicy": {"file": lod_path.name, "sha256": sha256(lod_path)},
        "knownLimits": [
            "Plaques are explicit not-present and are not fabricated.",
            "Picking proxies use coarse per-chunk bounds boxes; final G7 precision is pending.",
            "Instance groups are candidates only because component-local transforms are not present in G3 evidence.",
            "Production runtime and public assets remain frozen until B4 and B5 acceptance."
        ],
    }
    manifest_path = output / "asset-pack-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (output / "run-manifest.json").write_text(json.dumps({
        "schemaVersion": 1,
        "status": "export-complete-validation-pending",
        "assetId": options.asset,
        "stage": "B4",
        "manifest": {"path": manifest_path.name, "sha256": sha256(manifest_path)},
        "runtimeReplacement": False,
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "status": "export-complete-validation-pending",
        "preview": {"bytes": preview["bytes"], "triangles": preview["triangles"]},
        "tiers": {tier: {name: value.get("triangles", 0) for name, value in packages.items()} for tier, packages in tiers.items()},
        "proxy": proxy,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
