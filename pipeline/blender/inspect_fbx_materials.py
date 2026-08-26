"""Inspect FBX material nodes and any linked texture images after import."""

from __future__ import annotations

import json
import os
import sys

import bpy


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 1:
        raise SystemExit("expected: <input-fbx>")
    return os.path.abspath(values[0])


def main():
    fbx_path = cli_args()
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)

    result = []
    for material in bpy.data.materials:
        record = {"name": material.name, "use_nodes": material.use_nodes}
        if material.use_nodes:
            tree = material.node_tree
            images = []
            for node in tree.nodes:
                if node.type == "TEX_IMAGE" and node.image:
                    images.append({
                        "image_name": node.image.name,
                        "filepath": node.image.filepath,
                        "colorspace": node.image.colorspace_settings.name,
                    })
            record["images"] = images
            links = []
            for link in tree.links:
                links.append({
                    "from": f"{link.from_node.name}.{link.from_socket.name}",
                    "to": f"{link.to_node.name}.{link.to_socket.name}",
                })
            record["links"] = links
            bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                record["base_color_default"] = list(bsdf.inputs["Base Color"].default_value)
                record["roughness_default"] = bsdf.inputs["Roughness"].default_value
                record["metallic_default"] = bsdf.inputs["Metallic"].default_value
        result.append(record)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
