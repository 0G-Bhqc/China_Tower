"""Deep-inspect original FBX scenes: materials, textures, transparency, roof geometry.

Usage:
  blender --background --factory-startup --python inspect_fbx_deep.py -- <input-fbx> <report-json> <texture-dir>
"""

import json
import os
import sys

import bpy


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 3:
        raise SystemExit("expected: <input-fbx> <report-json> <texture-dir>")
    return os.path.abspath(values[0]), os.path.abspath(values[1]), os.path.abspath(values[2])


def material_report(material, texture_dir):
    record = {
        "name": material.name,
        "diffuse": [round(c, 3) for c in material.diffuse_color],
        "useNodes": bool(material.use_nodes),
        "texture": None,
        "alphaTexture": None,
        "textureResolved": False,
        "blendMode": getattr(material, "blend_method", None),
    }
    if material.use_nodes:
        tree = material.node_tree
        for link in tree.links:
            if link.to_socket.name == "Base Color" and link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                record["texture"] = os.path.basename(link.from_node.image.filepath)
                record["textureResolved"] = os.path.isfile(os.path.join(texture_dir, record["texture"]))
            if link.to_socket.name in ("Alpha",) and link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                record["alphaTexture"] = os.path.basename(link.from_node.image.filepath)
    return record


def analyze(fbx_path, report_path, texture_dir):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=fbx_path)

    materials = {}
    objects = []
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        mat = obj.data.materials[0] if obj.data.materials else None
        mat_name = mat.name if mat else "__none__"
        if mat_name not in materials:
            materials[mat_name] = material_report(mat, texture_dir) if mat else {"name": "__none__", "texture": None}
        dims = obj.dimensions
        objects.append({
            "name": obj.name,
            "material": mat_name,
            "verts": len(obj.data.vertices),
            "dims": [round(d, 2) for d in dims],
            "thinSheet": round(min(dims), 2) < 0.15 and round(max(dims), 2) > 2.0,
        })

    texture_files = sorted(os.listdir(texture_dir)) if os.path.isdir(texture_dir) else []
    report = {
        "fbx": fbx_path,
        "objectCount": len(objects),
        "materialCount": len(materials),
        "materialsWithTexture": sum(1 for m in materials.values() if m.get("texture")),
        "materialsWithAlpha": sum(1 for m in materials.values() if m.get("alphaTexture")),
        "textureDir": texture_dir,
        "textureDirFileCount": len(texture_files),
        "materials": materials,
        "thinSheetObjects": [o for o in objects if o["thinSheet"]][:40],
        "largestObjects": sorted(objects, key=lambda o: -o["verts"])[:25],
    }
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"objects={report['objectCount']} materials={report['materialCount']} "
          f"withTexture={report['materialsWithTexture']} withAlpha={report['materialsWithAlpha']} "
          f"textureDirFiles={report['textureDirFileCount']}")


analyze(*cli_args())
