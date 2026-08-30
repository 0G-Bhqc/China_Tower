import * as THREE from 'three';
import type { PavilionId } from '../createPavilionGalleryModel';

// Per-tower ambient atmosphere: drifting petals/catkins and dusk fireflies. The direction is filmic restraint — sparse, slow, near the
// threshold of notice — so the particles grade the mood instead of becoming a
// game effect. Everything is pooled once at max count and reconfigured per
// pavilion in setPavilion; the tower switch only flips visibility and uniforms.

export type AmbientAtmosphere = {
  root: THREE.Group;
  setPavilion: (id: PavilionId) => void;
  update: (deltaSeconds: number, elapsed: number, camera: THREE.Camera) => void;
  dispose: () => void;
};

type TowerAtmos = {
  petals: { count: number; kind: 'catkin' | 'petal' | 'none'; tint: string; scale: [number, number] };
  fireflies: boolean;
};

const TOWER_ATMOS: Record<PavilionId, TowerAtmos> = {
  // 岳阳 · 洞庭晨雾: the strongest mist band, pale willow catkins.
  yueyang: {
      petals: { count: 55, kind: 'catkin', tint: '#f0e9d8', scale: [0.07, 0.13] },
    fireflies: false,
  },
  // 黄鹤 · 江雾落英: mid mist, vermilion-tinged petals falling off the plum.
  huanghe: {
      petals: { count: 120, kind: 'petal', tint: '#f2d3cb', scale: [0.12, 0.24] },
    fireflies: false,
  },
  // 滕王 · 落霞流萤: faint warm haze, no petals, fireflies over the terrace.
  tengwang: {
      petals: { count: 0, kind: 'none', tint: '#ffffff', scale: [0.1, 0.2] },
    fireflies: true,
  },
};

const WATER_Y = -0.62;
const QUALITY_SCALE: Record<'hero' | 'standard' | 'mobile', number> = { hero: 1, standard: 0.75, mobile: 0.5 };

function hash01(seed: number, salt: number): number {
  const value = Math.sin(seed * 269.5 + salt * 183.3) * 43758.5453;
  return value - Math.floor(value);
}

function createPetalTexture(): THREE.CanvasTexture {
  const size = 64;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas 2D context unavailable for petal texture');
  // Soft teardrop petal: brighter centre, feathered rim.
  const gradient = context.createRadialGradient(size / 2, size / 2.4, 2, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.95)');
  gradient.addColorStop(0.55, 'rgba(255,255,255,0.7)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  context.fillStyle = gradient;
  context.beginPath();
  context.ellipse(size / 2, size / 2, size * 0.32, size * 0.44, 0, 0, Math.PI * 2);
  context.fill();
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export function createAmbientAtmosphere(
  quality: 'hero' | 'standard' | 'mobile',
): AmbientAtmosphere {
  const root = new THREE.Group();
  root.name = 'ambient-atmosphere';
  const qualityScale = QUALITY_SCALE[quality];

  const petalTexture = createPetalTexture();

    // --- Petals / catkins (instanced quads) ---------------------------------
  const PETAL_MAX = 120;
  const petalMaterial = new THREE.MeshBasicMaterial({
    map: petalTexture,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
    opacity: 0.9,
  });
  const petalMesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), petalMaterial, PETAL_MAX);
  petalMesh.name = 'atmos-petals';
  petalMesh.renderOrder = 6;
  petalMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
  petalMesh.count = 0;
  petalMesh.frustumCulled = false;
  root.add(petalMesh);

  type PetalState = { baseX: number; baseZ: number; y: number; fallSpeed: number; swayAmp: number; swayFreq: number; phase: number; spin: number; scale: number };
  const petals: PetalState[] = [];
  for (let index = 0; index < PETAL_MAX; index += 1) {
    const angle = hash01(index, 91) * Math.PI * 2;
    const radius = 9 + hash01(index, 93) * 46;
    petals.push({
      baseX: Math.cos(angle) * radius,
      baseZ: Math.sin(angle) * radius,
      y: 3 + hash01(index, 95) * 22,
      fallSpeed: 0.32 + hash01(index, 97) * 0.5,
      swayAmp: 0.8 + hash01(index, 101) * 2.2,
      swayFreq: 0.4 + hash01(index, 103) * 0.9,
      phase: hash01(index, 107) * Math.PI * 2,
      spin: (hash01(index, 109) - 0.5) * 3,
      scale: 0.12,
    });
  }

  // --- Fireflies (additive shader points) ---------------------------------
  const FIREFLY_MAX = 70;
  const fireflyGeometry = new THREE.BufferGeometry();
  {
    const positions = new Float32Array(FIREFLY_MAX * 3);
    const seeds = new Float32Array(FIREFLY_MAX);
    for (let index = 0; index < FIREFLY_MAX; index += 1) {
      const angle = hash01(index, 111) * Math.PI * 2;
      const radius = 12 + hash01(index, 113) * 20;
      positions[index * 3] = Math.cos(angle) * radius;
      positions[index * 3 + 1] = 0.5 + hash01(index, 115) * 4;
      positions[index * 3 + 2] = Math.sin(angle) * radius;
      seeds[index] = hash01(index, 117) * 100;
    }
    fireflyGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    fireflyGeometry.setAttribute('aSeed', new THREE.BufferAttribute(seeds, 1));
  }
  const fireflyMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uPixelRatio: { value: Math.min(window.devicePixelRatio, 2) },
      uColor: { value: new THREE.Color('#ffcf7e') },
    },
    vertexShader: /* glsl */ `
      attribute float aSeed;
      uniform float uTime;
      uniform float uPixelRatio;
      varying float vPulse;
      void main() {
        vec3 p = position;
        float t = uTime * (0.25 + fract(aSeed * 0.731) * 0.35) + aSeed;
        p.x += sin(t) * 2.4;
        p.y += sin(t * 1.35 + 1.7) * 1.2;
        p.z += cos(t * 0.8 + 3.1) * 2.4;
        vPulse = 0.25 + 0.75 * pow(0.5 + 0.5 * sin(uTime * (1.2 + fract(aSeed * 0.37) * 1.4) + aSeed * 2.3), 3.0);
        vec4 mv = modelViewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        float size = (10.0 + fract(aSeed * 0.53) * 9.0) * uPixelRatio * (26.0 / max(1.0, -mv.z));
        gl_PointSize = clamp(size, 2.0, 22.0 * uPixelRatio);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor;
      varying float vPulse;
      void main() {
        vec2 d = gl_PointCoord - 0.5;
        float r = length(d) * 2.0;
        float alpha = smoothstep(1.0, 0.1, r) * vPulse;
        gl_FragColor = vec4(uColor * (0.6 + vPulse), alpha);
      }
    `,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
  });
  const fireflies = new THREE.Points(fireflyGeometry, fireflyMaterial);
  fireflies.name = 'atmos-fireflies';
  fireflies.renderOrder = 7;
  fireflies.frustumCulled = false;
  fireflies.visible = false;
  root.add(fireflies);

  // --- Configuration -------------------------------------------------------
  const setPavilion = (id: PavilionId): void => {
    const config = TOWER_ATMOS[id];
    const petalCount = Math.round(config.petals.count * qualityScale);
    petalMesh.count = petalCount;
    if (petalCount > 0) {
      petalMaterial.color.set(config.petals.tint);
      for (let index = 0; index < petalCount; index += 1) {
        petals[index].scale = config.petals.scale[0] + (config.petals.scale[1] - config.petals.scale[0]) * hash01(index, 123);
      }
    }
    fireflies.visible = config.fireflies;
  };

  const dummy = new THREE.Object3D();

  const update = (deltaSeconds: number, elapsed: number, camera: THREE.Camera): void => {
    // Petals: CPU-side fall/sway, one matrix compose per instance.
    if (petalMesh.count > 0) {
      const count = petalMesh.count;
      for (let index = 0; index < count; index += 1) {
        const state = petals[index];
        state.y -= state.fallSpeed * deltaSeconds;
        if (state.y < WATER_Y + 0.1) state.y = 12 + hash01(index, 131) * 16;
        const swayX = Math.sin(elapsed * state.swayFreq + state.phase) * state.swayAmp;
        const swayZ = Math.cos(elapsed * state.swayFreq * 0.8 + state.phase) * state.swayAmp * 0.7;
        dummy.position.set(state.baseX + swayX, state.y, state.baseZ + swayZ);
        dummy.rotation.set(elapsed * state.spin, elapsed * state.spin * 0.7 + state.phase, 0);
        dummy.scale.setScalar(state.scale);
        dummy.updateMatrix();
        petalMesh.setMatrixAt(index, dummy.matrix);
      }
      petalMesh.instanceMatrix.needsUpdate = true;
    }
    if (fireflies.visible) {
      fireflyMaterial.uniforms.uTime.value = elapsed;
    }
  };

  const dispose = (): void => {
    petalTexture.dispose();
    petalMesh.geometry.dispose();
    petalMaterial.dispose();
    fireflyGeometry.dispose();
    fireflyMaterial.dispose();
  };

  setPavilion('yueyang');

  return { root, setPavilion, update, dispose };
}
