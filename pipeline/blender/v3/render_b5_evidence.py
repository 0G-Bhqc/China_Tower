#!/usr/bin/env python3
"""Render Feiyun B5 seven-view/six-channel evidence from accepted B4 Hero packs."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import sys
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


SEMANTIC_COLORS = {
    "foundation": (0.30, 0.38, 0.50, 1.0),
    "podium": (0.55, 0.62, 0.72, 1.0),
    "structural-frame/columns": (0.82, 0.16, 0.12, 1.0),
    "structural-frame/brackets-dougong": (1.00, 0.72, 0.10, 1.0),
    "facade/walls": (0.82, 0.70, 0.54, 1.0),
    "facade/doors-windows": (0.08, 0.45, 0.62, 1.0),
    "facade/railings": (0.10, 0.78, 0.68, 1.0),
    "roof-system/sheathing": (0.16, 0.54, 0.22, 1.0),
    "roof-system/tiles": (0.08, 0.30, 0.58, 1.0),
    "roof-system/eaves": (0.18, 0.58, 0.96, 1.0),
    "roof-system/ridges": (0.45, 0.26, 0.78, 1.0),
    "roof-system/ornaments-finial": (0.82, 0.18, 0.76, 1.0),
    "secondary-details": (0.42, 0.45, 0.50, 1.0),
}
CHANNELS = ("beauty", "alpha-silhouette", "semantic-id", "depth", "normal", "roughness-material-id")


@dataclass
class ViewSpec:
    name: str
    target: Vector
    position: Vector
    lens: float
    kind: str
    semantic_scope: list[str]


def arguments() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hero", required=True, action="append", type=Path)
    parser.add_argument("--semantic-glb", required=True, type=Path)
    parser.add_argument("--semantic-hierarchy", required=True, type=Path)
    parser.add_argument("--b4-manifest", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(values)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def mesh_objects() -> list[bpy.types.Object]:
    return [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.data.polygons]


def import_paths(paths: list[Path]) -> list[bpy.types.Object]:
    before = {obj.as_pointer() for obj in bpy.context.scene.objects}
    for path in paths:
        bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    return [obj for obj in mesh_objects() if obj.as_pointer() not in before]


def object_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    if not points:
        raise RuntimeError("Cannot compute empty evidence bounds")
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def make_emission_material(name: str, color: tuple[float, float, float, float]) -> bpy.types.Material:
    material = bpy.data.materials.new(name)
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Color"].default_value = color
    emission.inputs["Strength"].default_value = 1.0
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def make_depth_material() -> tuple[bpy.types.Material, bpy.types.Node]:
    material = bpy.data.materials.new("b5-depth")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    camera_data = nodes.new("ShaderNodeCameraData")
    mapping = nodes.new("ShaderNodeMapRange")
    mapping.clamp = True
    mapping.inputs["To Min"].default_value = 1.0
    mapping.inputs["To Max"].default_value = 0.0
    material.node_tree.links.new(camera_data.outputs["View Distance"], mapping.inputs["Value"])
    material.node_tree.links.new(mapping.outputs["Result"], emission.inputs["Color"])
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material, mapping


def make_normal_material() -> bpy.types.Material:
    material = bpy.data.materials.new("b5-world-normal")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    emission = nodes.new("ShaderNodeEmission")
    geometry = nodes.new("ShaderNodeNewGeometry")
    multiply = nodes.new("ShaderNodeVectorMath")
    multiply.operation = "SCALE"
    multiply.inputs[3].default_value = 0.5
    add = nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    material.node_tree.links.new(geometry.outputs["Normal"], multiply.inputs[0])
    material.node_tree.links.new(multiply.outputs["Vector"], add.inputs[0])
    material.node_tree.links.new(add.outputs["Vector"], emission.inputs["Color"])
    material.node_tree.links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def hashed_color(name: str) -> tuple[float, float, float, float]:
    digest = hashlib.sha256(name.encode("utf-8")).digest()
    return tuple(0.18 + (digest[index] / 255.0) * 0.72 for index in range(3)) + (1.0,)


def base_material_name(name: str) -> str:
    return re.sub(r"\.\d{3}$", "", name)


def area_light(name: str, position: Vector, target: Vector, energy: float, size: float) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "DISK"
    data.size = size
    data.energy = energy
    obj = bpy.data.objects.new(name, data)
    bpy.context.scene.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()


def setup_scene(bounds: tuple[Vector, Vector]) -> tuple[bpy.types.Scene, bpy.types.Object, float, Vector]:
    low, high = bounds
    centre = (low + high) / 2
    span = max(high - low) * 1.12
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 1.0
    scene.world = bpy.data.worlds.new("B5EvidenceWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.035, 0.04, 0.05, 1.0)
    background.inputs["Strength"].default_value = 0.55
    energy_scale = max(1.0, (span / 20.0) ** 2)
    area_light("B5_Key", centre + Vector((span, -span, span * 1.15)), centre, 4200 * energy_scale, span * 0.8)
    area_light("B5_Fill", centre + Vector((-span, -span * 0.25, span * 0.65)), centre, 2100 * energy_scale, span * 0.7)
    area_light("B5_Rim", centre + Vector((0, span, span)), centre, 2500 * energy_scale, span * 0.7)
    camera_data = bpy.data.cameras.new("B5EvidenceCamera")
    camera = bpy.data.objects.new("B5EvidenceCamera", camera_data)
    bpy.context.scene.collection.objects.link(camera)
    camera.data.clip_start = max(0.02, span / 2000.0)
    camera.data.clip_end = span * 24.0
    scene.camera = camera
    return scene, camera, span, centre


def full_views(bounds: tuple[Vector, Vector]) -> list[ViewSpec]:
    low, high = bounds
    centre = (low + high) / 2
    span = max(high - low) * 1.12
    definitions = [
        ("front", Vector((0.0, -1.0, 0.22)), 1.95, 56),
        ("quarter", Vector((1.0, -1.0, 0.48)), 1.95, 58),
        ("right", Vector((1.0, 0.0, 0.22)), 1.95, 56),
        ("rear", Vector((0.0, 1.0, 0.22)), 1.95, 56),
        ("left", Vector((-1.0, 0.0, 0.22)), 1.95, 56),
        ("top", Vector((0.20, -0.35, 1.0)), 2.12, 54),
    ]
    views = [
        ViewSpec(name, centre, centre + direction.normalized() * span * distance, lens, "fixed", ["building"])
        for name, direction, distance, lens in definitions
    ]
    views.append(ViewSpec(
        "low-angle",
        centre + Vector((0, 0, span * 0.08)),
        Vector((centre.x + span * 1.38, centre.y - span * 1.38, low.z + span * 0.16)),
        52,
        "fixed",
        ["building"],
    ))
    return views


def closeup_view(name: str, objects: list[bpy.types.Object], semantic_scope: list[str]) -> ViewSpec:
    low, high = object_bounds(objects)
    centre = (low + high) / 2
    span = max(max(high - low) * 1.12, 0.25)
    direction = Vector((1.0, -1.0, 0.42)).normalized()
    return ViewSpec(name, centre, centre + direction * span * 1.82, 58, "critical-closeup", semantic_scope)


def replace_materials(obj: bpy.types.Object, materials: list[bpy.types.Material]) -> None:
    obj.data.materials.clear()
    for material in materials:
        obj.data.materials.append(material)


def configure_channel(
    scene: bpy.types.Scene,
    channel: str,
    hero_objects: list[bpy.types.Object],
    semantic_objects: list[bpy.types.Object],
    hero_materials: dict[int, list[bpy.types.Material]],
    material_id_slots: dict[int, list[bpy.types.Material]],
    silhouette: bpy.types.Material,
    depth: bpy.types.Material,
    normal: bpy.types.Material,
) -> None:
    for obj in hero_objects:
        obj.hide_render = channel == "semantic-id"
        replace_materials(obj, hero_materials[obj.as_pointer()] if channel != "roughness-material-id" else material_id_slots[obj.as_pointer()])
    for obj in semantic_objects:
        obj.hide_render = channel != "semantic-id"
    scene.view_layers[0].material_override = None
    scene.render.film_transparent = channel == "alpha-silhouette"
    if channel == "alpha-silhouette":
        scene.view_layers[0].material_override = silhouette
    elif channel == "depth":
        scene.view_layers[0].material_override = depth
    elif channel == "normal":
        scene.view_layers[0].material_override = normal
    if channel in {"semantic-id", "roughness-material-id", "depth", "normal", "alpha-silhouette"}:
        scene.view_settings.view_transform = "Standard"
        scene.view_settings.look = "None"
        scene.view_settings.exposure = 0.0
    else:
        scene.view_settings.view_transform = "AgX"
        scene.view_settings.look = "AgX - Medium High Contrast"
        scene.view_settings.exposure = 1.0


def main() -> None:
    options = arguments()
    output = options.output.resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite B5 evidence directory: {output}")
    output.mkdir(parents=True, exist_ok=False)
    hierarchy_path = options.semantic_hierarchy.resolve()
    b4_manifest_path = options.b4_manifest.resolve()
    hierarchy = json.loads(hierarchy_path.read_text(encoding="utf-8"))
    b4_manifest = json.loads(b4_manifest_path.read_text(encoding="utf-8"))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    hero_paths = [path.resolve() for path in options.hero]
    hero_objects = import_paths(hero_paths)
    semantic_glb = options.semantic_glb.resolve()
    semantic_objects = import_paths([semantic_glb])
    if len(hero_objects) != 3 or len(semantic_objects) != 341:
        raise RuntimeError(f"Unexpected B5 inputs: hero={len(hero_objects)} semantic={len(semantic_objects)}")
    bounds = object_bounds(semantic_objects)
    scene, camera, model_span, _ = setup_scene(bounds)

    semantic_materials = {
        semantic: make_emission_material(f"b5-semantic-{semantic.replace('/', '-')}", color)
        for semantic, color in SEMANTIC_COLORS.items()
    }
    for obj in semantic_objects:
        semantic = obj.get("semanticNode")
        if semantic not in semantic_materials:
            raise RuntimeError(f"Missing semantic evidence material: {semantic}")
        replace_materials(obj, [semantic_materials[semantic]])

    hero_materials = {obj.as_pointer(): list(obj.data.materials) for obj in hero_objects}
    material_names = sorted({base_material_name(material.name) for materials in hero_materials.values() for material in materials if material})
    material_id_materials = {
        name: make_emission_material(f"b5-material-id-{index:02d}", hashed_color(name))
        for index, name in enumerate(material_names)
    }
    material_id_slots = {
        pointer: [material_id_materials[base_material_name(material.name)] for material in materials if material]
        for pointer, materials in hero_materials.items()
    }
    silhouette = make_emission_material("b5-alpha-silhouette", (1.0, 1.0, 1.0, 1.0))
    depth_material, depth_mapping = make_depth_material()
    normal_material = make_normal_material()

    views = full_views(bounds)
    scopes = {
        "podium": ["foundation", "podium"],
        "roof-system": [semantic for semantic in SEMANTIC_COLORS if semantic.startswith("roof-system/")],
        "roof-tiles": ["roof-system/tiles"],
        "brackets-dougong": ["structural-frame/brackets-dougong"],
    }
    for name, semantic_scope in scopes.items():
        selected = [obj for obj in semantic_objects if obj.get("semanticNode") in semantic_scope]
        views.append(closeup_view(name, selected, semantic_scope))

    images = []
    for channel in CHANNELS:
        configure_channel(
            scene, channel, hero_objects, semantic_objects, hero_materials, material_id_slots,
            silhouette, depth_material, normal_material,
        )
        channel_dir = output / channel
        channel_dir.mkdir(parents=True, exist_ok=False)
        for view in views:
            camera.location = view.position
            camera.rotation_euler = (view.target - camera.location).to_track_quat("-Z", "Y").to_euler()
            camera.data.lens = view.lens
            distance = (camera.location - view.target).length
            local_span = max(model_span if view.kind == "fixed" else distance / 1.82, 0.25)
            depth_mapping.inputs["From Min"].default_value = max(camera.data.clip_start, distance - local_span * 0.75)
            depth_mapping.inputs["From Max"].default_value = distance + local_span * 0.75
            image_path = channel_dir / f"{view.name}.png"
            scene.render.filepath = str(image_path)
            bpy.ops.render.render(write_still=True)
            images.append({
                "view": view.name,
                "viewKind": view.kind,
                "semanticScope": view.semantic_scope,
                "channel": channel,
                "file": str(image_path.relative_to(output)).replace("\\", "/"),
                "sha256": sha256(image_path),
                "bytes": image_path.stat().st_size,
                "camera": {
                    "position": [round(float(value), 6) for value in camera.location],
                    "target": [round(float(value), 6) for value in view.target],
                    "lensMm": view.lens,
                },
            })

    material_recovery = hierarchy.get("materialRecovery", [])
    manifest = {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3-b5-evidence",
        "assetId": b4_manifest["assetId"],
        "stage": "B5",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "status": "render-complete-validation-pending",
        "reviewOnly": True,
        "runtimeReplacement": False,
        "inputs": {
            "acceptedB4Manifest": {"path": str(b4_manifest_path), "sha256": sha256(b4_manifest_path)},
            "heroPacks": [{"path": str(path), "sha256": sha256(path)} for path in hero_paths],
            "semanticGlb": {"path": str(semantic_glb), "sha256": sha256(semantic_glb)},
            "semanticHierarchy": {"path": str(hierarchy_path), "sha256": sha256(hierarchy_path)},
            "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        },
        "channelContract": {
            "beauty": "accepted B4 Hero render batches with recovered source albedo",
            "alpha-silhouette": "accepted B4 Hero geometry, white emission on transparent background",
            "semantic-id": "B3 materialized semantic GLB; separate 341-node identity source aligned to the same locked bounds/cameras",
            "depth": "accepted B4 Hero geometry, deterministic camera-distance grayscale",
            "normal": "accepted B4 Hero geometry, world-space geometry normals; no fabricated normal texture",
            "roughness-material-id": "accepted B4 Hero material-slot IDs; roughness remains the independently declared source-material scalar",
        },
        "materialTruth": {
            "materials": material_recovery,
            "materialIdColors": {name: list(hashed_color(name)) for name in material_names},
            "ao": "missing-not-faked",
            "normalTexture": "missing-not-faked; source custom geometry normals used",
        },
        "fixedViews": [view.name for view in views if view.kind == "fixed"],
        "criticalCloseups": [view.name for view in views if view.kind == "critical-closeup"],
        "plaqueCloseup": {
            "status": "not-present",
            "reason": "G2 approved no independent source plaque geometry; B5 does not fabricate a closeup.",
            "images": 0,
        },
        "channels": list(CHANNELS),
        "images": images,
        "counts": {
            "fixedViews": 7,
            "criticalCloseupsRendered": 4,
            "notPresentCloseups": 1,
            "channels": 6,
            "images": len(images),
            "heroMeshNodes": len(hero_objects),
            "semanticMeshNodes": len(semantic_objects),
            "heroTriangles": sum(sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons) for obj in hero_objects),
        },
        "knownLimits": [
            "B5 validates the Phase 1 evidence pipeline; it does not claim Phase 2 source-artifact cleanup or final artistic quality.",
            "Semantic ID uses the decoupled B3/G3 identity mesh because B4 render batching intentionally keeps picking identity external.",
            "Plaque is explicit not-present and no text or board is invented.",
        ],
    }
    manifest_path = output / "run-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": manifest["status"], "images": len(images), "output": str(output)}, ensure_ascii=False))


if __name__ == "__main__":
    main()
