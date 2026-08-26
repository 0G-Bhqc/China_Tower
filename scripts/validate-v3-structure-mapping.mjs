import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [assetId = 'feiyun', reviewId = 'review-001'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(assetId) || !/^review-\d{3}$/.test(reviewId)) {
  throw new Error('Usage: npm run validate:structure-mapping -- <asset-id> <review-NNN>');
}

const reviewDir = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-hierarchy', reviewId);
const manifestPath = path.join(reviewDir, 'run-manifest.json');
const decisionPath = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-hierarchy-review', reviewId, 'g3-decision.json');
const sha256 = async (pathname) => createHash('sha256').update(await readFile(pathname)).digest('hex');
const requireFile = async (pathname) => {
  const details = await stat(pathname);
  if (!details.isFile() || details.size === 0) throw new Error(`Missing or empty file: ${pathname}`);
  return details;
};
const readJson = async (pathname) => JSON.parse(await readFile(pathname, 'utf8'));

await requireFile(manifestPath);
const manifest = await readJson(manifestPath);
await requireFile(decisionPath);
const decision = await readJson(decisionPath);
if (manifest.schemaVersion !== 1 || manifest.track !== 'dcc-highmodel-v3-semantic-hierarchy' || manifest.assetId !== assetId) {
  throw new Error('G3 manifest identity mismatch');
}
if (!manifest.reviewOnly || manifest.runtimeReplacement !== false || !manifest.integrity?.passed) {
  throw new Error('G3 review-only/integrity invariant failed');
}
if (
  decision.schemaVersion !== 1
  || decision.gate !== 'G3'
  || decision.assetId !== assetId
  || decision.reviewStatus !== 'approved'
  || decision.result !== 'passed'
  || decision.hierarchy.manifestSha256 !== await sha256(manifestPath)
  || decision.hierarchy.reviewGlbSha256 !== manifest.outputs.reviewGlbSha256
  || decision.mappingChain.join('>') !== 'sourceObject>blenderObject>semanticNode>glbNode>runtimeStableId'
  || decision.admission.runtimeReplacement !== false
) {
  throw new Error('G3 decision identity, hash binding, or review status mismatch');
}

for (const [pathKey, hashKey] of [
  ['fbx', 'fbxSha256'],
  ['catalog', 'catalogSha256'],
  ['partition', 'partitionSha256'],
  ['partitionManifest', 'partitionManifestSha256'],
  ['g2Decisions', 'g2DecisionsSha256'],
  ['job', 'jobSha256'],
]) {
  const pathname = manifest.input[pathKey];
  await requireFile(pathname);
  if (await sha256(pathname) !== manifest.input[hashKey]) throw new Error(`G3 input hash mismatch: ${pathKey}`);
}

// A reviewed evidence manifest binds the builder hash used at creation time. The live pipeline
// file may evolve for later stages (B3 added material/UV/normal transport). That drift must be
// visible, but it must not invalidate already hash-bound G3 outputs and their approved decision.
await requireFile(manifest.input.script);
const currentScriptSha256 = await sha256(manifest.input.script);
const scriptMatchesHistoricalInput = currentScriptSha256 === manifest.input.scriptSha256;

const partitionManifest = await readJson(manifest.input.partitionManifest);
const g2Decisions = await readJson(manifest.input.g2Decisions);
if (g2Decisions.result !== 'passed' || g2Decisions.partition.manifestSha256 !== manifest.input.partitionManifestSha256) {
  throw new Error('G3 is not bound to the passed canonical G2 manifest');
}

const hierarchyPath = path.join(reviewDir, manifest.outputs.hierarchy);
const glbPath = path.join(reviewDir, manifest.outputs.reviewGlb);
await requireFile(hierarchyPath);
const glbStat = await requireFile(glbPath);
if (await sha256(glbPath) !== manifest.outputs.reviewGlbSha256 || glbStat.size !== manifest.outputs.reviewGlbBytes) {
  throw new Error('Review GLB hash/size mismatch');
}
const hierarchy = await readJson(hierarchyPath);
if (
  hierarchy.track !== 'dcc-highmodel-v3-semantic-hierarchy'
  || hierarchy.assetId !== assetId
  || hierarchy.reviewOnly !== true
  || hierarchy.mappingChain.join('>') !== 'sourceObject>blenderObject>semanticNode>glbNode>runtimeStableId'
) {
  throw new Error('Hierarchy identity or mapping chain mismatch');
}

const requiredLeaves = g2Decisions.decisions.map((entry) => entry.semanticNode).sort();
const semanticNodes = new Map(hierarchy.semanticNodes.map((entry) => [entry.semanticNode, entry]));
if (semanticNodes.size !== requiredLeaves.length || requiredLeaves.some((leaf) => !semanticNodes.has(leaf))) {
  throw new Error('Hierarchy does not contain every G2 semantic leaf');
}
const decisionByLeaf = new Map(g2Decisions.decisions.map((entry) => [entry.semanticNode, entry.decision]));
for (const leaf of requiredLeaves) {
  const node = semanticNodes.get(leaf);
  if (node.decision !== decisionByLeaf.get(leaf)) throw new Error(`G2/G3 decision mismatch: ${leaf}`);
  if (!node.glbNode || !node.runtimeStableId || !node.parentRuntimeStableId || !node.lodPolicy) {
    throw new Error(`Incomplete semantic-node contract: ${leaf}`);
  }
  if (node.decision === 'not-present' && (node.componentCount !== 0 || node.triangles !== 0 || node.interaction.clickable)) {
    throw new Error(`Invalid not-present hierarchy leaf: ${leaf}`);
  }
}

const compositeKeys = new Set();
const componentTotalsByChunk = new Map();
let componentTriangles = 0;
for (const entry of hierarchy.components) {
  const key = `${entry.sourceObject}\u0000${entry.sourceRootVertex}`;
  if (compositeKeys.has(key)) throw new Error(`Duplicate composite component mapping: ${key}`);
  compositeKeys.add(key);
  for (const field of hierarchy.mappingChain) {
    if (!entry[field]) throw new Error(`Incomplete mapping field ${field}: ${key}`);
  }
  if (!entry.sourceObjectHash || !entry.sourceGeometryFingerprint || !entry.hierarchyBlenderObject) {
    throw new Error(`Incomplete source/hierarchy provenance: ${key}`);
  }
  const aggregate = componentTotalsByChunk.get(entry.runtimeStableId) ?? { components: 0, triangles: 0 };
  aggregate.components += 1;
  aggregate.triangles += entry.triangles;
  componentTotalsByChunk.set(entry.runtimeStableId, aggregate);
  componentTriangles += entry.triangles;
}
if (compositeKeys.size !== manifest.integrity.components || componentTriangles !== manifest.integrity.hierarchyTriangles) {
  throw new Error('G3 component or triangle coverage mismatch');
}

const chunkIds = new Set();
const chunkNodes = new Set();
let chunkTriangles = 0;
for (const chunk of hierarchy.chunks) {
  if (chunkIds.has(chunk.runtimeStableId) || chunkNodes.has(chunk.glbNode)) throw new Error('Duplicate stable ID or GLB node');
  chunkIds.add(chunk.runtimeStableId);
  chunkNodes.add(chunk.glbNode);
  const expectedPrefix = `${assetId}/part/${chunk.semanticNode}/src-${chunk.sourceObjectHash.slice(0, 12)}`;
  if (chunk.runtimeStableId !== expectedPrefix) throw new Error(`Traversal-dependent or malformed stable ID: ${chunk.runtimeStableId}`);
  if (chunk.transformMatrixWorld.length !== 16 || !chunk.interaction.clickable || !chunk.lodPolicy) {
    throw new Error(`Incomplete runtime part contract: ${chunk.runtimeStableId}`);
  }
  const totals = componentTotalsByChunk.get(chunk.runtimeStableId);
  if (!totals || totals.components !== chunk.components || totals.triangles !== chunk.triangles) {
    throw new Error(`Chunk/component aggregation mismatch: ${chunk.runtimeStableId}`);
  }
  chunkTriangles += chunk.triangles;
}
if (chunkIds.size !== manifest.integrity.glbMeshNodes || chunkTriangles !== manifest.integrity.hierarchyTriangles) {
  throw new Error('G3 chunk coverage mismatch');
}

const glb = await readFile(glbPath);
if (glb.readUInt32LE(0) !== 0x46546c67 || glb.readUInt32LE(4) !== 2 || glb.readUInt32LE(8) !== glb.length) {
  throw new Error('Invalid GLB 2.0 header');
}
const jsonLength = glb.readUInt32LE(12);
if (glb.readUInt32LE(16) !== 0x4e4f534a) throw new Error('GLB JSON chunk missing');
const gltf = JSON.parse(glb.subarray(20, 20 + jsonLength).toString('utf8').trimEnd());
const gltfNodes = new Map((gltf.nodes ?? []).map((node, index) => [node.name, { ...node, index }]));
for (const node of hierarchy.semanticNodes) {
  const gltfNode = gltfNodes.get(node.glbNode);
  if (!gltfNode || gltfNode.extras?.runtimeStableId !== node.runtimeStableId || gltfNode.extras?.semanticNode !== node.semanticNode) {
    throw new Error(`Semantic GLB extras mismatch: ${node.semanticNode}`);
  }
}
for (const chunk of hierarchy.chunks) {
  const gltfNode = gltfNodes.get(chunk.glbNode);
  if (!gltfNode || gltfNode.mesh === undefined) throw new Error(`GLB mesh node missing: ${chunk.glbNode}`);
  if (
    gltfNode.extras?.runtimeStableId !== chunk.runtimeStableId
    || gltfNode.extras?.semanticNode !== chunk.semanticNode
    || gltfNode.extras?.sourceObjectHash !== chunk.sourceObjectHash
  ) {
    throw new Error(`GLB runtime extras mismatch: ${chunk.glbNode}`);
  }
}

let glbTriangles = 0;
for (const mesh of gltf.meshes ?? []) {
  for (const primitive of mesh.primitives ?? []) {
    if (primitive.mode !== undefined && primitive.mode !== 4) throw new Error('Non-triangle GLB primitive found');
    const accessorIndex = primitive.indices ?? primitive.attributes?.POSITION;
    const count = gltf.accessors?.[accessorIndex]?.count;
    if (!Number.isInteger(count) || count % 3 !== 0) throw new Error('Invalid GLB primitive index count');
    glbTriangles += count / 3;
  }
}
if (glbTriangles !== manifest.integrity.hierarchyTriangles) throw new Error('GLB triangle count differs from hierarchy evidence');

console.log(JSON.stringify({
  gate: 'G3',
  assetId,
  reviewId,
  result: 'passed',
  sourceObjects: manifest.integrity.sourceObjects,
  components: compositeKeys.size,
  triangles: glbTriangles,
  semanticLeaves: semanticNodes.size,
  glbMeshNodes: chunkIds.size,
  reviewGlbBytes: glbStat.size,
  reviewGlbSha256: manifest.outputs.reviewGlbSha256,
  replayProvenance: {
    historicalScriptSha256: manifest.input.scriptSha256,
    currentScriptSha256,
    currentScriptMatchesHistoricalInput: scriptMatchesHistoricalInput,
    status: scriptMatchesHistoricalInput ? 'exact-current-script-match' : 'historical-script-hash-bound-current-pipeline-evolved',
  },
  runtimeReplacement: false,
}, null, 2));
