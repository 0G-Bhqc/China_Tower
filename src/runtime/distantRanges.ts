import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';

// 远山 — the layer that makes the vista read as 壮阔.
//
// Every 意境 line this project is built on assumes a mountain range that the
// scene did not have. 岳阳楼 is 「衔远山，吞长江」 — it *holds* distant
// mountains in its mouth; 滕王阁序 gives 「层峦耸翠，上出重霄」 and 「烟光凝而
// 暮山紫」; 崔颢's 黄鹤楼 line is 「晴川历历汉阳树」, the far bank seen clearly.
// Until now the horizon was bare water meeting an HDRI sky, so the frame had
// width but no depth: nothing between the tower and the sky to measure the
// distance against. A wide empty horizon reads as *small*, not as *vast* —
// scale needs an intermediate register.
//
// Three concentric ridge lines do that job. The reading depends entirely on
// aerial perspective: each layer sits at a different distance, so it picks up
// a different amount of haze, and the eye reads the value steps between them
// as depth. That is why the haze is done here in a custom shader rather than
// leaning on scene.fog — FogExp2 is a function of camera distance only, which
// would flatten all three ridges to the same tone and lose the layering.

export type DistantRangesQuality = 'hero' | 'standard' | 'mobile';

type Sector = {
  /** Bearing of the massif centre, radians (atan2(x, z)). */
  centre: number;
  halfWidth: number;
  /** 0 = hard-edged, 1 = the whole sector is a feather. */
  feather: number;
};

type LayerSpec = {
  radius: number;
  /** Crest height above the water line, metres. */
  height: number;
  /** Rock tone before haze — what the crests read as. */
  color: string;
  /** Haze at the water line, 0 = pin sharp, 1 = fully dissolved. */
  haze: number;
  seed: number;
  /** Omit for a full ring. */
  sector?: Sector;
};

type TowerRangeSpec = {
  layers: LayerSpec[];
  /**
   * How far the ridge drops across the sun's bearing. The gap is not a cheat:
   * it is the 江口 / 湖口 where the river meets the lake, which is also the one
   * place the range may not stand in front of the sun disc.
   */
  sunCorridor: number;
  /** e-folding height of the haze blanket, metres. Small = haze hugs the water. */
  hazeFalloff: number;
  sunWrap: number;
};

// --- Per-tower ranges ---------------------------------------------------
// Heights are not arbitrary: each layer's PEAK is set to sit roughly one
// degree of elevation above the layer in front of it, while its MEAN ridge
// line (CREST_MEAN of the peak) sits below that previous peak. That
// interleaving is the mechanism of 层峦叠嶂 — you see the next range's
// average skyline below the near range's summits, and its summits above them.
// Flatten all three to the same elevation and they fuse into one silhouette.
//
// The absolute metres look small for mountains because the water plane ends
// at 2 km: these are stylised hills placed close enough to subtend the angle
// a real 20 km-distant range would.
//
// Elevation is the only honest way to set these, because the camera height is
// not authored anywhere — it falls out of the model span in main.ts, and it
// differs per tower. Measured with scripts/verify-distant-ranges.cjs --camera:
//
//   yueyang  camera 22.5 m above water      tengwang  21.3 m
//   huanghe  camera 36.9 m above water      (fov 42°, so 1° ~= 2.4% of frame)
//
// An earlier pass guessed the heights and every crest ended up BELOW the
// eye-level horizon, which reads as low islands rather than a range. Peaks are
// therefore set to land at 2.0-2.2°, 3.1-3.4° and 4.4-4.8° of elevation:
//   yueyang  36 /  78 / 140 m at 560 / 1150 / 1560 m  -> 1.4° / 2.8° / 4.3°
//   huanghe  66 / 107 / 176 m at 760 / 1180 / 1660 m  -> 1.8° / 3.4° / 4.8°
//   tengwang 50 /  93 / 162 m at 900 / 1260 / 1680 m  -> 1.9° / 3.3° / 4.8°
// Each mean (CREST_MEAN of the peak) still sits below the preceding peak.
const TOWER_RANGES: Record<PavilionId, TowerRangeSpec> = {
  // 洞庭湖: 「浩浩汤汤，横无际涯」. The lake is the subject, so the shore is
  // faint, low and far — only 君山, the island the tower looks across at, gets
  // to be near enough to read as land.
  yueyang: {
    sunCorridor: 0.5,
    hazeFalloff: 128,
    sunWrap: 0.16,
    layers: [
      // 君山 — 「前望君山」. Placed on the default framing's bearing
      // (atan2(-23, -39) ≈ -2.61 rad from sceneCatalog) so the island is in
      // shot without hunting for it.
      { radius: 560, height: 36, color: '#4f5f5c', haze: 0.4, seed: 11, sector: { centre: -2.55, halfWidth: 0.52, feather: 0.55 } },
      { radius: 1150, height: 78, color: '#6d7b80', haze: 0.66, seed: 3 },
      { radius: 1560, height: 140, color: '#8d979b', haze: 0.86, seed: 7 },
    ],
  },
  // 长江: 「晴川历历汉阳树」 — 历历 means *clearly*. Of the three this is the
  // one whose far bank must be legible, so it carries the least haze and the
  // nearest ridges. A hazy 晴川 would contradict the line it is illustrating.
  huanghe: {
    sunCorridor: 0.35,
    hazeFalloff: 178,
    sunWrap: 0.12,
    layers: [
      { radius: 760, height: 66, color: '#5b6a66', haze: 0.3, seed: 5 },
      { radius: 1180, height: 107, color: '#78868a', haze: 0.52, seed: 13 },
      { radius: 1660, height: 176, color: '#96a2a6', haze: 0.74, seed: 21 },
    ],
  },
  // 赣江: 「层峦耸翠，上出重霄」 and 「烟光凝而暮山紫」. The tallest and the most
  // coloured — a violet rock tone under a warm haze is exactly how 暮山紫
  // happens, the two hues mixing to purple rather than any single purple.
  // Also the only tower whose sun disc sits on the water line, so it gets the
  // full sun corridor: the disc sets into the river mouth.
  tengwang: {
    // Was 1 (crest -> 0 at the sun bearing). With the old 0.42 corridor that
    // erased the skyline across the whole frame; at 0.6 the range dips to ~40%
    // under the disc and recovers to ~92% by the frame edges, so the disc sits
    // in a valley instead of in an empty sky.
    sunCorridor: 0.6,
    hazeFalloff: 150,
    sunWrap: 0.2,
    layers: [
      { radius: 900, height: 50, color: '#5f4a63', haze: 0.44, seed: 17 },
      { radius: 1260, height: 93, color: '#84688a', haze: 0.66, seed: 23 },
      { radius: 1680, height: 162, color: '#a58aa8', haze: 0.84, seed: 31 },
    ],
  },
};

// Integer frequencies only. Non-integer ones produce a visible seam where the
// ring wraps at θ = 2π, and a seam in a skyline is exactly the kind of thing
// the eye goes straight to.
const OCTAVES = [3, 5, 11, 23];
const OCTAVE_WEIGHTS = [1, 0.55, 0.3, 0.16];
const OCTAVE_WEIGHT_SUM = OCTAVE_WEIGHTS.reduce((sum, weight) => sum + weight, 0);

// Half-width of the sun corridor, radians (~15°).
//
// Was 0.42 (24°), which sounds narrow but is not: the falloff is Gaussian, so
// the ridge stays suppressed out to roughly 2.2x this, i.e. a ~66° gap. That
// is wider than the 42° vertical fov. For tengwang — whose default view points
// straight at its sun — a 0.42 corridor pressed the crest to ~1% of peak
// across the *entire frame*, so the tower that most needs 层峦耸翠 had no
// mountains anywhere in shot. A 江口 is a gap you can see the far bank past,
// not the whole range ending.
const CORRIDOR_WIDTH = 0.26;

// Ridged noise comes out ~N(0.363, 0.178). These map it onto a skyline: the
// mean ridge line lands at CREST_MEAN of the layer's peak height, and valleys
// bottom out at CREST_FLOOR rather than at zero — a ridge that touches the
// water reads as a hole in the range, not as a low ridge.
const CREST_FLOOR = 0.28;
const CREST_MEAN = 0.58;

function wrapAngle(angle: number): number {
  return Math.atan2(Math.sin(angle), Math.cos(angle));
}

/**
 * Ridged noise: 1 - |sin| produces sharp crests, where a plain sine gives
 * dunes. Four octaves is enough — past that the extra detail falls below one
 * pixel at these distances and only costs the mirror render.
 */
function ridgedNoise(theta: number, seed: number): number {
  let sum = 0;
  for (let index = 0; index < OCTAVES.length; index += 1) {
    const wave = Math.sin(theta * OCTAVES[index] + seed * (index + 1) * 1.7);
    sum += (1 - Math.abs(wave)) * OCTAVE_WEIGHTS[index];
  }
  return sum / OCTAVE_WEIGHT_SUM;
}

/** Soft-edged angular window for massifs that occupy only part of the ring. */
function sectorMask(theta: number, sector: Sector): number {
  const offset = Math.abs(wrapAngle(theta - sector.centre));
  const inner = sector.halfWidth * (1 - sector.feather);
  if (offset <= inner) return 1;
  if (offset >= sector.halfWidth) return 0;
  const t = (sector.halfWidth - offset) / Math.max(1e-5, sector.halfWidth - inner);
  return t * t * (3 - 2 * t);
}

function corridorMultiplier(theta: number, sunBearing: number, strength: number): number {
  const offset = wrapAngle(theta - sunBearing);
  return 1 - strength * Math.exp(-((offset / CORRIDOR_WIDTH) ** 2));
}

function buildRidgeGeometry(
  layer: LayerSpec,
  segments: number,
  waterY: number,
  sunBearing: number,
  corridorStrength: number,
): THREE.BufferGeometry {
  // Two vertices per column — a base tucked well under the water line so the
  // plane hides it — wrapped into a triangle strip that closes on itself.
  const baseY = waterY - 140;
  const positions = new Float32Array((segments + 1) * 2 * 3);
  for (let column = 0; column <= segments; column += 1) {
    const theta = (column / segments) * Math.PI * 2;
    // A little radius wobble at wrap-safe frequencies, so the range is not a
    // perfect circle. Under heavy haze this reads as ridges sitting at
    // slightly different depths rather than as one wall.
    const wobble = 1 + 0.055 * Math.sin(theta * 3 + layer.seed) + 0.035 * Math.sin(theta * 7 + layer.seed * 1.9);
    const radius = layer.radius * wobble;
    const noise = ridgedNoise(theta, layer.seed);
    const crest = CREST_FLOOR + (1 - CREST_FLOOR) * THREE.MathUtils.clamp((noise - 0.12) / 0.58, 0, 1);
    const sector = layer.sector ? sectorMask(theta, layer.sector) : 1;
    const height = layer.height * crest * sector * corridorMultiplier(theta, sunBearing, corridorStrength);
    const offset = column * 6;
    positions[offset] = Math.sin(theta) * radius;
    positions[offset + 1] = baseY;
    positions[offset + 2] = Math.cos(theta) * radius;
    positions[offset + 3] = Math.sin(theta) * radius;
    // Crest anchors at the WATER LINE + height, not at baseY + height. The
    // original `baseY + height` double-counted the 140 m base offset and put
    // every crest under the surface: the ranges rendered ONLY in the mirror
    // reflection (strong deltas in the water, exactly zero in the sky —
    // run-005 row sampling). The elevation design above (1.4°-4.8°) and the
    // --camera probe both assume height above the water line; this keeps
    // the geometry honest to both.
    positions[offset + 4] = waterY + height;
    positions[offset + 5] = Math.cos(theta) * radius;
  }

  const indices = new Uint32Array(segments * 6);
  for (let column = 0; column < segments; column += 1) {
    const bottom = column * 2;
    const next = (column + 1) * 2;
    const offset = column * 6;
    indices[offset] = bottom;
    indices[offset + 1] = next;
    indices[offset + 2] = bottom + 1;
    indices[offset + 3] = bottom + 1;
    indices[offset + 4] = next;
    indices[offset + 5] = next + 1;
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

function createRidgeMaterial(waterY: number): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uRock: { value: new THREE.Color('#6d7b80') },
      uHaze: { value: new THREE.Color('#a9b2a9') },
      uHazeAmount: { value: 0.6 },
      uHazeFalloff: { value: 150 },
      uWaterY: { value: waterY },
      uSunDir: { value: new THREE.Vector3(0, 0, 1) },
      uSunTint: { value: new THREE.Color('#ffd9a0') },
      uSunWrap: { value: 0.15 },
    },
    vertexShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_vertex>
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = world.xyz;
        gl_Position = projectionMatrix * viewMatrix * world;
        #include <logdepthbuf_vertex>
      }
    `,
    fragmentShader: /* glsl */ `
      #include <common>
      #include <logdepthbuf_pars_fragment>
      uniform vec3 uRock;
      uniform vec3 uHaze;
      uniform float uHazeAmount;
      uniform float uHazeFalloff;
      uniform float uWaterY;
      uniform vec3 uSunDir;
      uniform vec3 uSunTint;
      uniform float uSunWrap;
      varying vec3 vWorld;
      void main() {
        #include <logdepthbuf_fragment>
        // Haze thins with altitude: valley floors dissolve into the water
        // while crests stay legible. This is the whole ball game — it is what
        // separates three overlapping ridges from one flat paper cut-out.
        float altitude = max(0.0, vWorld.y - uWaterY);
        float thinning = exp(-altitude / uHazeFalloff);
        float amount = clamp(uHazeAmount * (0.32 + 0.68 * thinning), 0.0, 1.0);
        vec3 colour = mix(uRock, uHaze, amount);
        // Broad wrap light. Deliberately weak: at 1-2 km the atmosphere owns
        // the value, not the sun. Front-lit flank lifts, backlit flank sinks.
        vec3 outward = normalize(vec3(vWorld.x, 0.0, vWorld.z) + vec3(1e-4));
        float frontLit = max(0.0, -dot(outward, uSunDir));
        colour += uSunTint * pow(frontLit, 1.6) * uSunWrap * (1.0 - amount * 0.65);
        colour *= mix(0.93, 1.0, frontLit);
        gl_FragColor = vec4(colour, 1.0);
      }
    `,
    side: THREE.DoubleSide,
    // The haze above is this layer's atmosphere, so scene.fog must not
    // double-count it — FogExp2 is camera-distance only and would flatten
    // every ridge to the same tone.
    fog: false,
    transparent: false,
    depthWrite: true,
  });
}

export type DistantRanges = {
  root: THREE.Group;
  setActive: (id: PavilionId, sunTint: THREE.Color) => void;
  /** Called every frame so the ridges follow the live fog/mood colour. */
  syncHaze: (fogColor: THREE.Color) => void;
  dispose: () => void;
};

export function createDistantRanges(
  quality: DistantRangesQuality,
  waterY: number,
  // The corridor is baked into the ridge geometry, so the sun bearing has to
  // be known at build time. It is read through a callback rather than copied
  // into TOWER_RANGES: the sun direction belongs to the lighting rig, and a
  // second copy of it would drift the moment a sky is retuned.
  sunDirectionOf: (id: PavilionId) => readonly [number, number, number],
): DistantRanges {
  const root = new THREE.Group();
  root.name = 'distant-ranges';
  const segments = quality === 'hero' ? 320 : quality === 'standard' ? 192 : 128;

  // All three towers are built up front and toggled. Rebuilding geometry on a
  // tower switch would hitch on exactly the frame the user is waiting for.
  const perTower = new Map<PavilionId, { group: THREE.Group; materials: THREE.ShaderMaterial[] }>();

  for (const [id, spec] of Object.entries(TOWER_RANGES) as Array<[PavilionId, TowerRangeSpec]>) {
    const group = new THREE.Group();
    group.name = `${id}-distant-ranges`;
    group.visible = false;
    const materials: THREE.ShaderMaterial[] = [];
    // Bearing of the *drawn* sun, not the analytic key light — tengwang drops
    // its disc onto the water line via diskDirection, and that disc is the
    // object the range has to stay out of the way of.
    const sunDirection = sunDirectionOf(id);
    const sunBearing = Math.atan2(sunDirection[0], sunDirection[2]);
    const sunDir = new THREE.Vector3(sunDirection[0], 0, sunDirection[2]);
    if (sunDir.lengthSq() < 1e-8) sunDir.set(0, 0, 1);
    sunDir.normalize();
    for (const layer of spec.layers) {
      const material = createRidgeMaterial(waterY);
      material.uniforms.uHazeAmount.value = layer.haze;
      material.uniforms.uHazeFalloff.value = spec.hazeFalloff;
      material.uniforms.uSunWrap.value = spec.sunWrap;
      material.uniforms.uRock.value.set(layer.color);
      material.uniforms.uSunDir.value.copy(sunDir);
      const geometry = buildRidgeGeometry(layer, segments, waterY, sunBearing, spec.sunCorridor);
      const mesh = new THREE.Mesh(geometry, material);
      mesh.name = `${id}-ridge-${layer.radius}`;
      // Ranges never cast or receive: they sit beyond the shadow camera's
      // span, and a shadow out there would only fight the haze.
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
      group.add(mesh);
      materials.push(material);
    }
    root.add(group);
    perTower.set(id, { group, materials });
  }

  let active: PavilionId = 'yueyang';
  perTower.get('yueyang')!.group.visible = true;

  return {
    root,
    setActive(id, tint) {
      const entry = perTower.get(id);
      if (!entry) return;
      for (const [key, other] of perTower) other.group.visible = key === id;
      active = id;
      for (const material of entry.materials) material.uniforms.uSunTint.value.copy(tint);
    },
    syncHaze(fogColor) {
      const entry = perTower.get(active);
      if (!entry) return;
      for (const material of entry.materials) {
        (material.uniforms.uHaze.value as THREE.Color).copy(fogColor);
      }
    },
    dispose() {
      for (const { group, materials } of perTower.values()) {
        group.traverse((object) => {
          if (object instanceof THREE.Mesh) object.geometry.dispose();
        });
        for (const material of materials) material.dispose();
      }
      perTower.clear();
      root.clear();
    },
  };
}
