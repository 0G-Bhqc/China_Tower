# China Tower project continuation status

Updated: 2026-09-02 (Asia/Shanghai)
Workspace: `E:/Station/China_Tower`
Branch: `master` (local only, no remote)

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
| distant-ranges (3 towers) | PASS — sky strong-signal 3.3-5.5% of frame | `run-006` |
| godrays-stability (3 towers) | PASS — worst push→pause delta 6/2/3 vs half-gate 337-650 | `run-001` |
| frame-stability (3 towers × parked/orbit) | PASS — 18/18 checks, diffCv ≤ 0.164 vs 0.6 limit | `run-001` |

A failed check needs a re-run after the fix, not an argument.

## Known open items

1. **黄鹤楼 far bank is haze-limited.** 「晴川历历汉阳树」 wants legibility, but the tower carries the
   heaviest mood fog of the three (`fogDensity 0.0014` in `TOWER_SKIES`). Lowering fog globally is a
   mood change, not a range fix — do it as its own measured round if attempted.
2. **No git remote.** Backups go to `G:\我的云端硬盘\China_Tower\<dated>.zip` (4.0 GB full pack,
   2026-09-02). Local-only git is a single point of failure.
3. **Chunk size warning** on the main JS bundle (945 kB, gzip 260 kB). Cosmetic; split if load
   times ever matter.
4. `docs/CONTINUATION-2026-09-02.md` documents the 09-02 session end-to-end (diagnosis →
   crest-anchor bug fix → evidence).

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
