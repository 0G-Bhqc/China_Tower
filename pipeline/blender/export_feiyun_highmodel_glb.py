"""Export the verified complete Feiyun Tower high model as a Meshopt GLB.

Only the isolated, verified FBX enters this exporter. Geometry is preserved in
full; equal-material source meshes are joined merely to reduce draw calls, then
Meshopt compresses the vertex streams without replacing the architecture with a
procedural approximation.
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
    return {"name": material.name, "diffuseColor": [round(value, 5) for value in material.diffuse_color], "usesNodes": bool(material.use_nodes)}


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
    fbx_path, output_glb, report_path = cli_args()
    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)

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

    admitted = [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.data.vertices and obj.data.polygons]
    if not admitted:
        raise RuntimeError("The safe FBX has no Feiyun architectural mesh geometry")

    material_groups = {}
    for obj in admitted:
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
        joined.name = f"feiyun-highmodel-{material}"
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
        export_image_format="JPEG",
        export_jpeg_quality=85,
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
        "assetId": "feiyun",
        "source": os.path.basename(fbx_path),
        "admission": {"method": "whole-building high-model admission after Blender inspection", "admittedComponents": len(admitted)},
        "textureRecovery": {
            "maxTextureSize": TEXTURE_MAX_SIZE,
            "mapping": TEXTURE_MAPPING,
            "results": texture_recovery,
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
