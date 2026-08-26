#!/usr/bin/env python3
"""Render a locked-camera B4 comparison: B3 reference, preview, and assembled Standard packs."""

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
    parser.add_argument("--reference", required=True, type=Path)
    parser.add_argument("--preview", required=True, type=Path)
    parser.add_argument("--standard", required=True, action="append", type=Path)
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


def load(paths: list[Path]) -> list[bpy.types.Object]:
    bpy.ops.wm.read_factory_settings(use_empty=True)
    for path in paths:
        bpy.ops.import_scene.gltf(filepath=str(path.resolve()))
    objects = mesh_objects()
    if not objects:
        raise RuntimeError("Review input contains no renderable mesh")
    return objects


def scene_bounds(objects: list[bpy.types.Object]) -> tuple[Vector, Vector]:
    points = [obj.matrix_world @ Vector(corner) for obj in objects for corner in obj.bound_box]
    low = Vector(tuple(min(point[index] for point in points) for index in range(3)))
    high = Vector(tuple(max(point[index] for point in points) for index in range(3)))
    return low, high


def area_light(name: str, position: Vector, target: Vector, energy: float, size: float) -> None:
    data = bpy.data.lights.new(name, "AREA")
    data.shape = "DISK"
    data.size = size
    data.energy = energy
    obj = bpy.data.objects.new(name, data)
    bpy.context.collection.objects.link(obj)
    obj.location = position
    obj.rotation_euler = (target - position).to_track_quat("-Z", "Y").to_euler()


def configure_scene(low: Vector, high: Vector) -> tuple[bpy.types.Scene, bpy.types.Object, float, Vector]:
    centre = (low + high) / 2
    span = max(high - low) * 1.12
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 960
    scene.render.resolution_y = 960
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.view_settings.look = "AgX - Medium High Contrast"
    scene.view_settings.exposure = 1.0
    scene.world = bpy.data.worlds.new("B4ReviewWorld")
    scene.world.use_nodes = True
    background = scene.world.node_tree.nodes.get("Background")
    background.inputs["Color"].default_value = (0.035, 0.04, 0.05, 1.0)
    background.inputs["Strength"].default_value = 0.55
    energy_scale = max(1.0, (span / 20.0) ** 2)
    area_light("B4_Key", centre + Vector((span, -span, span * 1.15)), centre, 4200 * energy_scale, span * 0.8)
    area_light("B4_Fill", centre + Vector((-span, -span * 0.25, span * 0.65)), centre, 2100 * energy_scale, span * 0.7)
    area_light("B4_Rim", centre + Vector((0, span, span)), centre, 2500 * energy_scale, span * 0.7)
    camera_data = bpy.data.cameras.new("B4ReviewCamera")
    camera = bpy.data.objects.new("B4ReviewCamera", camera_data)
    bpy.context.collection.objects.link(camera)
    camera.data.lens = 55
    camera.data.clip_start = max(0.02, span / 2000.0)
    camera.data.clip_end = span * 24.0
    scene.camera = camera
    return scene, camera, span, centre


def render_variant(label: str, paths: list[Path], output: Path, fixed_bounds: tuple[Vector, Vector]) -> dict:
    objects = load(paths)
    scene, camera, span, centre = configure_scene(*fixed_bounds)
    low, _ = fixed_bounds
    poses = {
        "quarter": {
            "position": centre + Vector((1.0, -1.0, 0.48)).normalized() * span * 1.95,
            "target": centre,
            "lens": 58,
        },
        "low-angle": {
            "position": Vector((centre.x + span * 1.38, centre.y - span * 1.38, low.z + span * 0.16)),
            "target": centre + Vector((0, 0, span * 0.08)),
            "lens": 52,
        },
    }
    images = []
    for pose_name, pose in poses.items():
        camera.location = pose["position"]
        camera.rotation_euler = (pose["target"] - camera.location).to_track_quat("-Z", "Y").to_euler()
        camera.data.lens = pose["lens"]
        image_path = output / f"{label}-{pose_name}.png"
        scene.render.filepath = str(image_path)
        bpy.ops.render.render(write_still=True)
        images.append({"view": pose_name, "file": image_path.name, "sha256": sha256(image_path)})
    stable_ids = {obj.get("runtimeStableId") for obj in objects if obj.get("runtimeStableId")}
    return {
        "label": label,
        "inputs": [{"path": str(path.resolve()), "sha256": sha256(path.resolve())} for path in paths],
        "meshNodes": len(objects),
        "triangles": sum(sum(max(len(poly.vertices) - 2, 0) for poly in obj.data.polygons) for obj in objects),
        "runtimeStableIds": len(stable_ids),
        "images": images,
    }


def main() -> None:
    options = arguments()
    output = options.output.resolve()
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite B4 visual review: {output}")
    output.mkdir(parents=True, exist_ok=False)
    reference = options.reference.resolve()
    reference_objects = load([reference])
    fixed_bounds = scene_bounds(reference_objects)
    variants = [
        render_variant("reference-highmodel", [reference], output, fixed_bounds),
        render_variant("preview-placeholder", [options.preview.resolve()], output, fixed_bounds),
        render_variant("standard-assembled", [path.resolve() for path in options.standard], output, fixed_bounds),
    ]
    manifest = {
        "schemaVersion": 1,
        "status": "comparison-complete-human-review-pending",
        "stage": "B4",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "reviewOnly": True,
        "comparison": "locked bounds, lighting, camera poses, color management, and resolution",
        "previewDisclosure": "Loading placeholder LOD; not represented as the source high model.",
        "variants": variants,
        "script": {"path": str(Path(__file__).resolve()), "sha256": sha256(Path(__file__).resolve())},
        "runtimeReplacement": False,
    }
    manifest_path = output / "run-manifest.json"
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": manifest["status"], "output": str(output), "variants": variants}, ensure_ascii=False))


if __name__ == "__main__":
    main()
