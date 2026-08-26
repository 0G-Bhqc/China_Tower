# China Tower project continuation status

Updated: 2026-08-23 (Asia/Shanghai)  
Workspace: `E:/Station/China_Tower`  
Execution state: **Three-pavilion poetry runtime implemented; Feiyun/Penglai remain archived research assets**

## Product state

- The finished exhibit set is now three pavilions: Yueyang, Huanghe, and Tengwang.
- Feiyun is removed from the finished product as requested. Penglai assets remain in the repository as
  a repair candidate and are not exposed by navigation or active product routing. Legacy `?pavilion=feiyun`
  and `?pavilion=penglai` URLs fall back to Yueyang.
- The runtime now presents pavilion-specific poetry, architecture, and component views, with responsive
  desktop side-panel and mobile bottom-drawer layouts.
- Yueyang, Huanghe, and Tengwang now use grounding/depth stabilization; Huanghe roof-like imported
  materials are explicitly calibrated to opaque dark tile response.
- Direct `file://` browsing is not supported by the module-based build. Continue to open the project
  through `npm run dev` or another HTTP server.

## Frozen V3 baseline

- Five verified jobs exist under `evidence/v3/<asset>/job.json`.
- Frozen runtime manifest: `evidence/v3/baseline/pavilion-assets.manifest.json`.
- Frozen manifest SHA-256:
  `1dafc2670f24a560a993952d4b23b7d45a13dccca798734a27ca8cc875314c11`.
- `npm run v3:prepare` and `npm run v3:validate` previously passed.
- The detailed implementation contract is `docs/engineering-implementation-v3.md`.

## Feiyun high-model work completed

### Verified dissection

`evidence/v3/feiyun/dissection/run-003` is a completed Blender 5.2 dissection:

- 30 admitted architectural source meshes;
- 83,580 edge-connected components;
- 2,540,987 observed triangles, exactly matching the source-mapped expected total;
- 7 beauty views and 7 source-ID views, including low-angle;
- no runtime GLB export and no automatically approved semantic label.

Dissection manifest SHA-256:
`888d6712a1e1b90d41214b5f66b5650c813bf94d8d9847bcb37adc03f09423a6`.

### Repetition analysis decision

Three attempts showed that source-object and connected-component repetition are not reliable
architectural separators for this FBX:

1. exact component signatures promoted micro-fragment coincidences;
2. world AABB signatures were rotation-sensitive;
3. transform-invariant exact edge-length fingerprints produced zero semantic/material repeat
   groups because nearly every loose fragment is unique.

A tolerance probe found 11 threshold-passing groups, but all were 3–12-triangle
`secondary-details` fragments distributed across multiple storeys. They were rejected as false
positives. The recorded decision is `refine-code`, not another semantic-spec iteration:
`evidence/v3/feiyun/semantic-review/review-003/review.md`.

## New semantic partition pipeline

The current implementation switches from repetition matching to an exclusive
spatial/material/shape/height-band hypothesis partition:

- Blender script: `pipeline/blender/v3/semantic_partition.py`
- Node runner: `scripts/run-v3-semantic-partition.mjs`
- npm command: `npm run v3:semantic -- <asset> <run-NNN> <review-NNN>`
- Blender script SHA-256:
  `b1a6bd50e2beb12f793ec80b596068248510b413b7f2c731ef85dc9b81d463e1`
- Runner SHA-256:
  `0992c8509b01dc8ba638b26e1be118e08fec03231069bb1bcf1d18f1de29f75d`

The task assigns every component to exactly one review-only leaf, preserves source object/root
mapping, renders seven-view semantic ID, silhouette, depth, normal, material ID, and five isolation
targets, and refuses to export GLB. All automatic labels stay `hypothesis`.

### Depth/normal evidence implementation

The Blender pass now includes per-view camera-depth and geometry-normal renders while continuing
to use the audited high-model source:
`evidence/3d-assets/jobs/feiyun/outputs/full-scene.fbx`.
The canonical package is `semantic-partition/review-020`; its predecessor channel/depth/normal visual record is
`semantic-review/review-005/review.md`, its baseline leaf-isolation decisions are recorded in
`semantic-review/review-006/leaf-decisions.md`, and its targeted four-angle leaf review is in
`semantic-review/review-007/targeted-review.md`; the refined classifier review is in
`semantic-review/review-008/refined-review.md`; normal-evidence interpretation is in
`semantic-review/review-009/normal-refinement.md`.
The manifest-bound G2 decision is `semantic-review/review-010/g2-decisions.json`, with the review
record in `semantic-review/review-010/review.md`.

### Semantic review attempts

- `semantic-partition/review-001`: blocked before rendering because Blender 5.2 renamed the AgX
  look enum. `failure.json` is preserved. The script now supports the Blender 5.2 enum.
- `semantic-partition/review-002`: stopped on explicit user request. The worker processes were
  terminated and all partial outputs were preserved. Do not overwrite this directory.
- `semantic-partition/review-003`: completed with Blender 5.2 after the visual gate selected
  `continue`; this is the first complete semantic-partition evidence package.
- `semantic-partition/review-004` through `review-012`: preserved failed or diagnostic attempts
  from Blender 5.2 API compatibility corrections; none replaced a production asset.
- `semantic-partition/review-013`: complete six-channel package, but depth contrast was refined
  before admission.
- `semantic-partition/review-014`: admitted diagnostic package with 35 seven-view pass images and
  five isolation images.
- `semantic-partition/review-015`: admitted complete package with the same 35 channel images, five
  existing isolation images, and 16 additional per-leaf isolation images. It remains preserved as
  the prior canonical package and does not export GLB.
- `semantic-partition/review-016`: admitted package with 35 channel images, 21 baseline isolation
  images, and 64 targeted four-angle leaf images. It supersedes review-015 as canonical evidence;
  it still does not export GLB.
- `semantic-partition/review-017`: admitted refined package with 35 channel images, 21 baseline
  isolation entries, and 56 targeted leaf images. It supersedes review-016 as canonical evidence;
  it still does not export GLB.
- `semantic-partition/review-018`: admitted package with the same 35 channel images, 21 baseline
  isolation entries, and 56 targeted leaf images, plus world-space surface-normal area statistics
  in `semantic-partition.json`. It supersedes review-017 as canonical evidence; it still does not
  export GLB.
- `semantic-partition/review-019`: admitted compound-candidate diagnostic package. It adds five
  overlapping facade/roof diagnostic groups and fixes internal component lookup collisions by
  using `sourceObject + sourceRootVertex`; it is preserved as the rejected-candidate evidence.
- `semantic-partition/review-020`: canonical corrected package. It reconstructs walls and
  doors/windows from the compound facade field, returns false plaque candidates to roof ornaments,
  leaves beams/rafters/plaques empty for explicit source-geometry disposition, and adds 40 tight
  storey/side or roof-band subgroup renders. It still does not export GLB.

`review-003` admission checks passed:

- `run-manifest.json` exists with identity `dcc-highmodel-v3-semantic-partition`;
- integrity is true for all 83,580 components and 2,540,987 triangles;
- all 28 files declared by the manifest exist;
- seven semantic-ID views and five isolation views were visually reviewed in
  `evidence/v3/feiyun/semantic-review/review-004/review.md`.

`review-014` admission checks passed:

- manifest identity is `dcc-highmodel-v3-semantic-partition` and integrity is true;
- 30 source meshes, 83,580 components, and 2,540,987 assigned triangles are unchanged;
- all 42 declared outputs exist and are non-empty;
- depth and normal views were visually checked in
  `evidence/v3/feiyun/semantic-review/review-005/review.md`.

`review-015` admission checks passed:

- manifest identity is `dcc-highmodel-v3-semantic-partition` for `feiyun` and integrity is true;
- 35 channel renders and 21 isolation renders are declared; all 58 declared output/data files are
  present and non-empty;
- all 16 `renders/isolation-leaves/*.png` files are present and non-empty;
- manifest SHA-256 is
  `84201d67be916c20f4210d98a3b8151271364f623e7cc10a2e2dcae6cdc9ad83`.
- The inherited catalog has 10 duplicated short component IDs among 20 one- to two-triangle
  fragments. `sourceObject` plus `sourceRootVertex` remains the disambiguating trace key; this is
  recorded as a refinement issue and is not used as semantic approval evidence.

`review-016` admission checks passed:

- manifest identity is `dcc-highmodel-v3-semantic-partition / feiyun` and integrity is true;
- all 122 declared files are present and non-empty: 35 channel renders, 21 baseline isolation
  renders, 64 targeted four-angle leaf renders, plus the two data files;
- manifest SHA-256 is
  `bab4085c4cd5684ff18ba69a4d110a28aae80131bec9a57492bb075fedf58cbe`.

The review-016 targeted pass did not promote any additional leaf. Its six-leaf decision is preserved
in review-007. Review-017 supersedes it with the refined classifier result described below.

`review-017` admission checks passed:

- manifest identity is `dcc-highmodel-v3-semantic-partition / feiyun` and integrity is true;
- all 114 declared files are present and non-empty, including 35 channel renders, 21 baseline
  isolation entries, and 56 targeted four-angle leaf renders;
- the refined classifier restores 14 wall candidates and produces cleaner eave/ornament groups;
  it intentionally leaves doors/windows and rafters empty rather than promoting generic fragments;
- manifest SHA-256 is
  `9fc606b3e743ee31145b794133bec78a3ec6c5e703dff1340439e973beb5201d`.

Review 008 provisionally approves eight leaves, rejects the current wall assignment pending
reassignment, and leaves seven leaves pending. G2 remains not passed and runtime GLB export stays
blocked.

`review-018` admission checks passed:

- manifest identity is `dcc-highmodel-v3-semantic-partition / feiyun` and integrity is true;
- all 114 declared files are present and non-empty;
- semantic summaries include world-space vertical/roof surface-area fractions, with columns,
  sheathing, and eaves showing the expected orientation profiles;
- the wall group remains visually fragmented and has only 0.2408 vertical-area fraction, so no
  additional leaf is promoted;
- manifest SHA-256 is
  `124c38008f8fa01c53d8247281c13f59fdf440073b2adc8e6f60f219eb4a6481`.

Review 009 keeps eight provisional approvals, rejects the current wall assignment pending
reassignment, and leaves seven leaves pending. G2 remains not passed and runtime GLB export stays
blocked.

`review-019` and `review-020` admission checks passed:

- both manifests have identity `dcc-highmodel-v3-semantic-partition / feiyun` and integrity true;
- `review-019` declares 133 non-empty files and provides the rejected beam/plaque plus compound
  facade/roof diagnostic evidence;
- `review-020` declares 163 non-empty files: 35 channel views, 21 baseline isolations, 52 leaf
  views, 16 aggregate diagnostics, 40 subgroup views, and three JSON records;
- `review-020` covers all 83,580 composite component identities and all 2,540,987 triangles;
- walls now contain 2,275 components / 184,351 triangles and doors/windows contain 1,032 components
  / 152,539 triangles; both form readable storey facade fields;
- manifest SHA-256 is
  `d90bf0090e0c513b3f30c591e0109de49f1a90baaf5846c6b4d328970644d2de`.

G2 now passes through the separate manifest-bound human-review sidecar
`semantic-review/review-010/g2-decisions.json`: 13 leaves are `approved`; beams, rafters, and
plaques are explicit `not-present` independent source geometry with recorded merge/disposition
evidence. `npm run validate:semantic-coverage -- feiyun review-010` passes. Automatic partition
labels remain `hypothesis` by design; the review sidecar, not the classifier, owns approval.

No production runtime GLB was exported or replaced. The review-only hierarchy GLB described below
is evidence and is not referenced by the production manifest.

## Feiyun G3 structure mapping

G3 now passes with the immutable evidence package
`evidence/v3/feiyun/semantic-hierarchy/review-001` and the manifest-bound decision record
`evidence/v3/feiyun/semantic-hierarchy-review/review-001/g3-decision.json`.

- hierarchy builder: `pipeline/blender/v3/build_semantic_hierarchy.py`;
- runner: `scripts/run-v3-semantic-hierarchy.mjs`;
- validator: `scripts/validate-v3-structure-mapping.mjs`;
- command: `npm run v3:hierarchy -- feiyun review-020 review-010 review-001`;
- validation: `npm run validate:structure-mapping -- feiyun review-001`;
- complete query chain:
  `sourceObject -> blenderObject -> semanticNode -> glbNode -> runtimeStableId`;
- 30 source objects, 83,580 composite component identities, and 2,540,987 triangles are mapped
  exactly once into 341 actual GLB mesh nodes;
- stable IDs derive from asset ID, semantic path, and source-geometry SHA-256, never traversal
  order;
- GLB extras and `semantic-hierarchy.json` agree for runtime ID, semantic node, source object, and
  source-object hash;
- every node records bounds, transform, triangles, instances, LOD identity policy, clickability,
  explode participation, and parent-follow behavior;
- the three G2 `not-present` leaves remain explicit zero-geometry semantic nodes;
- review GLB is 61,834,704 bytes with SHA-256
  `8b956dca8b036721b224a6cc1266ee30f2a313cb1e70839ce085728ee23f4f5e`;
- G3 manifest SHA-256 is
  `dc45a8f3c1316d789ace038b3d5a470ab26fca9465e2c42e5aab8a01ddf990fd`.

`src/runtime/PavilionAssemblyRuntime.ts` now prefers authored `runtimeStableId` and semantic extras,
with the old traversal-derived ID retained only as a legacy fallback. Production assets are still
the frozen baseline; this runtime support does not switch the manifest.

The live hierarchy builder later evolved for B3 material/UV/normal transport. G3 remains bound to
its historical script SHA-256; `semantic-hierarchy-review/review-001/provenance-drift.json`
records the drift, and the structure validator reports it explicitly while continuing to validate
all canonical inputs, the approved decision, GLB extras, mapping coverage, triangle counts, and
output hashes.

## Feiyun B3 and B4

B3 source-material transport is accepted and bound to
`evidence/3d-assets/jobs/feiyun/b3-material-recovery/review-005` (materialized semantic GLB
SHA-256 `ff3e94a59959647b12135efcc89b5df08dfb5e0425c56618bfc81b276254f893`). It preserves
source UVs/custom normals, binds the three verified source photo atlases with repeat sampling, and
does not fake missing AO or normal textures.

B4 was approved through `runtime-pack-review/review-003/acceptance.json`, bound to
`runtime-packs/review-004` and `runtime-pack-review/review-002`. B5 review-001 then exposed an
additional defect that the original B4 validator did not cover: Blender 5.2 retained three material
slots while assigning every welded face to slot zero. Therefore the old approval remains an honest
historical decision but is superseded for continuation; `runtime-packs/review-004` must not feed B5.

The corrected B4 candidate is `runtime-packs/review-005`, with visible review
`runtime-pack-review/review-005`:

- preview: 49,946 triangles / 1,107,676 bytes, explicitly a loading placeholder;
- Hero: 1,619,997 triangles; core 12,762,288 bytes;
- Standard: 849,991 triangles; core 7,403,268 bytes;
- Mobile: 264,966 triangles; core 2,627,856 bytes;
- render batches weld semantic slices before simplification, removing the rejected speckling/hole
  failure from `runtime-pack-review/review-001`;
- preview and all nine tier/package render GLBs preserve all three real recovered material IDs
  (`#26`, `#27`, `#28`) with non-zero triangles; no B5 renderer workaround is used;
- a separate 341-node picking proxy and stable-ID digest preserve semantic interaction identity;
- `plaque` is explicit `not-present`, not fabricated;
- all 153 strengthened B4 structural/hash/budget/material/runtime-freeze checks pass in
  `runtime-packs/review-005/b4-validation-v2.json`;
- the live runtime manifest still exactly matches the frozen manifest SHA-256
  `1dafc2670f24a560a993952d4b23b7d45a13dccca798734a27ca8cc875314c11`.

B5 `b5-evidence/review-001` is retained as failed diagnostic evidence because it used the superseded
single-material B4 package. It is not a B5 pass. Human approval of corrected B4 review-005 is the
next gate; only then may B5 be regenerated in a new directory. B4 approval is not Phase 1 exit,
G4-G10, Phase 2 visual completion, or production runtime replacement.

`review-002` completed before the stop:

- 7 semantic-ID views;
- 7 alpha-silhouette views;
- 7 source-material-ID diagnostic views;
- isolation renders for podium, roof, tiles, brackets/dougong, and plaque;
- a 29,885,795-byte `semantic-partition.json` covering all 83,580 components;
- zero integrity issues in `issues.json`;
- triangle sum of all exclusive leaves: 2,540,987.

It did **not** write `run-manifest.json`, so it is diagnostic partial evidence only. Its explicit
pause record is `evidence/v3/feiyun/semantic-partition/review-002/pause.json`. The partial partition
SHA-256 is:
`edff1d59d248528f85e5763cec0198f65e8574f4cf88a70698f7827a2ac7c878`.

### Canonical semantic distribution (`review-020`)

| Hypothesis leaf | Components | Triangles |
| --- | ---: | ---: |
| foundation | 120 | 135,448 |
| podium | 279 | 242,151 |
| columns | 288 | 75,986 |
| beams | 0 | 0 |
| brackets/dougong | 3,487 | 298,143 |
| walls | 2,275 | 184,351 |
| doors/windows | 1,032 | 152,539 |
| railings | 1,124 | 25,034 |
| rafters | 0 | 0 |
| sheathing | 134 | 270,695 |
| tiles | 11,033 | 456,595 |
| eaves | 556 | 320,895 |
| ridges | 48 | 18,164 |
| ornaments/finial | 482 | 14,893 |
| plaques | 0 | 0 |
| secondary details | 62,722 | 346,093 |

Counts still prove coverage/exclusivity rather than approval. Approval comes from review 010's
manifest-bound visible decision record. The three empty leaves are not silent omissions: each has
an explicit `not-present` disposition and merge/evidence boundary.

## Exact continuation procedure

1. Confirm no stale process: `Get-Process blender,node -ErrorAction SilentlyContinue` and distinguish
   unrelated Node processes by start time/path before stopping anything.
2. Treat all prior partition directories as immutable evidence. The canonical package is
   `semantic-partition/review-020`; G2 decisions are in `semantic-review/review-010`.
3. Re-run `npm run validate:semantic-coverage -- feiyun review-010` and
   `npm run validate:structure-mapping -- feiyun review-001` before starting or accepting G4 work.
4. Do not rerun or overwrite any existing semantic review. Any correction must use a new
   run/review ID and preserve the prior evidence.
5. Keep runtime replacement blocked while generating and independently validating G4 LOD/pack
   exports (`preview`, `core`, `roof`, `detail`, `plaque`, `hero`).

## Remaining project work

- Generate Feiyun's G4 LOD/pack evidence, then materials, lighting, and runtime integration.
- Apply the same evidence-gated DCC process to Penglai, Huanghe, Tengwang, and Yueyang.
- Research and place each real plaque using the correct inscription, position, orientation, and
  suitable Chinese font; plaque text must not be guessed from geometry.
- Add concise factual introductions and real poem/prose appreciation for each tower.
- Generate or author tower-specific scene backdrops, then add lightweight shader/particle/cloud,
  water, foliage, and lighting motion with reduced-motion and performance fallbacks.
- Implement progressive pack loading, budgeted detail tiers, compressed textures, and measure
  first interaction/load targets.
- Complete browser seven-view capture, low-angle regression, runtime-loading smoke tests, and
  performance audit for later gates.

## Quality and safety boundaries

- The legacy `.img2threejs/state.json` remains stopped at
  `max-correction-loops-reached:form-refinement:3/3`; it must not be rewritten or bypassed.
- The V3 DCC jobs are separate, immutable evidence runs. Every retry uses a new run/review ID.
- No automatic semantic label is approved by count, hash, or script output alone.
- No partial review directory may be promoted to runtime.
- No production GLB has been replaced during the work summarized here.
