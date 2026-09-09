import * as THREE from 'three';
import {
  generateTengwangRoofTextures,
  generateTengwangWoodTextures,
  generateTengwangWallTextures,
  NORMAL_STRENGTH,
} from '../createTengwangProceduralTextures';

// Zone-matched procedural relief for semantically recolored meshes.
//
// The semantic recolour pass paints albedo as vertex colours on flat
// placeholder geometry; layering the zone normal/roughness maps on top gives
// those surfaces the tile-ridge / wood-grain / plaster bump they otherwise
// lack. Albedo maps are deliberately NOT attached — vertex colours stay the
// single albedo source.
//
// The texture sets are session singletons shared by every tower loader
// (only the normal/roughness patterns are used, which are palette-agnostic),
// so they are flagged `userData.shared` and survive disposeObjectDeep when a
// pavilion is switched out.

type ZoneTextures = { normal: THREE.Texture; roughness: THREE.Texture };

const cache: Partial<Record<'roof' | 'wood' | 'wall', ZoneTextures>> = {};

function markShared(textures: ZoneTextures): ZoneTextures {
  for (const texture of [textures.normal, textures.roughness]) {
    texture.userData = { ...texture.userData, shared: true };
  }
  return textures;
}

function getZoneTextures(zone: 'roof' | 'wood' | 'wall'): ZoneTextures {
  const cachedTextures = cache[zone];
  if (cachedTextures) return cachedTextures;
  let generated: ZoneTextures;
  if (zone === 'roof') generated = generateTengwangRoofTextures('#1f2a25');
  else if (zone === 'wood') generated = generateTengwangWoodTextures('#3a1c16');
  else generated = generateTengwangWallTextures('#5e574b');
  cache[zone] = markShared(generated);
  return cache[zone]!;
}

/**
 * Attach zone-matched normal/roughness relief to every vertex-colour mesh
 * under `root` that carries a `semanticZone` marker. Returns the count of
 * meshes that received relief.
 */
export function applySemanticRelief(root: THREE.Object3D, normalScale = NORMAL_STRENGTH * 0.7): number {  let applied = 0;
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const material = Array.isArray(object.material) ? object.material[0] : object.material;
    if (!(material instanceof THREE.MeshStandardMaterial) || !material.vertexColors) return;
    if (!object.geometry.getAttribute('uv')) return;
    const zone = object.userData.semanticZone as string | null;
    const textures = zone === 'roof'
      ? getZoneTextures('roof')
      : zone === 'timber' || zone === 'vermilion'
        ? getZoneTextures('wood')
        : zone === 'wall' || zone === 'stone'
          ? getZoneTextures('wall')
          : null;
    if (!textures) return;
    material.normalMap = textures.normal;
    material.roughnessMap = textures.roughness;
    material.normalScale.set(normalScale, normalScale);
    material.needsUpdate = true;
    applied += 1;
  });
  return applied;
}

// ---------------------------------------------------------------------------
// 滕王阁语义档首屏精修: lod0/lod1/lod2 全楼仅 17 个部件——塔身是整块单色体,
// 台基是一张拉伸纹理, 屋顶是单色板。几何救不了首屏印象, 但表面可以:
// 按朝向+色相分区叠加程序化法线起伏(瓦垄/木纹/夯土), 给无贴图色块烘焙
//  subtle 的顶点 AO。albedo 一律不动(贴图与漆色原样保留), 只加“触感”。
// 有贴图的只上法线(不动粗糙), 无贴图的才上法线+粗糙+AO。
// UV 以几何为单位乘分区 repeat(共享纹理本身保持 repeat 1, 不污染别楼)。
// 跳过: 无 UV / 已有 normalMap / ≤8 三角的碎片。
// ---------------------------------------------------------------------------

const TIER_REPEAT: Record<'roof' | 'wood' | 'wall', number> = { roof: 10, wood: 6, wall: 8 };
const TIER_NORMAL_SCALE: Record<'roof' | 'wood' | 'wall', number> = { roof: 0.85, wood: 0.5, wall: 0.6 };

function classifyTierZone(
  avgNy: number, flatness: number, color: THREE.Color, hasMap: boolean,
): 'roof' | 'wood' | 'wall' {
  const r = color.r, g = color.g, b = color.b;
  if (g > r * 1.02 && g >= b && g > 0.05) return 'roof'; // 绿琉璃屋面
  if (r > b * 1.2 && r > 0.08) return 'wood'; // 赭红木作/墙身
  if (hasMap && avgNy > 0.45 && flatness >= 0.3) return 'roof'; // 非铺装的上向贴图面
  return 'wall';
}

export function applyTengwangTierDetail(root: THREE.Object3D): number {
  let applied = 0;
  const scaledGeometries = new Set<THREE.BufferGeometry>();
  const materialZones = new Map<string, string>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const geometry = object.geometry;
    const index = geometry.getIndex();
    const position = geometry.getAttribute('position') as THREE.BufferAttribute | undefined;
    const normal = geometry.getAttribute('normal') as THREE.BufferAttribute | undefined;
    const uv = geometry.getAttribute('uv') as THREE.BufferAttribute | undefined;
    if (!position || !normal || !uv) return;
    const triCount = Math.floor(((index ? index.count : position.count) || 0) / 3);
    if (triCount <= 8) return;
    let material = (Array.isArray(object.material) ? object.material[0] : object.material) as THREE.MeshStandardMaterial | undefined;
    if (!(material instanceof THREE.MeshStandardMaterial)) return;
    if (material.normalMap) return; // 已有法线(语义 relief 或自带)不再叠加
    // 平均法线 Y + 扁平度 + 色相 → 分区。
    let ny = 0;
    for (let v = 0; v < normal.count; v += 1) ny += normal.getY(v);
    ny /= Math.max(1, normal.count);
    geometry.computeBoundingBox();
    const bb = geometry.boundingBox!;
    const sizeX = bb.max.x - bb.min.x;
    const sizeY = bb.max.y - bb.min.y;
    const sizeZ = bb.max.z - bb.min.z;
    const flatness = sizeY / Math.max(sizeX, sizeZ, 0.001);
    const hasMap = !!material.map;
    const zone = classifyTierZone(ny, flatness, material.color, hasMap);
    // 同一材质服务不同分区时克隆, 互不串味(语义档基本 1:1, 预防为主)。
    const seenZone = materialZones.get(material.uuid);
    if (seenZone && seenZone !== zone) {
      material = material.clone();
      if (Array.isArray(object.material)) object.material = [material, ...object.material.slice(1)];
      else object.material = material;
    }
    materialZones.set(material.uuid, zone);
    const textures = getZoneTextures(zone);
    // UV 分区 repeat(几何级): 语义档自带 UV 量程野(0..1 到 ±70 都有),
    // 直接乘固定倍数会有的过密成噪、有的过疏无感。按本几何 UV 跨度归一,
    // 让每个部件恰好铺满分区目标瓦数(屋面 10 / 木作 6 / 墙体 8),
    // 世界尺度一致, 共享纹理本身不动。
    if (!scaledGeometries.has(geometry)) {
      scaledGeometries.add(geometry);
      let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
      for (let v = 0; v < uv.count; v += 1) {
        const u = uv.getX(v), w = uv.getY(v);
        if (u < uMin) uMin = u;
        if (u > uMax) uMax = u;
        if (w < vMin) vMin = w;
        if (w > vMax) vMax = w;
      }
      const uvSpan = Math.max(uMax - uMin, vMax - vMin, 1e-4);
      const k = THREE.MathUtils.clamp(TIER_REPEAT[zone] / uvSpan, 0.02, 200);
      for (let v = 0; v < uv.count; v += 1) uv.setXY(v, uv.getX(v) * k, uv.getY(v) * k);
      uv.needsUpdate = true;
    }
    material.normalMap = textures.normal;
    const ns = TIER_NORMAL_SCALE[zone];
    material.normalScale.set(ns, ns);
    if (!hasMap) {
      material.roughnessMap = textures.roughness;
      // 无贴图色块烘焙 subtle 顶点 AO: 下暗上亮、背光面收, 幅度压在 ±10%。
      if (!geometry.getAttribute('color')) {
        const colors = new Float32Array(position.count * 3);
        const hRange = Math.max(sizeY, 0.001);
        for (let v = 0; v < position.count; v += 1) {
          const h01 = (position.getY(v) - bb.min.y) / hRange;
          const up01 = normal.getY(v) * 0.5 + 0.5;
          const shade = 0.82 + 0.18 * (0.62 * h01 + 0.38 * up01);
          colors[v * 3] = shade;
          colors[v * 3 + 1] = shade;
          colors[v * 3 + 2] = shade;
        }
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        material.vertexColors = true;
      }
    }
    material.needsUpdate = true;
    applied += 1;
  });
  return applied;
}
