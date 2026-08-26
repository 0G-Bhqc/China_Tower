"""Export selected, decimated high-model construction families as a Three.js detail layer.

The source is the verified FBX, never the untrusted .max.  This exports only the
architectural detail families admitted by the component contract, leaving primary
volumes and roof shells procedural in Three.js.
"""

from __future__ import annotations

import json
import os
import sys

import bpy


SIGNATURES = {
    "50|1238|0.700001,0.050003,3.000001",
    "38|1148|0.700001,0.050002,2.4",
    "32|1600|0.698825,0.698825,0.179697",
    "24|804|0.62,0.050001,0.91",
    "20|14280|1.517343,1.7238,2.370864",
    "20|60|0.4,0.400001,4.586237",
    "12|36691|1.031441,1.031438,0.923227",
    "12|2092|0.41571,0.415711,0.688486",
    "12|60|0.4,0.400001,9.474671",
    "12|60|0.4,0.400001,1.709145",
    "12|28|0.15,0.15,1",
    "12|28|0.25,0.25,3.216003",
    "5|44|0.200001,14.099999,0.400002",
    "5|44|16.200001,0.200001,0.400004",
}


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 3:
        raise SystemExit("expected: <fbx> <catalog> <output-glb>")
    return [os.path.abspath(value) for value in values]


def signature(family):
    dims = ",".join(str(value) for value in family["medianDimensionsMeters"])
    return f'{family["instanceCount"]}|{family["trianglesPerInstance"]}|{dims}'


def main():
    fbx_path, catalog_path, output_path = cli_args()
    with open(catalog_path, encoding="utf-8") as handle:
        catalog = json.load(handle)
    selected_names = {family["familyId"] for family in catalog["families"] if signature(family) in SIGNATURES}

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    selected = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.data.name in selected_names]
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or obj not in selected:
            bpy.data.objects.remove(obj, do_unlink=True)

    # Dense bracket families retain a visible carved silhouette at this ratio while
    # avoiding delivery of the original 1.7M-triangle scene to the browser.
    for obj in selected:
        source_triangles = len(obj.data.polygons)
        if source_triangles >= 10000:
            # The FBX preserves repeated components as linked mesh data.  Make a
            # local copy before applying an object-level decimator so every
            # exported instance remains valid.
            if obj.data.users > 1:
                obj.data = obj.data.copy()
            modifier = obj.modifiers.new(name="threejs-detail-decimate", type="DECIMATE")
            modifier.ratio = 0.24
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.modifier_apply(modifier=modifier.name)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in selected:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = selected[0]
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
    total = sum(len(obj.data.polygons) for obj in selected)
    print(json.dumps({"objects": len(selected), "triangles": total, "output": output_path}, ensure_ascii=False))


if __name__ == "__main__":
    main()
