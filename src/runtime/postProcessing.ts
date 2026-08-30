import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { createGodRaysPass, GodRaysPass } from './godRays';

// Cinematic finishing for the poetic scene: HDR chain + Unreal bloom so dusk
// skies, lantern glow and water speculars read like graded footage, sealed by
// a soft filmic grade (split-tone, vignette, animated fine grain). Mobile runs
// the same grade through a lean composer (no bloom, no MSAA) so the per-tower
// mood survives on the low tier at roughly one fullscreen pass of cost.

export type TowerGradePreset = 'yueyang' | 'huanghe' | 'tengwang';

type GradePreset = {
  // Multiplicative split-tone: shadows and highlights each pull toward a tint,
  // weighted by luminance so midtones stay honest.
  shadowTint: [number, number, number];
  highlightTint: [number, number, number];
  tintStrength: number;
  // Contrast pivots on midtone grey; lift raises the black point (misty air).
  contrast: number;
  lift: number;
  saturation: number;
  vignette: number;
  grain: number;
};

export const TOWER_GRADE_PRESETS: Record<TowerGradePreset, GradePreset> = {
  // 岳阳 · 晨雾清冷: cool grey-teal shadows, lifted blacks for lake mist, a
  // touch more grain so the dawn haze shimmers instead of banding.
  yueyang: {
    shadowTint: [0.88, 0.96, 1.04], highlightTint: [1.02, 1.01, 0.98],
    tintStrength: 0.5, contrast: 0.97, lift: 0.022, saturation: 1.0, vignette: 0.3, grain: 0.034,
  },
  // 黄鹤 · 江天暖金: golden highlights under a high sun, warm-neutral shadows,
  // the crispest and brightest grade of the three.
  huanghe: {
    shadowTint: [1.01, 0.99, 0.95], highlightTint: [1.05, 1.0, 0.9],
    tintStrength: 0.55, contrast: 1.04, lift: 0.008, saturation: 1.08, vignette: 0.3, grain: 0.026,
  },
  // 滕王 · 落霞绛紫: orange-magenta high lights against teal-violet shadows,
  // deeper vignette — the dusk grade the 落霞与孤鹜 mood hangs on.
  tengwang: {
    shadowTint: [0.9, 0.9, 1.05], highlightTint: [1.06, 0.94, 0.84],
    tintStrength: 0.62, contrast: 1.05, lift: 0.012, saturation: 1.06, vignette: 0.38, grain: 0.03,
  },
};

const FilmGradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    uTime: { value: 0 },
    uShadowTint: { value: new THREE.Vector3(1, 1, 1) },
    uHighlightTint: { value: new THREE.Vector3(1, 1, 1) },
    uTintStrength: { value: 0 },
    uContrast: { value: 1 },
    uLift: { value: 0 },
    // Per-cue mood bias (set via setMoodBias, eased in render): a colour
    // multiplier plus a shadow-weighted exposure nudge.
    uMoodTint: { value: new THREE.Vector3(1, 1, 1) },
    uMoodExposure: { value: 0 },
    // Square-root falloff from the corners: strong enough to focus the
    // composition on the tower, soft enough to pass for optics, not a filter.
    uVignette: { value: 0.32 },
    // Animated blue-noise-ish grain lifts near-black gradients (dusk sky, water
    // at night) past 8-bit banding. Amplitude stays under self-perception.
    uGrain: { value: 0.028 },
    uSaturation: { value: 1.07 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uTime;
    uniform vec3 uShadowTint;
    uniform vec3 uHighlightTint;
    uniform float uTintStrength;
    uniform float uContrast;
    uniform float uLift;
    uniform vec3 uMoodTint;
    uniform float uMoodExposure;
    uniform float uVignette;
    uniform float uGrain;
    uniform float uSaturation;
    varying vec2 vUv;

    float hash12(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }

    void main() {
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb;

      // Gentle saturation around Rec.709 luma.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(luma), color, uSaturation);

      // Split-tone: shadows pull one way, highlights the other, midtones stay
      // untouched. Multiplicative so HDR values above 1 keep their energy.
      float shadowWeight = 1.0 - smoothstep(0.0, 0.55, luma);
      float highlightWeight = smoothstep(0.35, 1.1, luma);
      vec3 tint = mix(uHighlightTint, uShadowTint, shadowWeight);
      color *= mix(vec3(1.0), tint, uTintStrength * clamp(shadowWeight + highlightWeight, 0.0, 1.0));

      // Contrast about mid grey, then a shadow-weighted lift for misty blacks.
      color = (color - 0.18) * uContrast + 0.18;
      color += uLift * shadowWeight;

      // Cue mood bias: colour multiplier plus an exposure nudge weighted to
      // protect already-bright regions.
      color *= uMoodTint;
      color *= 1.0 + uMoodExposure * (1.0 - min(luma, 1.0) * 0.55);

      // Film grain: centered, temporally re-rolled so it shimmers like stock.
      float grain = (hash12(vUv * vec2(1613.0, 919.0) + fract(uTime) * 97.0) - 0.5) * uGrain;
      // Grain rides midtones least and shadows most, like real negative stock.
      color += grain * (1.0 - luma * 0.65);

      // Vignette in squared-distance space with a smooth floor.
      vec2 centered = vUv - 0.5;
      float d = dot(centered, centered) * uVignette * 2.6;
      color *= 1.0 - smoothstep(0.05, 0.75, d) * uVignette;

      gl_FragColor = vec4(color, texel.a);
    }
  `,
};

function applyPreset(shaderPass: ShaderPass, preset: GradePreset): void {
  const uniforms = shaderPass.uniforms;
  uniforms.uShadowTint.value.set(...preset.shadowTint);
  uniforms.uHighlightTint.value.set(...preset.highlightTint);
  uniforms.uTintStrength.value = preset.tintStrength;
  uniforms.uContrast.value = preset.contrast;
  uniforms.uLift.value = preset.lift;
  uniforms.uSaturation.value = preset.saturation;
  uniforms.uVignette.value = preset.vignette;
  uniforms.uGrain.value = preset.grain;
}

export type PostStack = {
  setBloomStrength: (strength: number) => void;
  setGrade: (preset: TowerGradePreset) => void;
  setMoodBias: (bias: { tint: [number, number, number]; exposure: number } | null) => void;
  setGodRays: (sunDirection: THREE.Vector3, strength: number, sunColor: string) => void;
  setGodRaysExcluded: (objects: Array<THREE.Object3D | null>) => void;
  setSize: (width: number, height: number) => void;
  render: () => void;
  dispose: () => void;
};

// Cue mood bias target; identity until a poetic cue asks otherwise.
const moodBiasNeutral = { tint: [1, 1, 1] as [number, number, number], exposure: 0 };
let moodBiasTarget = moodBiasNeutral;
const moodTmpVector = new THREE.Vector3();

export function createPostStack(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  quality: 'hero' | 'standard' | 'mobile',
): PostStack {
  const size = renderer.getSize(new THREE.Vector2());
  let composer: EffectComposer;
  let msaaRenderTarget: THREE.WebGLRenderTarget | null = null;

  if (quality === 'mobile') {
    // Lean chain: the grade is one fullscreen pass, bloom is dropped entirely.
    composer = new EffectComposer(renderer);
    composer.addPass(new RenderPass(scene, camera));
  } else {
    // The composer renders into its own targets, silently bypassing the canvas
    // MSAA — give the HDR targets their own multisamples so tower eaves and
    // balustrades stay crisp instead of buzzing with post-chain aliasing.
    const msaaSamples = quality === 'hero' ? 4 : 2;
    msaaRenderTarget = new THREE.WebGLRenderTarget(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio(), {
      type: THREE.HalfFloatType,
      samples: msaaSamples,
    });
    composer = new EffectComposer(renderer, msaaRenderTarget);
    composer.addPass(new RenderPass(scene, camera));
  }

  // God rays sit between render and bloom so the streaks themselves bloom.
  let godRaysPass: GodRaysPass | null = null;
  if (quality !== 'mobile') {
    godRaysPass = createGodRaysPass(scene, camera, renderer, size.x, size.y);
    composer.addPass(godRaysPass);
  }

  let bloomPass: UnrealBloomPass | null = null;
  if (quality !== 'mobile') {
    // Outdoor HDR skies sit well above luminance 1 almost everywhere, so a low
    // threshold blooms the entire sky into a milky veil. Only the sun disk and
    // specular glints (luminance >6) pass; the wider radius feathers the halo
    // so glints read as atmospheric glow, not hard sprites.
    bloomPass = new UnrealBloomPass(new THREE.Vector2(size.x, size.y), 0.5, 0.35, 6);
    composer.addPass(bloomPass);
  }

  const gradePass = new ShaderPass(FilmGradeShader);
  composer.addPass(gradePass);
  composer.addPass(new OutputPass());

  return {
    setBloomStrength: (strength: number) => {
      if (bloomPass) bloomPass.strength = strength;
    },
    setGrade: (preset: TowerGradePreset) => {
      applyPreset(gradePass, TOWER_GRADE_PRESETS[preset]);
    },
    setMoodBias: (bias) => {
      moodBiasTarget = bias ?? moodBiasNeutral;
    },
    setGodRays: (sunDirection: THREE.Vector3, strength: number, sunColor: string) => {
      godRaysPass?.setSunDirection(sunDirection);
      godRaysPass?.setSunColor(sunColor);
      godRaysPass?.setStrength(strength);
    },
    setGodRaysExcluded: (objects: Array<THREE.Object3D | null>) => {
      godRaysPass?.setExcluded(objects);
    },
    setSize: (width: number, height: number) => {
      composer.setSize(width, height);
      bloomPass?.setSize(width, height);
      godRaysPass?.setSize(width, height);
    },
    render: () => {
      gradePass.uniforms.uTime.value = performance.now() / 1000;
      // Ease the mood bias toward its target (~0.7s at 60fps).
      const moodUniforms = gradePass.uniforms;
      const blend = 0.055;
      moodUniforms.uMoodTint.value.lerp(moodTmpVector.set(...moodBiasTarget.tint), blend);
      moodUniforms.uMoodExposure.value += (moodBiasTarget.exposure - moodUniforms.uMoodExposure.value) * blend;
      composer.render();
    },
    dispose: () => {
      godRaysPass?.dispose();
      bloomPass?.dispose();
      gradePass.dispose();
      composer.dispose();
      msaaRenderTarget?.dispose();
    },
  };
}
