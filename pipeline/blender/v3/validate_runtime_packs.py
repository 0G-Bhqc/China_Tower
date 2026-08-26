#!/usr/bin/env python3
"""Independently validate immutable V3 B4 runtime-pack evidence."""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
from datetime import datetime, timezone
from pathlib import Path


MIB = 1024 * 1024
BYTE_BUDGETS = {
    "preview": 8 * MIB,
    "hero-core": 25 * MIB,
    "standard-core": 18 * MIB,
    "mobile-core": 10 * MIB,
}
TRIANGLE_BUDGETS = {"hero": 1_800_000, "standard": 900_000, "mobile": 350_000}


def arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--review", required=True, type=Path)
    parser.add_argument("--hierarchy", required=True, type=Path)
    parser.add_argument("--canonical-hierarchy", required=True, type=Path)
    parser.add_argument("--runtime-manifest", required=True, type=Path)
    parser.add_argument("--frozen-runtime-manifest", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    return parser.parse_args()


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def glb_inventory(path: Path) -> dict:
    with path.open("rb") as handle:
        magic, version, length = struct.unpack("<4sII", handle.read(12))
        if magic != b"glTF" or version != 2 or length != path.stat().st_size:
            raise ValueError("invalid GLB header")
        chunk_length, chunk_type = struct.unpack("<II", handle.read(8))
        if chunk_type != 0x4E4F534A:
            raise ValueError("first GLB chunk is not JSON")
        document = json.loads(handle.read(chunk_length).decode("utf-8").rstrip(" \t\r\n\0"))
    accessors = document.get("accessors", [])
    materials = [item.get("name", f"material-{index}") for index, item in enumerate(document.get("materials", []))]
    triangles = 0
    triangles_by_material: dict[str, int] = {}
    for mesh in document.get("meshes", []):
        for primitive in mesh.get("primitives", []):
            mode = primitive.get("mode", 4)
            if mode != 4:
                continue
            accessor_index = primitive.get("indices")
            if accessor_index is None:
                accessor_index = primitive.get("attributes", {}).get("POSITION")
            if accessor_index is not None:
                primitive_triangles = accessors[accessor_index]["count"] // 3
                triangles += primitive_triangles
                material_index = primitive.get("material")
                material_name = materials[material_index] if material_index is not None and material_index < len(materials) else "__unassigned__"
                triangles_by_material[material_name] = triangles_by_material.get(material_name, 0) + primitive_triangles
    stable_ids = sorted({
        node.get("extras", {}).get("runtimeStableId")
        for node in document.get("nodes", [])
        if node.get("extras", {}).get("runtimeStableId")
    })
    proxy_ids = sorted({
        node.get("extras", {}).get("proxyForRuntimeStableId")
        for node in document.get("nodes", [])
        if node.get("extras", {}).get("proxyForRuntimeStableId")
    })
    batch_source_ids = set()
    for node in document.get("nodes", []):
        encoded = node.get("extras", {}).get("sourceRuntimeStableIdsJson")
        if encoded:
            batch_source_ids.update(json.loads(encoded))
    return {
        "triangles": triangles,
        "materialNames": sorted(triangles_by_material),
        "trianglesByMaterial": dict(sorted(triangles_by_material.items())),
        "meshCount": len(document.get("meshes", [])),
        "extensionsUsed": sorted(document.get("extensionsUsed", [])),
        "runtimeStableIds": stable_ids,
        "batchSourceRuntimeStableIds": sorted(batch_source_ids),
        "proxyForRuntimeStableIds": proxy_ids,
    }


def component_ids(document: dict) -> set[str]:
    return {item["runtimeStableId"] for item in document["components"]}


def main() -> int:
    options = arguments()
    review = options.review.resolve()
    output = options.output.resolve() if options.output else review / "b4-validation.json"
    manifest_path = review / "asset-pack-manifest.json"
    run_path = review / "run-manifest.json"
    manifest = read_json(manifest_path)
    run_manifest = read_json(run_path)
    runtime_manifest_path = options.runtime_manifest.resolve()
    frozen_runtime_manifest_path = options.frozen_runtime_manifest.resolve()
    hierarchy_document = read_json(options.hierarchy.resolve())
    hierarchy_ids = component_ids(hierarchy_document)
    canonical_ids = component_ids(read_json(options.canonical_hierarchy.resolve()))
    expected_materials = sorted(item["runtimeMaterial"] for item in hierarchy_document.get("materialRecovery", []))
    checks: list[dict] = []

    def check(name: str, passed: bool, actual=None, expected=None) -> None:
        checks.append({"name": name, "passed": bool(passed), "actual": actual, "expected": expected})

    check("stage-is-B4", manifest.get("stage") == "B4", manifest.get("stage"), "B4")
    check("review-only", manifest.get("reviewOnly") is True, manifest.get("reviewOnly"), True)
    check("runtime-replacement-frozen", manifest.get("runtimeReplacement") is False and run_manifest.get("runtimeReplacement") is False)
    check("live-runtime-manifest-exists", runtime_manifest_path.is_file())
    check(
        "live-runtime-matches-frozen-baseline",
        runtime_manifest_path.is_file()
        and frozen_runtime_manifest_path.is_file()
        and sha256(runtime_manifest_path) == sha256(frozen_runtime_manifest_path),
        sha256(runtime_manifest_path) if runtime_manifest_path.is_file() else None,
        sha256(frozen_runtime_manifest_path) if frozen_runtime_manifest_path.is_file() else None,
    )
    check("run-manifest-hash", run_manifest.get("manifest", {}).get("sha256") == sha256(manifest_path))
    check("export-order", manifest.get("exportOrder") == ["preview", "core", "roof", "detail", "plaque"])
    check("B3-G3-stable-id-same-set", hierarchy_ids == canonical_ids, len(hierarchy_ids), len(canonical_ids))
    check("B3-recovered-material-contract", len(expected_materials) == 3, expected_materials, "three recovered source materials")

    preview = manifest["preview"]
    records = [("preview", None, preview)]
    for tier in ("hero", "standard", "mobile"):
        for package in ("core", "roof", "detail"):
            records.append((package, tier, manifest["tiers"][tier][package]))

    tier_ids: dict[str, set[str]] = {tier: set() for tier in ("hero", "standard", "mobile")}
    for package, tier, record in records:
        path = review / record["file"]
        label = "preview" if tier is None else f"{tier}-{package}"
        exists = path.is_file()
        check(f"{label}-file-exists", exists)
        if not exists:
            continue
        digest = sha256(path)
        inventory = glb_inventory(path)
        check(f"{label}-sha256", digest == record.get("sha256"), digest, record.get("sha256"))
        check(f"{label}-content-address", f".{digest[:12]}.glb" in path.name)
        check(f"{label}-bytes", path.stat().st_size == record.get("bytes"), path.stat().st_size, record.get("bytes"))
        check(f"{label}-triangles", inventory["triangles"] == record.get("triangles"), inventory["triangles"], record.get("triangles"))
        recorded_materials = record.get("materialInventory", {})
        check(
            f"{label}-material-names",
            inventory["materialNames"] == expected_materials == recorded_materials.get("names"),
            inventory["materialNames"],
            expected_materials,
        )
        check(
            f"{label}-material-triangle-inventory",
            inventory["trianglesByMaterial"] == recorded_materials.get("trianglesByMaterial"),
            inventory["trianglesByMaterial"],
            recorded_materials.get("trianglesByMaterial"),
        )
        check(
            f"{label}-all-materials-nonempty",
            all(inventory["trianglesByMaterial"].get(name, 0) > 0 for name in expected_materials),
            inventory["trianglesByMaterial"],
            "positive triangles for every recovered source material",
        )
        manifest_ids = set(record.get("runtimeStableIds", []))
        if record.get("renderBatch"):
            check(
                f"{label}-GLB-batch-source-stable-ids",
                set(inventory["batchSourceRuntimeStableIds"]) == manifest_ids,
                len(inventory["batchSourceRuntimeStableIds"]),
                len(manifest_ids),
            )
            expected_digest = hashlib.sha256(("\n".join(sorted(manifest_ids)) + "\n").encode("utf-8")).hexdigest()
            check(f"{label}-batch-stable-id-digest", record["renderBatch"].get("stableIdSetSha256") == expected_digest)
            check(f"{label}-batch-picking-external", record["renderBatch"].get("pickingIdentity") == "external-one-to-one-proxy")
        else:
            check(f"{label}-GLB-stable-ids", set(inventory["runtimeStableIds"]) == manifest_ids, len(inventory["runtimeStableIds"]), len(manifest_ids))
        if tier:
            check(f"{label}-no-intra-tier-duplicate", tier_ids[tier].isdisjoint(manifest_ids))
            tier_ids[tier].update(manifest_ids)
        byte_budget = BYTE_BUDGETS.get(label)
        if byte_budget is not None:
            check(f"{label}-byte-budget", path.stat().st_size <= byte_budget, path.stat().st_size, byte_budget)
        compression = record.get("geometryCompression")
        if compression:
            check(f"{label}-meshopt-extension", "EXT_meshopt_compression" in inventory["extensionsUsed"])
            check(f"{label}-meshopt-record", compression.get("method") == "EXT_meshopt_compression" and compression.get("decoder") == "MeshoptDecoder")

    for tier in ("hero", "standard", "mobile"):
        packages = manifest["tiers"][tier]
        total_triangles = sum(packages[name].get("triangles", 0) for name in ("core", "roof", "detail"))
        check(f"{tier}-triangle-budget", total_triangles <= TRIANGLE_BUDGETS[tier], total_triangles, TRIANGLE_BUDGETS[tier])
        check(f"{tier}-stable-id-coverage", tier_ids[tier] == hierarchy_ids, len(tier_ids[tier]), len(hierarchy_ids))
        plaque = packages["plaque"]
        check(f"{tier}-plaque-not-present", plaque.get("status") == "not-present" and plaque.get("triangles") == 0)
    check("stable-id-tier-invariance", tier_ids["hero"] == tier_ids["standard"] == tier_ids["mobile"])

    proxy = manifest["pickingProxy"]
    proxy_path = review / proxy["file"]
    proxy_contract_path = review / proxy["contract"]
    proxy_inventory = glb_inventory(proxy_path)
    proxy_contract = read_json(proxy_contract_path)
    contract_ids = {item["runtimeStableId"] for item in proxy_contract["entries"]}
    check("proxy-file-hash", sha256(proxy_path) == proxy["sha256"])
    check("proxy-contract-hash", sha256(proxy_contract_path) == proxy["contractSha256"])
    check("proxy-one-to-one", proxy_contract.get("oneToOne") is True and len(contract_ids) == len(proxy_contract["entries"]))
    check("proxy-stable-id-coverage", contract_ids == hierarchy_ids, len(contract_ids), len(hierarchy_ids))
    check("proxy-GLB-coverage", set(proxy_inventory["proxyForRuntimeStableIds"]) == hierarchy_ids)

    lod_path = review / manifest["lodPolicy"]["file"]
    check("lod-policy-hash", sha256(lod_path) == manifest["lodPolicy"]["sha256"])
    lod_policy = read_json(lod_path)
    filtering = lod_policy.get("componentFiltering", {})
    if filtering:
        flattened = [item for group in filtering.values() for item in group]
        check("component-filter-audited", bool(flattened))
        check("component-filter-conservation", all(
            item["beforeTriangles"] - item["droppedTriangles"] == item["afterTriangles"] for item in flattened
        ))
        check("component-filter-uv-retained", all(item["uvLayersAfter"] > 0 for item in flattened if item["afterTriangles"] > 0))

    failures = [item for item in checks if not item["passed"]]
    result = {
        "schemaVersion": 1,
        "assetId": manifest.get("assetId"),
        "stage": "B4",
        "review": review.name,
        "validatedAt": datetime.now(timezone.utc).isoformat(),
        "status": "pass" if not failures else "fail",
        "runtimeReplacement": False,
        "summary": {"checks": len(checks), "passed": len(checks) - len(failures), "failed": len(failures)},
        "failedChecks": failures,
        "checks": checks,
        "inputs": {
            "manifestSha256": sha256(manifest_path),
            "hierarchySha256": sha256(options.hierarchy.resolve()),
            "canonicalHierarchySha256": sha256(options.canonical_hierarchy.resolve()),
            "runtimeManifestSha256": sha256(runtime_manifest_path),
            "frozenRuntimeManifestSha256": sha256(frozen_runtime_manifest_path),
            "validatorSha256": sha256(Path(__file__).resolve()),
        },
    }
    if output.exists():
        raise RuntimeError(f"Refusing to overwrite validation evidence: {output}")
    output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"status": result["status"], "failed": [item["name"] for item in failures], "output": str(output)}, ensure_ascii=False))
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
