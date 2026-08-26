"""Dump material statistics for runtime GLBs: texture coverage, colors, vertex weights."""

import json
import os
import sys

import bpy


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 2:
        raise SystemExit("expected: <input-glb> <report-json>")
    return os.path.abspath(values[0]), os.path.abspath(values[1])


def analyze(glb_path, report_path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=glb_path)

    stats = {}
    for obj in bpy.data.objects:
        if obj.type != "MESH":
            continue
        material = obj.data.materials[0] if obj.data.materials else None
        name = material.name if material else "__none__"
        entry = stats.setdefault(name, {"objects": 0, "verts": 0, "hasTexture": False, "textureFile": None, "diffuse": None})
        entry["objects"] += 1
        entry["verts"] += len(obj.data.vertices)
        if not material:
            continue
        entry["diffuse"] = [round(c, 3) for c in material.diffuse_color]
        if material.use_nodes:
            tree = material.node_tree
            bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
            if bsdf:
                link = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
                if link and link.from_node.type == "TEX_IMAGE" and link.from_node.image:
                    entry["hasTexture"] = True
                    entry["textureFile"] = os.path.basename(link.from_node.image.filepath)

    total_verts = sum(e["verts"] for e in stats.values())
    textured_verts = sum(e["verts"] for e in stats.values() if e["hasTexture"])
    near_white = []
    for name, e in stats.items():
        d = e["diffuse"] or [1, 1, 1, 1]
        if not e["hasTexture"] and d[0] > 0.75 and d[1] > 0.75 and d[2] > 0.75:
            near_white.append({"name": name, "verts": e["verts"], "diffuse": d})

    report = {
        "glb": os.path.basename(glb_path),
        "materialCount": len(stats),
        "totalVerts": total_verts,
        "texturedVertShare": round(textured_verts / total_verts, 4) if total_verts else 0,
        "untexturedNearWhiteVerts": sum(n["verts"] for n in near_white),
        "materials": sorted(stats.items(), key=lambda kv: -kv[1]["verts"]),
        "nearWhitePlaceholders": sorted(near_white, key=lambda n: -n["verts"])[:20],
    }
    with open(report_path, "w", encoding="utf-8") as fh:
        json.dump(report, fh, ensure_ascii=False, indent=2)
    print(f"{report['glb']}: {report['materialCount']} materials, "
          f"textured vertex share {report['texturedVertShare']:.1%}, "
          f"near-white placeholder verts {report['untexturedNearWhiteVerts']}")


analyze(*cli_args())
