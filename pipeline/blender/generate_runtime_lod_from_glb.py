"""Generate one runtime LOD from an already admitted and verified GLB."""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


YUEYANG_ROOF_MATERIALS = {
    "Material #25",
    "Material #26",
    "3d66-Standardmaterial-22732580-024",
    "3d66-Standardmaterial-22732580-025",
    "3d66-Standardmaterial-22732580-026",
}


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 6:
        raise SystemExit("expected: <input-glb> <output-glb> <asset-id> <tier> <ratio> <report-json>")
    source, output, asset_id, tier, ratio, report = values
    source = os.path.abspath(source)
    if os.path.splitext(source)[1].lower() != ".glb":
        raise SystemExit("only admitted GLB input is accepted")
    if tier not in {"lod1", "lod2"}:
        raise SystemExit("tier must be lod1 or lod2")
    return source, os.path.abspath(output), asset_id, tier, float(ratio), os.path.abspath(report)


def triangle_count(obj):
    return sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)


def world_span(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return max(maximum - minimum)


def protected_ratio(obj, base_ratio):
    triangles = triangle_count(obj)
    span = world_span(obj)
    if triangles <= 64 or span <= 0.06:
        return 1.0
    if triangles <= 300 or span <= 0.16:
        return max(base_ratio, 0.82)
    if triangles <= 1500 or span <= 0.38:
        return max(base_ratio, 0.62)
    return base_ratio


def semantic_protected_ratio(obj, asset_id):
    """Keep silhouette-critical surfaces intact when evidence identifies them.

    Yueyang's helmet roof uses individually modelled tiles over a red timber
    under-structure. Generic collapse decimation thins the tile courses and
    exposes the under-structure even at a 70% ratio. The retained material
    bindings provide a stable, evidence-backed way to protect those meshes.
    """
    if asset_id != "yueyang":
        return None
    names = {slot.material.name for slot in obj.material_slots if slot.material}
    if names & YUEYANG_ROOF_MATERIALS:
        return 1.0
    return None


def main():
    source, output, asset_id, tier, base_ratio, report_path = cli_args()
    if not 0.02 <= base_ratio < 1.0:
        raise SystemExit("ratio must be in [0.02, 1.0)")
    os.makedirs(os.path.dirname(output), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.gltf(filepath=source)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.data.vertices and obj.data.polygons]
    if not meshes:
        raise RuntimeError("admitted GLB contains no mesh geometry")

    before = sum(triangle_count(obj) for obj in meshes)
    protected = 0
    semantic_protected = 0
    failures = []
    for obj in meshes:
        ratio = protected_ratio(obj, base_ratio)
        semantic_ratio = semantic_protected_ratio(obj, asset_id)
        if semantic_ratio is not None:
            ratio = semantic_ratio
            semantic_protected += 1
        if ratio > base_ratio:
            protected += 1
        if ratio >= 0.999 or triangle_count(obj) < 8:
            continue
        # Imported glTF instances may share MeshData. Modifiers cannot be
        # applied to multi-user data, so make only the decimated instance local.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        modifier = obj.modifiers.new(name=f"{tier}-runtime-decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        try:
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        except Exception as error:
            failures.append({"name": obj.name, "error": str(error)})
            if modifier.name in obj.modifiers:
                obj.modifiers.remove(modifier)
        obj.select_set(False)

    after = sum(triangle_count(obj) for obj in meshes)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in meshes:
        obj.select_set(True)
        obj["runtimeLod"] = tier
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.export_scene.gltf(
        filepath=output,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
    )

    report = {
        "schemaVersion": 1,
        "assetId": asset_id,
        "tier": tier,
        "source": os.path.basename(source),
        "policy": {
            "method": "admitted-runtime-GLB decimation",
            "baseRatio": base_ratio,
            "smallMeshProtection": True,
            "semanticProtection": "yueyang-roof-materials" if asset_id == "yueyang" else None,
        },
        "input": {"meshes": len(meshes), "triangles": before},
        "output": {
            "file": os.path.basename(output),
            "meshes": len(meshes),
            "triangles": after,
            "effectiveRatio": round(after / before, 6),
            "protectedMeshes": protected,
            "semanticProtectedMeshes": semantic_protected,
            "failedMeshes": failures,
        },
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report["output"], ensure_ascii=False))


if __name__ == "__main__":
    main()
