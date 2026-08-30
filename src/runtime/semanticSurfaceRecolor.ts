import * as THREE from 'three';

/**
 * Runtime semantic surface recolouring.
 *
 * Source FBX conversions carry a large share of geometry on placeholder
 * materials: no texture node and a near-white diffuse.  Those regions render
 * as blank clay.  The Yueyang loader fixes this with hand-calibrated material
 * colours; this module generalises the idea by deriving a semantic colour for
 * every face of an untextured mesh:
 *
 *   - upward-facing, high      -> dark tile roof
 *   - downward-facing          -> timber red (eave undersides, bracket sets)
 *   - vertical, upper          -> vermilion structure (railings, doors, posts)
 *   - vertical, lower          -> warm plaster wall
 *   - upward-facing, low       -> stone platform
 *
 * Colours are written as vertex colours so one merged mesh can carry all five
 * zones, and each face gets a small hash-based value variation so large flat
 * regions do not read as a single plastic tone.
 */

export interface SemanticPalette {
  roof: number;
  timber: number;
  vermilion: number;
  wall: number;
  stone: number;
}

export const DEFAULT_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x3b4038,
  timber: 0x5a2a20,
  vermilion: 0x8c3126,
  wall: 0xd6c5a3,
  stone: 0x97917f,
};

function isNearWhite(color: THREE.Color): boolean {
  return color.r > 0.78 && color.g > 0.78 && color.b > 0.78;
}

/** True when the material is an untextured near-white placeholder. */
export function needsSemanticRecolor(material: THREE.Material): boolean {
  if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) {
    return false;
  }
  return !material.map && isNearWhite(material.color);
}

/** Exported for loader-side placeholder audits. */
export function isNearWhitePlaceholder(material: THREE.Material): boolean {
  if (!(material instanceof THREE.MeshStandardMaterial) && !(material instanceof THREE.MeshPhysicalMaterial)) {
    return false;
  }
  return !material.map && material.color && isNearWhite(material.color);
}

function faceHash(a: number, b: number, c: number): number {
  let h = a * 92837111 + b * 689287499 + c * 283923481;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const _vA = new THREE.Vector3();
const _vB = new THREE.Vector3();
const _vC = new THREE.Vector3();
const _e1 = new THREE.Vector3();
const _e2 = new THREE.Vector3();
const _n = new THREE.Vector3();
const _cent = new THREE.Vector3();

/**
 * Barrel-tile ridge modulation for roof faces.
 *
 * Ridges run down the slope, so the stripe phase advances along the eave
 * direction (horizontal, perpendicular to the downhill gradient).  The result
 * reads as individual tile courses when the camera moves close, without any
 * texture asset.
 */
function tileRidgeFactor(
  centroid: THREE.Vector3,
  normal: THREE.Vector3,
  tileWidth: number,
): number {
  const hx = normal.x;
  const hz = normal.z;
  let ex: number;
  let ez: number;
  if (Math.abs(hx) + Math.abs(hz) < 1e-4) {
    // Flat roof: fall back to stripes along world X.
    ex = 1;
    ez = 0;
  } else {
    // Eave direction = horizontal perpendicular to the downhill gradient.
    const invLen = 1 / Math.hypot(hx, hz);
    ex = -hz * invLen;
    ez = hx * invLen;
  }
  const phase = (centroid.x * ex + centroid.z * ez) / tileWidth;
  // Smooth triangle wave in [0, 1]. Kept nearly flat: vertex colours are
  // interpolated without mipmaps, so any visible stripe contrast turns into
  // distance glitter once roof tessellation approaches pixel density. The
  // tile-course relief is carried by the zone normal maps instead.
  const frac = phase - Math.floor(phase);
  const tri = 1 - Math.abs(frac * 2 - 1);
  return 0.94 + 0.08 * tri * tri;
}

/**
 * Recolour every face of the mesh via vertex colours and swap in a
 * vertex-colour material.  Returns true when the mesh was recoloured.
 *
 * `options.upwardZone` controls how upward faces are zoned:
 *   - 'auto' (default): upward faces below 42% of the mesh's own height are
 *     treated as stone.  Correct for meshes that mix roofs and stone.
 *   - 'roof': every upward face is roof.  Required when one mesh spans the
 *     whole tower (e.g. the Huanghe #25 roof mesh): the in-mesh height gate
 *     would otherwise misclassify the lower roof tiers as stone.
 * `options.slopeAsRoof` routes tilted faces (normal.y > 0.18) to the roof zone
 *   instead of wall/vermilion.  Chinese pavilion roofs are steep; without it
 *   the slope faces fall under the vertical gate and read as plaster.  Enable
 *   it only for meshes known to be roof-dominated (auxiliary pavilions).
 * `options.verticalZone` overrides the vertical-face gate: 'height' (default)
 *   splits wall/vermilion by height; 'vermilion' paints every vertical face
 *   vermilion — right for whole-tower roof meshes whose vertical faces are all
 *   fascia and brackets, where the pink wall tone speckles the eave bands.
 */
export function recolorMeshSurfaces(
  mesh: THREE.Mesh,
  palette: SemanticPalette = DEFAULT_SEMANTIC_PALETTE,
  options: { upwardZone?: 'auto' | 'roof'; slopeAsRoof?: boolean; verticalZone?: 'height' | 'vermilion' } = {},
): boolean {
  const geometry = mesh.geometry;
  const position = geometry.getAttribute('position');
  if (!position) return false;

  const source = mesh.material;
  if (!(source instanceof THREE.MeshStandardMaterial) && !(source instanceof THREE.MeshPhysicalMaterial)) {
    return false;
  }

  geometry.computeBoundingBox();
  const bbox = geometry.boundingBox!;
  const height = Math.max(bbox.max.y - bbox.min.y, 1e-6);

  const colors = new Float32Array(position.count * 3);
  const zoneColors = {
    roof: new THREE.Color(palette.roof),
    timber: new THREE.Color(palette.timber),
    vermilion: new THREE.Color(palette.vermilion),
    wall: new THREE.Color(palette.wall),
    stone: new THREE.Color(palette.stone),
  };

  // Mark vertex -> zone colour assignment (last write wins is fine; the
  // semantic boundaries are creases by construction).
  const assigned = new Uint8Array(position.count);
  const zoneFaceCounts: Record<keyof typeof zoneColors, number> = { roof: 0, timber: 0, vermilion: 0, wall: 0, stone: 0 };
  let faceTotal = 0;

  const index = geometry.getIndex();
  const triangleCount = index ? index.count / 3 : position.count / 3;

  for (let t = 0; t < triangleCount; t++) {
    let ia: number, ib: number, ic: number;
    if (index) {
      ia = index.getX(t * 3);
      ib = index.getX(t * 3 + 1);
      ic = index.getX(t * 3 + 2);
    } else {
      ia = t * 3;
      ib = t * 3 + 1;
      ic = t * 3 + 2;
    }

    _vA.fromBufferAttribute(position, ia);
    _vB.fromBufferAttribute(position, ib);
    _vC.fromBufferAttribute(position, ic);

    _e1.subVectors(_vB, _vA);
    _e2.subVectors(_vC, _vA);
    _n.crossVectors(_e1, _e2);
    if (_n.lengthSq() < 1e-12) continue;
    _n.normalize();

    _cent.copy(_vA).add(_vB).add(_vC).multiplyScalar(1 / 3);
    const heightNorm = THREE.MathUtils.clamp((_cent.y - bbox.min.y) / height, 0, 1);

    let zone: keyof typeof zoneColors;
    if (_n.y > 0.55) {
      zone = options.upwardZone === 'roof' || heightNorm > 0.42 ? 'roof' : 'stone';
    } else if (options.slopeAsRoof && _n.y > 0.18) {
      // Steep roof slope: tilted upward but under the flat-roof gate. Walls
      // are vertical (normal.y ≈ 0) so this band is roof-safe.
      zone = 'roof';
    } else if (_n.y < -0.5) {
      zone = 'timber';
    } else if (options.verticalZone === 'vermilion' || heightNorm > 0.55) {
      zone = 'vermilion';
    } else {
      zone = 'wall';
    }
    zoneFaceCounts[zone] += 1;
    faceTotal += 1;

    // Deterministic per-face value variation so broad surfaces keep grain.
    // Roof faces get a tighter band: their tessellation is so dense that
    // per-face contrast reads as TV static at distance rather than grain.
    const hash01 = faceHash(
      Math.round(_cent.x * 16.7),
      Math.round(_cent.y * 16.7),
      Math.round(_cent.z * 16.7),
    );
    const variation = zone === 'roof' ? 0.95 + 0.08 * hash01 : 0.9 + 0.16 * hash01;
    // Roof faces additionally carry procedural barrel-tile ridges so the
    // surface reads as tile courses at close range. Wider courses (0.55m
    // floor) keep the stripe period above per-triangle size so it does not
    // alias into glitter.
    const ridge = zone === 'roof' ? tileRidgeFactor(_cent, _n, Math.max(height * 0.012, 0.55)) : 1;
    const base = zoneColors[zone];
    for (const vi of [ia, ib, ic]) {
      if (assigned[vi]) continue;
      colors[vi * 3] = Math.min(base.r * variation * ridge, 1);
      colors[vi * 3 + 1] = Math.min(base.g * variation * ridge, 1);
      colors[vi * 3 + 2] = Math.min(base.b * variation * ridge, 1);
      assigned[vi] = 1;
    }
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

  // Publish the dominant zone so loaders can layer zone-matched relief
  // (normal/roughness) textures on top of the vertex-colour albedo.
  let dominantZone: keyof typeof zoneColors = 'wall';
  let dominantCount = -1;
  for (const [zone, count] of Object.entries(zoneFaceCounts)) {
    if (count > dominantCount) {
      dominantCount = count;
      dominantZone = zone as keyof typeof zoneColors;
    }
  }
  mesh.userData.semanticZone = faceTotal > 0 ? dominantZone : null;

  const recolored = source.clone();
  recolored.color.set(0xffffff);
  recolored.vertexColors = true;
  recolored.roughness = Math.min(recolored.roughness, 0.82);
  recolored.metalness = Math.min(recolored.metalness, 0.08);
  recolored.name = `${source.name}-semantic`;
  mesh.material = recolored;
  return true;
}
