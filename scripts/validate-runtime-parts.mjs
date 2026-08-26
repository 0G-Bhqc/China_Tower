import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const workspace = resolve(import.meta.dirname, '..');
const report = JSON.parse(await readFile(resolve(workspace, 'evidence/3d-assets/runtime-parts.json'), 'utf8'));
const expectedIds = ['yueyang', 'huanghe', 'tengwang'];
const minimumParts = { yueyang: 300, huanghe: 11, tengwang: 13 };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(report.schemaVersion === 1 && report.status === 'passed', 'Runtime parts report is not passed');
assert(Array.isArray(report.assets) && report.assets.length === expectedIds.length, 'Exactly three finished-pavilion part inventories are required');
assert(JSON.stringify(report.assets.map((asset) => asset.id)) === JSON.stringify(expectedIds), 'Part inventory scope must be yueyang, huanghe, tengwang');
assert(new Set(report.assets.map((asset) => asset.id)).size === expectedIds.length, 'Part inventory asset IDs must be unique');

for (const asset of report.assets) {
  assert(asset.id in minimumParts, `Unexpected part inventory: ${asset.id}`);
  assert(asset.partCount === asset.parts.length, `Part count drift: ${asset.id}`);
  assert(asset.partCount >= minimumParts[asset.id], `Insufficient retained parts: ${asset.id}`);
  const ids = asset.parts.map((part) => part.id);
  assert(new Set(ids).size === ids.length, `Duplicate stable part ID: ${asset.id}`);
  assert(ids.every((id) => id.startsWith(`${asset.id}-`)), `Part ID prefix drift: ${asset.id}`);
  assert(asset.parts.every((part) => part.label && part.category), `Missing part metadata: ${asset.id}`);
  assert(ids.includes(asset.selectedPart), `Pointer-selected part not in inventory: ${asset.id}`);
  assert(asset.interaction === 'orbit-low-angle-pick-explode-reset-passed', `Interaction gate failed: ${asset.id}`);
  assert(asset.resetExplodedAmount < 0.001, `Reset transform drift: ${asset.id}`);
}

console.log(`Runtime parts OK: ${report.assets.reduce((sum, asset) => sum + asset.partCount, 0).toLocaleString()} stable parts across three finished high models.`);
