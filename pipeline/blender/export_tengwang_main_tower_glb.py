"""Export the admitted Tengwang Pavilion high-model core as a WebGL-ready GLB.

The source Max scene is never opened.  Geometry comes only from the verified
FBX conversion, is split into loose parts for exclusion of context geometry,
then joined by source material to retain detail with a practical draw-call
count.  The selection contract records every decision used by the export.
"""

from __future__ import annotations

import json
import os
import sys

import bpy
from mathutils import Vector


def _parse_excluded():
    raw = os.environ.get("TENGWANG_EXCLUDED_OBJECTS", "")
    if raw:
        return set(name.strip() for name in raw.split(",") if name.strip())
    # The previous default excluded the podium (157, 172) and right-side
    # pavilion access (193), which caused the missing base and courtyard gap.
    # The relaxed core envelope now keeps context geometry out, so default to
    # keeping all group members.
    return set()


EXCLUDED_SOURCE_OBJECTS = _parse_excluded()


def _parse_envelope():
    env = os.environ.get("TENGWANG_CORE_ENVELOPE")
    if env:
        parts = [float(p.strip()) for p in env.split(",")]
        if len(parts) == 4:
            return {"x": (parts[0], parts[1]), "y": (parts[2], parts[3])}
    # Relaxed default: the old (-180,-75)x(-35,90) window dropped the podium
    # and the right-side pavilion. Expand to include both while still rejecting
    # the largest terrain/background meshes seen in the 4642 m source bounds.
    return {
        "x": (-220.0, -30.0),
        "y": (-90.0, 150.0),
    }


def _parse_separate_loose():
    env = os.environ.get("TENGWANG_SEPARATE_LOOSE", "")
    return env.lower() not in {"0", "false", "no", ""} if env else True


def _parse_max_object_span():
    env = os.environ.get("TENGWANG_MAX_OBJECT_SPAN_METERS")
    if env:
        return float(env)
    # The source scene contains a single 4,642 m context mesh. Reject any
    # object whose bounding box exceeds this span so the envelope can be
    # relaxed enough to keep side pavilions without swallowing the terrain.
    return 500.0


CORE_ENVELOPE_METERS = _parse_envelope()
SEPARATE_LOOSE = _parse_separate_loose()
MAX_OBJECT_SPAN_METERS = _parse_max_object_span()


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 5:
        raise SystemExit("expected: <input-fbx> <group-json> <group-id> <output-glb> <report-json>")
    return (
        os.path.abspath(values[0]),
        os.path.abspath(values[1]),
        values[2],
        os.path.abspath(values[3]),
        os.path.abspath(values[4]),
    )


def world_bounds(obj):
    points = [obj.matrix_world @ Vector(corner) for corner in obj.bound_box]
    minimum = Vector((min(point.x for point in points), min(point.y for point in points), min(point.z for point in points)))
    maximum = Vector((max(point.x for point in points), max(point.y for point in points), max(point.z for point in points)))
    return minimum, maximum


def material_name(obj):
    material = obj.data.materials[0] if obj.data.materials else None
    return material.name if material else "__unassigned__"


def material_record(material):
    diffuse = list(material.diffuse_color)
    record = {
        "name": material.name,
        "diffuseColor": [round(channel, 5) for channel in diffuse],
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
    env = os.environ.get("TENGWANG_TEXTURE_DIR")
    if env:
        return env
    return os.path.abspath("3D资产/滕王阁")


def _repair_material_textures(texture_dir: str):
    """Relink FBX texture nodes to the actual on-disk source images.

    CRITICAL: never remove existing image datablocks.  The FBX importer shares
    one image block between every material referencing the same file, so
    removing it silently unlinks all other materials and destroys their
    textures.  Load the resolved path with check_existing and assign instead.
    """
    if not os.path.isdir(texture_dir):
        print(f"WARNING: Tengwang texture directory not found: {texture_dir}")
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
    print(f"Recovered {recovered} Tengwang base-color textures from {texture_dir}")


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
    print(f"Forced {changed} Tengwang materials opaque")


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
    print(f"Neutralized metalness on {changed} Tengwang materials")


def _fix_placeholder_materials(texture_dir: str):
    """Attach the delivered roof sheet to the black placeholder roof material.

    "Material #25" is pure black with no texture and carries the largest roof
    meshes in this scene too; the delivery folder ships a dedicated Chinese
    tile sheet (屋顶贴图.tga) for exactly these roofs.
    """
    fixes = 0
    for material in bpy.data.materials:
        if material.name != "Material #25" or not material.use_nodes:
            continue
        tree = material.node_tree
        bsdf = next((n for n in tree.nodes if n.type == "BSDF_PRINCIPLED"), None)
        if not bsdf:
            continue
        tile = os.path.join(texture_dir, "屋顶贴图.tga")
        if not os.path.isfile(tile):
            print(f"WARNING: Tengwang roof sheet missing: {tile}")
            continue
        image = bpy.data.images.load(tile, check_existing=True)
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
        fixes += 1
    print(f"Repaired {fixes} placeholder Tengwang materials")


def main():
    fbx_path, group_path, group_id, output_glb, report_path = cli_args()
    with open(group_path, encoding="utf-8") as handle:
        contract = json.load(handle)
    if group_id == "__all__":
        group = {"id": "__all__", "members": []}
    else:
        # Comma-separated ids export the union of several curated groups, e.g.
        # "tower-core-with-base,upper-roof-stack,tower-detail-shell" for the
        # complete main tower including podium and side pavilions.
        wanted = [part.strip() for part in group_id.split(",") if part.strip()]
        members = []
        found = []
        for item in contract["groups"]:
            if item["id"] in wanted:
                found.append(item["id"])
                members.extend(item["members"])
        missing_groups = [gid for gid in wanted if gid not in found]
        if missing_groups:
            raise RuntimeError(f"group ids not found: {missing_groups}")
        group = {"id": group_id, "members": members}
    os.makedirs(os.path.dirname(output_glb), exist_ok=True)
    os.makedirs(os.path.dirname(report_path), exist_ok=True)

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    _force_opaque_materials()
    _neutralize_metalness()
    _repair_material_textures(_parse_texture_dir())
    _fix_placeholder_materials(_parse_texture_dir())
    mesh_by_name = {obj.name: obj for obj in bpy.context.scene.objects if obj.type == "MESH"}
    if group_id == "__all__":
        source_objects = list(mesh_by_name.values())
        source_names = set(mesh_by_name.keys())
        missing = []
    else:
        source_objects = [mesh_by_name[name] for name in group["members"] if name in mesh_by_name]
        missing = [name for name in group["members"] if name not in mesh_by_name]
        if missing:
            print(f"WARNING: {len(missing)} group members missing from FBX: {missing[:10]}")
        source_names = set(group["members"])
    if not source_objects:
        raise RuntimeError("No source objects were found after FBX import")

    for obj in source_objects:
        obj["sourceObject"] = obj.name
    if SEPARATE_LOOSE:
        for obj in source_objects:
            bpy.ops.object.select_all(action="DESELECT")
            obj.select_set(True)
            bpy.context.view_layer.objects.active = obj
            bpy.ops.object.mode_set(mode="EDIT")
            bpy.ops.mesh.separate(type="LOOSE")
            bpy.ops.object.mode_set(mode="OBJECT")
    admitted = []
    rejected = {"excludedSource": 0, "outsideCoreEnvelope": 0, "oversized": 0, "empty": 0}
    for obj in list(bpy.context.scene.objects):
        if obj.type != "MESH" or obj.get("sourceObject") not in source_names:
            continue
        if len(obj.data.polygons) == 0:
            rejected["empty"] += 1
            continue
        source = obj.get("sourceObject")
        if source in EXCLUDED_SOURCE_OBJECTS:
            rejected["excludedSource"] += 1
            continue
        minimum, maximum = world_bounds(obj)
        center = (minimum + maximum) * 0.5
        span = maximum - minimum
        if span.x > MAX_OBJECT_SPAN_METERS or span.y > MAX_OBJECT_SPAN_METERS or span.z > MAX_OBJECT_SPAN_METERS:
            rejected["oversized"] += 1
            continue
        if not (CORE_ENVELOPE_METERS["x"][0] <= center.x <= CORE_ENVELOPE_METERS["x"][1] and CORE_ENVELOPE_METERS["y"][0] <= center.y <= CORE_ENVELOPE_METERS["y"][1]):
            rejected["outsideCoreEnvelope"] += 1
            continue
        admitted.append(obj)
    if not admitted:
        raise RuntimeError("Admission filter removed every loose component")

    admitted_set = set(admitted)
    for obj in list(bpy.context.scene.objects):
        if obj.type == "MESH" and obj not in admitted_set:
            bpy.data.objects.remove(obj, do_unlink=True)

    # Coalesce only equal-material loose parts, retaining every triangle while
    # reducing 2,800-plus transient component objects to a browser-safe layer.
    material_groups = {}
    for obj in admitted:
        if obj.name not in bpy.data.objects:
            continue
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
        joined.name = f"tengwang-main-tower-{material}"
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
    )

    materials = []
    seen_materials = set()
    for obj in export_objects:
        for material in obj.data.materials:
            if material and material.name not in seen_materials:
                seen_materials.add(material.name)
                materials.append(material_record(material))
    minimum, maximum = world_bounds(export_objects[0])
    for obj in export_objects[1:]:
        obj_minimum, obj_maximum = world_bounds(obj)
        minimum.x, minimum.y, minimum.z = min(minimum.x, obj_minimum.x), min(minimum.y, obj_minimum.y), min(minimum.z, obj_minimum.z)
        maximum.x, maximum.y, maximum.z = max(maximum.x, obj_maximum.x), max(maximum.y, obj_maximum.y), max(maximum.z, obj_maximum.z)
    report = {
        "schemaVersion": 1,
        "assetId": "tengwang",
        "source": os.path.basename(fbx_path),
        "groupId": group_id,
        "admission": {
            "method": "loose-part dissection + core spatial envelope" if SEPARATE_LOOSE else "whole-object bounds + core spatial envelope",
            "coreEnvelopeMeters": CORE_ENVELOPE_METERS,
            "maxObjectSpanMeters": MAX_OBJECT_SPAN_METERS,
            "separateLoose": SEPARATE_LOOSE,
            "excludedSourceObjects": sorted(EXCLUDED_SOURCE_OBJECTS),
            "sourceMemberCount": len(source_objects),
            "missingSourceMembers": missing,
            "admittedComponents": len(admitted),
            "rejectedComponents": rejected,
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
