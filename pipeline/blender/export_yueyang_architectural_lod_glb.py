"""Create a browser LOD of the complete sanitized Yueyang architectural assembly.

This is a component-aware export: each source object remains separate, but high
triangle carved and roof families are reduced in Blender before delivery.  The
original FBX is retained only as local evidence and is not shipped to the web app.
"""

from __future__ import annotations

import json
import os
import sys

import bpy


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 2:
        raise SystemExit("expected: <fbx> <output-glb>")
    return [os.path.abspath(value) for value in values]


def reduction_ratio(triangles):
    if triangles >= 20000:
        return 0.16
    if triangles >= 8000:
        return 0.28
    if triangles >= 2000:
        return 0.52
    if triangles >= 600:
        return 0.74
    return None


def main():
    fbx_path, output_path = cli_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH"]
    for obj in meshes:
        ratio = reduction_ratio(len(obj.data.polygons))
        if ratio is None:
            continue
        # Linked component data is intentional in the source.  The modifier is
        # local to an instance, so copy before applying it.
        if obj.data.users > 1:
            obj.data = obj.data.copy()
        modifier = obj.modifiers.new(name="browser-lod-decimate", type="DECIMATE")
        modifier.ratio = ratio
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        bpy.ops.object.modifier_apply(modifier=modifier.name)
        obj.select_set(False)

    bpy.ops.object.select_all(action="SELECT")
    bpy.context.view_layer.objects.active = meshes[0]
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        use_selection=True,
        export_apply=True,
        export_yup=True,
        export_materials="EXPORT",
        export_cameras=False,
        export_lights=False,
    )
    triangle_count = sum(len(obj.data.polygons) for obj in meshes)
    print(json.dumps({"objects": len(meshes), "triangles": triangle_count, "output": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
