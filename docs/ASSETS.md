# 资产分级与分发

`git clone` 只拿到代码和小文件。大体量 GLB 走 GitHub Release，一键拉取。

## 三级

| 级 | 内容 | 体量 | 怎么拿 |
|---|---|---|---|
| 随 git | 代码、HDRI、draco、纹理小图、manifest | 约 15MB | `git clone` 自带 |
| Release `assets-v1` | 三座楼阁运行时 GLB 12 个（lod0/1/2 + 滕王大师版 + 黄鹤环境 + 飞鸟） | 约 350MB | `pnpm assets` 自动下载+校验 |
| 永不发布 | `*.review.glb` 中间产物、`evidence/`（11GB）、`3D资产/` 源文件、`.zip` 构建包 | 数 GB～11GB | 本地留存，不上传 |

## 为什么不用 Git LFS

- 免费额度只有 1GB 存储 + 每月 1GB 流量，几个完整 clone 就烧完，超了要么付费要么限流。
- 每个 clone 的人都要装 `git-lfs`，多一道门槛；Release 附件走 CDN 直接下载，开箱即用。
- 这是个人开源 3D 网页项目的主流做法（Khronos 等组织级项目才用 submodule+LFS）。

## 他人上手

```bash
git clone https://github.com/0G-Bhqc/China_Tower.git
cd China_Tower
pnpm install
pnpm assets     # 从 Release 拉 350MB 运行时资产，SHA-256 校验
pnpm dev
```

没跑 `pnpm assets` 也能启动，缺 GLB 的楼阁会进降级模式（见 `loadVerifiedGlb`）。

## 维护者更新资产包

```bash
pnpm assets:pack   # 按 scripts/package-asset-pack.mjs 清单打 asset-pack/asset-pack-v1.zip
# 传到 Release（替换附件）：
gh release upload assets-v1 asset-pack/asset-pack-v1.zip asset-pack/asset-pack-v1.zip.sha256 --clobber
```

清单变更（增删运行时引用的 GLB）时，同步改 `scripts/package-asset-pack.mjs` 的 `PACK_FILES`
和 `scripts/fetch-assets.mjs` 的 `TAG`（发新版 `assets-v2`）。
