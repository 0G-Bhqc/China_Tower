# China Tower — Source Rebuild Notes (2026-08-18)

## Trigger

Use this doc when:
- User chooses path A: rebuild source DCC assets instead of runtime fixes.
- No native `.max`/`.blend`/`.fbx` files are in-repo but exist elsewhere on disk.
- Runtime recolor/material calibration has been ruled out as insufficient.

## Source discovery pattern

- Search: `D:\3D66`, `Documents`, `Downloads`, `Desktop`, `*3D*`.
- Example: `find /d /e -maxdepth 4 -type d \( -iname "*3d*" -o -iname "*asset*" \)`
- Filter by asset keywords after locating candidate directories.

## Verified source locations

- `/d/3D66/LiuYunKu/黄鹤楼/3d66.com_20515822.max` — 307 MB
- `/d/3D66/LiuYunKu/滕王阁/3d66.com_13009910.max` — 278 MB
- `/d/3D66/LiuYunKu/蓬莱阁/3d66.com_24241301.max` — 335 MB
- `/d/3D66/LiuYunKu/飞云楼/3d66.com_21849443.max` — 385 MB
- `/d/3D66/LiuYunKu/岳阳楼/3d66.com_22732580.max` — 25.8 MB

## Backup rule

- Copy original `.max` files to `backup/assets/source/` before any modification.
- Record original path and timestamp.

## Rebuild brief

### Output
- GLB 2.0 binary
- Textures: JPEG/PNG, max 2048x2048, embedded
- Materials: PBR BaseColor/Roughness/Metallic/Normal
- Preserve mesh naming for runtime semantic recognition

### Material palette (reference)
- Roof tiles: `#2a2a2a`, roughness `0.65`
- Wood columns/beams: `#5c3a1e`, roughness `0.75`
- Dougong: `#6b4423`, roughness `0.70`
- Walls: `#8c7e6d`, roughness `0.85`
- Railings: `#5c4a3a`, roughness `0.70`
- Foundation: `#6b6b6b`, roughness `0.90`

### Polygon budgets
- 滕王阁: >= 500k triangles
- 黄鹤楼: preserve existing count; fix tile material
- 飞云楼: >= 300k triangles; emphasize dougong and multi-eaved roof
- 岳阳楼: keep as baseline

### Texture requirements
- Wood grain: 1024x1024 seamless
- Roof tiles: 1024x1024 + normal map
- Stone: 1024x1028 weathering variation

## Priority

1. 滕王阁
2. 黄鹤楼
3. 飞云楼

## Verification

1. Export `{pavilion}-main-tower-lod1.glb`
2. Backup current production asset
3. Replace `public/assets/` file
4. `tsc --noEmit`
5. `vite build`
6. Confirm preview `200` + non-zero `Content-Length`
7. Browser check at `http://127.0.0.1:5173?pavilion=<id>`
