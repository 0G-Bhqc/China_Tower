import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { detectDeviceQualityProfile, selectAvailableLod, type RuntimeLod } from './runtime/DeviceQualityProfile';
import { assetUrl, isAbortError, loadVerifiedGlb, type PavilionModelLoadOptions } from './runtime/loadVerifiedGlb';
import { registerPavilionAssembly } from './runtime/PavilionAssemblyRuntime';
import { computeStructuralBaseY } from './runtime/grounding';
import { createPlaqueMesh, type PlaqueSpec } from './runtime/createPlaqueMesh';
import { needsSemanticRecolor, recolorMeshSurfaces, type SemanticPalette, isNearWhitePlaceholder } from './runtime/semanticSurfaceRecolor';
import { applySemanticRelief, applyTengwangTierDetail } from './runtime/semanticRelief';
import { flipWindingIfMirrored } from './runtime/mergeAssemblyByMaterial';
import { MeshoptSimplifier } from './vendor/meshopt_simplifier.module';

// ---------------------------------------------------------------------------
// High-precision admission: keep the master's fidelity, drop its invisible
// density. Every mesh simplifies toward a global triangle budget with a hard
// error ceiling (1% of each mesh's extent) and locked borders, so eave tips,
// ornaments and silhouettes never visibly degrade while flat expanses lose
// their redundant interior vertices. Afterwards geometries merge per material,
// collapsing 4500+ draw calls into a few hundred. Vendored simplifier:
// meshoptimizer 0.22 (MIT), the same algorithm gltfpack uses.
// ---------------------------------------------------------------------------
const HP_TRIANGLE_BUDGET = 3_200_000;
const HP_MAX_ERROR = 0.02;
const HP_MIN_SIMPLIFY_TRIANGLES = 600;

function compactGeometry(geometry: THREE.BufferGeometry, newIndices: Uint32Array): void {
  const position = geometry.getAttribute('position');
  const oldVertexCount = position.count;
  const remap = new Uint32Array(oldVertexCount).fill(0xffffffff);
  const indices = new Uint32Array(newIndices.length);
  let next = 0;
  for (let i = 0; i < newIndices.length; i += 1) {
    const source = newIndices[i];
    if (remap[source] === 0xffffffff) {
      remap[source] = next;
      next += 1;
    }
    indices[i] = remap[source];
  }
  for (const name of Object.keys(geometry.attributes)) {
    const attribute = geometry.getAttribute(name);
    const itemSize = attribute.itemSize;
    const ArrayCtor = (attribute.array as Float32Array).constructor as new (length: number) => Float32Array;
    const compacted = new ArrayCtor(next * itemSize);
    const source = attribute.array as ArrayLike<number>;
    for (let v = 0; v < oldVertexCount; v += 1) {
      const target = remap[v];
      if (target === 0xffffffff) continue;
      for (let c = 0; c < itemSize; c += 1) compacted[target * itemSize + c] = source[v * itemSize + c];
    }
    geometry.setAttribute(name, new THREE.BufferAttribute(compacted, itemSize));
  }
  geometry.setIndex(new THREE.BufferAttribute(indices, 1));
}

async function admitHighPrecisionBudget(assembly: THREE.Group): Promise<string> {
  if (!MeshoptSimplifier.supported) return 'simplifier unavailable, master kept whole';
  await MeshoptSimplifier.ready;
  const records: Array<{ geometry: THREE.BufferGeometry; triangleCount: number }> = [];
  let totalTriangles = 0;
  const meshList: THREE.Mesh[] = [];
  assembly.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshList.push(object as THREE.Mesh);
  });
  // 同一几何被多实例共享时只登记一次: 否则实例数会虚增总量,
  // 且同一几何被反复化简导致过度抽稀。
  const seenAdmissionGeometries = new Set<THREE.BufferGeometry>();
  for (const mesh of meshList) {
    const geometry = mesh.geometry;
    if (seenAdmissionGeometries.has(geometry)) continue;
    seenAdmissionGeometries.add(geometry);
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position');
    if (!index || !position) continue;
    const triangleCount = index.count / 3;
    if (triangleCount < HP_MIN_SIMPLIFY_TRIANGLES) continue;
    records.push({ geometry, triangleCount });
    totalTriangles += triangleCount;
  }
  if (totalTriangles <= HP_TRIANGLE_BUDGET) return `within budget (${Math.round(totalTriangles)} tris)`;
  const ratio = HP_TRIANGLE_BUDGET / totalTriangles;
  let before = 0;
  let after = 0;
  for (const [recordIndex, { geometry, triangleCount }] of records.entries()) {
    before += triangleCount;
    const targetTriangles = Math.max(3, Math.floor(triangleCount * ratio));
    const sourceIndices = new Uint32Array(geometry.getIndex()!.array);
    const positions = geometry.getAttribute('position').array as Float32Array;
    const [simplified] = MeshoptSimplifier.simplify(sourceIndices, positions, 3, targetTriangles * 3, HP_MAX_ERROR, ['LockBorder']);
    if (simplified.length < sourceIndices.length) {
      compactGeometry(geometry, simplified);
      after += simplified.length / 3;
    } else {
      after += triangleCount;
    }
    // 后台升级时数千网格连续简化会冻结主线程: 每 8 个让出一帧, 进度条与
    // 运镜保持活着。hero 首载同理受益, 开销仅数毫秒。
    if ((recordIndex & 7) === 7) await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return `simplified ${Math.round(before)} → ${Math.round(after)} tris (error ≤ ${(HP_MAX_ERROR * 100).toFixed(1)}% of extent, borders locked)`;
}

/**
 * Merge per-material geometry groups into single meshes so the 4500-mesh
 * master stops costing 4500 draw calls per frame. Parts that survived the
 * merge keep multi-material meshes intact; registered assembly parts become
 * the merged groups (pick/explode operate at that granularity).
 */
function mergeAssemblyByMaterial(assembly: THREE.Group): number {
  assembly.updateMatrixWorld(true);
  // Bake each mesh's transform RELATIVE to the assembly, not world: merged
  // meshes re-enter as children of the assembly and must not inherit its
  // scale/position a second time.
  const inverseAssembly = new THREE.Matrix4().copy(assembly.matrixWorld).invert();
  const meshList: THREE.Mesh[] = [];
  assembly.traverse((object) => {
    if ((object as THREE.Mesh).isMesh) meshList.push(object as THREE.Mesh);
  });
  type Group = { material: THREE.Material; attributesKey: string; geometries: THREE.BufferGeometry[] };
  const groups = new Map<string, Group>();
  const kept: THREE.Mesh[] = [];
  const bakedGeometries: THREE.BufferGeometry[] = [];
  for (const mesh of meshList) {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const geometry = mesh.geometry;
    if (materials.length !== 1 || !geometry.index) {
      kept.push(mesh);
      continue;
    }
    const attributesKey = Object.keys(geometry.attributes).sort()
      .map((name) => `${name}:${geometry.getAttribute(name).itemSize}`)
      .join('|');
    const key = `${materials[0].uuid}::${attributesKey}`;
    let group = groups.get(key);
    if (!group) {
      group = { material: materials[0], attributesKey, geometries: [] };
      groups.set(key, group);
    }
    // 永远克隆后再烘焙: gltfpack 产物大量复用同一几何(2529 实例共享 888 定义),
    // 若首个实例直接原地烘焙, 后续复用者会在已烘焙结果上叠加变换,
    // 碎片被甩到几公里外(2026-09 实测合并体跨度 1107m)。原几何随后统一释放。
    // 镜像实例(行列式<0)烘焙后必须翻转绕序, 否则合并网格行列式回正、
    // three 的镜像剔除补偿消失, 镜像部件整片被剔(门扇镂空)。
    const baked = geometry.clone();
    const bakeMatrix = new THREE.Matrix4().multiplyMatrices(inverseAssembly, mesh.matrixWorld);
    baked.applyMatrix4(bakeMatrix);
    flipWindingIfMirrored(baked, bakeMatrix);
    bakedGeometries.push(baked);
    group.geometries.push(baked);
  }

  for (const mesh of meshList) {
    mesh.parent?.remove(mesh);
    // 只有被合并消费掉的原几何才释放; kept 网格保留自身几何(仅脱离父级)。
    if (!kept.includes(mesh)) mesh.geometry.dispose();
  }

  let mergedIndex = 0;
  let fallbackMeshes = 0;
  // 成功合并的 baked 几何(mergeGeometries 拷贝数据, 原 baked 可释放);
  // 失败回退的 baked 直接上屏, 不可释放——用集合区分。
  const consumedBaked = new Set<THREE.BufferGeometry>();
  for (const group of groups.values()) {
    if (group.geometries.length === 0) continue;
    let merged: THREE.BufferGeometry | null = null;
    if (group.geometries.length === 1) {
      merged = group.geometries[0];
    } else {
      try {
        merged = mergeGeometries(group.geometries, false);
      } catch {
        merged = null;
      }
    }
    if (!merged) {
      // 合并失败(属性/索引类型不一致)必须回退为单网格逐个上屏:
      // 直接丢弃整组 = 整组部件凭空消失(2026-09 门扇镂空类投诉的头号嫌疑)。
      // baked 几何已是装配系坐标, 可直接使用。
      for (const single of group.geometries) {
        const mesh = new THREE.Mesh(single, group.material);
        mesh.name = `tengwang-unmerged-${String(mergedIndex).padStart(3, '0')}-${String(fallbackMeshes).padStart(3, '0')}`;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        assembly.add(mesh);
        fallbackMeshes += 1;
      }
      mergedIndex += 1;
      continue;
    }
    merged.computeBoundingBox();
    merged.computeBoundingSphere();
    const mesh = new THREE.Mesh(merged, group.material);
    mesh.name = `tengwang-merged-${String(mergedIndex).padStart(3, '0')}`;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    assembly.add(mesh);
    mergedIndex += 1;
    // 多几何合并产出的是全新缓冲, 原 baked 可释放; 单几何组直接沿用
    // baked 本体(正显示), 不可释放。
    if (group.geometries.length > 1) {
      for (const baked of group.geometries) consumedBaked.add(baked);
    }
  }
  if (fallbackMeshes > 0) {
    console.warn(`[Tengwang] ${fallbackMeshes} mesh(es) kept unmerged (merge incompatible), draw calls +${fallbackMeshes}.`);
  }
  for (const mesh of kept) assembly.add(mesh);
  for (const geometry of bakedGeometries) {
    if (!consumedBaked.has(geometry)) continue;
    geometry.dispose();
  }
  return mergedIndex + kept.length;
}

const TENGWANG_LODS: Record<RuntimeLod, string> = {
  lod0: assetUrl('/assets/tengwang-main-tower-highmodel.glb'),
  lod1: assetUrl('/assets/tengwang-main-tower-lod1.glb'),
  lod2: assetUrl('/assets/tengwang-main-tower-lod2.glb'),
};

// High-precision source: 3D资产/滕王阁（1）/3d66.com_22753718.max
// Runtime master is the OFFLINE-BAKED web derivative (gltfpack -si 0.36 -cc
// -kn -vpf -vtf): 406MB/8.4M-tris → ~61MB/~0.78M-tris, meshopt-compressed,
// float positions/UVs kept (the source units are huge; default quantization
// smeared textures 39153%). Raw master stays out of public/ as bake source.
// 运行时准入预算(3.2M)直接放行, 只做材质合并; 化简已在构建期完成。
const TENGWANG_HIGH_PRECISION_GLB = assetUrl('/assets/tengwang-high-precision/tengwang-master-web.glb');

// Tengwang reads as dark grey-green tile roofs on strong vermilion work.
const TENGWANG_SEMANTIC_PALETTE: SemanticPalette = {
  roof: 0x3d4a44,
  timber: 0x4e241c,
  vermilion: 0x93352a,
  wall: 0xd8cbae,
  stone: 0x94907f,
};

const TENGWANG_PLAQUES: PlaqueSpec[] = [
  {
    text: '滕王阁',
    width: 3.6,
    height: 0.9,
    bgColor: '#0f1f4f',
    textColor: '#d4af37',
    position: [0, 13.8, 3.6],
    rotation: [0, Math.PI, 0],
    font: '"Noto Serif SC", "SimSun", "STSong", serif',
  },
];

function attachPlaques(root: THREE.Group, assembly: THREE.Group): void {
  // 牌匾落位改用射线实测: 从默认机位方向(与 frameModel 同方位角)向塔心打
  // 一束射线, 取首个命中面的位置+法线挂匾——无论资产单位/朝向/合并粒度怎么
  // 变, 匾永远贴在朝向默认视角的那面墙上, 不再依赖 focus 包络(大师版上
  // focus 会锁到入口小品, 旧算法把 2 米匾埋进了台基)。
  // 射线未命中则宁可不挂(不可见的匾比嵌进墙里的匾强)。
  assembly.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(assembly);
  if (box.isEmpty()) return;
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  const corridorAzimuth = 1.22; // 与 frameModel 滕王阁默认方位角一致
  const rayDirection = new THREE.Vector3(
    Math.sin(corridorAzimuth), 0, Math.cos(corridorAzimuth),
  );
  const rayOrigin = centre.clone()
    .addScaledVector(rayDirection, Math.max(size.x, size.z) * 2)
    .add(new THREE.Vector3(0, size.y * 0.12, 0));
  const rayTarget = centre.clone().add(new THREE.Vector3(0, size.y * 0.12, 0));
  const raycaster = new THREE.Raycaster(
    rayOrigin,
    rayTarget.clone().sub(rayOrigin).normalize(),
    0.1,
    Math.max(size.x, size.z) * 4,
  );
  const pickables: THREE.Object3D[] = [];
  assembly.traverse((object) => {
    if (object instanceof THREE.Mesh) pickables.push(object);
  });
  // 取首个真正朝向机位走廊的命中面(掠过翼角侧面之类不正对的不算):
  // rayDirection 即塔心指向机位的方向, 法线与它点积 > 0.34(约 70° 夹角内)才挂匾。
  let hit: THREE.Intersection | null = null;
  for (const candidate of raycaster.intersectObjects(pickables, false)) {
    if (!candidate.face) continue;
    const facing = candidate.face.normal.clone().transformDirection(candidate.object.matrixWorld);
    if (facing.dot(rayDirection) < 0.34) continue;
    hit = candidate;
    break;
  }
  if (!hit || !hit.face) return;
  const width = THREE.MathUtils.clamp(size.y * 0.1, 2.2, 4.5);
  for (const spec of TENGWANG_PLAQUES) {
    const plaque = createPlaqueMesh({
      ...spec,
      width,
      height: width * (spec.height / spec.width),
    });
    const normal = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    plaque.position.copy(hit.point).addScaledVector(normal, 0.18);
    // 牌面看法线: PlaneGeometry 默认朝 +z, orient 到命中法线。
    plaque.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), normal);
    plaque.userData.pavilionPlaque = { text: spec.text, bgColor: spec.bgColor, textColor: spec.textColor };
    root.add(plaque);
  }
}

// Zone relief now comes from the shared runtime/semanticRelief module, whose
// texture singletons are shared across all three tower loaders.

function calibratedMaterial(source: THREE.Material): THREE.Material {  // Always clone and force opaque so the high-precision model never renders
  // as an invisible/faint silhouette because of transparency or zero opacity.
  const clone = source.clone();
  clone.transparent = false;
  clone.opacity = 1;
  clone.depthWrite = true;
  if (clone instanceof THREE.MeshStandardMaterial || clone instanceof THREE.MeshPhysicalMaterial) {
    clone.roughness = Math.min(clone.roughness, 0.5);
    clone.metalness = Math.min(clone.metalness, 0.05);
    if (clone instanceof THREE.MeshPhysicalMaterial) {
      clone.clearcoat = 0.18;
      clone.clearcoatRoughness = 0.28;
    }
    clone.envMapIntensity = 0.85;
    clone.name = `${source.name}-source-preserved`;
  }
  return clone;
}

// The exported high-precision GLB carries one source-scene backdrop sheet
// (a 2-triangle ~1745x1431 flat plane). It dwarfs the whole complex, inflates
// every span-derived camera/explode/shadow computation, and covers the app
// ground with an untextured sheet. Everything else — including the wide
// multi-layer podium slabs (~170 units across) — is native architecture and
// must stay, so this threshold sits between the backdrop (>1700) and the
// largest legitimate structure (~174).
const MAX_IN_AREA_FOOTPRINT = 200;

function removeOutOfAreaGeometry(assembly: THREE.Object3D): number {
  assembly.updateMatrixWorld(true);
  const removals: Array<{ mesh: THREE.Mesh; parent: THREE.Object3D }> = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const bounds = new THREE.Box3().setFromObject(object);
    if (bounds.isEmpty()) return;
    const size = bounds.getSize(new THREE.Vector3());
    if (Math.max(size.x, size.z) > MAX_IN_AREA_FOOTPRINT) {
      removals.push({ mesh: object, parent: object.parent ?? assembly });
    }
  });
  for (const { mesh, parent } of removals) {
    parent.remove(mesh);
    mesh.geometry.dispose();
  }
  if (removals.length > 0) {
    console.info(`[Tengwang] Removed ${removals.length} out-of-area source-scene mesh(es) (footprint > ${MAX_IN_AREA_FOOTPRINT}).`);
  }
  return removals.length;
}

function prepareHighModel(assembly: THREE.Group, tierDetail = false): void {
  removeOutOfAreaGeometry(assembly);
  const materials = new Map<string, THREE.Material>();
  let meshIndex = 0;
  const rawBounds = new THREE.Box3().setFromObject(assembly);
  const modelHeight = Math.max(rawBounds.max.y - rawBounds.min.y, 0.001);

  // Foundation tier tracking: assign increasing polygonOffset per layer so
  // stacked flat slabs no longer z-fight each other or the global ground.
  // Also applies a tiny Y-axis nudge per layer to physically separate
  // co-planar geometry — the most reliable way to kill z-fighting.
  const foundationLayers: Array<{ minY: number; layerIndex: number; yNudge: number }> = [];
  const BASE_LAYER_HEIGHT = modelHeight * 0.25; // bottom quarter is "foundation"
  const LAYER_Y_NUDGE = 0.03; // 3 cm vertical separation per layer

  // First pass: collect foundation mesh Y-ranges for layer-index assignment.
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.geometry.computeBoundingBox();
    const geoBox = object.geometry.boundingBox ?? new THREE.Box3();
    const localMinY = geoBox.min.y;
    if (localMinY < BASE_LAYER_HEIGHT) {
      foundationLayers.push({ minY: localMinY, layerIndex: 0, yNudge: 0 });
    }
  });
  foundationLayers.sort((a, b) => a.minY - b.minY);
  let currentLayer = 0;
  let lastMinY = -Infinity;
  const LAYER_THRESHOLD = 0.15; // metres of Y-range = new layer
  for (const entry of foundationLayers) {
    if (entry.minY - lastMinY > LAYER_THRESHOLD) currentLayer++;
    entry.layerIndex = currentLayer;
    entry.yNudge = currentLayer * LAYER_Y_NUDGE;
    lastMinY = entry.minY;
  }

  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const sourceMaterials = Array.isArray(object.material) ? object.material : [object.material];
    const calibratedMaterials = sourceMaterials.map((source) => {
      let calibrated = materials.get(source.name);
      if (!calibrated) {
        calibrated = calibratedMaterial(source);
        materials.set(source.name, calibrated);
      }
      return calibrated;
    });
    // A mesh with one source material must retain a scalar material.  Assigning
    // a one-element array makes Three.js look for geometry groups and can leave
    // the complete model unrendered.
    object.material = Array.isArray(object.material) ? calibratedMaterials : calibratedMaterials[0];
    object.castShadow = true;
    object.receiveShadow = true;

    // Aggressive polygonOffset + physical Y-nudge for every foundation/bottom-tier mesh.
    // Covers: deck, platform, terrace, base, foundation, step, stair,
    // granite, stone, plinth, 台基, 底座, 踏步, 台阶, 石作 — plus all
    // meshes whose geometry sits in the lower quarter of the model.
    object.geometry.computeBoundingBox();
    const geometryBox = object.geometry.boundingBox ?? new THREE.Box3();
    const localCenterY = (geometryBox.min.y + geometryBox.max.y) / 2;
    const isFoundationName = /deck|platform|step mass|terrace|foundation|base|step|stair|granite|stone|plinth|台基|底座|踏步|台阶|石作|podium|铺砖/i.test(object.name);
    const isLowTier = localCenterY < BASE_LAYER_HEIGHT;
    const isFlatSlab = (geometryBox.max.y - geometryBox.min.y) < (geometryBox.max.x - geometryBox.min.x) * 0.6 &&
                       (geometryBox.max.y - geometryBox.min.y) < (geometryBox.max.z - geometryBox.min.z) * 0.6;

    if (isFoundationName || isLowTier || isFlatSlab) {
      const effectiveMaterials = Array.isArray(object.material) ? object.material : [object.material];
      // Find layer index for deeper-slab offset escalation.
      const matchedLayer = foundationLayers.find((layer) => Math.abs(layer.minY - geometryBox.min.y) < LAYER_THRESHOLD * 2);
      const layerIndex = matchedLayer ? matchedLayer.layerIndex : 0;
      const layerEscalation = layerIndex * 3;

      // NOTE: no physical Y displacement here. An earlier revision nudged
      // foundation-band meshes upward per layer to fight z-fighting, but with
      // the full podium restored the band count exploded and the differential
      // nudges visibly tore stairs, railings, and the tower base away from
      // their supports. Native alignment wins; polygonOffset below is enough.

      effectiveMaterials.forEach((material) => {
        material.polygonOffset = true;
        // Extreme values — the default near/far ratio makes modest values
        // ineffective on large scenes.  These are tuned for a ~30m model.
        material.polygonOffsetFactor = -(20 + layerEscalation);
        material.polygonOffsetUnits = -(40 + layerEscalation * 6);
        material.depthWrite = true;
        material.depthTest = true;
        // Foundation slabs should always be single-sided opaque so the
        // invisible underside never competes for depth.
        material.side = THREE.FrontSide;
        // Render foundation earlier so it sits behind the ground in the
        // depth buffer even when polygonOffset is insufficient.
        material.depthFunc = THREE.LessEqualDepth;
      });
    }
  });

  // Apply semantic surface recolouring for untextured placeholder geometry,
  // matching the Penglai/Yueyang pattern so the high-precision asset gets the
  // same readable architectural palette without overwriting real textures.
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const effective = Array.isArray(object.material) ? object.material[0] : object.material;
    if (needsSemanticRecolor(effective)) {
      recolorMeshSurfaces(object, TENGWANG_SEMANTIC_PALETTE);
    } else if (isNearWhitePlaceholder(effective)) {
      object.name = `${object.name ?? 'tengwang-mesh'}-untextured-placeholder`;
    }
    object.name = `tengwang-highmodel-component-${String(++meshIndex).padStart(3, '0')}`;
    object.userData.pickingPart = object.name;
  });

  const reliefMeshes = applySemanticRelief(assembly);
  console.info(`[Tengwang] Semantic relief textures applied to ${reliefMeshes} recolored mesh(es).`);
  // 语义档首屏精修(大师版不需要, 移动端为显存跳过): 17 块大色块按分区叠
  // 法线起伏 + 无贴图块烘 AO, albedo 原样保留。见 semanticRelief。
  if (tierDetail && detectDeviceQualityProfile().id !== 'mobile') {
    const tierMeshes = applyTengwangTierDetail(assembly);
    console.info(`[Tengwang] Tier surface detail applied to ${tierMeshes} mesh(es).`);
  }

  // Normalize the imported high-precision model into the shared pavilion
  // gallery scale. The source scene may be authored at unusual world scale,
  // so compute actual bounds and rescale to a consistent target size.
  const normalizeBounds = new THREE.Box3().setFromObject(assembly);
  const rawSize = normalizeBounds.getSize(new THREE.Vector3());
  const rawHeight = rawSize.y;
  const rawSpan = Math.max(rawSize.x, rawSize.y, rawSize.z);

  // Find the dominant vertical structure (main pavilion) so we do not scale
  // to the full site footprint; that would leave the building a few metres
  // wide and invisible. Instead: scale that structure to ~30 m, matching
  // the Penglai pattern, and publish a world-space focus box for the shared
  // camera framer.
  assembly.updateMatrixWorld(true);
  let maxHeight = 0;
  const meshBoxes: THREE.Box3[] = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(object);
    if (!box.isEmpty() && box.max.y - box.min.y > 0.5) {
      meshBoxes.push(box);
      maxHeight = Math.max(maxHeight, box.max.y - box.min.y);
    }
  });
  const focus = new THREE.Box3();
  let hasFocus = false;
  for (const box of meshBoxes) {
    if (box.max.y - box.min.y >= maxHeight * 0.55) {
      if (!hasFocus) {
        focus.copy(box);
        hasFocus = true;
      } else {
        focus.union(box);
      }
    }
  }
  const focusSpan = hasFocus
    ? Math.max(focus.max.x - focus.min.x, focus.max.z - focus.min.z, focus.max.y - focus.min.y)
    : 0;
  const horizontalSpan = Math.max(normalizeBounds.max.x - normalizeBounds.min.x, normalizeBounds.max.z - normalizeBounds.min.z);
  const scale = focusSpan > 0 ? 30 / focusSpan : horizontalSpan > 0 ? 28 / horizontalSpan : 0.4;
  assembly.scale.setScalar(scale);
  const scaledFocus = focus.clone();
  scaledFocus.min.multiplyScalar(scale);
  scaledFocus.max.multiplyScalar(scale);
  assembly.userData.focusBounds = scaledFocus;
  assembly.updateMatrixWorld(true);
  const bounds = new THREE.Box3().setFromObject(assembly);
  const centre = bounds.getCenter(new THREE.Vector3());
  console.log('[Tengwang] postScale bounds:', bounds.min.toString(), '->', bounds.max.toString(), 'centre:', centre.toString(), 'span:', Math.max(...bounds.getSize(new THREE.Vector3()).toArray()));

  // Centre on the gallery ground plane; keep the base grounded. Ground on the
  // structural base plane rather than the raw bounds minimum: this asset's
  // retaining-wall meshes sink ~5 native units beneath the source-scene floor,
  // and grounding on them hoisted the whole complex into the air.
  assembly.position.x -= centre.x;
  assembly.position.z -= centre.z;
  assembly.position.y -= computeStructuralBaseY(assembly);

  // The focus box was computed in pre-centering local space. Convert it to
  // world space now so the shared camera framer looks at the actual model
  // instead of an empty offset point.
  assembly.updateWorldMatrix(true, false);
  const worldFocus = new THREE.Box3();
  worldFocus.set(
    scaledFocus.min.clone().applyMatrix4(assembly.matrixWorld),
    scaledFocus.max.clone().applyMatrix4(assembly.matrixWorld),
  );
  assembly.userData.focusBounds = worldFocus;

  console.log('[Tengwang] final assembly pos:', assembly.position.toString(), 'scale:', assembly.scale.toString());

  // Final bounds after centering
  const finalBounds = new THREE.Box3().setFromObject(assembly);
  const finalCentre = finalBounds.getCenter(new THREE.Vector3());
  console.log('[Tengwang] final bounds:', finalBounds.min.toString(), '->', finalBounds.max.toString(), 'centre:', finalCentre.toString());

  // Check mesh visibility before adding to root
  let visibleMeshCount = 0;
  let hiddenMeshCount = 0;
  assembly.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      if (obj.visible) visibleMeshCount++;
      else hiddenMeshCount++;
    }
  });
  console.log(`[Tengwang] Mesh visibility: ${visibleMeshCount} visible, ${hiddenMeshCount} hidden`);

  // Ensure model is visible by checking if it's within reasonable bounds
  if (finalBounds.isEmpty() || finalBounds.getSize(new THREE.Vector3()).length() < 1) {
    console.warn('[Tengwang] Model bounds are too small, model may not be visible');
  }

  // 台基薄板分级微抬升: logarithmicDepthBuffer 下 polygonOffset 无效,
  // 叠放共面石板在移动视角下闪烁黑色斑纹 (深度冲突)。按世界高度分级,
  // 每级 +6mm 垂直分离——台基视距 (5~40m) 不可见, 但彻底消除共面冲突。
  // 仅处理薄板 (高 < 0.8m): 楼梯/栏杆等高构件不受影响, 不再撕裂。
  assembly.updateMatrixWorld(true);
  const slabProbe = new THREE.Box3();
  const slabRecords: Array<{ mesh: THREE.Mesh; minY: number }> = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    slabProbe.setFromObject(object);
    if (slabProbe.isEmpty()) return;
    const centre = slabProbe.getCenter(new THREE.Vector3());
    if (centre.y > 10) return;
    const height = slabProbe.max.y - slabProbe.min.y;
    if (height >= 0.8) return;
    slabRecords.push({ mesh: object, minY: slabProbe.min.y });
  });
  if (slabRecords.length > 1) {
    slabRecords.sort((a, b) => a.minY - b.minY);
    let slabLevel = 0;
    let slabAnchorY = slabRecords[0].minY;
    const SLAB_LEVEL_GAP = 0.12;
    for (const record of slabRecords) {
      if (record.minY - slabAnchorY > SLAB_LEVEL_GAP) slabLevel += 1;
      slabAnchorY = Math.max(slabAnchorY, record.minY);
      record.mesh.position.y += slabLevel * 0.006;
    }
    console.info('[Tengwang] ' + slabRecords.length + ' 台基薄板分级微抬 ' + (slabLevel + 1) + ' 级');
  }
  assembly.updateMatrixWorld(true);

  // Source-scene annex sweep: the master drags a strip of unrelated buildings
  // along the front-left plaza edge (centre distance > 24 m). They are not
  // part of the real complex and sit half-sunken at the rim, so drop them —
  // centre-based so the podium's own corner-reaching slabs stay safe.
  const annexes: THREE.Mesh[] = [];
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) return;
    const centre = box.getCenter(new THREE.Vector3());
    if (Math.hypot(centre.x, centre.z) > 24) annexes.push(object);
  });
  if (annexes.length > 0) {
    for (const mesh of annexes) {
      mesh.parent?.remove(mesh);
      mesh.geometry.dispose();
    }
    console.info(`[Tengwang] Removed ${annexes.length} out-of-complex annex mesh(es) beyond r=24.`);
  }

  assembly.updateMatrixWorld(true);
}

// DEBUG override: replace all high-precision materials with a simple opaque
// DoubleSide red so the 426MB GLB is guaranteed visible even if its original
// PBR chain is incompatible with the app's light rig / env map.
function applyDebugMaterialOverride(assembly: THREE.Group): void {
  assembly.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.material = new THREE.MeshBasicMaterial({
      color: 0xff3b30,
      side: THREE.DoubleSide,
      depthTest: true,
      depthWrite: true,
    });
  });
  console.warn('[Tengwang] Applied debug material override (opaque red, DoubleSide).');
}

type TengwangStage = { url: string; lod: string; source: string; plaques: boolean };

export function createTengwangTowerHighModel(loadOptions: PavilionModelLoadOptions = {}): THREE.Group {
  const root = new THREE.Group();
  root.name = 'tengwang-highmodel-root';
  root.userData.sculptRuntime = { nodes: { root }, meshes: {}, sockets: {}, colliders: {}, destructionGroups: { tower: [] } };

  // Asset selection. Desktop (and hero) load the offline-baked web master
  // first (61MB/0.78M tris — on par with huanghe's 60MB default): one stage,
  // no crude-to-fine pop. Mobile takes the 8.5MB lod1 tier. `?lod=` still
  // forces any semantic tier, and every stage falls back down the full chain
  // on failure (never jumping straight to the coarsest).
  const forcedLod = new URLSearchParams(window.location.search).get('lod') as RuntimeLod | null;
  const qualityId = detectDeviceQualityProfile().id;
  const useHighPrecision = qualityId !== 'mobile' && !forcedLod;
  const preferredLod = forcedLod ?? selectAvailableLod(TENGWANG_LODS);
  root.userData.runtimeLod = useHighPrecision ? 'master' : preferredLod;
  const semanticFallbacks = (['lod0', 'lod1', 'lod2'] as RuntimeLod[])
    .filter((lod) => lod !== preferredLod)
    .map((lod) => ({ url: TENGWANG_LODS[lod], lod, source: `${lod}-fallback`, plaques: lod !== 'lod2' } satisfies TengwangStage));
  const stages: TengwangStage[] = useHighPrecision
    ? [
        { url: TENGWANG_HIGH_PRECISION_GLB, lod: 'master', source: 'high-precision', plaques: true },
        { url: TENGWANG_LODS.lod0, lod: 'lod0', source: 'semantic-hierarchy', plaques: true },
        ...semanticFallbacks.filter((stage) => stage.lod !== 'lod0'),
      ]
    : [
        { url: TENGWANG_LODS[preferredLod], lod: preferredLod, source: preferredLod === 'lod0' ? 'semantic-hierarchy' : `${preferredLod}-tier`, plaques: true },
        // 完整降级链: lod0→lod1→lod2 逐级下探, 跳过已选档。
        ...semanticFallbacks,
      ];
  let stageIndex = 0;

  const loadStage = (): void => {
    const stage = stages[stageIndex++];
    loadVerifiedGlb(stage.url, loadOptions)
      .then(async (gltf) => {
        const assembly = gltf.scene;
        assembly.name = 'tengwang-highmodel-admitted-core';
        root.userData.runtimeLod = stage.lod;
        // 大师版自带真几何与贴图, 不需要档位表面精修; 语义档需要。
        prepareHighModel(assembly, stage.source !== 'high-precision');
        // Web 烘焙版已在预算内(0.78M < 3.2M): 准入直放, 只做材质合并降 draw call。
        if (stage.source === 'high-precision') {
          const budget = await admitHighPrecisionBudget(assembly);
          const drawMeshes = mergeAssemblyByMaterial(assembly);
          console.info(`[Tengwang] ${budget}; merged to ${drawMeshes} draw meshes.`);
        }
        registerPavilionAssembly(root, assembly, 'tengwang');
        if (assembly.userData.focusBounds instanceof THREE.Box3) {
          root.userData.focusBounds = assembly.userData.focusBounds;
          if (stage.plaques) attachPlaques(root, assembly);
        }
        root.add(assembly);
        root.userData.highModelReady = true;
        root.userData.highModelSource = stage.source;
        console.log(`[Tengwang] Stage ready: ${stage.source} (${stage.url})`);
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
      })
      .catch((error: unknown) => {
        if (isAbortError(error)) return;
        if (stageIndex < stages.length) {
          console.warn(`Tengwang GLB ${stage.url} failed, degrading.`, error);
          loadStage();
          return;
        }
        root.userData.highModelReady = false;
        root.userData.highModelLoadError = true;
        root.userData.highModelLoadErrorReason = 'asset-fetch-or-parse-failed';
        window.dispatchEvent(new CustomEvent('china-towers-model-ready', { detail: 'tengwang' }));
        console.error('Tengwang runtime GLB failed to load.', error);
      });
  };
  loadStage();
  return root;
}
