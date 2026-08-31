import * as THREE from 'three';
import { FullScreenQuad, Pass } from 'three/examples/jsm/postprocessing/Pass.js';
import { GodRaysDepthMaskShader, GodRaysGenerateShader } from 'three/examples/jsm/shaders/GodRaysShader.js';

// Crepuscular rays adapted from the three.js god-rays technique (Sousa 2008):
// a MeshDepthMaterial pass turns the frame into a near-white/far-black mask,
// three radial-blur passes smear that mask toward the sun's screen position,
// and the combine pass adds the inverted smear over the colour buffer — bright
// rays across the sky, dark wedges behind the tower silhouette.
//
// The mask pass is depth-safe under the renderer's logarithmic depth buffer:
// MeshDepthMaterial writes 1 - gl_FragCoord.z, which stays monotonic in log
// space, and the blur/combine shaders never read the depth buffer directly.
// No sun mesh is needed — the HDRI's own sun disk anchors the effect while the
// masked background (cleared to black) supplies the ray energy.

const BLUR_STEP_SIZES = [1.0, 0.3, 0.075];

// Combine pass, adapted from the stock GodRaysCombineShader for a bright HDRI
// sky. The stock shader adds intensity * (1 - mask) unconditionally — correct
// against the example's near-black backdrop, but over a dawn lake it pushes an
// already-bright sky straight into clipped white. Two changes: the rays carry
// the per-tower sun tint instead of raw white, and the contribution is gated
// by the base pixel's tonal headroom, so blown regions stay untouched and the
// streaks land on water, midtones and the tower's radiating shadow wedges.
const TintedGodRaysCombineShader = {
  name: 'TintedGodRaysCombineShader',
  uniforms: {
    tColors: { value: null as THREE.Texture | null },
    tGodRays: { value: null as THREE.Texture | null },
    fGodRayIntensity: { value: 0.69 },
    uSunColor: { value: new THREE.Color(0xffe0b0) },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4( position, 1.0 );
    }
  `,
  fragmentShader: /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColors;
    uniform sampler2D tGodRays;
    uniform float fGodRayIntensity;
    uniform vec3 uSunColor;
    void main() {
      vec4 base = texture2D( tColors, vUv );
      // Blurred sky-visibility mask: ~1 where the line of sight to the sun
      // runs through open sky, ~0 behind the occluder wedge and far from the
      // sun. Structured energy that fades on its own — no global veil.
      float rays = texture2D( tGodRays, vUv ).r;
      float luma = dot( base.rgb, vec3( 0.2126, 0.7152, 0.0722 ) );
      // Only genuinely darker regions take the shafts; a bright dusk sky
      // needs no additive help and would clip into milk.
      float headroom = smoothstep( 0.62, 0.15, luma );
      base.rgb += uSunColor * ( fGodRayIntensity * rays * headroom );
      gl_FragColor = vec4( base.rgb, 1.0 );
    }
  `,
};

export type GodRaysSettings = {
  sunDirection: THREE.Vector3;
  sunColor: string;
  strength: number;
};

export type GodRaysPassHandle = {
  pass: GodRaysPass;
  setSunDirection: (direction: THREE.Vector3) => void;
  setStrength: (strength: number) => void;
  setExcluded: (objects: Array<THREE.Object3D | null>) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

export class GodRaysPass extends Pass {
  // The composer does not inject scene/camera into custom passes, so they
  // arrive through the constructor (RenderPass convention).
  scene: THREE.Scene;
  camera: THREE.Camera;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly depthMaterial: THREE.MeshDepthMaterial;
  private readonly maskMaterial: THREE.ShaderMaterial;
  private readonly generateMaterial: THREE.ShaderMaterial;
  private readonly combineMaterial: THREE.ShaderMaterial;
  private readonly renderTargetDepth: THREE.WebGLRenderTarget;
  private readonly renderTargetA: THREE.WebGLRenderTarget;
  private readonly renderTargetB: THREE.WebGLRenderTarget;
  private readonly fullscreenQuad = new FullScreenQuad(undefined);
  private readonly sunDirection = new THREE.Vector3(0, 0.3, -1).normalize();
  private readonly excluded: THREE.Object3D[] = [];
  private readonly clearColor = new THREE.Color();
  private strength = 0.8;
  private active = true;

  constructor(scene: THREE.Scene, camera: THREE.Camera, renderer: THREE.WebGLRenderer, width: number, height: number) {
    super();
    this.needsSwap = true;
    this.scene = scene;
    this.camera = camera;
    this.renderer = renderer;
    // Silhouette mask: near geometry reads white, sky black. Fog must not
    // tint the mask, and the depth write stays monotonic under the renderer's
    // logarithmic depth buffer.
    this.depthMaterial = new THREE.MeshDepthMaterial({ depthTest: true, depthWrite: true });
    // r179's MeshDepthMaterial typings omit `fog`; set through a narrow cast.
    (this.depthMaterial as unknown as { fog: boolean }).fog = false;
    this.generateMaterial = new THREE.ShaderMaterial(GodRaysGenerateShader);
    this.maskMaterial = new THREE.ShaderMaterial(GodRaysDepthMaskShader);
    this.combineMaterial = new THREE.ShaderMaterial(TintedGodRaysCombineShader);
    const size = this.maskSize(width, height);
    const options = { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, depthBuffer: false };
    this.renderTargetDepth = new THREE.WebGLRenderTarget(size.width, size.height, options);
    this.renderTargetA = new THREE.WebGLRenderTarget(size.width, size.height, options);
    this.renderTargetB = new THREE.WebGLRenderTarget(size.width, size.height, options);
  }

  private maskSize(width: number, height: number): { width: number; height: number } {
    // Quarter resolution mask — the blur erases the detail anyway, and the
    // reduced fill rate keeps the extra passes near-free.
    const ratio = this.renderer.getPixelRatio();
    return {
      width: Math.max(2, Math.floor((width * ratio) / 4)),
      height: Math.max(2, Math.floor((height * ratio) / 4)),
    };
  }

  setSunDirection(direction: THREE.Vector3): void {
    this.sunDirection.copy(direction).normalize();
  }

  setSunColor(color: string): void {
    (this.combineMaterial.uniforms.uSunColor.value as THREE.Color).set(color);
  }

  setStrength(strength: number): void {
    this.strength = strength;
    this.updateEnabled();
  }

  /** Pause the whole pass (e.g. while the camera is moving). */
  setActive(active: boolean): void {
    this.active = active;
    this.updateEnabled();
  }

  private updateEnabled(): void {
    this.enabled = this.active && this.strength > 0.01;
  }

  setExcluded(objects: Array<THREE.Object3D | null>): void {
    this.excluded.length = 0;
    for (const object of objects) if (object) this.excluded.push(object);
  }

  setSize(width: number, height: number): void {
    const size = this.maskSize(width, height);
    this.renderTargetDepth.setSize(size.width, size.height);
    this.renderTargetA.setSize(size.width, size.height);
    this.renderTargetB.setSize(size.width, size.height);
  }

  render(
    renderer: THREE.WebGLRenderer,
    writeBuffer: THREE.WebGLRenderTarget,
    readBuffer: THREE.WebGLRenderTarget,
  ): void {
    const scene = this.scene;
    const camera = this.camera;

    const prevClearColor = renderer.getClearColor(this.clearColor);
    const prevClearAlpha = renderer.getClearAlpha();
    const prevBackground = scene.background;
    const prevOverride = scene.overrideMaterial;

    // Hide animated/transparent props: the Water's onBeforeRender would
    // re-render the mirror scene a second time inside this pass, and the
    // billboard particles would punch solid holes into the mask.
    const hidden: THREE.Object3D[] = [];
    for (const object of this.excluded) {
      object.traverse((child) => {
        if (child.visible) {
          hidden.push(child);
          child.visible = false;
        }
      });
    }

    // Mask pass: geometry white (near), sky black. Background must be nulled
    // or the HDRI equirect would flood the mask with bright non-depth colour.
    scene.background = null;
    scene.overrideMaterial = this.depthMaterial;
    renderer.setRenderTarget(this.renderTargetDepth);
    renderer.setClearColor(0x000000, 1);
    renderer.clear();
    renderer.render(scene, camera);
    scene.overrideMaterial = prevOverride;
    scene.background = prevBackground;
    renderer.setClearColor(prevClearColor, prevClearAlpha);
    for (const child of hidden) child.visible = true;

    // Invert into a sky-visibility mask (sky ~1, occluders ~0) — the energy
    // term for the shafts, per the stock GodRaysDepthMaskShader.
    this.maskMaterial.uniforms.tInput.value = this.renderTargetDepth.texture;
    renderer.setRenderTarget(this.renderTargetA);
    this.fullscreenQuad.material = this.maskMaterial;
    this.fullscreenQuad.render(renderer);

    // Sun screen position drives the radial blur direction.
    const cameraSpace = this.sunDirection.clone().applyQuaternion((camera as THREE.PerspectiveCamera).quaternion);
    const facing = cameraSpace.z < 0;
    const ndc = this.sunDirection.clone().multiplyScalar(400).add(camera.position).project(camera as THREE.PerspectiveCamera);
    const sunScreenX = (ndc.x + 1) / 2;
    const sunScreenY = (ndc.y + 1) / 2;
    const offscreen = !facing || sunScreenX < -0.4 || sunScreenX > 1.4 || sunScreenY < -0.4 || sunScreenY > 1.4;
    // z drives the in-shader fade: 1000 = full, 0 = rays faded out when the
    // sun sits behind the camera or far off screen.
    this.generateMaterial.uniforms.vSunPositionScreenSpace.value.set(sunScreenX, sunScreenY, offscreen ? 0 : 1000);

    // Radial blur ping-pong: three passes with shrinking step sizes give the
    // large-support streaks without long per-pixel loops.
    let source: THREE.WebGLRenderTarget = this.renderTargetA;
    let target: THREE.WebGLRenderTarget = this.renderTargetB;
    for (const stepSize of BLUR_STEP_SIZES) {
      this.generateMaterial.uniforms.tInput.value = source.texture;
      this.generateMaterial.uniforms.fStepSize.value = stepSize;
      renderer.setRenderTarget(target);
      this.fullscreenQuad.material = this.generateMaterial;
      this.fullscreenQuad.render(renderer);
      const swap = source;
      source = target;
      target = swap;
    }

    // Combine additively over the colour buffer.
    this.combineMaterial.uniforms.tColors.value = readBuffer.texture;
    this.combineMaterial.uniforms.tGodRays.value = source.texture;
    this.combineMaterial.uniforms.fGodRayIntensity.value = this.strength;
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fullscreenQuad.material = this.combineMaterial;
    this.fullscreenQuad.render(renderer);
  }

  dispose(): void {
    this.renderTargetDepth.dispose();
    this.renderTargetA.dispose();
    this.renderTargetB.dispose();
    this.depthMaterial.dispose();
    this.maskMaterial.dispose();
    this.generateMaterial.dispose();
    this.combineMaterial.dispose();
    this.fullscreenQuad.dispose();
  }
}

export function createGodRaysPass(
  scene: THREE.Scene,
  camera: THREE.Camera,
  renderer: THREE.WebGLRenderer,
  width: number,
  height: number,
): GodRaysPass {
  return new GodRaysPass(scene, camera, renderer, width, height);
}

export type GodRaysRuntime = {
  setSettings: (settings: GodRaysSettings) => void;
  setExcluded: (objects: Array<THREE.Object3D | null>) => void;
  setSize: (width: number, height: number) => void;
  dispose: () => void;
};

/** Internal helper used by postProcessing to wire the pass. */
export function wireGodRays(pass: GodRaysPass, renderer: THREE.WebGLRenderer): GodRaysRuntime {
  return {
    setSettings: (settings) => {
      pass.setSunDirection(settings.sunDirection);
      if (settings.sunColor) pass.setSunColor(settings.sunColor);
      pass.setStrength(settings.strength);
    },
    setExcluded: (objects) => pass.setExcluded(objects),
    setSize: (width, height) => pass.setSize(width, height),
    dispose: () => pass.dispose(),
  };
}
