"""Diagnose texture loss: import FBX, step through repair stages, count textured materials."""

import os
import sys

import bpy


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1:]
    if len(values) != 2:
        raise SystemExit("expected: <input-fbx> <texture-dir>")
    return os.path.abspath(values[0]), os.path.abspath(values[1])


def textured(material):
    if not material.use_nodes:
        return False
    tree = material.node_tree
    bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
    if not bsdf:
        return False
    link = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
    return bool(link and link.from_node.type == "TEX_IMAGE" and link.from_node.image)


def stats(label):
    mats = list(bpy.data.materials)
    names = {}
    for m in mats:
        names.setdefault(m.name, []).append(m)
    dupes = {k: len(v) for k, v in names.items() if len(v) > 1}
    used = {m.name for obj in bpy.data.objects if obj.type == "MESH" for m in obj.data.materials if m}
    used_textured = sum(1 for obj in bpy.data.objects if obj.type == "MESH" for m in obj.data.materials if m and textured(m))
    print(f"[{label}] materials={len(mats)} textured={sum(1 for m in mats if textured(m))} "
          f"dupNames={dupes} usedNames={len(used)} usedTexturedSlots={used_textured}")


def repair(texture_dir):
    available = {name.lower(): name for name in os.listdir(texture_dir)}
    recovered = skipped_no_match = skipped_no_link = 0
    for material in bpy.data.materials:
        if not material.use_nodes:
            continue
        tree = material.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        link = next((l for l in tree.links if l.to_node == bsdf and l.to_socket.name == "Base Color"), None)
        if not link or link.from_node.type != "TEX_IMAGE":
            skipped_no_link += 1
            continue
        image_node = link.from_node
        image = image_node.image
        expected = os.path.basename(image.filepath) if image else ""
        if not expected or "." not in expected:
            skipped_no_link += 1
            continue
        actual = available.get(expected.lower())
        if not actual:
            stem = os.path.splitext(expected)[0].lower()
            for lower_name, real_name in available.items():
                if os.path.splitext(lower_name)[0] == stem:
                    actual = real_name
                    break
        if not actual:
            skipped_no_match += 1
            print(f"  NO MATCH: {material.name} -> {expected}")
            continue
        resolved = os.path.join(texture_dir, actual)
        if image and image.filepath == resolved:
            recovered += 1
            continue
        if image:
            bpy.data.images.remove(image)
        image_node.image = bpy.data.images.load(resolved, check_existing=False)
        recovered += 1
    print(f"recovered={recovered} skippedNoLink={skipped_no_link} skippedNoMatch={skipped_no_match}")


fbx_path, texture_dir = cli_args()
bpy.ops.wm.read_factory_settings(use_empty=True)
bpy.ops.import_scene.fbx(filepath=fbx_path)
stats("after-import")
repair(texture_dir)
stats("after-repair")
