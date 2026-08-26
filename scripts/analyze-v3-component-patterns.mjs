import { createHash } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [assetId, sourceRun = 'run-002', reviewId = 'review-001'] = process.argv.slice(2);
const allowedAssets = new Set(['feiyun', 'penglai', 'huanghe', 'tengwang', 'yueyang']);
if (!allowedAssets.has(assetId) || !/^run-\d{3}$/.test(sourceRun) || !/^review-\d{3}$/.test(reviewId)) {
  throw new Error('Usage: npm run v3:patterns -- <asset-id> <run-NNN> <review-NNN>');
}

const sourceRoot = path.join(projectRoot, 'evidence', 'v3', assetId, 'dissection', sourceRun);
const catalogPath = path.join(sourceRoot, 'component-catalog.json');
const outputRoot = path.join(projectRoot, 'evidence', 'v3', assetId, 'semantic-review', reviewId);
const outputPath = path.join(outputRoot, 'pattern-analysis.json');
try {
  await stat(outputPath);
  throw new Error(`Refusing to overwrite pattern evidence: ${path.relative(projectRoot, outputPath)}`);
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const catalogBuffer = await readFile(catalogPath);
const catalogSha256 = createHash('sha256').update(catalogBuffer).digest('hex');
const catalog = JSON.parse(catalogBuffer.toString('utf8'));
if (catalog.assetId !== assetId) throw new Error('Component catalog identity mismatch');

function quantize(value) {
  const step = value < 0.05 ? 0.005 : value < 0.5 ? 0.02 : value < 2 ? 0.05 : value < 10 ? 0.15 : 0.3;
  return Math.round(value / step) * step;
}

function triangleBucket(triangles) {
  const step = triangles < 16 ? 2 : triangles < 64 ? 4 : triangles < 256 ? 16 : triangles < 1024 ? 64 : 256;
  return Math.max(step, Math.round(triangles / step) * step);
}

function primaryHypothesis(component) {
  return [...component.semanticHypotheses].sort((a, b) => b.confidence - a.confidence)[0];
}

function signature(component, primary) {
  const [dx, dy, dz] = component.boundsMeters.dimensions;
  const horizontal = [quantize(dx), quantize(dy)].sort((a, b) => a - b);
  const materials = component.materials.map((item) => item.name).sort().join('+');
  if (component.shapeFingerprint) {
    return `${primary.semanticNode}|shape${component.shapeFingerprint}|m${materials}`;
  }
  return `${primary.semanticNode}|tb${triangleBucket(component.triangles)}|d${horizontal[0].toFixed(3)},${horizontal[1].toFixed(3)},${quantize(dz).toFixed(3)}|m${materials}`;
}

const overall = catalog.boundsMeters;
const overallHeight = Math.max(overall.dimensions[2], 1e-6);
const groups = new Map();
const semanticSummary = new Map();

for (const component of catalog.components) {
  const primary = primaryHypothesis(component);
  const key = signature(component, primary);
  const centerZ = component.boundsMeters.center[2];
  const normalizedHeight = (centerZ - overall.minimum[2]) / overallHeight;
  const heightBand = Math.max(0, Math.min(11, Math.floor(normalizedHeight * 12)));
  const group = groups.get(key) ?? {
    signature: key,
    semanticNode: primary.semanticNode,
    confidence: primary.confidence,
    componentIds: [],
    triangles: 0,
    sourceObjects: new Set(),
    heightBands: new Array(12).fill(0),
    exampleDimensions: component.boundsMeters.dimensions,
    maximumSpan: Math.max(...component.boundsMeters.dimensions),
  };
  group.componentIds.push(component.id);
  group.triangles += component.triangles;
  group.sourceObjects.add(component.sourceObject);
  group.heightBands[heightBand] += 1;
  groups.set(key, group);

  const summary = semanticSummary.get(primary.semanticNode) ?? { components: 0, triangles: 0, repeatComponents: 0, repeatTriangles: 0 };
  summary.components += 1;
  summary.triangles += component.triangles;
  semanticSummary.set(primary.semanticNode, summary);
}

const patternGroups = [...groups.values()]
  .filter((group) => group.componentIds.length >= 4)
  .map((group) => {
    const id = `pattern-${createHash('sha1').update(group.signature).digest('hex').slice(0, 12)}`;
    const repeatCandidate = group.componentIds.length >= 4 && group.triangles >= 64 && group.maximumSpan >= 0.08;
    if (repeatCandidate) {
      const summary = semanticSummary.get(group.semanticNode);
      summary.repeatComponents += group.componentIds.length;
      summary.repeatTriangles += group.triangles;
    }
    return {
      id,
      status: 'hypothesis',
      semanticNode: group.semanticNode,
      confidence: group.confidence,
      repeatCandidate,
      componentCount: group.componentIds.length,
      triangleTotal: group.triangles,
      sourceObjectCount: group.sourceObjects.size,
      sourceObjects: [...group.sourceObjects].sort(),
      heightBands: group.heightBands,
      exampleDimensionsMeters: group.exampleDimensions,
      signature: group.signature,
      componentIds: group.componentIds,
    };
  })
  .sort((a, b) => b.componentCount - a.componentCount || b.triangleTotal - a.triangleTotal);

const admittedComponentIds = new Set(patternGroups.flatMap((group) => group.componentIds));
const output = {
  schemaVersion: 1,
  track: 'dcc-highmodel-v3',
  assetId,
  source: {
    run: sourceRun,
    componentCatalog: path.relative(projectRoot, catalogPath).replaceAll('\\', '/'),
    componentCatalogSha256: catalogSha256,
    componentCount: catalog.componentCount,
    triangles: catalog.triangles,
  },
  method: {
    status: 'hypothesis',
    dimensions: 'fallback only: orientation-normalized horizontal dimensions with scale-aware quantization',
    topology: 'preferred: transform-invariant vertex/triangle/sorted-edge-length SHA-1 fingerprint; fallback: triangle-count bucket',
    material: 'source material name set',
    repeatCandidateMinimum: '4 components, 64 aggregate triangles and 0.08 m minimum maximum span',
    limitation: 'matching dimensions/topology/material does not prove an architectural role; isolation renders are mandatory',
  },
  summary: {
    patternGroupCount: patternGroups.length,
    repeatCandidateCount: patternGroups.filter((group) => group.repeatCandidate).length,
    groupedComponentCount: admittedComponentIds.size,
    ungroupedComponentCount: catalog.componentCount - admittedComponentIds.size,
    semantics: Object.fromEntries([...semanticSummary.entries()].sort(([left], [right]) => left.localeCompare(right))),
  },
  topRepeatCandidates: patternGroups.filter((group) => group.repeatCandidate).slice(0, 120).map((group) => group.id),
  patternGroups,
  reviewState: 'needs-isolation-render-review',
  nextAction: 'Render the top repeat candidates and semantic masks before approving instancing or architectural labels.',
};

await mkdir(outputRoot, { recursive: true });
await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({
  status: 'completed',
  assetId,
  sourceRun,
  reviewId,
  componentCount: catalog.componentCount,
  patternGroupCount: output.summary.patternGroupCount,
  repeatCandidateCount: output.summary.repeatCandidateCount,
  groupedComponentCount: output.summary.groupedComponentCount,
}, null, 2));
