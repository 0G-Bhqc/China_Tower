"""Export the verified Penglai main-pavilion cluster as a Meshopt GLB.

The source scene is a 183 x 230 metre complex. Admission is based on the
measured high-rise centre, with oversized ground/background meshes rejected.
No raw .max file enters this process.
"""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


def _parse_centre():
    env = os.environ.get("PENGLAI_CENTRE_XY")
    if env:
        parts = [float(p.strip()) for p in env.split(",")]
        if len(parts) == 2:
            return Vector((parts[0], parts[1]))
    return Vector((-6.28, 79.28))


def _parse_radius():
    env = os.environ.get("PENGLAI_ADMISSION_RADIUS_METERS")
    if env:
        return float(env)
    # Widened from 115 m: the walled complex measures roughly 183 x 230 m and
    # the previous window truncated courtyard buildings on the far side.
    return 170.0


def _parse_max_span():
    env = os.environ.get("PENGLAI_MAX_HORIZONTAL_SPAN_METERS")
    if env:
        return float(env)
    # Keep wide enough to admit the full walled complex while still rejecting
    # a single merged terrain/background sheet.
    return 260.0


CENTRE_XY = _parse_centre()
ADMISSION_RADIUS = _parse_radius()
MAX_HORIZONTAL_SPAN = _parse_max_span()


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 3:
        raise SystemExit("expected: <input-fbx> <output-glb> <report-json>")
    return tuple(os.path.abspath(value) for value in values)


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    maximum = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return minimum, maximum


def admitted(obj):
    if obj.type != "MESH" or not obj.data.vertices or not obj.data.polygons:
        return False
    minimum, maximum = world_bounds(obj)
    centre = (minimum + maximum) * 0.5
    dimensions = maximum - minimum
    return (
        abs(centre.x - CENTRE_XY.x) <= ADMISSION_RADIUS
        and abs(centre.y - CENTRE_XY.y) <= ADMISSION_RADIUS
        and dimensions.x <= MAX_HORIZONTAL_SPAN
        and dimensions.y <= MAX_HORIZONTAL_SPAN
    )


def material_signature(obj):
    names = tuple(material.name if material else "__unassigned__" for material in obj.data.materials)
    return names or ("__unassigned__",)


def material_record(material):
    record = {
        "name": material.name,
        "diffuseColor": [round(value, 5) for value in material.diffuse_color],
        "metallic": round(float(material.metallic), 5),
        "roughness": round(float(material.roughness), 5),
        "usesNodes": bool(material.use_nodes),
    }
    if material.use_nodes:
        tree = material.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf:
            link = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
            if link and link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                record["baseColorTexture"] = os.path.basename(link.from_node.image.filepath)
    return record


def _parse_texture_dir():
    env = os.environ.get("PENGLAI_TEXTURE_DIR")
    if env:
        return env
    return os.path.abspath("3D资产/蓬莱阁")


def _repair_material_textures(texture_dir: str):
    """Relink FBX texture nodes to the actual on-disk source images.

    CRITICAL: never remove existing image datablocks.  The FBX importer shares
    one image block between every material referencing the same file, so
    removing it silently unlinks all other materials and destroys their
    textures (this dropped this very asset from 78 to 22 textured materials).
    Load the resolved path with check_existing and assign instead.
    """
    if not os.path.isdir(texture_dir):
        print(f"WARNING: Penglai texture directory not found: {texture_dir}")
        return
    available = {name.lower(): name for name in os.listdir(texture_dir)}
    recovered = 0
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        tree = material.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        link = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
        if not link or link.from_node.type != "TEX_IMAGE":
            continue
        image_node = link.from_node
        image = image_node.image
        expected = os.path.basename(image.filepath) if image else ""
        if not expected or "." not in expected:
            continue
        actual = available.get(expected.lower())
        if not actual:
            stem = os.path.splitext(expected)[0].lower()
            for lower_name, real_name in available.items():
                if os.path.splitext(lower_name)[0] == stem:
                    actual = real_name
                    break
        if not actual:
            continue
        resolved = os.path.join(texture_dir, actual)
        if image and os.path.abspath(bpy.path.abspath(image.filepath)) == os.path.abspath(resolved) and image.size[0] > 0:
            recovered += 1
            continue
        image_node.image = bpy.data.images.load(resolved, check_existing=True)
        recovered += 1
    print(f"Recovered {recovered} Penglai base-color textures from {texture_dir}")


def _force_opaque_materials():
    """Drop Eevee HASHED blend so exported glTF materials are not translucent.

    Blender 4.2+ replaced blend_method/shadow_method with
    surface_render_method: DITHERED is the opaque default, BLENDED would
    export as alpha-blended glTF.
    """
    changed = 0
    for material in bpy.data.materials:
        if hasattr(material, "surface_render_method"):
            if material.surface_render_method != "DITHERED":
                material.surface_render_method = "DITHERED"
                changed += 1
        elif material.blend_method != "OPAQUE":
            material.blend_method = "OPAQUE"
            changed += 1
    print(f"Forced {changed} Penglai materials opaque")


def main():
    fbx_path, output_glb, report_path = cli_args()
    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    _force_opaque_materials()
    _repair_material_textures(_parse_texture_dir())
    source_objects = [obj for obj in bpy.context.scene.objects if admitted(obj)]
    if not source_objects:
        raise RuntimeError("The measured Penglai main-pavilion window admitted no geometry")

    groups = {}
    for obj in source_objects:
        groups.setdefault(material_signature(obj), []).append(obj)
    export_objects = []
    for index, (signature, objects) in enumerate(groups.items(), start=1):
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = f"penglai-main-cluster-{index:03d}"
        joined["sourceMaterials"] = "|".join(signature)
        export_objects.append(joined)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=output_glb,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_tangents=True,
        export_materials="EXPORT",
        export_image_format="AUTO",
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
    )

    minimum, maximum = world_bounds(export_objects[0])
    for obj in export_objects[1:]:
        obj_minimum, obj_maximum = world_bounds(obj)
        for axis in range(3):
            minimum[axis] = min(minimum[axis], obj_minimum[axis])
            maximum[axis] = max(maximum[axis], obj_maximum[axis])
    materials, seen = [], set()
    for obj in export_objects:
        for material in obj.data.materials:
            if material and material.name not in seen:
                seen.add(material.name)
                materials.append(material_record(material))
    report = {
        "schemaVersion": 1,
        "assetId": "penglai",
        "source": os.path.basename(fbx_path),
        "admission": {
            "method": "measured main-pavilion centre window with oversized background rejection",
            "centreXYMeters": [CENTRE_XY.x, CENTRE_XY.y],
            "radiusMeters": ADMISSION_RADIUS,
            "maxHorizontalSpanMeters": MAX_HORIZONTAL_SPAN,
            "admittedComponents": len(source_objects),
        },
        "output": {
            "file": os.path.basename(output_glb),
            "meshCount": len(export_objects),
            "triangles": sum(len(obj.data.polygons) for obj in export_objects),
            "boundsMeters": {
                "minimum": [round(value, 4) for value in minimum],
                "maximum": [round(value, 4) for value in maximum],
                "dimensions": [round(maximum[index] - minimum[index], 4) for index in range(3)],
            },
            "materials": materials,
        },
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps({"components": len(source_objects), "meshes": len(export_objects), "triangles": report["output"]["triangles"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
