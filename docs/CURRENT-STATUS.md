# China Tower project continuation status

Updated: 2026-09-04 七项优化收口 (Asia/Shanghai)
Workspace: `E:/Station/China_Tower`
Branch: `master` (local only, no remote)
HEAD: `4c5b8ee` + FINAL docs（见 `docs/CONTINUATION-2026-09-04.md`），工作区干净，`dist/` 为根基座正式包（31 文件 / 14 GLB / 0.70GB）

## What this project is now

The product is **frozen at three pavilions** — 岳阳楼 / 黄鹤楼 / 滕王阁 — a Three.js
high-fidelity poetry exhibit. Feiyun and Penglai are archive-only research assets: not in
navigation, `?pavilion=feiyun|penglai` URLs fall back to Yueyang. The August semantic-segmentation
pipeline work is done and retired; current work is runtime visual polish backed by **measured
evidence, not belief**.

## Verification infrastructure (the load-bearing part)

Three probe scripts live in `scripts/`, all writing `results.json` under `evidence/`
(gitignored, ~10 GB). Rules that keep them honest:

- `PROBE_PORT` overrides the dev-server port; playwright resolves project-first.
- **Hardware GL is the default.** `--use-angle=swiftshader` software rendering stalls this scene
  and hangs screenshots; `PROBE_SOFTWARE_GL=1` opts back in deliberately.
- Measurements must land in `results.json` — console-only metrics are lost evidence.
- Judgements read *variability*, not raw magnitude: animated content (water normals, petals,
  the stork) produces a stable meanMad that is not flicker; flicker is a swinging series.
- The mirror reflection re-renders the distant ranges: sky-segment and water-segment pixels are
  scored separately, and only the sky segment carries a skyline verdict.

### Current evidence baseline

| Probe | Result | Run |
| --- | --- | --- |
| distant-ranges (3 towers) | PASS — sky strong-signal 4.33 / 5.88 / 3.84% of frame | `run-013` (09-04 七项后) |
| godrays-stability (3 towers) | PASS | `run-006` (09-04 七项后) |
| frame-stability (3 towers × parked/orbit) | PASS | `run-009` (09-04 七项后) |
| flicker-dips (3 towers, stop-start drags) | PASS — composited-frame dips 0 / 0 / 0（落日/辉光改动后复测） | 2026-09-04 |
| subpath deploy (`DEPLOY_BASE=/towers/`) | PASS — /towers 下启动、GLB 200、零报错 | 2026-09-04 |

A failed check needs a re-run after the fix, not an argument.

## The 09-04 seven-item round (see `docs/CONTINUATION-2026-09-04.md`)

Nine cues rebuilt on a 晨/日/暮 arc (T3 now 落霞孤鹜 with a dedicated `deepDusk`
mood); tengwang sunset grandeur pass (disc 460, wider glow, 6 cloud cards, dimmed
Sky mie); 黄鹤 haze-limit round (fog 0.0011, ridge haze cut); platform bake detail
+ skirt damp gradient + `#model-meta` layer restored; runtime adaptive governor
(`diagnostics.adaptiveLevel`, `?noadapt=1` bypass); tengwang defaults to lod1
(395k tris, master hero-only); mobile cheap water; dist pruned to 14 GLBs / 0.70GB;
subpath deploys via `DEPLOY_BASE` + `npm run deploy`. Nine cue screenshots for
visual review: `evidence/review-0904-cues/`.

## The 09-03 night close-out (after the flicker round)

1. **R 键与重置按钮统一** (`8bb2a6f`)。`resetInspection()`（`cancelCueFlight + hideSceneReading + 清选中/展构件/仰视`）
   只接了重置按钮，R 键仍是旧内联逻辑：相机回默认位、氛围残留诗境。现 R 键直接调 `resetInspection()`。
   无头回归：诗境机位 → R / 按钮均清诗句卡、状态回中文就绪、零 pageerror；`tsc --noEmit` 通过。
2. **polish 两轮补正式证据。** `ab94c3f` 前的探针跑在旧代码上；夜里重跑
   frame-stability `run-007` / godrays `run-005` / distant-ranges `run-009` /
   flicker-dips 三楼 0-0-0，全 PASS（见上表）。
3. **`dist/` 已重打。** `npm run build:final-html`（tsc + vite + 打包 + `verify-final-html`）PASS；
   部署契约：52 hashed files / 35 GLBs / entry assets verified。
4. **G 盘全量包已补。** `G:\我的云端硬盘\China_Tower\China_Tower-backup-20260903.zip`
  （1.85 GB，Optimal 压缩；内容是 09-02 包的超集，+7 个新文件：4 个正式探针、
   `favicon.svg`、CONTINUATION-2026-09-03、references 调研包；`src/main.ts` 为含 reset 修复的工作区版本）。

## The 09-03 flicker round (two root causes, both measured)

The user-visible 频闪 was two independent defects. Both were found by
screencast-frame forensics (`scripts/probe-flicker-dips.cjs`: CDP screencast +
in-page mesh-containment sampler), then bisected with URL toggles
(`probe-flash-bisect.cjs`: `nopost/nowater/nobloom/norays/noranges/nobg`),
then fixed and re-measured to zero.

1. **Shore-rock fly-through (all towers).** The 22 `scene-shore-rock-*` meshes
   ring the plaza at radius 34-37 — exactly the ground-level orbit corridor
   (`minPolarAngle` drags clamp the camera to y≈0.25). Inside a rock's bounding
   sphere the lens sees nothing but magnified rock texture for several frames:
   the "flash". Fix: collect the rocks' world bounding spheres once and hard
   push the camera to `radius + 0.6` in `constrainInspectionCamera` (every
   tower). A partial soft-nudge (lerp 0.3) was measured to lose against a
   continuous drag — the correction must be per-frame absolute.
2. **Horizon-glow NaN → bloom wash (tengwang).** `poetic-horizon-glow`'s
   fragment shader computed `pow(1.0 - vUv.y, 1.6)` unguarded. At ground level
   the 1600 m billboard clips against the near plane, perspective-correct
   interpolation pushes `vUv.y` out of [0,1] on the clipped scanline, and
   `pow(negative, 1.6)` writes a NaN **row** into the scene buffer. Bloom's
   high-pass picks the row up and the 5-mip blur + composite smear it across
   the whole frame; ACES tone-maps Inf/Inf → NaN → the composited frame is
   100 % black for 1-3 frames (~130 dips per drag session). Instrumented
   per-pass pixel dumps (`pass tracer` round) showed RenderPass output clean,
   bloom output NaN at 3 of 5 sample spots. Fix: `clamp(1.0 - vUv.y, 0.0, 1.0)`
   — pixel-identical in-domain, judge-verified the 落霞 glow is unchanged.
   `probe-bloom-nan-isolate.cjs` names the poison object by hiding candidates
   at a parked poison pose. Tengwang was the only affected tower in practice
   (its ground-level corridor faces the glow azimuth).

Cross-check: `probe-flicker-ground-truth.cjs` samples the canvas from inside
the page AND via CDP in the same session — during the bug both samplers dipped
in lockstep (144/144), proving the black was real rendered content, not a
screencast artifact.

## Known open items

1. **黄鹤楼 far bank is haze-limited.** 「晴川历历汉阳树」 wants legibility, but the tower carries the
   heaviest mood fog of the three (`fogDensity 0.0014` in `TOWER_SKIES`). Lowering fog globally is a
   mood change, not a range fix — do it as its own measured round if attempted.
2. **No git remote.** Backups go to `G:\我的云端硬盘\China_Tower\<dated>.zip`. Local-only git is a single point of failure.
   09-04 会话 G 盘未挂载，改本地双盘：`E:\Station\China_Tower_backups\` + `D:\China_Tower_backups\`
  （每提交一 bundle 双写，全量 zip 在 B0/P1/FINAL 各一）。G 盘恢复后补全量包。
3. **Chunk size warning** on the main JS bundle (~949 kB, gzip ~262 kB). Cosmetic; split if load
   times ever matter.
4. `docs/CONTINUATION-2026-09-02.md` documents the 09-02 session end-to-end (diagnosis →
   crest-anchor bug fix → evidence); `docs/CONTINUATION-2026-09-03.md` does the same for the
   flicker round (two root causes → fixes → zero-dip evidence).

## The crest-anchor bug (kept as a case study)

The distant ranges rendered **only in the mirror reflection** for their entire first life:
`buildRidgeGeometry` anchored crests at `baseY + height`, double-counting the 140 m base offset and
putting every crest underwater. Water deltas measured 124-171 while the sky measured exactly zero.
It was found by triangulating three instruments — a geometric projector (`--camera`), a pixel
differ, and a forced-red material test — after neither alone was believed. Fixed to
`waterY + height` in commit `c5e7319`.

## Constraints that must not regress

- No automatic semantic labels may self-approve; approval lives in human review records.
- No half-finished review directory is ever promoted to a runtime asset.
- Changes that fail measurement do not enter the production manifest.
- The finished set is fixed at three towers; Feiyun and Penglai stay out of navigation.
