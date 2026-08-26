#!/usr/bin/env python3
"""Filter main-tower objects from the full-scene FBX and export a clean GLB."""
import bpy
import json
import math
import sys
import traceback
from mathutils import Vector
from pathlib import Path

PROJECT_ROOT = Path(r"E:\Station\China_Tower")
INPUT_FBX = PROJECT_ROOT / "evidence/3d-assets/jobs/tengwang/outputs/full-scene.fbx"
OUTPUT_GLB = PROJECT_ROOT / "public/assets/tengwang-high-precision/tengwang-22753718.glb"
REPORT_PATH = PROJECT_ROOT / "evidence/v3/tengwang/dissection/run-005/conversion-report.json"


def log(message: str):
    print(message, flush=True)


def clear_scene():
    log("[filter] Clearing scene...")
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
    log("[filter] Scene cleared.")


def import_fbx(path: Path):
    log(f"[filter] Importing FBX: {path}")
    bpy.ops.import_scene.fbx(
        filepath=str(path),
        use_custom_props=False,
        use_image_search=False,
        automatic_bone_orientation=True,
        axis_forward="Y",
        axis_up="Z",
    )
    log(f"[filter] FBX import complete.")


def mesh_stats(obj):
    if obj.type != "MESH" or not obj.data:
        return 0, 0
    tris = sum(max(len(p.vertices) - 2, 0) for p in obj.data.polygons)
    return len(obj.data.vertices), tris


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


def export_glb(path: Path):
    log(f"[filter] Exporting GLB: {path}")
    bpy.ops.export_scene.gltf(filepath=str(path), export_format="GLB")
    log(f"[filter] GLB export complete.")


def write_report(report: dict):
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    log(f"[filter] Report written: {REPORT_PATH}")


def main():
    try:
        clear_scene()
        log(f"[filter] Input FBX: {INPUT_FBX}")
        log(f"[filter] Output GLB: {OUTPUT_GLB}")

        if not INPUT_FBX.exists():
            raise RuntimeError(f"Input FBX not found: {INPUT_FBX}")

        import_fbx(INPUT_FBX)

        all_meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        log(f"[filter] Total mesh objects: {len(all_meshes)}")

        bounds = {}
        for obj in all_meshes:
            b_min, b_max, span = compute_bounds([obj])
            bounds[obj.name] = {
                "min": b_min,
                "max": b_max,
                "span": span,
                "size": [b_max[i] - b_min[i] for i in range(3)],
            }

        max_span = max((v["span"] for v in bounds.values()), default=0)
        width_depth_threshold = 500.0
        height_threshold = 200.0

        keep = []
        remove = []
        for obj in all_meshes:
            info = bounds[obj.name]
            size_xz = max(info["size"][0], info["size"][1])
            size_y = info["size"][2]
            if size_xz > width_depth_threshold or size_y > height_threshold:
                remove.append(obj.name)
            else:
                keep.append(obj)

        log(f"[filter] Keeping {len(keep)} objects, removing {len(remove)} objects.")
        if remove:
            log(f"[filter] Removed samples: {remove[:10]}")

        for obj in all_meshes:
            if obj not in keep:
                bpy.data.objects.remove(obj, do_unlink=True)

        meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
        log(f"[filter] Mesh count after filtering: {len(meshes)}")
        if not meshes:
            raise RuntimeError("No meshes remain after filtering.")

        total_verts = 0
        total_tris = 0
        for obj in meshes:
            v, t = mesh_stats(obj)
            total_verts += v
            total_tris += t
        log(f"[filter] Total vertices: {total_verts}, triangles: {total_tris}")

        bounds_min, bounds_max, span = compute_bounds(meshes)
        size = [bounds_max[i] - bounds_min[i] for i in range(3)]
        height = bounds_max[1] - bounds_min[1]
        log(f"[filter] Bounds min: {bounds_min}, max: {bounds_max}, size: {size}, span: {span:.3f}m, height: {height:.3f}m")

        OUTPUT_GLB.parent.mkdir(parents=True, exist_ok=True)
        export_glb(OUTPUT_GLB)

        output_bytes = OUTPUT_GLB.stat().st_size if OUTPUT_GLB.exists() else 0
        passed = output_bytes > 0 and OUTPUT_GLB.exists()
        log(f"[filter] Output size: {output_bytes} bytes, passed={passed}")

        report = {
            "schemaVersion": 1,
            "assetId": "tengwang-22753718",
            "source": {
                "inputFbx": str(INPUT_FBX),
                "outputGlb": str(OUTPUT_GLB),
            },
            "filter": {
                "keptObjects": len(keep),
                "removedObjects": len(remove),
                "widthDepthThreshold": width_depth_threshold,
                "heightThreshold": height_threshold,
                "removedSample": remove[:10],
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
        log(f"[filter] Conversion complete. Status: {report['status']}")
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
        log(f"[filter] ERROR: {exc}")
        print(json.dumps(error_report, ensure_ascii=False))
        sys.exit(1)


if __name__ == "__main__":
    main()
