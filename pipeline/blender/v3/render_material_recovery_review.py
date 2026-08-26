#!/usr/bin/env python3
"""Render reference, neutral, and grazing evidence for a recovered review GLB."""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


def arguments() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--force-clamp", action="store_true", help="Reproduce the historical UV clamp failure for comparison.")
    return parser.parse_args(values)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def bounds() -> tuple[Vector, Vector]:
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.data.vertices:
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def area_light(name: str, position: Vector, target: Vector, energy: float, size: float):
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "DISK"
    data.size = size
    data.energy = energy
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()
    return obj


def main() -> None:
    options = arguments()
    input_path = options.input.resolve()
    output_path = options.output.resolve()
    if output_path.exists() and any(output_path.iterdir()):
        raise RuntimeError(f"Evidence directory is not empty: {output_path}")
    output_path.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=str(input_path))
    if options.force_clamp:
        for material in bpy.data.materials:
            if material.use_nodes and material.node_tree:
                for node in material.node_tree.nodes:
                    if node.type == "TEX_IMAGE":
                        node.extension = "EXTEND"
    low, high = bounds()
    centre = (low + high) / 2
    span = max(high - low) * 1.12
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 1100
    scene.render.resolution_y = 1100
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 1.15
    scene.world = bpy.data.worlds.new("ReviewWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.035, 0.04, 0.05, 1.0)
    background.inputs["Strength"].default_value = 0.55

    energy_scale = max(1.0, (span / 20.0) ** 2)
    key = area_light("Review_Key", centre + Vector((span, -span, span * 1.15)), centre, 4200 * energy_scale, span * 0.8)
    fill = area_light("Review_Fill", centre + Vector((-span, -span * 0.25, span * 0.65)), centre, 2200 * energy_scale, span * 0.7)
    rim = area_light("Review_Rim", centre + Vector((0, span, span)), centre, 2600 * energy_scale, span * 0.7)

    camera_data = bpy.data.cameras.new("ReviewCamera")
    camera = bpy.data.objects.new("ReviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    direction = Vector((1.0, -1.0, 0.48)).normalized()
    camera.location = centre + direction * span * 1.95
    camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.lens = 58

    neutral = bpy.data.materials.new("review-neutral-clay")
    neutral.diffuse_color = (0.46, 0.50, 0.56, 1.0)
    neutral.roughness = 0.7
    variants = []

    reference_path = output_path / ("reference-clamp-failure.png" if options.force_clamp else "reference.png")
    scene.view_layers[0].material_override = None
    scene.render.filepath = str(reference_path)
    bpy.ops.render.render(write_still=True)
    variants.append({"name": "reference", "path": reference_path.name, "sha256": sha256(reference_path), "material": "recovered-source-albedo"})

    neutral_path = output_path / "neutral.png"
    scene.view_layers[0].material_override = neutral
    scene.render.filepath = str(neutral_path)
    bpy.ops.render.render(write_still=True)
    variants.append({"name": "neutral", "path": neutral_path.name, "sha256": sha256(neutral_path), "material": "neutral-clay-override"})

    key.location = centre + Vector((span * 1.2, -span * 0.2, span * 0.12))
    key.rotation_euler = (centre - key.location).to_track_quat("-Z", "Y").to_euler()
    key.data.energy = 5200 * energy_scale
    fill.data.energy = 180 * energy_scale
    rim.data.energy = 320 * energy_scale
    scene.view_settings.exposure = 0.65
    grazing_path = output_path / "grazing.png"
    scene.render.filepath = str(grazing_path)
    bpy.ops.render.render(write_still=True)
    variants.append({"name": "grazing", "path": grazing_path.name, "sha256": sha256(grazing_path), "material": "neutral-clay-override"})

    manifest = {
        "schemaVersion": 1,
        "status": "review-renders-complete-no-artistic-approval",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "reviewOnly": True,
        "forcedClampFailure": options.force_clamp,
        "input": {"path": str(input_path), "sha256": sha256(input_path)},
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        "camera": {"direction": list(direction), "lensMm": camera.data.lens},
        "variants": variants,
        "runtimeReplacement": False,
    }
    (output_path / "run-manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
