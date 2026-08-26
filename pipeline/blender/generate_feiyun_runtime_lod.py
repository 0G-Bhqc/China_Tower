"""Generate one quality-weighted Feiyun runtime LOD from the verified FBX.

The decimator runs before material joining so small brackets, finials and rail
parts retain a larger share of their topology than broad roof and wall fields.
Raw MAX scenes are never accepted by this script.
"""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


DEFAULT_TEXTURE_MAPPING = {
    "Material #26": "3D资产/飞云楼/3d66Model-21849443-files-002.jpg",
    "Material #27": "3D资产/飞云楼/3d66Model-21849443-files-003.jpg",
    "Material #28": "3D资产/飞云楼/3d66Model-21849443-files-004.jpg",
}


def _parse_texture_mapping():
    env = os.environ.get("FEIYUN_TEXTURE_MAPPING")
    if not env:
        return dict(DEFAULT_TEXTURE_MAPPING)
    mapping = {}
    for pair in env.split(","):
        material, texture = pair.split(":", 1)
        mapping[material.strip()] = texture.strip()
    return mapping


def _parse_texture_max_size():
    env = os.environ.get("FEIYUN_TEXTURE_MAX_SIZE")
    return int(env) if env else 2048


def _resolve_texture_path(texture_path):
    env = os.environ.get("FEIYUN_TEXTURE_DIR")
    if env:
        return os.path.join(env, os.path.basename(texture_path))
    return os.path.abspath(texture_path)


TEXTURE_MAPPING = _parse_texture_mapping()
TEXTURE_MAX_SIZE = _parse_texture_max_size()


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 5:
        raise SystemExit("expected: <verified-fbx> <output-glb> <tier> <base-ratio> <report-json>")
    source, output, tier, ratio, report = values
    source = os.path.abspath(source)
    if os.path.splitext(source)[1].lower() != ".fbx":
        raise SystemExit("only verified FBX input is accepted")
    return source, os.path.abspath(output), tier, float(ratio), os.path.abspath(report)


def triangle_count(obj):
    return sum(max(0, len(polygon.vertices) - 2) for polygon in obj.data.polygons)


def world_dimensions(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return maximum - minimum


def protected_ratio(obj, base_ratio):
    triangles = triangle_count(obj)
    dimensions = world_dimensions(obj)
    span = max(dimensions)
    # Micro components define the perceived density of brackets, railings and
    # finials. Preserve them aggressively; recover the budget from broad fields.
    if triangles <= 96 or span <= 0.09:
        return 1.0
    if triangles <= 480 or span <= 0.22:
        return max(base_ratio, 0.72)
    if triangles <= 2400 or span <= 0.55:
        return max(base_ratio, 0.48)
    return base_ratio


def source_material_name(obj):
    material = obj.data.materials[0] if obj.data.materials else None
    return material.name if material else "__unassigned__"


def prepare_textured_material(material, texture_path):
    resolved = _resolve_texture_path(texture_path)
    if not os.path.isfile(resolved):
        print(f"WARNING: Feiyun texture missing for {material.name}: {resolved}")
        return False
    image = bpy.data.images.load(resolved, check_existing=False)
    max_size = TEXTURE_MAX_SIZE
    if max(image.size[0], image.size[1]) > max_size:
        image.scale(max_size, max_size)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    shader = nodes.new("ShaderNodeBsdfPrincipled")
    image_node = nodes.new("ShaderNodeTexImage")
    image_node.image = image
    image_node.extension = "REPEAT"
    image_node.interpolation = "Linear"
    shader.inputs["Roughness"].default_value = 0.68
    shader.inputs["Metallic"].default_value = 0.0
    material.node_tree.links.new(image_node.outputs["Color"], shader.inputs["Base Color"])
    material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
    return True


def main():
    source_path, output_path, tier, base_ratio, report_path = cli_args()
    if tier not in {"lod1", "lod2"} or not 0.02 <= base_ratio < 1.0:
        raise SystemExit("tier must be lod1/lod2 and ratio must be in [0.02, 1.0)")
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=source_path)

    # Recover the source albedo atlases that the FBX conversion dropped. UVs and
    # custom normals are already preserved; we only need REPEAT image sampling.
    texture_recovery = {}
    for material in bpy.data.materials:
        texture_path = TEXTURE_MAPPING.get(material.name)
        if texture_path:
            texture_recovery[material.name] = {
                "path": texture_path,
                "resolved": _resolve_texture_path(texture_path),
                "recovered": prepare_textured_material(material, texture_path),
            }

    meshes = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.data.vertices and obj.data.polygons]
    if not meshes:
        raise RuntimeError("verified FBX contains no mesh geometry")

    before_triangles = sum(triangle_count(obj) for obj in meshes)
    protected_objects = 0
    failed_objects = []
    for index, obj in enumerate(meshes):
        ratio = protected_ratio(obj, base_ratio)
        if ratio > base_ratio:
            protected_objects += 1
        if ratio >= 0.999 or triangle_count(obj) < 8:
            continue
        bpy.context.view_layer.objects.active = obj
        obj.select_set(True)
        modifier = obj.modifiers.new(name=f"{tier}-quality-weighted-decimate", type="DECIMATE")
        modifier.decimate_type = "COLLAPSE"
        modifier.ratio = ratio
        modifier.use_collapse_triangulate = True
        try:
            bpy.ops.object.modifier_apply(modifier=modifier.name)
        except Exception as error:  # preserve source component instead of dropping it
            failed_objects.append({"name": obj.name, "error": str(error)})
            if modifier.name in obj.modifiers:
                obj.modifiers.remove(modifier)
        obj.select_set(False)
        if index and index % 500 == 0:
            print(f"decimated {index}/{len(meshes)} components")

    after_decimation = sum(triangle_count(obj) for obj in meshes)
    material_groups = {}
    for obj in meshes:
        material_groups.setdefault(source_material_name(obj), []).append(obj)

    export_objects = []
    for material_name, objects in material_groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for obj in objects:
            obj.select_set(True)
        bpy.context.view_layer.objects.active = objects[0]
        if len(objects) > 1:
            bpy.ops.object.join()
        joined = bpy.context.view_layer.objects.active
        joined.name = f"feiyun-{tier}-{material_name}"
        joined["sourceMaterial"] = material_name
        joined["runtimeLod"] = tier
        export_objects.append(joined)

    bpy.ops.object.select_all(action="DESELECT")
    for obj in export_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = export_objects[0]
    bpy.ops.export_scene.gltf(
        filepath=output_path,
        export_format="GLB",
        use_selection=True,
        export_yup=True,
        export_apply=True,
        export_normals=True,
        export_tangents=False,
        export_materials="EXPORT",
        export_image_format="JPEG",
        export_jpeg_quality=85,
        export_meshopt_compression_enable=True,
        export_meshopt_extension="EXT_meshopt_compression",
    )

    report = {
        "schemaVersion": 1,
        "assetId": "feiyun",
        "tier": tier,
        "source": os.path.basename(source_path),
        "policy": {
            "method": "per-component quality-weighted collapse before material joining",
            "baseRatio": base_ratio,
            "microComponentProtection": True,
        },
        "textureRecovery": {
            "maxTextureSize": TEXTURE_MAX_SIZE,
            "mapping": TEXTURE_MAPPING,
            "results": texture_recovery,
        },
        "input": {"components": len(meshes), "triangles": before_triangles},
        "output": {
            "file": os.path.basename(output_path),
            "meshes": len(export_objects),
            "triangles": after_decimation,
            "effectiveRatio": round(after_decimation / before_triangles, 6),
            "protectedComponents": protected_objects,
            "failedComponents": failed_objects,
        },
    }
    with open(report_path, "w", encoding="utf-8") as handle:
        json.dump(report, handle, ensure_ascii=False, indent=2)
    print(json.dumps(report["output"], ensure_ascii=False))


if __name__ == "__main__":
    main()

