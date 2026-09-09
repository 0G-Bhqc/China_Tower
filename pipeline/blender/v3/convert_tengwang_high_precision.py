#!/usr/bin/env python3
"""Convert Tengwang source to high-precision runtime GLB via Blender."""
import bpy
import json
import math
import os
import sys
import traceback
from mathutils import Vector
from pathlib import Path

PROJECT_ROOT = Path(r"E:\Station\China_Tower")
INPUT_FBX = PROJECT_ROOT / "evidence/3d-assets/jobs/tengwang/outputs/full-scene-22753718.fbx"
OUTPUT_GLB = PROJECT_ROOT / "3D资产/tengwang-master-source/tengwang-22753718.glb"
REPORT_PATH = PROJECT_ROOT / "evidence/v3/tengwang/dissection/run-004/conversion-report.json"


def log(message: str):
    print(message, flush=True)


def clear_scene():
    log("[convert] Clearing scene...")
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for block in list(bpy.data.images):
        block.user_clear()
        if block.users == 0:
            bpy.data.images.remove(block)
    for block in list(bpy.data.meshes):
        block.user_clear()
        if block.users == 0:
            bpy.data.meshes.remove(block)
    for block in list(bpy.data.materials):
        block.user_clear()
        if block.users == 0:
            bpy.data.materials.remove(block)
    for block in list(bpy.data.objects):
        bpy.data.objects.remove(block, do_unlink=True)
    log("[convert] Scene cleared.")


def import_fbx(path: Path):
    log(f"[convert] Importing FBX: {path}")
    bpy.ops.import_scene.fbx(
        filepath=str(path),
        use_custom_props=False,
        use_image_search=False,
        automatic_bone_orientation=True,
        axis_forward="Y",
        axis_up="Z",
    )
    log(f"[convert] FBX import complete.")


def mesh_stats(obj):
    if obj.type != "MESH" or not obj.data:
        return 0, 0
    tris = sum(max(len(p.vertices) - 2, 0) for p in obj.data.polygons)
    return len(obj.data.vertices), tris


def export_glb(path: Path):
    log(f"[convert] Exporting GLB: {path}")
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB")
    log(f"[convert] GLB export complete.")


def compute_bounds(meshes):
    bounds_min = [float("inf")] * 3
    bounds_max = [float("-inf")] * 3
    for obj in meshes:
        if obj.data and obj.data.vertices:
            for vertex in obj.data.vertices:
                world_co = obj.matrix_world @ Vector(vertex.co)
                for i in range(3):
                    bounds_min[i] = min(bounds_min[i], world_co[i])
                    bounds_max[i] = max(bounds_max[i], world_co[i])
    if bounds_min[0] == float("inf"):
        return [0.0, 0.0, 0.0], [0.0, 0.0, 0.0], 0.0
    size = [bounds_max[i] - bounds_min[i] for i in range(3)]
    span = max(size)
    return bounds_min, bounds_max, span


def normalize_scene(meshes, target_height: float = 160.0):
    log(f"[convert] Skipping in-Blender normalization; Three.js will handle scaling.")
    return 1.0


def write_report(report: dict):
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"[convert] Report written: {REPORT_PATH}")


def main():
    try:
        clear_scene()
        log(f"[convert] Input FBX: {INPUT_FBX}")
        log(f"[convert] Output GLB: {OUTPUT_GLB}")

        if not INPUT_FBX.exists():
            raise RuntimeError(f"Input FBX not found: {INPUT_FBX}")

        import_fbx(INPUT_FBX)

        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        log(f"[convert] Mesh count: {len(meshes)}")
        if not meshes:
            raise RuntimeError("No meshes found after FBX import.")

        total_verts = 0
        total_tris = 0
        imported = []
        for obj in meshes:
            v, t = mesh_stats(obj)
            total_verts += v
            total_tris += t
            imported.append({
                "name": obj.name,
                "vertices": v,
                "triangles": t,
                "materials": [m.name for m in obj.data.materials if m],
            })
        log(f"[convert] Total vertices: {total_verts}, triangles: {total_tris}")

        bounds_min, bounds_max, span = compute_bounds(meshes)
        size = [bounds_max[i] - bounds_min[i] for i in range(3)]
        log(f"[convert] Bounds min: {bounds_min}, max: {bounds_max}, span: {span:.3f}m")

        normalize_scene(meshes, 160.0)
        bounds_min, bounds_max, span = compute_bounds(meshes)
        size = [bounds_max[i] - bounds_min[i] for i in range(3)]
        log(f"[convert] Normalized bounds min: {bounds_min}, max: {bounds_max}, span: {span:.3f}m, size: {size}")

        if span < 0.05:
            raise RuntimeError(
                f"Imported scene span is {span:.4f}m; likely unit/camera failure."
            )
        if span > 12000:
            raise RuntimeError(
                f"Imported scene span is {span:.2f}m; likely raw millimeters or camera units."
            )

        OUTPUT_GLB.parent.mkdir(parents=True, exist_ok=True)
        export_glb(OUTPUT_GLB)

        output_bytes = OUTPUT_GLB.stat().st_size if OUTPUT_GLB.exists() else 0
        passed = output_bytes > 0 and OUTPUT_GLB.exists()
        log(f"[convert] Output size: {output_bytes} bytes, passed={passed}")

        report = {
            "schemaVersion": 1,
            "assetId": "tengwang-22753718",
            "source": {
                "inputFbx": str(INPUT_FBX),
                "outputGlb": str(OUTPUT_GLB),
            },
            "integrity": {
                "meshCount": len(meshes),
                "vertexCount": total_verts,
                "triangleCount": total_tris,
                "boundsMeters": {
                    "width": size[0],
                    "depth": size[1],
                    "height": size[2],
                    "span": span,
                    "min": bounds_min,
                    "max": bounds_max,
                },
                "imported": imported[:10],
            },
            "output": {
                "bytes": output_bytes,
                "format": "GLB",
                "gltfVersion": 2,
            },
            "status": "success" if passed else "failed",
            "message": None if passed else "GLB file missing after export.",
        }
        write_report(report)
        log(f"[convert] Conversion complete. Status: {report['status']}")
        print(json.dumps(report, ensure_ascii=False))

    except Exception as exc:
        error_report = {
            "schemaVersion": 1,
            "assetId": "tengwang-22753718",
            "status": "error",
            "error": str(exc),
            "traceback": traceback.format_exc(),
        }
        write_report(error_report)
        log(f"[convert] ERROR: {exc}")
        print(json.dumps(error_report, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
