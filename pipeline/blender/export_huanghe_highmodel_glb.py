"""Export the vetted Huanghe Tower architectural high model for Three.js.

This importer accepts only the safe, isolated FBX conversion.  It keeps the
complete five-tier tower, tile relief, bracket work, balustrades and podium,
while coalescing equal-material objects so the retained geometry is viable in a
browser.  The original MAX file is never read by this process or the app.
"""

from __future__ import annotations

import json
import math
import os
import sys

import bpy
from mathutils import Vector


def _parse_max_span():
    env = os.environ.get("HUANGHE_MAX_ARCHITECTURE_SPAN_METERS")
    if env:
        return float(env)
    # Relaxed from 100 m: the previous threshold admitted the main tower but
    # dropped large merged roof/tile sheets and podium slabs that are still
    # genuine architecture, leaving only thin shells in the runtime GLB.
    return 180.0


MAX_ARCHITECTURE_SPAN_METERS = _parse_max_span()


def _parse_core_radius():
    env = os.environ.get("HUANGHE_CORE_RADIUS_METERS")
    return float(env) if env else None


CORE_RADIUS_METERS = _parse_core_radius()


# Object-name heuristics to keep roof/tile geometry even when its merged bounding
# span exceeds the global threshold. These names come from the source object-map.
ROOF_TILE_NAME_HINTS = ("tile", "roof", "wa", "eave", "ridge", "gable")


def _is_likely_tile_object(obj_name: str) -> bool:
    lower = obj_name.lower()
    return any(hint in lower for hint in ROOF_TILE_NAME_HINTS)


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 3:
        raise SystemExit("expected: <input-fbx> <output-glb> <report-json>")
    return tuple(os.path.abspath(value) for value in values)


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def material_name(obj):
    material = obj.data.materials[0] if obj.data.materials else None
    return material.name if material else "__unassigned__"


def material_record(material):
    record = {
        "name": material.name,
        "diffuseColor": [round(channel, 5) for channel in material.diffuse_color],
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
    env = os.environ.get("HUANGHE_TEXTURE_DIR")
    if env:
        return env
    return os.path.abspath("3D资产/黄鹤楼")


def _repair_material_textures(texture_dir: str):
    """Relink FBX texture nodes to the actual on-disk source images.

    CRITICAL: never remove existing image datablocks.  The FBX importer shares
    one image block between every material referencing the same file, so
    removing it silently unlinks all other materials and destroys their
    textures (this exact bug dropped Penglai from 78 to 22 textured materials).
    Instead, load the resolved path with check_existing and assign.
    """
    if not os.path.isdir(texture_dir):
        print(f"WARNING: Huanghe texture directory not found: {texture_dir}")
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
    print(f"Recovered {recovered} Huanghe base-color textures from {texture_dir}")


def _force_opaque_materials():
    """The FBX arrives with Eevee HASHED blend on every material.

    glTF exports that as an alpha-blended material, which turns the dense but
    textureless roof sheets into translucent black gauze.  No alpha textures
    exist in this asset, so force every material opaque.

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
    print(f"Forced {changed} Huanghe materials opaque")


def _neutralize_metalness():
    """FBX imports arrive with Metallic=1 on every Principled BSDF.

    glTF then renders the whole tower as a pure mirror: diffuse drops to
    zero, the recovered base-colour textures are multiplied away and every
    surface shows the uniform grey environment.  These are painted timber
    and tile buildings - force dielectric shading.
    """
    changed = 0
    for material in bpy.data.materials:
        bsdf = None
        if material.use_nodes:
            bsdf = next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if bsdf is not None:
            socket = bsdf.inputs.get("Metallic")
            if socket is not None and not socket.is_linked and socket.default_value != 0.0:
                socket.default_value = 0.0
                changed += 1
        elif material.metallic != 0.0:
            material.metallic = 0.0
            changed += 1
    print(f"Neutralized metalness on {changed} Huanghe materials")


def _find_bsdf(material):
    if not material.use_nodes:
        return None
    return next((n for n in material.node_tree.nodes if n.type == "BSDF_PRINCIPLED"), None)


def _attach_base_color_texture(material, image_path, factor=None):
    """Point the Principled Base Color at image_path, keeping any existing node.

    The unconnected Base Color input default becomes the glTF baseColorFactor,
    so a grayscale tile bump sheet can be tinted golden via factor.
    """
    bsdf = _find_bsdf(material)
    if not bsdf:
        return False
    tree = material.node_tree
    image = bpy.data.images.load(image_path, check_existing=True)
    existing = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
    if existing and existing.from_node.type == "TEX_IMAGE":
        tex_node = existing.from_node
    else:
        if existing:
            tree.links.remove(existing)
        tex_node = tree.nodes.new("ShaderNodeTexImage")
        tex_node.location = bsdf.location - Vector((300, 0))
        tree.links.new(tex_node.outputs["Color"], bsdf.inputs["Base Color"])
    tex_node.image = image
    if factor is not None:
        bsdf.inputs["Base Color"].default_value = (factor[0], factor[1], factor[2], 1.0)
    return True


def _fix_placeholder_materials(texture_dir: str):
    """Repair known broken materials before export.

    - "Material #25": pure black, textureless, used by the four largest roof
      sheets (258k verts each).  The delivery folder ships an unused grayscale
      tile-ridge sheet (files-002.jpg) that was clearly meant for these roofs;
      attach it as base colour with a golden glaze factor.
    - "...-012": references a 3ds Max Mix texture that has no file; attach the
      unused weathered-stone sheet (files-003.JPG) instead.
    """
    fixes = 0
    for material in bpy.data.materials:
        if material.name == "Material #25":
            tile = os.path.join(texture_dir, "3d66Model-20515822-files-002.jpg")
            if os.path.isfile(tile) and _attach_base_color_texture(material, tile, factor=(1.0, 0.8, 0.38)):
                fixes += 1
        elif material.name == "3d66-Standardmaterial-20515822-012":
            stone = os.path.join(texture_dir, "3d66Model-20515822-files-003.JPG")
            if os.path.isfile(stone) and _attach_base_color_texture(material, stone):
                fixes += 1
    print(f"Repaired {fixes} placeholder Huanghe materials")


def main():
    fbx_path, output_glb, report_path = cli_args()
    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    _force_opaque_materials()
    _neutralize_metalness()
    _repair_material_textures(_parse_texture_dir())
    _fix_placeholder_materials(_parse_texture_dir())

    admitted, excluded = [], []
    for obj in bpy.context.scene.objects:
        if obj.type != "MESH" or not obj.data.vertices or not obj.data.polygons:
            continue
        minimum, maximum = world_bounds(obj)
        dimensions = maximum - minimum
        center = (minimum + maximum) * 0.5
        if CORE_RADIUS_METERS is not None and math.hypot(center.x - 163.6776123, center.y + 482.3624878) > CORE_RADIUS_METERS:
            excluded.append({"name": obj.name, "dimensionsMeters": [round(value, 3) for value in dimensions], "reason": "outside-core-radius"})
            continue
        span = max(dimensions.x, dimensions.y)
        if span > MAX_ARCHITECTURE_SPAN_METERS and not _is_likely_tile_object(obj.name):
            excluded.append({"name": obj.name, "dimensionsMeters": [round(value, 3) for value in dimensions], "reason": "oversized"})
            continue
        admitted.append(obj)
    if not admitted:
        raise RuntimeError("The safe FBX has no admitted Huanghe architectural geometry")

    admitted_set = set(admitted)
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj not in admitted_set:
            bpy.data.objects.remove(obj, do_unlink=True)

    material_groups = {}
    for obj in admitted:
        if obj.name in bpy.data.objects:
            material_groups.setdefault(material_name(obj), []).append(obj)
    export_objects = []
    for material, objects in material_groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = f"huanghe-main-tower-{material}"
        joined["sourceMaterial"] = material
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
        # Browser-side Meshopt decoding preserves the full topology while
        # quantizing/compressing vertex streams for a practical transfer size.
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
    )

    minimum, maximum = world_bounds(export_objects[0])
    for obj in export_objects[1:]:
        obj_minimum, obj_maximum = world_bounds(obj)
        minimum.x, minimum.y, minimum.z = min(minimum.x, obj_minimum.x), min(minimum.y, obj_minimum.y), min(minimum.z, obj_minimum.z)
        maximum.x, maximum.y, maximum.z = max(maximum.x, obj_maximum.x), max(maximum.y, obj_maximum.y), max(maximum.z, obj_maximum.z)
    materials, seen = [], set()
    for obj in export_objects:
        for material in obj.data.materials:
            if material and material.name not in seen:
                seen.add(material.name)
                materials.append(material_record(material))
    report = {
        "schemaVersion": 1,
        "assetId": "huanghe",
        "source": os.path.basename(fbx_path),
        "admission": {
            "method": "whole-building spatial admission after Blender high-model inspection",
            "maxArchitectureSpanMeters": MAX_ARCHITECTURE_SPAN_METERS,
            "coreRadiusMeters": CORE_RADIUS_METERS,
            "admittedComponents": len(admitted),
            "excludedOversizedMeshes": excluded,
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
    print(json.dumps({"admittedComponents": len(admitted), "meshes": len(export_objects), "triangles": report["output"]["triangles"]}, ensure_ascii=False))


if __name__ == "__main__":
    main()
