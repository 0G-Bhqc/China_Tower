# Blender 重制需求文档

## 当前问题总结

### 黄鹤楼
- **瓦片白色**：源 LOD1 材质本身为白色，不符合真实情况，需改为深灰/黑色琉璃瓦
- **牌匾**：四面均为"黄鹤楼"，内容符合史实，但需确认材质是否为木质底色+金字

### 滕王阁
- **模型过于简陋**：当前 LOD1 全为光滑面，缺乏斗拱、雕花、瓦片纹理等真实建筑细节
- **牌匾缺失**：当前模型无牌匾

### 飞云楼
- **质量模糊**：B3 语义 GLB 为中等偏低质量，低多边形、无贴图、斗拱简化
- **表面光滑**：缺乏木纹、瓦片纹理等细节

## Blender 重制统一要求

### 输出格式
- 格式：GLB 2.0（glTF 2.0 Binary）
- 纹理：JPEG/PNG，最大 2048x2048，嵌入 GLB
- 材质：PBR 流程（BaseColor + Roughness + Metallic + Normal）
- 网格：保留原始命名，便于 Runtime 语义识别

### 材质规范
| 构件类型 | 颜色 | Roughness | Metallic | 备注 |
|---------|------|-----------|----------|------|
| 屋顶瓦片 | #2a2a2a（深灰黑） | 0.65 | 0 | 琉璃瓦质感 |
| 木构柱梁 | #5c3a1e（深木色） | 0.75 | 0 | 木材纹理 |
| 斗拱 | #6b4423（浅木色） | 0.70 | 0 | 雕刻细节 |
| 墙体 | #8c7e6d（灰白） | 0.85 | 0 | 夯土/灰浆 |
| 栏杆 | #5c4a3a（深木色） | 0.70 | 0 | 木栏杆 |
| 基座 | #6b6b6b（灰色） | 0.90 | 0 | 石材 |

### 几何体细节要求

#### 滕王阁（最高优先级）
- **斗拱**：逐层还原宋式/清式斗拱结构，包括斗、拱、翘、昂
- **瓦片**：添加瓦片纹理或法线贴图，表现筒瓦、板瓦层次
- **雕花**：门窗格纹、栏杆雕花、梁枋彩绘
- **结构**：还原原始模型精细程度，面数 >= 500k 三角形

#### 黄鹤楼
- **瓦片颜色**：改为黑色/深灰色琉璃瓦
- **牌匾**：四面牌匾（均为"黄鹤楼"），黑底金字，行书字体
- **材质**：保留现有 PBR 材质，修正瓦片颜色

#### 飞云楼
- **斗拱**：突出十字歇山顶特有的斗拱结构
- **木构层次**：明确展现柱、梁、枋、檩的逻辑关系
- **屋顶**：多层歇山顶，飞檐翘角，瓦片纹理
- **面数**：>= 300k 三角形

### 贴图要求
- 木纹：1024x1024 以上，无缝平铺
- 瓦片：1024x1024 以上，带法线贴图表现凹凸
- 石材：1024x1024 以上，表现风化纹理

### 输出文件命名规范
```
{pavilion}-main-tower-lod1.glb    # LOD1 主模型（目标替换文件）
{pavilion}-main-tower-lod2.glb    # LOD2 简化模型（可选）
{pavilion}-plaque-front.glb       # 牌匾独立文件（可选）
```

## 当前可用资产路径

### 黄鹤楼
- 源：`public/assets/huanghe-main-tower-lod1.glb`
- 备份：`backup/src/createHuangheTowerHighModel.ts.bak2`

### 滕王阁
- 源：`public/assets/tengwang-main-tower-lod1.glb`
- 备份：`backup/src/createTengwangTowerHighModel.ts.bak2`

### 飞云楼
- 源：`public/assets/feiyun-b3-semantic-hierarchy.review.glb`（B3 语义 GLB）
- 备份：`backup/src/createFeiyunTowerHighModel.ts`（已修改）
- 参考：`evidence/v3/feiyun/semantic-hierarchy/review-002/feiyun-semantic-hierarchy.review.glb`

## 实施步骤

1. **确认源文件位置**：用户需提供原始 3ds Max/Blender 源文件，或从现有 GLB 反向导入
2. **Blender 重制**：按上述规范重建 LOD1 模型
3. **材质烘焙**：导出 PBR 材质贴图
4. **GLB 导出**：按命名规范导出
5. **替换测试**：覆盖 `public/assets/` 下对应文件
6. **浏览器验证**：通过 `http://127.0.0.1:5173?pavilion={id}` 验证

## 注意事项

- **禁止直接修改项目 GLB**：修改前必须全量备份到 `backup/assets/`
- **保留原始 UV**：避免 Runtime 材质映射断裂
- **保持网格命名**：便于 Runtime 识别和调试
- **先修改滕王阁**：滕王阁问题最严重，优先处理
