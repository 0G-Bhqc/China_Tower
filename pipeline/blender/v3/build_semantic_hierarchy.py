"""Build an immutable review-only semantic GLB hierarchy from an approved V3 partition.

The output is not a production runtime replacement. Geometry is grouped by source object and
approved semantic leaf, preserving a queryable source -> Blender -> semantic -> GLB -> stable ID
chain while avoiding one mesh per connected component.
"""

from __future__ import annotations

from array import array
from collections import defaultdict
from datetime import datetime, timezone
from hashlib import sha256
import json
import os
import sys

import bpy
from mathutils import Vector


PARENT_BY_LEAF = {
    "foundation": "building",
    "podium": "building",
    "structural-frame/columns": "structural-frame",
    "structural-frame/beams": "structural-frame",
    "structural-frame/brackets-dougong": "structural-frame",
    "facade/walls": "facade",
    "facade/doors-windows": "facade",
    "facade/railings": "facade",
    "roof-system/rafters": "roof-system",
    "roof-system/sheathing": "roof-system",
    "roof-system/tiles": "roof-system",
    "roof-system/eaves": "roof-system",
    "roof-system/ridges": "roof-system",
    "roof-system/ornaments-finial": "roof-system",
    "plaques": "building",
    "secondary-details": "building",
}

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


def cli_args():
    marker = sys.argv.index("--") if "--" in sys.argv else len(sys.argv)
    values = sys.argv[marker + 1 :]
    if len(values) not in {7, 8}:
        raise SystemExit(
            "expected: <asset-id> <input-fbx> <catalog-json> <partition-json> "
            "<g2-decisions-json> <output-dir> <job-json> [material-recovery-json]"
        )
    asset_id = values[0]
    required = [os.path.abspath(value) for value in values[1:7]]
    material_config = os.path.abspath(values[7]) if len(values) == 8 else None
    return asset_id, *required, material_config


def read_json(pathname):
    with open(pathname, encoding="utf-8-sig") as handle:
        return json.load(handle)


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


def composite_key(source_object, source_root_vertex):
    return source_object, int(source_root_vertex)


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


def stable_id(asset_id, semantic_node, source_hash=None):
    if source_hash is None:
        return f"{asset_id}/semantic/{semantic_node}"
    return f"{asset_id}/part/{semantic_node}/src-{source_hash[:12]}"


def glb_name(asset_id, semantic_node, source_hash=None):
    semantic_slug = semantic_node.replace("/", "__")
    if source_hash is None:
        return f"{asset_id}__semantic__{semantic_slug}"
    return f"{asset_id}__part__{semantic_slug}__src-{source_hash[:12]}"


def aggregate_bounds(components):
    if not components:
        return None
    minimum = Vector((float("inf"), float("inf"), float("inf")))
    maximum = Vector((-float("inf"), -float("inf"), -float("inf")))
    for component in components:
        candidate_min = component["boundsMeters"]["minimum"]
        candidate_max = component["boundsMeters"]["maximum"]
        for index in range(3):
            minimum[index] = min(minimum[index], float(candidate_min[index]))
            maximum[index] = max(maximum[index], float(candidate_max[index]))
    return {
        "minimum": [round(float(value), 5) for value in minimum],
        "maximum": [round(float(value), 5) for value in maximum],
        "dimensions": [round(float(maximum[index] - minimum[index]), 5) for index in range(3)],
    }


def matrix_values(matrix):
    return [round(float(matrix[row][column]), 9) for row in range(4) for column in range(4)]


def build_mesh(name, source_object, polygons):
    vertex_map = {}
    coordinates = array("f")
    loop_vertices = array("I")
    loop_starts = array("I")
    loop_totals = array("I")
    uv_coordinates = array("f")
    custom_normals = []
    smooth_flags = array("b")
    source_uv = source_object.data.uv_layers.active
    source_corner_normals = getattr(source_object.data, "corner_normals", None)
    triangles = 0
    for polygon in polygons:
        loop_starts.append(len(loop_vertices))
        loop_totals.append(len(polygon.vertices))
        smooth_flags.append(bool(polygon.use_smooth))
        triangles += max(len(polygon.vertices) - 2, 0)
        for source_loop_index in polygon.loop_indices:
            source_vertex_index = source_object.data.loops[source_loop_index].vertex_index
            target_index = vertex_map.get(int(source_vertex_index))
            if target_index is None:
                target_index = len(vertex_map)
                vertex_map[int(source_vertex_index)] = target_index
                coordinate = source_object.data.vertices[source_vertex_index].co
                coordinates.extend((float(coordinate.x), float(coordinate.y), float(coordinate.z)))
            loop_vertices.append(target_index)
            if source_uv is not None:
                uv = source_uv.data[source_loop_index].uv
                uv_coordinates.extend((float(uv.x), float(uv.y)))
            if source_corner_normals is not None:
                normal = source_corner_normals[source_loop_index].vector
                custom_normals.append((float(normal.x), float(normal.y), float(normal.z)))
    mesh = bpy.data.meshes.new(name=f"{name}__mesh")
    mesh.vertices.add(len(vertex_map))
    mesh.vertices.foreach_set("co", coordinates)
    mesh.loops.add(len(loop_vertices))
    mesh.loops.foreach_set("vertex_index", loop_vertices)
    mesh.polygons.add(len(loop_starts))
    mesh.polygons.foreach_set("loop_start", loop_starts)
    mesh.polygons.foreach_set("loop_total", loop_totals)
    mesh.update(calc_edges=False)
    mesh.polygons.foreach_set("use_smooth", smooth_flags)
    if source_uv is not None:
        target_uv = mesh.uv_layers.new(name=source_uv.name)
        target_uv.data.foreach_set("uv", uv_coordinates)
    if custom_normals:
        mesh.normals_split_custom_set(custom_normals)
    return mesh, triangles


def make_material(semantic_node):
    material = bpy.data.materials.new(name=f"g3-{semantic_node.replace('/', '-')}")
    material.diffuse_color = SEMANTIC_COLORS[semantic_node]
    material.roughness = 1.0
    return material


def make_recovered_materials(config):
    recovered = {}
    records = []
    for source_name, entry in config["mapping"].items():
        texture_path = os.path.abspath(entry["albedo"])
        if not os.path.isfile(texture_path):
            raise RuntimeError(f"Recovered albedo is missing: {texture_path}")
        image = bpy.data.images.load(texture_path, check_existing=False)
        material = bpy.data.materials.new(name=f"recovered-{source_name}")
        material.use_nodes = True
        nodes = material.node_tree.nodes
        nodes.clear()
        output = nodes.new("ShaderNodeOutputMaterial")
        shader = nodes.new("ShaderNodeBsdfPrincipled")
        texture = nodes.new("ShaderNodeTexImage")
        texture.image = image
        texture.extension = "REPEAT"
        texture.interpolation = "Linear"
        shader.inputs["Roughness"].default_value = float(entry.get("roughnessScalar", 0.68))
        shader.inputs["Metallic"].default_value = float(entry.get("metalnessScalar", 0.0))
        material.node_tree.links.new(texture.outputs["Color"], shader.inputs["Base Color"])
        material.node_tree.links.new(shader.outputs["BSDF"], output.inputs["Surface"])
        recovered[source_name] = material
        records.append({
            "sourceMaterial": source_name,
            "runtimeMaterial": material.name,
            "albedo": texture_path,
            "albedoSha256": file_sha256(texture_path),
            "uvPolicy": "preserve source UV and sample with REPEAT",
            "roughness": {"kind": "independent-scalar", "value": float(entry.get("roughnessScalar", 0.68))},
            "metalness": {"kind": "independent-scalar", "value": float(entry.get("metalnessScalar", 0.0))},
            "normal": {"kind": "source-custom-geometry-normal", "texture": None},
            "ao": {"kind": "missing-not-faked", "texture": None},
        })
    return recovered, records


def create_empty(name, parent, stable_runtime_id, semantic_node, status):
    obj = bpy.data.objects.new(name, None)
    bpy.context.scene.collection.objects.link(obj)
    obj.parent = parent
    obj["assetId"] = stable_runtime_id.split("/")[0]
    obj["runtimeStableId"] = stable_runtime_id
    obj["semanticNode"] = semantic_node
    obj["semanticStatus"] = status
    obj["pickable"] = False
    obj["explodeParticipation"] = "parent"
    return obj


def main():
    asset_id, fbx_path, catalog_path, partition_path, decisions_path, output_dir, job_path, material_config_path = cli_args()
    if os.path.exists(output_dir):
        raise RuntimeError(f"Output directory already exists: {output_dir}")
    os.makedirs(output_dir, exist_ok=False)

    catalog = read_json(catalog_path)
    partition = read_json(partition_path)
    decisions = read_json(decisions_path)
    job = read_json(job_path)
    material_config = read_json(material_config_path) if material_config_path else None
    partition_manifest_path = os.path.join(os.path.dirname(partition_path), "run-manifest.json")
    if any(value.get("assetId") != asset_id for value in (catalog, partition, decisions, job)):
        raise RuntimeError("V3 hierarchy input identity mismatch")
    if decisions.get("gate") != "G2" or decisions.get("result") != "passed":
        raise RuntimeError("G3 hierarchy requires a passed G2 decision")
    if material_config is not None and material_config.get("assetId") != asset_id:
        raise RuntimeError("Material-recovery config identity mismatch")

    decision_by_leaf = {entry["semanticNode"]: entry for entry in decisions["decisions"]}
    assignment_by_key = {
        composite_key(entry["sourceObject"], entry["sourceRootVertex"]): entry
        for entry in partition["assignments"]
    }
    catalog_by_key = {
        composite_key(component["sourceObject"], component["sourceRootVertex"]): component
        for component in catalog["components"]
    }
    if len(assignment_by_key) != len(catalog["components"]) or set(assignment_by_key) != set(catalog_by_key):
        raise RuntimeError("Partition/catalog composite component coverage mismatch")

    components_by_source = defaultdict(list)
    for component in catalog["components"]:
        components_by_source[component["sourceObject"]].append(component)
    source_hashes = {}
    for source_object, components in components_by_source.items():
        digest = sha256()
        for component in sorted(components, key=lambda item: int(item["sourceRootVertex"])):
            digest.update(str(component["sourceRootVertex"]).encode("ascii"))
            digest.update(component["shapeFingerprint"].encode("ascii"))
            digest.update(str(component["triangles"]).encode("ascii"))
        source_hashes[source_object] = digest.hexdigest()

    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    bpy.ops.import_scene.fbx(filepath=fbx_path)
    object_map = read_json(os.path.join(os.path.dirname(fbx_path), "object-map.json"))
    admitted_names = {
        entry["name"]
        for entry in object_map.get("objects", [])
        if entry.get("class") in {"Editable_mesh", "PolyMeshObject", "Editable_Poly"}
    }
    source_objects = sorted(
        [obj for obj in bpy.context.scene.objects if obj.type == "MESH" and obj.name in admitted_names and len(obj.data.polygons) > 0],
        key=lambda obj: obj.name,
    )
    if len(source_objects) != int(catalog["sourceObjectCount"]):
        raise RuntimeError("Admitted Blender source-object count mismatch")

    root = create_empty(f"{asset_id}__building", None, f"{asset_id}/building", "building", "approved")
    parent_objects = {"building": root}
    for parent_id in ("structural-frame", "facade", "roof-system"):
        parent_objects[parent_id] = create_empty(
            f"{asset_id}__{parent_id}", root, f"{asset_id}/{parent_id}", parent_id, "approved"
        )
    leaf_objects = {}
    for leaf, parent_id in PARENT_BY_LEAF.items():
        decision = decision_by_leaf[leaf]
        leaf_objects[leaf] = create_empty(
            glb_name(asset_id, leaf),
            parent_objects[parent_id],
            stable_id(asset_id, leaf),
            leaf,
            decision["decision"],
        )

    semantic_materials = {leaf: make_material(leaf) for leaf in PARENT_BY_LEAF}
    recovered_materials, recovered_material_records = (
        make_recovered_materials(material_config) if material_config is not None else ({}, [])
    )
    chunk_records = []
    component_records = []
    built_objects = set(parent_objects.values()) | set(leaf_objects.values())
    observed_triangles = 0

    for source_object in source_objects:
        parent = array("I", range(len(source_object.data.vertices)))
        rank = bytearray(len(source_object.data.vertices))
        for edge in source_object.data.edges:
            union(parent, rank, edge.vertices[0], edge.vertices[1])
        polygons_by_leaf = defaultdict(list)
        for polygon in source_object.data.polygons:
            root_vertex = find(parent, polygon.vertices[0])
            key = composite_key(source_object.name, root_vertex)
            assignment = assignment_by_key.get(key)
            if assignment is None:
                raise RuntimeError(f"Missing semantic assignment for {source_object.name}/{root_vertex}")
            polygons_by_leaf[assignment["semanticNode"]].append(polygon)

        source_hash = source_hashes[source_object.name]
        for leaf, polygons in sorted(polygons_by_leaf.items()):
            decision = decision_by_leaf[leaf]
            if decision["decision"] != "approved":
                raise RuntimeError(f"Geometry assigned to non-approved leaf: {leaf}")
            node_name = glb_name(asset_id, leaf, source_hash)
            runtime_id = stable_id(asset_id, leaf, source_hash)
            mesh, triangle_count = build_mesh(node_name, source_object, polygons)
            source_material = source_object.data.materials[0].name if source_object.data.materials else "__unassigned__"
            if material_config is not None:
                if source_material not in recovered_materials:
                    raise RuntimeError(f"Missing recovered material mapping: {source_material}")
                mesh.materials.append(recovered_materials[source_material])
            else:
                mesh.materials.append(semantic_materials[leaf])
            chunk_object = bpy.data.objects.new(node_name, mesh)
            bpy.context.scene.collection.objects.link(chunk_object)
            chunk_object.parent = leaf_objects[leaf]
            chunk_object.matrix_world = source_object.matrix_world.copy()
            chunk_object["assetId"] = asset_id
            chunk_object["semanticNode"] = leaf
            chunk_object["runtimeStableId"] = runtime_id
            chunk_object["sourceObject"] = source_object.name
            chunk_object["sourceObjectHash"] = source_hash
            chunk_object["sourceMaterial"] = source_material
            chunk_object["pickable"] = True
            chunk_object["explodeParticipation"] = "leaf-parent"
            built_objects.add(chunk_object)
            observed_triangles += triangle_count

            chunk_components = [
                component for component in components_by_source[source_object.name]
                if assignment_by_key[composite_key(component["sourceObject"], component["sourceRootVertex"])]["semanticNode"] == leaf
            ]
            expected_chunk_triangles = sum(int(component["triangles"]) for component in chunk_components)
            if triangle_count != expected_chunk_triangles:
                raise RuntimeError(f"Chunk triangle mismatch: {node_name}")
            chunk_records.append({
                "sourceObject": source_object.name,
                "sourceObjectHash": source_hash,
                "sourceMaterial": source_material,
                "blenderObject": source_object.name,
                "semanticNode": leaf,
                "hierarchyBlenderObject": node_name,
                "glbNode": node_name,
                "runtimeStableId": runtime_id,
                "parentRuntimeStableId": stable_id(asset_id, leaf),
                "components": len(chunk_components),
                "triangles": triangle_count,
                "instances": 1,
                "transformMatrixWorld": matrix_values(source_object.matrix_world),
                "boundsMeters": aggregate_bounds(chunk_components),
                "interaction": {"clickable": True, "explodeParticipation": "leaf-parent"},
                "lodPolicy": "preserve-semantic-proxy; geometry simplification deferred to G4",
            })
            for component in chunk_components:
                component_records.append({
                    "componentId": component["id"],
                    "sourceRootVertex": component["sourceRootVertex"],
                    "sourceObject": source_object.name,
                    "sourceObjectHash": source_hash,
                    "sourceGeometryFingerprint": component["shapeFingerprint"],
                    "blenderObject": source_object.name,
                    "semanticNode": leaf,
                    "hierarchyBlenderObject": node_name,
                    "glbNode": node_name,
                    "runtimeStableId": runtime_id,
                    "triangles": component["triangles"],
                    "boundsMeters": component["boundsMeters"],
                    "materialProvenance": component.get("materials", []),
                })

    if observed_triangles != int(catalog["triangles"]) or len(component_records) != len(catalog["components"]):
        raise RuntimeError("Hierarchy component/triangle integrity mismatch")

    for obj in list(bpy.data.objects):
        if obj not in built_objects:
            bpy.data.objects.remove(obj, do_unlink=True)
    bpy.ops.object.select_all(action="DESELECT")
    for obj in built_objects:
        obj.select_set(True)
    bpy.context.view_layer.objects.active = root

    glb_path = os.path.join(output_dir, f"{asset_id}-semantic-hierarchy.review.glb")
    bpy.ops.export_scene.gltf(
        filepath=glb_path,
        export_format="GLB",
        use_selection=True,
        export_extras=True,
        export_materials="EXPORT",
        export_normals=True,
        export_yup=True,
    )

    semantic_nodes = []
    for leaf in PARENT_BY_LEAF:
        decision = decision_by_leaf[leaf]
        leaf_components = [
            component for component in catalog["components"]
            if assignment_by_key[composite_key(component["sourceObject"], component["sourceRootVertex"])]["semanticNode"] == leaf
        ]
        semantic_nodes.append({
            "semanticNode": leaf,
            "decision": decision["decision"],
            "blenderObject": leaf_objects[leaf].name,
            "glbNode": leaf_objects[leaf].name,
            "runtimeStableId": stable_id(asset_id, leaf),
            "parentSemanticNode": PARENT_BY_LEAF[leaf],
            "parentRuntimeStableId": f"{asset_id}/{PARENT_BY_LEAF[leaf]}",
            "componentCount": len(leaf_components),
            "triangles": sum(int(component["triangles"]) for component in leaf_components),
            "instances": 0 if decision["decision"] == "not-present" else 1,
            "sourceObjects": sorted({component["sourceObject"] for component in leaf_components}),
            "boundsMeters": aggregate_bounds(leaf_components),
            "interaction": {
                "clickable": decision["decision"] == "approved",
                "explodeParticipation": "parent" if decision["decision"] == "approved" else "none",
                "explodeWithParent": PARENT_BY_LEAF[leaf],
            },
            "lodPolicy": "semantic identity and picking proxy must survive every LOD; G4 export pending",
        })

    hierarchy_path = os.path.join(output_dir, "semantic-hierarchy.json")
    write_json(hierarchy_path, {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3-semantic-hierarchy",
        "assetId": asset_id,
        "reviewOnly": True,
        "mappingChain": ["sourceObject", "blenderObject", "semanticNode", "glbNode", "runtimeStableId"],
        "stableIdPolicy": "asset/part/semantic-path/src-<first-12-of-source-geometry-sha256>; independent of traversal/export order",
        "materialRecovery": recovered_material_records,
        "semanticTree": {
            "building": ["foundation", "podium", "structural-frame", "facade", "roof-system", "plaques", "secondary-details"],
            "structural-frame": ["structural-frame/columns", "structural-frame/beams", "structural-frame/brackets-dougong"],
            "facade": ["facade/walls", "facade/doors-windows", "facade/railings"],
            "roof-system": ["roof-system/rafters", "roof-system/sheathing", "roof-system/tiles", "roof-system/eaves", "roof-system/ridges", "roof-system/ornaments-finial"],
        },
        "semanticNodes": semantic_nodes,
        "chunks": sorted(chunk_records, key=lambda item: item["runtimeStableId"]),
        "components": sorted(component_records, key=lambda item: (item["sourceObject"], int(item["sourceRootVertex"]))),
    })

    manifest_path = os.path.join(output_dir, "run-manifest.json")
    write_json(manifest_path, {
        "schemaVersion": 1,
        "track": "dcc-highmodel-v3-semantic-hierarchy",
        "assetId": asset_id,
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "blenderVersion": bpy.app.version_string,
        "reviewOnly": True,
        "input": {
            "fbx": fbx_path,
            "fbxSha256": file_sha256(fbx_path),
            "catalog": catalog_path,
            "catalogSha256": file_sha256(catalog_path),
            "partition": partition_path,
            "partitionSha256": file_sha256(partition_path),
            "partitionManifest": partition_manifest_path,
            "partitionManifestSha256": file_sha256(partition_manifest_path),
            "g2Decisions": decisions_path,
            "g2DecisionsSha256": file_sha256(decisions_path),
            "job": job_path,
            "jobSha256": file_sha256(job_path),
            "script": os.path.abspath(__file__),
            "scriptSha256": file_sha256(os.path.abspath(__file__)),
            "materialConfig": material_config_path,
            "materialConfigSha256": file_sha256(material_config_path) if material_config_path else None,
        },
        "integrity": {
            "sourceObjects": len(source_objects),
            "components": len(component_records),
            "expectedTriangles": int(catalog["triangles"]),
            "hierarchyTriangles": observed_triangles,
            "semanticLeaves": len(PARENT_BY_LEAF),
            "approvedLeaves": sum(1 for value in decision_by_leaf.values() if value["decision"] == "approved"),
            "notPresentLeaves": sum(1 for value in decision_by_leaf.values() if value["decision"] == "not-present"),
            "glbMeshNodes": len(chunk_records),
            "sourceUvPreserved": True,
            "sourceCustomNormalsPreserved": True,
            "passed": True,
        },
        "outputs": {
            "hierarchy": "semantic-hierarchy.json",
            "reviewGlb": os.path.basename(glb_path),
            "reviewGlbSha256": file_sha256(glb_path),
            "reviewGlbBytes": os.path.getsize(glb_path),
        },
        "materialRecovery": recovered_material_records,
        "runtimeReplacement": False,
        "nextAction": "Validate G3 traceability and GLB extras before any G4 LOD/pack export or runtime manifest switch.",
    })
    print(json.dumps({
        "assetId": asset_id,
        "sourceObjects": len(source_objects),
        "components": len(component_records),
        "triangles": observed_triangles,
        "glbMeshNodes": len(chunk_records),
        "glbBytes": os.path.getsize(glb_path),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
