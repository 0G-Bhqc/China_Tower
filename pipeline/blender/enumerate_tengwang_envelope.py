"""List every mesh inside the Tengwang main-tower spatial envelope.

Reports name, bounds, triangles and material for each object whose centre lies
inside x[-220,-30] y[-90,150], so we can see which tower parts the curated
group union (16 objects, 141k tris) is missing.
"""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 2:
        raise SystemExit("expected: <input-fbx> <output-json>")
    return os.path.abspath(values[0]), os.path.abspath(values[1])


def main():
    fbx_path, output = cli_args()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    # Same envelope the export script admits against.
    x_range = (-220.0, -30.0)
    y_range = (-90.0, 150.0)

    rows = []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.data.vertices:
            continue
        points = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
        centre = Vector((
            sum(p.x for p in points) / len(points),
            sum(p.y for p in points) / len(points),
            sum(p.z for p in points) / len(points),
        ))
        if not (x_range[0] <= centre.x <= x_range[1] and y_range[0] <= centre.y <= y_range[1]):
            continue
        materials = [m.name if m else "__none__" for m in obj.data.materials]
        rows.append({
            "name": obj.name,
            "sourceObject": obj.original.name if obj.original else obj.name,
            "centre": [round(c, 2) for c in centre],
            "size": [
                round(max(p.x for p in points) - min(p.x for p in points), 2),
                round(max(p.y for p in points) - min(p.y for p in points), 2),
                round(max(p.z for p in points) - min(p.z for p in points), 2),
            ],
            "triangles": sum(len(p.vertices) - 2 for p in obj.data.polygons),
            "materials": materials[:4],
        })

    rows.sort(key=lambda r: -r["triangles"])
    payload = {
        "envelope": {"x": x_range, "y": y_range},
        "objectCount": len(rows),
        "totalTriangles": sum(r["triangles"] for r in rows),
        "objects": rows,
    }
    with open(output, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"objectCount": len(rows), "totalTriangles": payload["totalTriangles"]}))
    for row in rows[:40]:
        print(f"{row['triangles']:>9}  {row['name'][:48]:<48} size={row['size']}")


if __name__ == "__main__":
    main()
