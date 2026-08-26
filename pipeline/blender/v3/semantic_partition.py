"""Create review-only semantic partitions for a verified V3 FBX.

This pass is deliberately non-destructive. It reuses the connected-component catalog from a
completed dissection run, assigns exactly one leaf hypothesis to every component, and renders
diagnostic semantic, silhouette, material-ID, and isolation views. It does not export GLB data and
does not approve any label.
"""

from __future__ import annotations

from array import array
from collections import Counter, defaultdict
from datetime import datetime, timezone
from hashlib import sha1, sha256
import colorsys
import json
import math
import os
import sys

import bpy
from mathutils import Vector


LEAF_NODES = [
    "foundation",
    "podium",
    "structural-frame/columns",
    "structural-frame/beams",
    "structural-frame/brackets-dougong",
    "facade/walls",
    "facade/doors-windows",
    "facade/railings",
    "roof-system/rafters",
    "roof-system/sheathing",
    "roof-system/tiles",
    "roof-system/eaves",
    "roof-system/ridges",
    "roof-system/ornaments-finial",
    "plaques",
    "secondary-details",
]

SEMANTIC_COLORS = {
    "foundation": (0.30, 0.38, 0.50, 1.0),
    "podium": (0.55, 0.62, 0.72, 1.0),
    "structural-frame/columns": (0.82, 0.16, 0.12, 1.0),
    "structural-frame/beams": (0.96, 0.38, 0.08, 1.0),
    "structural-frame/brackets-dougong": (1.00, 0.72, 0.10, 1.0),
    "facade/walls": (0.82, 0.70, 0.54, 1.0),
    "facade/doors-windows": (0.08, 0.45, 0.62, 1.0),
    "facade/railings": (0.10, 0.78, 0.68, 1.0),
    "roof-system/rafters": (0.40, 0.72, 0.18, 1.0),
    "roof-system/sheathing": (0.16, 0.54, 0.22, 1.0),
    "roof-system/tiles": (0.08, 0.30, 0.58, 1.0),
    "roof-system/eaves": (0.18, 0.58, 0.96, 1.0),
    "roof-system/ridges": (0.45, 0.26, 0.78, 1.0),
    "roof-system/ornaments-finial": (0.82, 0.18, 0.76, 1.0),
    "plaques": (0.98, 0.18, 0.40, 1.0),
    "secondary-details": (0.42, 0.45, 0.50, 1.0),
}

# Bands are normalized against the audited full-height bounds. They intentionally overlap only
# architectural roof volumes visible in the seven-view evidence; labels remain hypotheses.
ROOF_BANDS = (
    (0.14, 0.33),
    (0.37, 0.51),
    (0.55, 0.69),
    (0.72, 1.01),
)

DIAGNOSTIC_GROUP_IDS = (
    "facade-compound-panels",
    "facade-wide-walls",
    "facade-openings",
    "roof-slender-candidates",
    "eaves-lower-perimeter",
)


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) != 5:
        raise SystemExit("expected: <asset-id> <input-fbx> <catalog-json> <output-dir> <job-json>")
    return values[0], *(os.path.abspath(value) for value in values[1:])


def write_json(pathname, value):
    os.makedirs(os.path.dirname(pathname), exist_ok=True)
    with open(pathname, "w", encoding="utf-8") as handle:
        json.dump(value, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


def file_sha256(pathname):
    digest = sha256()
    with open(pathname, "rb") as handle:
        for chunk in iter(lambda: handle.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def stable_color(name, saturation=0.72, value=0.94):
    digest = sha1(name.encode("utf-8")).digest()
    hue = int.from_bytes(digest[:2], "big") / 65535.0
    red, green, blue = colorsys.hsv_to_rgb(hue, saturation, value)
    return (red, green, blue, 1.0)


def component_key(component):
    """Return the collision-free catalog identity used by every internal lookup."""
    return component["sourceObject"], int(component["sourceRootVertex"])


def find(parent, index):
    while parent[index] != index:
        parent[index] = parent[parent[index]]
        index = parent[index]
    return index


def union(parent, rank, left, right):
    left_root = find(parent, left)
    right_root = find(parent, right)
    if left_root == right_root:
        return
    if rank[left_root] < rank[right_root]:
        parent[left_root] = right_root
    elif rank[left_root] > rank[right_root]:
        parent[right_root] = left_root
    else:
        parent[right_root] = left_root
        rank[left_root] += 1


def make_material(name, color):
    material = bpy.data.materials.new(name=name)
    material.diffuse_color = color
    material.roughness = 1.0
    return material


def point_camera(camera, target, position):
    camera.location = position
    camera.rotation_euler = (target - camera.location).to_track_quat("-Z", "Y").to_euler()


def component_metrics(component, bounds):
    minimum = Vector(component["boundsMeters"]["minimum"])
    maximum = Vector(component["boundsMeters"]["maximum"])
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    overall_minimum = Vector(bounds["minimum"])
    overall_maximum = Vector(bounds["maximum"])
    overall = overall_maximum - overall_minimum
    height = max(float(overall.z), 1e-6)
    width = max(float(overall.x), 1e-6)
    depth = max(float(overall.y), 1e-6)
    horizontal = max(float(dimensions.x), float(dimensions.y), 1e-6)
    horizontal_min = max(min(float(dimensions.x), float(dimensions.y)), 1e-6)
    vertical = max(float(dimensions.z), 1e-6)
    center_z = (float(center.z) - float(overall_minimum.z)) / height
    bottom_z = (float(minimum.z) - float(overall_minimum.z)) / height
    top_z = (float(maximum.z) - float(overall_minimum.z)) / height
    center_x = (float(center.x) - (float(overall_minimum.x) + float(overall_maximum.x)) * 0.5) / width
    frontness = (float(center.y) - float(overall_minimum.y)) / depth
    radial = max(abs(center_x) * 2.0, abs((float(center.y) - (float(overall_minimum.y) + float(overall_maximum.y)) * 0.5) / depth) * 2.0)
    return {
        "minimum": minimum,
        "maximum": maximum,
        "dimensions": dimensions,
        "center": center,
        "horizontal": horizontal,
        "horizontalMin": horizontal_min,
        "vertical": vertical,
        "verticality": vertical / horizontal,
        "flatness": horizontal / vertical,
        "slenderness": horizontal / horizontal_min,
        "centerZ": center_z,
        "bottomZ": bottom_z,
        "topZ": top_z,
        "centerX": center_x,
        "frontness": frontness,
        "radial": radial,
        "height": height,
        "width": width,
    }


def band_membership(center_z):
    for index, (low, high) in enumerate(ROOF_BANDS):
        if low <= center_z <= high:
            return index, (center_z - low) / max(high - low, 1e-6)
    return None, None


def just_below_roof(center_z):
    return any(low - 0.055 <= center_z < low + 0.015 for low, _ in ROOF_BANDS)


def classify_component(component, bounds):
    metrics = component_metrics(component, bounds)
    dimensions = metrics["dimensions"]
    dx, dy, dz = (float(value) for value in dimensions)
    horizontal = metrics["horizontal"]
    vertical = metrics["vertical"]
    center_z = metrics["centerZ"]
    triangles = int(component["triangles"])
    source_hypotheses = {item["semanticNode"] for item in component.get("semanticHypotheses", [])}
    band_index, band_phase = band_membership(center_z)

    # The visible front plaque candidate is deliberately narrow: centered, front-facing in object
    # space, panel-like, and outside the audited roof volumes. It remains a hypothesis.
    panel_ratio = dx / max(dy, 1e-6)
    plaque_aspect = dx / max(dz, 1e-6)
    if (
        band_index is None
        and 0.20 <= center_z <= 0.78
        and abs(metrics["centerX"]) <= 0.13
        and metrics["frontness"] <= 0.43
        and 1.2 <= dx <= 7.0
        and dy <= 1.25
        and 0.25 <= dz <= 2.4
        and panel_ratio >= 1.8
        and 1.35 <= plaque_aspect <= 9.0
        and triangles >= 20
    ):
        return "plaques", 0.44, "centered front panel candidate outside roof bands"

    if metrics["topZ"] <= 0.075 and horizontal >= 2.0:
        return "foundation", 0.50, "broad component confined to the lowest 7.5% of audited height"
    if center_z <= 0.16 and (horizontal >= 1.0 or "podium" in source_hypotheses):
        return "podium", 0.49, "low component within the platform and entrance-base volume"

    # Preserve the dissection pass's small, explicit set of vertical enclosure candidates before
    # roof-band heuristics can absorb them as tiles/eaves. Generic thin panels are deliberately not
    # promoted to doors/windows without an independent opening/frame signal.
    if "facade/walls" in source_hypotheses and center_z <= 0.79 and vertical >= 1.0 and horizontal >= 0.20:
        return "facade/walls", 0.38, "vertical enclosure candidate retained from the audited dissection pass"

    if center_z >= 0.82 and metrics["verticality"] >= 0.8 and horizontal <= 4.0:
        return "roof-system/ornaments-finial", 0.43, "upper narrow component in the terminal roof volume"

    if just_below_roof(center_z) and 0.08 <= horizontal <= 2.4 and vertical <= 2.2 and triangles >= 12:
        return "structural-frame/brackets-dougong", 0.39, "small-to-medium component in an under-eave height band"

    if band_index is not None:
        if "roof-system/eaves" in source_hypotheses and horizontal >= 0.40:
            return "roof-system/eaves", 0.46, "audited eave hypothesis retained ahead of generic roof-surface rules"
        if "roof-system/ornaments-finial" in source_hypotheses and band_phase >= 0.45 and horizontal <= 4.0:
            return "roof-system/ornaments-finial", 0.39, "audited ornament candidate in the upper half of a roof band"
        if metrics["slenderness"] >= 4.5 and horizontal >= 0.75 and band_phase >= 0.45:
            return "roof-system/ridges", 0.40, "long narrow component in the upper half of a roof band"
        if horizontal >= 3.0 and metrics["flatness"] >= 2.4 and triangles >= 160:
            return "roof-system/sheathing", 0.40, "large flat connected shell inside a roof band"
        if metrics["flatness"] >= 3.5 and horizontal >= 0.8 and (band_phase <= 0.55 or metrics["radial"] >= 0.36):
            return "roof-system/eaves", 0.42, "flat overhanging component in the lower/perimeter roof volume"
        if "roof-system/tiles" in source_hypotheses or (metrics["flatness"] >= 1.35 and triangles >= 16):
            return "roof-system/tiles", 0.41, "surface component inside an audited roof height band"
        # Geometry-only slender fragments did not form a readable rafter field in review-016.
        # Keep them unresolved until a repetition/material signal can distinguish real rafters.

    if ("structural-frame/columns" in source_hypotheses or metrics["verticality"] >= 2.6) and vertical >= 0.40 and horizontal <= 2.2:
        return "structural-frame/columns", 0.45, "vertically slender component outside roof surfaces"
    if ("structural-frame/beams" in source_hypotheses or metrics["flatness"] >= 4.5) and horizontal >= 0.45 and vertical <= 1.4:
        return "structural-frame/beams", 0.41, "horizontally slender component outside roof surfaces"

    near_storey_edge = min(abs(center_z - value) for value in (0.18, 0.35, 0.53, 0.71)) <= 0.025
    if near_storey_edge and 0.12 <= vertical <= 1.5 and horizontal <= 2.2 and metrics["radial"] >= 0.22:
        return "facade/railings", 0.33, "small perimeter component near an occupied-storey edge"

    return "secondary-details", 0.20, "unresolved component retained without semantic promotion"


def compute_surface_stats(mesh_objects, roots_by_object, catalog_by_source_root):
    """Accumulate world-space polygon area by normal orientation for each catalog component."""
    stats = defaultdict(lambda: {"area": 0.0, "verticalArea": 0.0, "roofArea": 0.0, "polygons": 0})
    for obj in mesh_objects:
        parent = roots_by_object[obj.name]
        normal_matrix = obj.matrix_world.to_3x3()
        for polygon in obj.data.polygons:
            root = find(parent, polygon.vertices[0])
            component = catalog_by_source_root.get((obj.name, int(root)))
            if component is None:
                continue
            area = float(polygon.area)
            if area <= 0.0:
                continue
            normal = normal_matrix @ polygon.normal
            if normal.length_squared == 0.0:
                continue
            normal.normalize()
            vertical_weight = max(0.0, 1.0 - abs(float(normal.z)) / 0.35)
            roof_weight = max(0.0, (abs(float(normal.z)) - 0.45) / 0.55)
            entry = stats[component_key(component)]
            entry["area"] += area
            entry["verticalArea"] += area * vertical_weight
            entry["roofArea"] += area * roof_weight
            entry["polygons"] += 1
    for entry in stats.values():
        area = entry["area"]
        entry["verticalFraction"] = entry["verticalArea"] / area if area else 0.0
        entry["roofFraction"] = entry["roofArea"] / area if area else 0.0
    return stats


def refine_assignments_with_surface_stats(components, assignments, surface_stats, bounds):
    """Apply conservative normal-based corrections after the FBX mesh is available."""
    for component in components:
        key = component_key(component)
        stats = surface_stats.get(key)
        if not stats or stats["area"] <= 0.0:
            continue
        metrics = component_metrics(component, bounds)
        center_z = metrics["centerZ"]
        vertical_fraction = stats["verticalFraction"]
        roof_fraction = stats["roofFraction"]
        source_hypotheses = {item["semanticNode"] for item in component.get("semanticHypotheses", [])}
        current = assignments[key]["semanticNode"]
        triangles = int(component["triangles"])

        # A dissection wall hypothesis with predominantly vertical surface area outranks a
        # roof-band guess. Keep the height bound so small base/ground fragments are untouched.
        if (
            "facade/walls" in source_hypotheses
            and 0.16 <= center_z <= 0.79
            and vertical_fraction >= 0.45
            and roof_fraction <= 0.72
        ):
            assignments[key] = {
                "semanticNode": "facade/walls",
                "status": "hypothesis",
                "confidence": 0.43,
                "reason": "vertical surface-area evidence supports the audited wall hypothesis",
            }
            continue

        # Recover only broad, high-area vertical enclosure candidates from the unresolved remainder;
        # narrow vertical members are already handled by the column rule and remain untouched.
        if (
            current == "secondary-details"
            and 0.18 <= center_z <= 0.79
            and vertical_fraction >= 0.72
            and roof_fraction <= 0.45
            and metrics["horizontal"] >= 1.2
            and metrics["vertical"] >= 0.55
            and triangles >= 240
        ):
            assignments[key] = {
                "semanticNode": "facade/walls",
                "status": "hypothesis",
                "confidence": 0.36,
                "reason": "broad vertical surface-area candidate recovered from secondary details",
            }


def apply_compound_semantic_refinement(components, assignments, surface_stats, bounds):
    """Apply the visually reviewed review-019 compound findings conservatively.

    The old wall, beam, and plaque guesses were rejected in review-019. Wall and opening leaves are
    reconstructed from the readable compound facade field; unresolvable beams remain in the
    secondary leaf, and false plaque candidates return to roof ornaments. Empty beam/rafter/plaque
    leaves may only become not-present through a separate manifest-bound review decision.
    """
    for component in components:
        key = component_key(component)
        current = assignments[key]["semanticNode"]
        if current == "structural-frame/beams":
            assignments[key] = {
                "semanticNode": "secondary-details",
                "status": "hypothesis",
                "confidence": 0.28,
                "reason": "review-019 rejected the sparse beam guess; no independent beam field was recoverable",
            }
        elif current == "facade/walls":
            assignments[key] = {
                "semanticNode": "secondary-details",
                "status": "hypothesis",
                "confidence": 0.24,
                "reason": "review-019 rejected the previous fragmented wall assignment before compound reconstruction",
            }
        elif current == "plaques":
            assignments[key] = {
                "semanticNode": "roof-system/ornaments-finial",
                "status": "hypothesis",
                "confidence": 0.48,
                "reason": "review-019 four-angle evidence identifies the former plaque guess as roof-animal ornament geometry",
            }

    for component in components:
        key = component_key(component)
        if assignments[key]["semanticNode"] != "secondary-details":
            continue
        stats = surface_stats.get(key)
        if not stats or stats["area"] <= 0.0:
            continue
        metrics = component_metrics(component, bounds)
        triangles = int(component["triangles"])
        vertical_fraction = stats["verticalFraction"]
        roof_fraction = stats["roofFraction"]
        facade_volume = (
            0.16 <= metrics["centerZ"] <= 0.81
            and metrics["radial"] >= 0.18
            and metrics["vertical"] >= 0.10
            and metrics["horizontal"] >= 0.06
            and vertical_fraction >= 0.24
            and roof_fraction <= 0.68
            and triangles >= 4
        )
        if not facade_volume:
            continue
        opening_like = (
            metrics["radial"] >= 0.22
            and 0.20 <= metrics["vertical"] <= 4.20
            and 0.05 <= metrics["horizontal"] <= 2.60
            and vertical_fraction >= 0.34
            and roof_fraction <= 0.38
            and triangles >= 8
        )
        if opening_like:
            assignments[key] = {
                "semanticNode": "facade/doors-windows",
                "status": "hypothesis",
                "confidence": 0.48,
                "reason": "review-019 compound evidence forms a repeated readable door/window-frame field by storey and side",
            }
        else:
            assignments[key] = {
                "semanticNode": "facade/walls",
                "status": "hypothesis",
                "confidence": 0.44,
                "reason": "review-019 compound evidence recovers the residual vertical enclosure field after opening extraction",
            }


def primary_material(component):
    materials = component.get("materials", [])
    if not materials:
        return "__unassigned__"
    return max(materials, key=lambda item: int(item.get("polygons", 0))).get("name", "__unassigned__")


def diagnostic_side(metrics, bounds):
    minimum = Vector(bounds["minimum"])
    maximum = Vector(bounds["maximum"])
    center = metrics["center"]
    width = max(float(maximum.x - minimum.x), 1e-6)
    depth = max(float(maximum.y - minimum.y), 1e-6)
    normalized_x = (float(center.x) - float((minimum.x + maximum.x) * 0.5)) / width
    normalized_y = (float(center.y) - float((minimum.y + maximum.y) * 0.5)) / depth
    if abs(normalized_x) >= abs(normalized_y):
        return "east" if normalized_x >= 0.0 else "west"
    return "rear" if normalized_y >= 0.0 else "front"


def build_diagnostic_groups(components, assignments, surface_stats, bounds):
    """Build review-only compound candidates without promoting semantic assignments.

    The source FBX is highly disconnected, so a wall, opening frame, or rafter field can span many
    tiny components. These overlapping groups deliberately preserve that ambiguity and expose it
    for visual review instead of pretending that a single-component heuristic solved the leaf.
    """
    groups = {group_id: [] for group_id in DIAGNOSTIC_GROUP_IDS}
    candidate_records = {group_id: [] for group_id in DIAGNOSTIC_GROUP_IDS}
    storey_levels = (0.20, 0.40, 0.60, 0.76)

    def add(group_id, component, metrics, stats, reason):
        groups[group_id].append(component)
        candidate_records[group_id].append({
            "componentId": component["id"],
            "sourceObject": component["sourceObject"],
            "sourceRootVertex": component["sourceRootVertex"],
            "triangles": int(component["triangles"]),
            "centerZNormalized": round(metrics["centerZ"], 5),
            "side": diagnostic_side(metrics, bounds),
            "storeyBand": min(range(len(storey_levels)), key=lambda index: abs(metrics["centerZ"] - storey_levels[index])),
            "material": primary_material(component),
            "verticalAreaFraction": round(stats["verticalFraction"], 4),
            "roofAreaFraction": round(stats["roofFraction"], 4),
            "reason": reason,
        })

    for component in components:
        key = component_key(component)
        stats = surface_stats.get(key)
        if not stats or stats["area"] <= 0.0:
            continue
        metrics = component_metrics(component, bounds)
        current = assignments[key]["semanticNode"]
        triangles = int(component["triangles"])
        vertical_fraction = stats["verticalFraction"]
        roof_fraction = stats["roofFraction"]
        band_index, band_phase = band_membership(metrics["centerZ"])
        facade_remainder = current in {
            "secondary-details", "facade/walls", "facade/doors-windows", "facade/railings"
        }

        if (
            facade_remainder
            and 0.16 <= metrics["centerZ"] <= 0.81
            and metrics["radial"] >= 0.18
            and metrics["vertical"] >= 0.10
            and metrics["horizontal"] >= 0.06
            and vertical_fraction >= 0.24
            and roof_fraction <= 0.68
            and triangles >= 4
        ):
            add(
                "facade-compound-panels",
                component,
                metrics,
                stats,
                "perimeter vertical-surface remainder grouped by storey, side, and source material",
            )

        if (
            current in {"secondary-details", "facade/walls"}
            and 0.16 <= metrics["centerZ"] <= 0.81
            and metrics["radial"] >= 0.16
            and metrics["vertical"] >= 0.40
            and metrics["horizontal"] >= 0.55
            and vertical_fraction >= 0.58
            and roof_fraction <= 0.42
            and triangles >= 80
        ):
            add(
                "facade-wide-walls",
                component,
                metrics,
                stats,
                "broad predominantly vertical enclosure candidate recovered across disconnected source parts",
            )

        if (
            current in {"secondary-details", "facade/doors-windows", "facade/railings"}
            and 0.16 <= metrics["centerZ"] <= 0.81
            and metrics["radial"] >= 0.22
            and 0.20 <= metrics["vertical"] <= 4.20
            and 0.05 <= metrics["horizontal"] <= 2.60
            and vertical_fraction >= 0.34
            and roof_fraction <= 0.38
            and triangles >= 8
        ):
            add(
                "facade-openings",
                component,
                metrics,
                stats,
                "small vertical/frame-like perimeter remainder; aggregate may reveal doors or windows",
            )

        if (
            band_index is not None
            and current in {"secondary-details", "roof-system/tiles", "roof-system/eaves", "roof-system/ridges"}
            and metrics["horizontal"] >= 0.35
            and metrics["vertical"] <= 1.80
            and metrics["slenderness"] >= 4.0
            and triangles >= 8
        ):
            add(
                "roof-slender-candidates",
                component,
                metrics,
                stats,
                "elongated component inside an audited roof band; repetition and placement require review",
            )

        if (
            band_index is not None
            and current in {"secondary-details", "roof-system/tiles", "roof-system/eaves", "structural-frame/beams"}
            and (band_phase <= 0.42 or metrics["radial"] >= 0.52)
            and metrics["horizontal"] >= 0.50
            and metrics["flatness"] >= 1.80
            and roof_fraction >= 0.22
            and triangles >= 12
        ):
            add(
                "eaves-lower-perimeter",
                component,
                metrics,
                stats,
                "flat component in the lower or perimeter portion of a roof band",
            )

    report = {
        "schemaVersion": 1,
        "assetId": None,
        "automaticLabelsAreApproved": False,
        "method": "overlapping compound review groups using world-space normals, bounds, storey bands, perimeter side, and source material",
        "groups": {},
    }
    for group_id in DIAGNOSTIC_GROUP_IDS:
        records = candidate_records[group_id]
        clusters = defaultdict(lambda: {"components": 0, "triangles": 0})
        for record in records:
            cluster_id = f"storey-{record['storeyBand']}/{record['side']}/{record['material']}"
            clusters[cluster_id]["components"] += 1
            clusters[cluster_id]["triangles"] += record["triangles"]
        report["groups"][group_id] = {
            "status": "diagnostic-hypothesis",
            "componentCount": len(records),
            "triangles": sum(record["triangles"] for record in records),
            "clusterCount": len(clusters),
            "clusters": dict(sorted(clusters.items())),
            "candidates": records,
        }
    subgroups = {}
    for group_id in ("facade-compound-panels", "facade-openings"):
        for component in groups[group_id]:
            metrics = component_metrics(component, bounds)
            storey = min(range(len(storey_levels)), key=lambda index: abs(metrics["centerZ"] - storey_levels[index]))
            side = diagnostic_side(metrics, bounds)
            subgroup_id = f"{group_id}--storey-{storey}--{side}"
            entry = subgroups.setdefault(subgroup_id, {"parent": group_id, "side": side, "components": []})
            entry["components"].append(component)
    for group_id in ("roof-slender-candidates", "eaves-lower-perimeter"):
        for component in groups[group_id]:
            metrics = component_metrics(component, bounds)
            band_index, _ = band_membership(metrics["centerZ"])
            subgroup_id = f"{group_id}--roof-band-{band_index}"
            entry = subgroups.setdefault(subgroup_id, {"parent": group_id, "side": "elevated", "components": []})
            entry["components"].append(component)
    report["subgroups"] = {
        subgroup_id: {
            "parent": entry["parent"],
            "viewSide": entry["side"],
            "componentCount": len(entry["components"]),
            "triangles": sum(int(component["triangles"]) for component in entry["components"]),
        }
        for subgroup_id, entry in sorted(subgroups.items())
    }
    return groups, subgroups, report


def create_camera(scene, bounds):
    bpy.ops.object.camera_add()
    camera = bpy.context.object
    camera.name = "v3-semantic-review-camera"
    camera.data.lens = 52
    minimum = Vector(bounds["minimum"])
    maximum = Vector(bounds["maximum"])
    dimensions = maximum - minimum
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 1.0)
    camera.data.clip_start = max(0.02, span / 2000.0)
    camera.data.clip_end = span * 24.0
    scene.camera = camera
    return camera


def configure_scene():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.render.resolution_x = 720
    scene.render.resolution_y = 720
    scene.render.resolution_percentage = 100
    scene.render.image_settings.file_format = "PNG"
    scene.render.film_transparent = False
    scene.display.shading.light = "FLAT"
    scene.display.shading.color_type = "MATERIAL"
    scene.display.shading.show_shadows = False
    scene.display.shading.show_cavity = False
    scene.display.shading.background_type = "WORLD"
    scene.display.shading.background_color = (0.018, 0.024, 0.034)
    for look in ("AgX - Medium High Contrast", "Medium High Contrast", "None"):
        try:
            scene.view_settings.look = look
            break
        except TypeError:
            continue
    return scene


def full_view_poses(bounds):
    minimum = Vector(bounds["minimum"])
    maximum = Vector(bounds["maximum"])
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 1.0)
    distance = span * 1.62
    directions = {
        "front": Vector((0.0, -1.0, 0.2)),
        "three-quarter": Vector((0.78, -0.78, 0.42)),
        "right": Vector((1.0, 0.0, 0.2)),
        "rear": Vector((0.0, 1.0, 0.2)),
        "left": Vector((-1.0, 0.0, 0.2)),
        "elevated": Vector((0.72, -0.72, 0.92)),
    }
    poses = {}
    for view_id, direction in directions.items():
        poses[view_id] = (center, center + direction.normalized() * distance)
    eye_height = min(max(float(dimensions.z) * 0.065, 1.2), 2.2)
    low_target = Vector((center.x, center.y, minimum.z + dimensions.z * 0.58))
    horizontal = Vector((0.72, -1.0, 0.0)).normalized()
    low_position = Vector((center.x, center.y, minimum.z + eye_height)) + horizontal * (distance * 0.72)
    poses["low-angle"] = (low_target, low_position)
    return poses


def append_material_set(objects, prefix, colors):
    materials = {key: make_material(f"{prefix}-{key.replace('/', '-')}", color) for key, color in colors.items()}
    slots = {}
    for obj in objects:
        slots[obj.name] = {}
        for key, material in materials.items():
            obj.data.materials.append(material)
            slots[obj.name][key] = len(obj.data.materials) - 1
    return slots


def render_full_views(scene, camera, poses, output_dir, pass_id):
    pass_dir = os.path.join(output_dir, "renders", pass_id)
    os.makedirs(pass_dir, exist_ok=True)
    outputs = []
    for view_id, (target, position) in poses.items():
        point_camera(camera, target, position)
        pathname = os.path.join(pass_dir, f"{view_id}.png")
        scene.render.filepath = pathname
        bpy.ops.render.render(write_still=True)
        outputs.append({"pass": pass_id, "view": view_id, "file": os.path.relpath(pathname, output_dir).replace("\\", "/")})
    return outputs


def render_compositor_pass(scene, camera, poses, output_dir, pass_id, layer_output, color_mode):
    """Render a normalized Eevee render-layer pass (Z or camera-space normal)."""
    scene.render.engine = "BLENDER_EEVEE"
    tree = scene.compositing_node_group
    if tree is None:
        tree = bpy.data.node_groups.new(f"v3-{pass_id}-compositor", "CompositorNodeTree")
        scene.compositing_node_group = tree
    tree.nodes.clear()
    if layer_output == "Depth":
        scene.view_layers[0].use_pass_z = True
    elif layer_output == "Normal":
        scene.view_layers[0].use_pass_normal = True
    scene.view_layers[0].update_render_passes()
    render_layers = tree.nodes.new("CompositorNodeRLayers")
    normalize = tree.nodes.new("CompositorNodeNormalize")
    viewer = tree.nodes.new("CompositorNodeViewer")
    layer_socket = render_layers.outputs.get(layer_output)
    if layer_socket is None:
        raise RuntimeError(f"Blender render layer does not expose {layer_output} pass")
    tree.links.new(layer_socket, normalize.inputs["Value"])
    tree.links.new(normalize.outputs["Value"], viewer.inputs[0])
    pass_dir = os.path.join(output_dir, "renders", pass_id)
    os.makedirs(pass_dir, exist_ok=True)
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = color_mode
    outputs = []
    for view_id, (target, position) in poses.items():
        point_camera(camera, target, position)
        pathname = os.path.join(pass_dir, f"{view_id}.png")
        scene.render.filepath = pathname
        bpy.ops.render.render(write_still=False)
        viewer_image = bpy.data.images.get("Viewer Node")
        if viewer_image is None:
            raise RuntimeError(f"Compositor viewer output missing for {pass_id}/{view_id}")
        viewer_image.save_render(filepath=pathname, scene=scene)
        outputs.append({"pass": pass_id, "view": view_id, "file": os.path.relpath(pathname, output_dir).replace("\\", "/")})
    return outputs


def make_normal_evidence_material():
    material = bpy.data.materials.new("v3-normal-evidence")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    geometry = nodes.new("ShaderNodeNewGeometry")
    scale = nodes.new("ShaderNodeVectorMath")
    scale.operation = "SCALE"
    scale.inputs["Scale"].default_value = 0.5
    offset = nodes.new("ShaderNodeVectorMath")
    offset.operation = "ADD"
    offset.inputs[1].default_value = (0.5, 0.5, 0.5)
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(geometry.outputs["Normal"], scale.inputs[0])
    links.new(scale.outputs["Vector"], offset.inputs[0])
    links.new(offset.outputs["Vector"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material


def make_depth_evidence_material(camera):
    material = bpy.data.materials.new("v3-depth-evidence")
    material.use_nodes = True
    nodes = material.node_tree.nodes
    links = material.node_tree.links
    nodes.clear()
    camera_data = nodes.new("ShaderNodeCameraData")
    mapping = nodes.new("ShaderNodeMapRange")
    mapping.clamp = True
    mapping.inputs["From Min"].default_value = float(camera.data.clip_start)
    mapping.inputs["From Max"].default_value = float(camera.data.clip_end)
    mapping.inputs["To Min"].default_value = 1.0
    mapping.inputs["To Max"].default_value = 0.0
    emission = nodes.new("ShaderNodeEmission")
    emission.inputs["Strength"].default_value = 1.0
    output = nodes.new("ShaderNodeOutputMaterial")
    links.new(camera_data.outputs["View Distance"], mapping.inputs["Value"])
    links.new(mapping.outputs["Result"], emission.inputs["Color"])
    links.new(emission.outputs["Emission"], output.inputs["Surface"])
    return material, mapping


def render_material_evidence(scene, camera, poses, output_dir, pass_id, mesh_objects, material, configure_view=None):
    """Render evidence with a temporary node material, preserving original slots and indices."""
    scene.render.engine = "BLENDER_EEVEE"
    scene.compositing_node_group = None
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.render.film_transparent = False
    saved = []
    for obj in mesh_objects:
        saved_indices = [polygon.material_index for polygon in obj.data.polygons]
        obj.data.materials.append(material)
        evidence_index = len(obj.data.materials) - 1
        for polygon in obj.data.polygons:
            polygon.material_index = evidence_index
        saved.append((obj, saved_indices))
    try:
        pass_dir = os.path.join(output_dir, "renders", pass_id)
        os.makedirs(pass_dir, exist_ok=True)
        outputs = []
        for view_id, (target, position) in poses.items():
            point_camera(camera, target, position)
            if configure_view is not None:
                configure_view(view_id, target, position)
            pathname = os.path.join(pass_dir, f"{view_id}.png")
            scene.render.filepath = pathname
            bpy.ops.render.render(write_still=True)
            outputs.append({"pass": pass_id, "view": view_id, "file": os.path.relpath(pathname, output_dir).replace("\\", "/")})
        return outputs
    finally:
        for obj, saved_indices in saved:
            for polygon, index in zip(obj.data.polygons, saved_indices):
                polygon.material_index = index
            obj.data.materials.pop(index=len(obj.data.materials) - 1)


def render_depth_views(scene, camera, poses, output_dir, mesh_objects):
    """Render normalized camera-depth evidence without changing source geometry."""
    material, mapping = make_depth_evidence_material(camera)
    model_span = float(camera.data.clip_end) / 24.0

    def configure_view(_view_id, target, position):
        view_distance = float((target - position).length)
        mapping.inputs["From Min"].default_value = max(float(camera.data.clip_start), view_distance - model_span * 0.72)
        mapping.inputs["From Max"].default_value = view_distance + model_span * 0.72

    return render_material_evidence(scene, camera, poses, output_dir, "depth", mesh_objects, material, configure_view)


def render_normal_views(scene, camera, poses, output_dir, mesh_objects):
    """Render normalized camera-space normal evidence from the admitted high-model meshes."""
    return render_material_evidence(scene, camera, poses, output_dir, "normal", mesh_objects, make_normal_evidence_material())


def component_bounds(components):
    minimum = Vector((math.inf, math.inf, math.inf))
    maximum = Vector((-math.inf, -math.inf, -math.inf))
    for component in components:
        candidate_min = Vector(component["boundsMeters"]["minimum"])
        candidate_max = Vector(component["boundsMeters"]["maximum"])
        for index in range(3):
            minimum[index] = min(minimum[index], candidate_min[index])
            maximum[index] = max(maximum[index], candidate_max[index])
    return minimum, maximum


def render_isolation(scene, camera, output_dir, target_id, target_nodes, components, assignments):
    selected = [component for component in components if assignments[component_key(component)]["semanticNode"] in target_nodes]
    if not selected:
        return {"target": target_id, "status": "missing", "file": None, "componentCount": 0, "triangles": 0}
    minimum, maximum = component_bounds(selected)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 0.75)
    direction = Vector((0.0, -1.0, 0.15))
    if target_id in {"roof", "tiles"}:
        direction = Vector((0.65, -0.75, 0.68))
    elif target_id in {"podium", "brackets-dougong"}:
        direction = Vector((0.52, -0.85, 0.30))
    point_camera(camera, center, center + direction.normalized() * span * 1.75)
    isolation_dir = os.path.join(output_dir, "renders", "isolation")
    os.makedirs(isolation_dir, exist_ok=True)
    pathname = os.path.join(isolation_dir, f"{target_id}.png")
    scene.render.filepath = pathname
    bpy.ops.render.render(write_still=True)
    return {
        "target": target_id,
        "status": "hypothesis",
        "file": os.path.relpath(pathname, output_dir).replace("\\", "/"),
        "componentCount": len(selected),
        "triangles": sum(int(component["triangles"]) for component in selected),
        "boundsMeters": {"minimum": [round(float(v), 5) for v in minimum], "maximum": [round(float(v), 5) for v in maximum]},
    }


def render_leaf_isolation(scene, camera, output_dir, semantic_node, components, assignments):
    """Render one review-only isolation image for a single semantic leaf."""
    selected = [component for component in components if assignments[component_key(component)]["semanticNode"] == semantic_node]
    if not selected:
        return {"target": semantic_node, "status": "missing", "file": None, "componentCount": 0, "triangles": 0}
    minimum, maximum = component_bounds(selected)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 0.75)
    direction = Vector((0.0, -1.0, 0.20))
    if semantic_node.startswith("roof-system/"):
        direction = Vector((0.65, -0.75, 0.68))
    elif semantic_node in {"foundation", "podium", "structural-frame/brackets-dougong"}:
        direction = Vector((0.52, -0.85, 0.30))
    point_camera(camera, center, center + direction.normalized() * span * 1.75)
    isolation_dir = os.path.join(output_dir, "renders", "isolation-leaves")
    os.makedirs(isolation_dir, exist_ok=True)
    slug = semantic_node.replace("/", "-")
    pathname = os.path.join(isolation_dir, f"{slug}.png")
    scene.render.filepath = pathname
    bpy.ops.render.render(write_still=True)
    return {
        "target": semantic_node,
        "status": "hypothesis",
        "file": os.path.relpath(pathname, output_dir).replace("\\", "/"),
        "componentCount": len(selected),
        "triangles": sum(int(component["triangles"]) for component in selected),
        "boundsMeters": {"minimum": [round(float(v), 5) for v in minimum], "maximum": [round(float(v), 5) for v in maximum]},
    }


def render_leaf_targeted_views(scene, camera, output_dir, semantic_node, components, assignments):
    """Render four review-only angles for a semantic leaf with a tight fitted camera."""
    selected = [component for component in components if assignments[component_key(component)]["semanticNode"] == semantic_node]
    if not selected:
        return []
    minimum, maximum = component_bounds(selected)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 0.75)
    views = {
        "front": Vector((0.0, -1.0, 0.08)),
        "side": Vector((1.0, -0.30, 0.18)),
        "elevated": Vector((0.45, -0.72, 0.82)),
        "low-angle": Vector((0.32, -0.92, -0.16)),
    }
    targeted_dir = os.path.join(output_dir, "renders", "isolation-targeted", semantic_node.replace("/", "-"))
    os.makedirs(targeted_dir, exist_ok=True)
    outputs = []
    for view_id, direction in views.items():
        point_camera(camera, center, center + direction.normalized() * span * 1.70)
        pathname = os.path.join(targeted_dir, f"{view_id}.png")
        scene.render.filepath = pathname
        bpy.ops.render.render(write_still=True)
        outputs.append({
            "target": semantic_node,
            "view": view_id,
            "status": "hypothesis",
            "file": os.path.relpath(pathname, output_dir).replace("\\", "/"),
            "componentCount": len(selected),
            "triangles": sum(int(component["triangles"]) for component in selected),
            "boundsMeters": {"minimum": [round(float(v), 5) for v in minimum], "maximum": [round(float(v), 5) for v in maximum]},
        })
    return outputs


def render_diagnostic_targeted_views(scene, camera, output_dir, target_id, selected):
    """Render four tight views for an overlapping compound diagnostic selection."""
    if not selected:
        return []
    minimum, maximum = component_bounds(selected)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 0.75)
    views = {
        "front": Vector((0.0, -1.0, 0.08)),
        "side": Vector((1.0, -0.30, 0.18)),
        "elevated": Vector((0.45, -0.72, 0.82)),
        "low-angle": Vector((0.32, -0.92, -0.16)),
    }
    targeted_dir = os.path.join(output_dir, "renders", "diagnostic-targeted", target_id)
    os.makedirs(targeted_dir, exist_ok=True)
    outputs = []
    triangles = sum(int(component["triangles"]) for component in selected)
    bounds_record = {
        "minimum": [round(float(value), 5) for value in minimum],
        "maximum": [round(float(value), 5) for value in maximum],
    }
    for view_id, direction in views.items():
        point_camera(camera, center, center + direction.normalized() * span * 1.70)
        pathname = os.path.join(targeted_dir, f"{view_id}.png")
        scene.render.filepath = pathname
        bpy.ops.render.render(write_still=True)
        outputs.append({
            "target": target_id,
            "view": view_id,
            "status": "diagnostic-hypothesis",
            "file": os.path.relpath(pathname, output_dir).replace("\\", "/"),
            "componentCount": len(selected),
            "triangles": triangles,
            "boundsMeters": bounds_record,
        })
    return outputs


def render_diagnostic_subgroup(scene, camera, output_dir, subgroup_id, side, selected):
    """Render one side-aligned tight image for a storey/side or roof-band subgroup."""
    if not selected:
        return None
    minimum, maximum = component_bounds(selected)
    dimensions = maximum - minimum
    center = (minimum + maximum) * 0.5
    span = max(float(dimensions.x), float(dimensions.y), float(dimensions.z), 0.50)
    directions = {
        "front": Vector((0.0, -1.0, 0.06)),
        "rear": Vector((0.0, 1.0, 0.06)),
        "east": Vector((1.0, 0.0, 0.06)),
        "west": Vector((-1.0, 0.0, 0.06)),
        "elevated": Vector((0.48, -0.72, 0.82)),
    }
    point_camera(camera, center, center + directions[side].normalized() * span * 1.72)
    subgroup_dir = os.path.join(output_dir, "renders", "diagnostic-subgroups")
    os.makedirs(subgroup_dir, exist_ok=True)
    pathname = os.path.join(subgroup_dir, f"{subgroup_id}.png")
    scene.render.filepath = pathname
    bpy.ops.render.render(write_still=True)
    return {
        "target": subgroup_id,
        "view": side,
        "status": "diagnostic-hypothesis",
        "file": os.path.relpath(pathname, output_dir).replace("\\", "/"),
        "componentCount": len(selected),
        "triangles": sum(int(component["triangles"]) for component in selected),
        "boundsMeters": {
            "minimum": [round(float(value), 5) for value in minimum],
            "maximum": [round(float(value), 5) for value in maximum],
        },
    }


def main():
    asset_id, fbx_path, catalog_path, output_dir, job_path = cli_args()
    if os.path.exists(output_dir):
        raise RuntimeError(f"Output directory already exists: {output_dir}")
    os.makedirs(output_dir, exist_ok=False)

    with open(job_path, encoding="utf-8-sig") as handle:
        job = json.load(handle)
    with open(catalog_path, encoding="utf-8-sig") as handle:
        catalog = json.load(handle)
    if job.get("assetId") != asset_id or catalog.get("assetId") != asset_id:
        raise RuntimeError("V3 job/catalog identity mismatch")

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    object_map_path = os.path.join(os.path.dirname(fbx_path), "object-map.json")
    with open(object_map_path, encoding="utf-8-sig") as handle:
        object_map = json.load(handle)
    source_mesh_names = {
        entry["name"]
        for entry in object_map.get("objects", [])
        if entry.get("class") not in {"Missing_GeomObject", "Missing_Light"}
    }
    mesh_objects = sorted(
        [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and len(obj.data.polygons) > 0 and obj.name in source_mesh_names],
        key=lambda obj: obj.name,
    )
    if not mesh_objects:
        raise RuntimeError("Verified FBX contains no admitted mesh geometry")

    assignments = {}
    summary = defaultdict(lambda: {"components": 0, "triangles": 0, "confidenceTotal": 0.0})
    for component in catalog["components"]:
        semantic_node, confidence, reason = classify_component(component, catalog["boundsMeters"])
        assignments[component_key(component)] = {"semanticNode": semantic_node, "status": "hypothesis", "confidence": confidence, "reason": reason}
        entry = summary[semantic_node]
        entry["components"] += 1
        entry["triangles"] += int(component["triangles"])
        entry["confidenceTotal"] += confidence

    catalog_by_source_root = {
        (component["sourceObject"], int(component["sourceRootVertex"])): component
        for component in catalog["components"]
    }
    roots_by_object = {}
    source_material_names = {}
    for obj in mesh_objects:
        mesh = obj.data
        parent = array("I", range(len(mesh.vertices)))
        rank = bytearray(len(mesh.vertices))
        for edge in mesh.edges:
            union(parent, rank, edge.vertices[0], edge.vertices[1])
        roots_by_object[obj.name] = parent
        source_material_names[obj.name] = [material.name if material else "__unassigned__" for material in mesh.materials]

    surface_stats = compute_surface_stats(mesh_objects, roots_by_object, catalog_by_source_root)
    refine_assignments_with_surface_stats(catalog["components"], assignments, surface_stats, catalog["boundsMeters"])
    apply_compound_semantic_refinement(catalog["components"], assignments, surface_stats, catalog["boundsMeters"])
    diagnostic_groups, diagnostic_subgroups, diagnostic_report = build_diagnostic_groups(
        catalog["components"], assignments, surface_stats, catalog["boundsMeters"]
    )
    diagnostic_report["assetId"] = asset_id
    summary = defaultdict(lambda: {"components": 0, "triangles": 0, "confidenceTotal": 0.0, "surfaceArea": 0.0, "verticalArea": 0.0, "roofArea": 0.0})
    for component in catalog["components"]:
        assignment = assignments[component_key(component)]
        entry = summary[assignment["semanticNode"]]
        entry["components"] += 1
        entry["triangles"] += int(component["triangles"])
        entry["confidenceTotal"] += float(assignment["confidence"])
        stats = surface_stats.get(component_key(component))
        if stats:
            entry["surfaceArea"] += stats["area"]
            entry["verticalArea"] += stats["verticalArea"]
            entry["roofArea"] += stats["roofArea"]

    scene = configure_scene()
    camera = create_camera(scene, catalog["boundsMeters"])
    poses = full_view_poses(catalog["boundsMeters"])
    semantic_slots = append_material_set(mesh_objects, "v3-semantic", SEMANTIC_COLORS)
    white_slots = append_material_set(mesh_objects, "v3-silhouette", {"white": (1.0, 1.0, 1.0, 1.0)})
    ghost_slots = append_material_set(mesh_objects, "v3-isolation", {"target": (0.05, 0.92, 1.0, 1.0), "ghost": (0.025, 0.035, 0.05, 1.0)})
    source_names = sorted({name for names in source_material_names.values() for name in names} | {"__unassigned__"})
    material_id_slots = append_material_set(mesh_objects, "v3-material-id", {name: stable_color(name, 0.62, 0.95) for name in source_names})

    polygon_records = {}
    missing_roots = Counter()
    for obj in mesh_objects:
        records = []
        parent = roots_by_object[obj.name]
        original_names = source_material_names[obj.name]
        for polygon in obj.data.polygons:
            root = find(parent, polygon.vertices[0])
            component = catalog_by_source_root.get((obj.name, int(root)))
            if component is None:
                missing_roots[obj.name] += 1
                semantic_node = "secondary-details"
                component_id = None
            else:
                component_id = component_key(component)
                semantic_node = assignments[component_id]["semanticNode"]
            source_material = original_names[polygon.material_index] if polygon.material_index < len(original_names) else "__unassigned__"
            records.append((polygon, component_id, semantic_node, source_material))
        polygon_records[obj.name] = records

    render_index = []
    for obj in mesh_objects:
        for polygon, _, semantic_node, _ in polygon_records[obj.name]:
            polygon.material_index = semantic_slots[obj.name][semantic_node]
    render_index.extend(render_full_views(scene, camera, poses, output_dir, "semantic-id"))

    scene.display.shading.background_color = (0.0, 0.0, 0.0)
    for obj in mesh_objects:
        for polygon, _, _, _ in polygon_records[obj.name]:
            polygon.material_index = white_slots[obj.name]["white"]
    render_index.extend(render_full_views(scene, camera, poses, output_dir, "alpha-silhouette"))

    scene.display.shading.background_color = (0.018, 0.024, 0.034)
    for obj in mesh_objects:
        for polygon, _, _, source_material in polygon_records[obj.name]:
            polygon.material_index = material_id_slots[obj.name][source_material]
    render_index.extend(render_full_views(scene, camera, poses, output_dir, "roughness-material-id"))

    isolation_targets = {
        "podium": {"foundation", "podium"},
        "roof": {node for node in LEAF_NODES if node.startswith("roof-system/")},
        "tiles": {"roof-system/tiles"},
        "brackets-dougong": {"structural-frame/brackets-dougong"},
        "plaque": {"plaques"},
    }
    isolation_index = []
    targeted_leaf_index = []
    targeted_diagnostic_index = []
    diagnostic_subgroup_index = []
    for target_id, target_nodes in isolation_targets.items():
        for obj in mesh_objects:
            for polygon, component_id, semantic_node, _ in polygon_records[obj.name]:
                is_target = component_id is not None and semantic_node in target_nodes
                polygon.material_index = ghost_slots[obj.name]["target" if is_target else "ghost"]
        isolation_index.append(render_isolation(scene, camera, output_dir, target_id, target_nodes, catalog["components"], assignments))

    for semantic_node in LEAF_NODES:
        for obj in mesh_objects:
            for polygon, component_id, component_semantic_node, _ in polygon_records[obj.name]:
                is_target = component_id is not None and component_semantic_node == semantic_node
                polygon.material_index = ghost_slots[obj.name]["target" if is_target else "ghost"]
        isolation_index.append(render_leaf_isolation(scene, camera, output_dir, semantic_node, catalog["components"], assignments))
        targeted_leaf_index.extend(render_leaf_targeted_views(scene, camera, output_dir, semantic_node, catalog["components"], assignments))

    for target_id in DIAGNOSTIC_GROUP_IDS:
        selected = diagnostic_groups[target_id]
        selected_keys = {component_key(component) for component in selected}
        for obj in mesh_objects:
            for polygon, component_id, _, _ in polygon_records[obj.name]:
                polygon.material_index = ghost_slots[obj.name]["target" if component_id in selected_keys else "ghost"]
        targeted_diagnostic_index.extend(
            render_diagnostic_targeted_views(scene, camera, output_dir, target_id, selected)
        )

    for subgroup_id, entry in sorted(diagnostic_subgroups.items()):
        selected = entry["components"]
        selected_keys = {component_key(component) for component in selected}
        for obj in mesh_objects:
            for polygon, component_id, _, _ in polygon_records[obj.name]:
                polygon.material_index = ghost_slots[obj.name]["target" if component_id in selected_keys else "ghost"]
        rendered = render_diagnostic_subgroup(
            scene, camera, output_dir, subgroup_id, entry["side"], selected
        )
        if rendered is not None:
            diagnostic_subgroup_index.append(rendered)

    render_index.extend(render_normal_views(scene, camera, poses, output_dir, mesh_objects))
    render_index.extend(render_depth_views(scene, camera, poses, output_dir, mesh_objects))

    semantic_summary = {}
    for node in LEAF_NODES:
        entry = summary[node]
        semantic_summary[node] = {
            "status": "hypothesis",
            "componentCount": entry["components"],
            "triangles": entry["triangles"],
            "meanConfidence": round(entry["confidenceTotal"] / max(entry["components"], 1), 3),
            "reviewDecision": None,
            "surfaceArea": round(entry["surfaceArea"], 5),
            "verticalAreaFraction": round(entry["verticalArea"] / max(entry["surfaceArea"], 1e-9), 4),
            "roofAreaFraction": round(entry["roofArea"] / max(entry["surfaceArea"], 1e-9), 4),
        }
    total_assigned_triangles = sum(entry["triangles"] for entry in semantic_summary.values())
    issues = []
    if missing_roots:
        issues.append({"severity": "blocking", "code": "catalog-root-mismatch", "objects": dict(missing_roots)})
    if total_assigned_triangles != int(catalog["triangles"]):
        issues.append({"severity": "blocking", "code": "assigned-triangle-mismatch", "expected": int(catalog["triangles"]), "observed": total_assigned_triangles})
    for node in LEAF_NODES:
        if semantic_summary[node]["componentCount"] == 0:
            issues.append({"severity": "review", "code": "empty-semantic-hypothesis", "node": node})

    assignment_records = [
        {
            "componentId": component["id"],
            "sourceObject": component["sourceObject"],
            "sourceRootVertex": component["sourceRootVertex"],
            "triangles": component["triangles"],
            **assignments[component_key(component)],
        }
        for component in catalog["components"]
    ]
    write_json(os.path.join(output_dir, "semantic-partition.json"), {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3",
        "assetId": asset_id,
        "automaticLabelsAreApproved": False,
        "method": {
            "type": "exclusive spatial/material/shape/height-band hypothesis partition with surface-normal evidence",
            "roofBandsNormalized": [list(item) for item in ROOF_BANDS],
            "surfaceNormalEvidence": "world-space polygon area fractions; vertical and roof-slope signals are conservative disambiguation evidence, not semantic approval",
            "limitation": "geometry/material/normal partition; semantic-ID and isolation review are required before approval",
            "repetitionEvidence": "not used; run-003 proved exact repetition unavailable and tolerant matches were micro-fragment false positives",
        },
        "summary": semantic_summary,
        "assignments": assignment_records,
    })
    write_json(os.path.join(output_dir, "diagnostic-candidates.json"), diagnostic_report)
    write_json(os.path.join(output_dir, "issues.json"), {"schemaVersion": 1, "assetId": asset_id, "issues": issues})
    write_json(os.path.join(output_dir, "run-manifest.json"), {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3-semantic-partition",
        "assetId": asset_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "blenderVersion": bpy.app.version_string,
        "input": {
            "file": fbx_path,
            "sha256": file_sha256(fbx_path),
            "catalog": catalog_path,
            "catalogSha256": file_sha256(catalog_path),
            "job": job_path,
            "jobSha256": file_sha256(job_path),
        },
        "integrity": {
            "sourceMeshes": len(mesh_objects),
            "components": len(catalog["components"]),
            "expectedTriangles": int(catalog["triangles"]),
            "assignedTriangles": total_assigned_triangles,
            "passed": not any(issue["severity"] == "blocking" for issue in issues),
        },
        "outputs": {
            "semanticPartition": "semantic-partition.json",
            "diagnosticCandidates": "diagnostic-candidates.json",
            "issues": "issues.json",
            "renders": render_index,
            "isolations": isolation_index,
            "targetedLeafIsolations": targeted_leaf_index,
            "targetedDiagnosticIsolations": targeted_diagnostic_index,
            "diagnosticSubgroupIsolations": diagnostic_subgroup_index,
        },
        "reviewState": "needs-human-semantic-review",
        "reviewPassCoverage": {
            "complete": ["alpha-silhouette"],
            "diagnosticOnly": ["semantic-id", "depth", "normal", "roughness-material-id", "isolation"],
            "pending": [],
        },
        "nextAction": "Review compound facade and roof diagnostic groups, then record approved, rejected, or explicit not-present decisions for every mandatory semantic leaf before any GLB export.",
    })
    print(json.dumps({
        "assetId": asset_id,
        "components": len(catalog["components"]),
        "triangles": total_assigned_triangles,
        "integrityPassed": not any(issue["severity"] == "blocking" for issue in issues),
        "semanticNodes": {node: {"components": value["componentCount"], "triangles": value["triangles"]} for node, value in semantic_summary.items()},
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
