#!/usr/bin/env python3
"""Render all six Feiyun material-to-atlas mappings with native repeating UVs."""

from __future__ import annotations

import argparse
import hashlib
import itertools
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

import bpy
from mathutils import Vector


MATERIALS = ("Material #26", "Material #27", "Material #28")


def args() -> argparse.Namespace:
    values = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", required=True, type=Path)
    parser.add_argument("--texture", required=True, action="append", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    return parser.parse_args(values)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def scene_bounds() -> tuple[Vector, Vector]:
    points = []
    for obj in bpy.context.scene.objects:
        if obj.type == "MESH" and obj.data.vertices:
            points.extend(obj.matrix_world @ Vector(corner) for corner in obj.bound_box)
    if not points:
        raise RuntimeError("No renderable mesh found.")
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def add_area(name: str, position: Vector, target: Vector, energy: float, size: float) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.energy = energy
    data.shape = "DISK"
    data.size = size
    light = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(light)
    light.location = position
    light.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()


def prepare_material(material, image) -> None:
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


def main() -> None:
    options = args()
    input_path = options.input.resolve()
    texture_paths = [path.resolve() for path in options.texture]
    output_path = options.output.resolve()
    if len(texture_paths) != 3 or len(set(texture_paths)) != 3:
        raise RuntimeError("Exactly three distinct --texture arguments are required.")
    if output_path.exists() and any(output_path.iterdir()):
        raise RuntimeError(f"Evidence directory is not empty: {output_path}")
    output_path.mkdir(parents=True, exist_ok=True)

    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.fbx(filepath=str(input_path), use_custom_normals=True)
    missing = [name for name in MATERIALS if bpy.data.materials.get(name) is None]
    if missing:
        raise RuntimeError(f"Missing expected FBX materials: {missing}")
    images = {path: bpy.data.images.load(str(path), check_existing=False) for path in texture_paths}

    low, high = scene_bounds()
    centre = (low + high) / 2
    span = max(high - low) * 1.16
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    if scene.world is None:
        scene.world = bpy.data.worlds.new("CandidateWorld")
    scene.world.color = (0.035, 0.04, 0.05)
    scene.view_settings.look = "AgX - Medium High Contrast"
    energy_scale = max(1.0, (span / 20.0) ** 2)
    add_area("Candidate_Key", centre + Vector((span, -span, span * 1.2)), centre, 2200 * energy_scale, span * 0.8)
    add_area("Candidate_Fill", centre + Vector((-span, -span * 0.25, span * 0.65)), centre, 1100 * energy_scale, span * 0.65)
    add_area("Candidate_Rim", centre + Vector((0, span, span)), centre, 1500 * energy_scale, span * 0.7)

    camera_data = bpy.data.cameras.new("CandidateCamera")
    camera = bpy.data.objects.new("CandidateCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    scene.camera = camera
    direction = Vector((1.0, -1.0, 0.52)).normalized()
    camera.location = centre + direction * span * 2.1
    camera.rotation_euler = (centre - camera.location).to_track_quat("-Z", "Y").to_euler()
    camera.data.type = "PERSP"
    camera.data.lens = 54

    runs = []
    for permutation in itertools.permutations(texture_paths):
        code = "".join(path.stem[-1] for path in permutation)
        mapping = {}
        for material_name, texture_path in zip(MATERIALS, permutation):
            prepare_material(bpy.data.materials[material_name], images[texture_path])
            mapping[material_name] = texture_path.name
        render_path = output_path / f"mapping-{code}-repeat.png"
        scene.render.filepath = str(render_path)
        bpy.ops.render.render(write_still=True)
        runs.append({
            "code": code,
            "mapping": mapping,
            "uvPolicy": "native coordinates with image extension REPEAT; no UV mutation",
            "render": render_path.name,
            "sha256": sha256(render_path),
        })

    manifest = {
        "schemaVersion": 1,
        "status": "candidate-render-complete-no-mapping-approved",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "inputs": {
            "fbx": {"path": str(input_path), "sha256": sha256(input_path)},
            "textures": [{"path": str(path), "sha256": sha256(path)} for path in texture_paths],
            "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        },
        "camera": {"direction": list(direction), "lensMm": camera.data.lens},
        "candidates": runs,
        "decision": None,
    }
    manifest_path = output_path / "run-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
