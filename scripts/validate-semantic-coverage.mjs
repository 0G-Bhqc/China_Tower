import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [assetId = 'feiyun', reviewId = 'review-010'] = process.argv.slice(2);
if (!/^[a-z0-9-]+$/.test(assetId) || !/^review-\d{3}$/.test(reviewId)) {
  throw new Error('Usage: npm run validate:semantic-coverage -- <asset-id> <review-NNN>');
}

const requiredLeaves = [
  'foundation',
  'podium',
  'structural-frame/columns',
  'structural-frame/beams',
  'structural-frame/brackets-dougong',
  'facade/walls',
  'facade/doors-windows',
  'facade/railings',
  'roof-system/rafters',
  'roof-system/sheathing',
  'roof-system/tiles',
  'roof-system/eaves',
  'roof-system/ridges',
  'roof-system/ornaments-finial',
  'plaques',
  'secondary-details',
];

const decisionPath = path.join(
  projectRoot,
  'evidence',
  'v3',
  assetId,
  'semantic-review',
  reviewId,
  'g2-decisions.json',
);

const readJson = async (pathname) => JSON.parse(await readFile(pathname, 'utf8'));
const sha256 = async (pathname) => createHash('sha256').update(await readFile(pathname)).digest('hex');
const requireFile = async (relativePath) => {
  const pathname = path.resolve(projectRoot, relativePath);
  const relative = path.relative(projectRoot, pathname);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`Evidence escapes project root: ${relativePath}`);
  const details = await stat(pathname);
  if (!details.isFile() || details.size === 0) throw new Error(`Evidence is missing or empty: ${relativePath}`);
  return pathname;
};

const review = await readJson(decisionPath);
if (review.schemaVersion !== 1 || review.gate !== 'G2' || review.assetId !== assetId) {
  throw new Error('G2 decision identity mismatch');
}
if (review.result !== 'passed' || review.reviewStatus !== 'approved') {
  throw new Error('G2 decision record is not approved/passed');
}

const manifestPath = await requireFile(review.partition.manifest);
if (await sha256(manifestPath) !== review.partition.manifestSha256) {
  throw new Error('Partition manifest SHA-256 does not match the approved review');
}
const manifest = await readJson(manifestPath);
if (manifest.track !== 'dcc-highmodel-v3-semantic-partition' || manifest.assetId !== assetId || !manifest.integrity?.passed) {
  throw new Error('Partition manifest identity or integrity failed');
}
const partitionPath = await requireFile(path.join(path.dirname(review.partition.manifest), manifest.outputs.semanticPartition));
const partition = await readJson(partitionPath);
if (partition.assetId !== assetId || partition.automaticLabelsAreApproved !== false) {
  throw new Error('Semantic partition identity or review-only invariant failed');
}

const decisions = new Map();
for (const entry of review.decisions ?? []) {
  if (decisions.has(entry.semanticNode)) throw new Error(`Duplicate G2 decision: ${entry.semanticNode}`);
  decisions.set(entry.semanticNode, entry);
}
for (const leaf of requiredLeaves) {
  const entry = decisions.get(leaf);
  if (!entry) throw new Error(`Missing mandatory G2 leaf decision: ${leaf}`);
  if (!['approved', 'not-present'].includes(entry.decision)) throw new Error(`Critical unknown G2 leaf: ${leaf}`);
  const summary = partition.summary?.[leaf];
  if (!summary) throw new Error(`Partition summary is missing mandatory leaf: ${leaf}`);
  if (entry.decision === 'approved' && summary.componentCount <= 0) {
    throw new Error(`Approved leaf has no components: ${leaf}`);
  }
  if (entry.decision === 'not-present') {
    if (summary.componentCount !== 0) throw new Error(`Not-present leaf still has assigned components: ${leaf}`);
    if (!entry.notPresentReason || !(entry.mergedInto?.length > 0 || entry.notPresentReason === 'no-independent-source-geometry')) {
      throw new Error(`Not-present leaf lacks explicit source-geometry disposition: ${leaf}`);
    }
  }
  if (!entry.rationale || !(entry.evidence?.length > 0)) throw new Error(`Decision lacks rationale/evidence: ${leaf}`);
  for (const evidencePath of entry.evidence) await requireFile(evidencePath);
}
if (decisions.size !== requiredLeaves.length) throw new Error('G2 decision record contains non-contract leaf decisions');

const assignmentKeys = new Set();
for (const assignment of partition.assignments ?? []) {
  const key = `${assignment.sourceObject}\u0000${assignment.sourceRootVertex}`;
  if (assignmentKeys.has(key)) throw new Error(`Duplicate composite component assignment: ${key}`);
  assignmentKeys.add(key);
}
if (assignmentKeys.size !== manifest.integrity.components) throw new Error('Composite assignment coverage mismatch');

console.log(JSON.stringify({
  gate: 'G2',
  assetId,
  reviewId,
  result: 'passed',
  approved: review.decisions.filter((entry) => entry.decision === 'approved').map((entry) => entry.semanticNode),
  notPresent: review.decisions.filter((entry) => entry.decision === 'not-present').map((entry) => entry.semanticNode),
  partitionManifestSha256: review.partition.manifestSha256,
  components: manifest.integrity.components,
  triangles: manifest.integrity.assignedTriangles,
}, null, 2));
