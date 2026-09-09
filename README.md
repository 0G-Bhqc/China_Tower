# 中国楼阁 · 高模 3D 藏品

Three.js 中国楼阁高精度三维展示项目，包含岳阳楼、黄鹤楼、滕王阁三座经 DCC 高模解析的楼阁。

## 快速开始

```bash
# 安装依赖
pnpm install

# 开发服务器
pnpm dev

# 生产构建
pnpm build

# 构建产物预览
pnpm preview
```

## 项目结构

```
├── index.html              # 应用入口
├── package.json            # 项目配置
├── tsconfig.json           # TypeScript 配置
├── vite.config.ts          # Vite 构建配置
├── pnpm-lock.yaml          # 依赖锁定
├── pnpm-workspace.yaml     # 工作区配置
├── start-preview.cmd       # Windows 快速启动脚本
│
├── src/                    # 源代码
│   ├── main.ts             # 应用入口 & 场景初始化
│   ├── style.css           # 全局样式
│   ├── runtime/            # 运行时模块
│   │   ├── DeviceQualityProfile.ts
│   │   ├── loadVerifiedGlb.ts
│   │   ├── PavilionAssemblyRuntime.ts
│   │   ├── createPlaqueMesh.ts
│   │   ├── semanticSurfaceRecolor.ts
│   │   └── sceneEnvironment.ts
│   ├── createYueyangTowerFormModel.ts       # 岳阳楼手写模型
│   ├── createYueyangTowerStructuralModel.ts # 岳阳楼结构模型
│   ├── createYueyangTowerModel.ts           # 岳阳楼旧版模型
│   ├── createObjectModel.ts                 # 通用对象模型
│   ├── createTengwangTowerHighModel.ts      # 滕王阁高精度 GLB 集成
│   ├── createHuangheTowerHighModel.ts       # 黄鹤楼高精度 GLB 集成
│   ├── createPavilionGalleryModel.ts        # 楼阁画廊 & 规格定义
│   ├── createTengwangProceduralTextures.ts  # 滕王阁程序化纹理
│   └── g3-preview.ts                        # G3 预览工具
│
├── public/                 # 静态资源
│   └── assets/             # 3D 模型 & 纹理
  │       ├── tengwang-high-precision/  # 滕王阁大师版 Web 烘焙版(61MB/78万面, 由 3D资产/tengwang-master-source/406MB 离线烘焙)
│       ├── huanghe_textures/         # 黄鹤楼纹理
│       ├── tengwang_textures/        # 滕王阁纹理
│       └── penglai_textures/         # 蓬莱阁纹理
│
├── dist/                   # 生产构建产物（不提交）
├── backup/                 # 备份目录
│   ├── implementation-20260823_212627/  # Hermes 最终版本备份
│   └── old-versions/        # 旧版本备份
│
├── docs/                   # 项目文档
│   ├── CURRENT-STATUS.md
│   ├── engineering-implementation-v2.md
│   ├── engineering-implementation-v3.md
│   ├── isolated-max-conversion-sop.md
│   ├── BLENDER_REBUILD_PLAN.md
│   ├── CHINA_TOWER_SOURCE_REBUILD_NOTES.md
│   └── RELEASE.md
│
├── references/             # 参考资料 & 调研文件
│   ├── yueyang/            # 岳阳楼参考资料
│   ├── 六楼阁调研资料包.zip
│   ├── 工程文档_中国楼阁3D建造网页.pdf
│   ├── object-sculpt-spec.json
│   ├── tengwang-materials.json
│   ├── tengwang-scale-verify.json
│   └── tengwang-vertices.json
│
├── scripts/                # 构建 & 验证脚本
│   └── validate-asset-pipeline.mjs
│
├── pipeline/               # 资产处理管道
├── schemas/                # JSON Schema 定义
│
└── china-tower-pack-*.zip  # 完整构建包（包含 dist + 静态资源）
```

## 楼阁说明

| 楼阁 | 模型类型 | 状态 |
|------|---------|------|
| 岳阳楼 | 手写程序化模型 | ✅ 完成 |
| 黄鹤楼 | 高精度 GLB | ✅ 完成 |
| 滕王阁 | 高精度 GLB（426MB） | ✅ 完成 |

## 技术栈

- **渲染引擎**: Three.js r160+
- **构建工具**: Vite 7 + TypeScript
- **包管理器**: pnpm
- **后处理**: EffectComposer / UnrealBloomPass / BokehPass

## 诊断开关

在 URL 参数中可启用诊断模式：

- `?pavilion=tengwang` — 直接打开滕王阁
- `?view=low-angle` — 仰视视角
- `?noshadow=1` — 关闭阴影（诊断用）
- `?hideglb=1` — 隐藏 GLB 模型（诊断用）

## 版本管理

- `backup/old-versions/` — 历史版本备份
- `backup/implementation-20260823_212627/` — Hermes 最终版本
- `china-tower-pack-*.zip` — 完整构建包副本

## License

内部项目，仅供学习研究使用。
