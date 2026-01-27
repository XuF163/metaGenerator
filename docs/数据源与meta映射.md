# 数据源（API）与 meta 产物映射说明

本文档解释：metaGenerator 在生成 `meta-{gs|sr}` 时，**分别从哪些 API / 数据源获取哪些信息**，以及这些信息最终落到 `meta` 目录的哪些文件里。

> 重要原则
> - **生成阶段不读取/不拷贝基线 meta**（`plugins/miao-plugin/resources/meta-*`）做兜底；基线仅用于 `validate` 对照。
> - **不生成占位图**：图片/资源缺失只记录到 `temp/metaGenerator/logs/`。
> - 所有上游请求都有本地缓存：`temp/metaGenerator/.cache/`，用于可复现与减少重复请求。

---

## 1) 产物总览：meta 目录结构（与 miao-plugin 对齐）

默认输出根目录：
- `temp/metaGenerator/.output/`

在输出根下生成：
- `meta-gs/`（原神）
- `meta-sr/`（崩坏：星穹铁道）

每个 `meta-{game}` 下的核心桶：
- `artifact/`（圣遗物/遗器）
- `character/`（角色）
- `material/`（材料/道具）
- `weapon/`（武器/光锥）

此外还可能包含（低频、偏“骨架”）：
- `info/`（版本/池子等固定脚本）
- `public/`（SR 公共图标等）

> “骨架文件”（`index.js/alias.js/extra.js/...`）来自 `temp/metaGenerator/scaffold/meta-{gs|sr}`，用于保证 meta 可被运行时加载。

---

## 2) 数据源清单（按“主源/辅源/补图源”分层）

### 2.1 主结构化数据源（优先）

1. **Hakush.in（主结构化源）**
   - 用途：GS/SR 的角色/武器/遗器/材料等 **结构化 JSON**（列表+详情）
   - 典型接口形态：
     - 列表：`https://api.hakush.in/{gi|hsr}/data/*.json`
     - 详情：`https://api.hakush.in/{gi|hsr}/data/{lang}/{type}/{id}.json`
     - UI 资源：`https://api.hakush.in/{gi|hsr}/UI/.../*.webp`

### 2.2 “缺口补齐”数据源（结构/映射/少量字段）

2. **Dimbreath AnimeGameData（GitLab Raw）**
   - 用途：补齐 GS 的 Excel 数据（尤其是圣遗物真实 itemId 映射等），用于与运行时 Profile/面板逻辑对齐
   - 默认 raw base（见代码常量）：
     - `https://gitlab.com/Dimbreath/AnimeGameData/-/raw/master`

3. **Dimbreath turnbasedgamedata（GitLab Raw）**
   - 用途：补齐 SR 的部分 Excel 映射（如某些命途/星神显示配置等）
   - 默认 raw base：
     - `https://gitlab.com/Dimbreath/turnbasedgamedata/-/raw/main`

4. **HoYoWiki（HoYoLAB Wiki API）**
   - 用途：当 Hakush 的部分 SR 材料 icon 缺失/404 时，用于“搜索条目 → 获取 icon_url → 下载 PNG → 转 webp”。
   - 典型请求：
     - `https://sg-wiki-api.hoyolab.com/hoyowiki/{gs|hsr}/wapi/search?...`

### 2.3 图片/资源补图源（当 Hakush UI 未命中时）

5. **Yatta.moe（Ambr 继任/镜像生态）**
   - 用途：
     - GS：补 `face-b.png`（baseline 中存在的 png 文件形态）
     - GS：武器 PNG → 转 webp（作为 Hakush webp 的后备）
     - SR：补材料/道具列表缺口（`/api/v2/cn/item`），以及角色圆形头像 png 等

6. **Enka.Network**
   - 用途：GS 武器 PNG → 转 webp（后备图源）

7. **HoneyHunterWorld（Gensh）**
   - 用途：
     - GS 武器图标/祈愿/觉醒图（部分老/特殊武器用 id 能命中）
     - GS 圣遗物套装分件图（`i_n{setId}_{idx}.webp` 形式）

---

## 3) 映射：GS（meta-gs）从哪些 API 生成哪些文件

### 3.1 GS 角色（`meta-gs/character`）

**结构化数据来源**
- Hakush 列表：用于发现角色 id、基础字段、icon 名等
- Hakush 详情：用于角色 detail（attr/talent/cons/passive 等）

**图片/资源来源**
- Hakush UI：`*.webp`（face/splash/side/gacha/card/banner、技能图标等）
- Yatta：补 `face-b.png`（PNG）
- 缺失时：不写占位图，只记录 `asset-error`

**落盘位置（关键文件）**
- `meta-gs/character/data.json`：角色索引（供运行时快速检索）
- `meta-gs/character/<角色名>/data.json`：角色完整 meta
- `meta-gs/character/<角色名>/imgs/*`：展示图（webp/png）
- `meta-gs/character/<角色名>/icons/*`：技能/天赋图（webp）
- `meta-gs/character/<角色名>/calc.js`：伤害计算配置（占位/LLM/启发式生成）
- `meta-gs/character/<角色名>/calc_auto.js`：组队伤害（基线常见文件，当前为 re-export shim）
- `meta-gs/character/<角色名>/artis.js`：圣遗物评分规则（基线常见文件，当前为默认 def()）

> 注意：`calc_auto.js / artis.js` 属于“低频人工规则文件”，生成器默认只提供通用兼容版本；要做到逐角色完全一致需要更复杂的规则生成/维护体系。

### 3.2 GS 武器（`meta-gs/weapon`）

**结构化数据来源**
- Hakush：武器列表/详情（存在覆盖缺口时会用 AnimeGameData 补齐）
- AnimeGameData：WeaponExcelConfigData + TextMap 等，用于补齐部分武器字段与描述

**图片/资源来源（按优先级）**
1. Hakush UI webp
2. Yatta/Enka PNG → webp
3. HoneyHunter webp（按武器 id 兜底）

**落盘位置**
- `meta-gs/weapon/<类型>/<武器名>/data.json`
- `meta-gs/weapon/<类型>/<武器名>/icon.webp`
- `meta-gs/weapon/<类型>/<武器名>/gacha.webp`
- `meta-gs/weapon/<类型>/<武器名>/awaken.webp`

### 3.3 GS 圣遗物（`meta-gs/artifact`）

**结构化数据来源**
- Hakush：套装列表/详情（效果文本、分件信息、Icon 名等）
- AnimeGameData：ReliquarySetExcelConfigData + ReliquaryExcelConfigData
  - 用于计算/映射：
    - 套装 metaId（与基线/运行时一致的 id 规则）
    - 每件圣遗物的真实 itemId（用于 Profile/面板匹配）

**图片/资源来源**
- Hakush UI webp（优先）
- HoneyHunter webp（按 `setId + idx` 形式补图）

**落盘位置**
- `meta-gs/artifact/data.json`：套装索引与效果
- `meta-gs/artifact/imgs/<套装名>/1.webp ... 5.webp`：分件图

### 3.4 GS 材料（`meta-gs/material`）

**结构化数据来源**
- Hakush `item_all`：全量物品库（id/name/desc/icon 等）
- Hakush `new.json`：增量提示（帮助缩小更新范围）

**图片/资源来源**
- Hakush UI webp：`https://api.hakush.in/gi/UI/<icon>.webp`

**落盘位置**
- `meta-gs/material/data.json`：按分类组织的材料索引
- `meta-gs/material/<分类>/<名称>.webp`：材料图标

---

## 4) 映射：SR（meta-sr）从哪些 API 生成哪些文件

### 4.1 SR 角色（`meta-sr/character`）

**结构化数据来源**
- Hakush 列表/详情：角色基础信息、技能树、行迹、突破材料等

**图片/资源来源**
- Hakush UI webp：技能/行迹/头像等
- Yatta：`face-b` 圆形头像（png）
- 特殊项：部分开拓者分支存在 `tree-4.webp`（按条件补齐）

**落盘位置**
- `meta-sr/character/data.json`
- `meta-sr/character/<角色名>/data.json`
- `meta-sr/character/<角色名>/imgs/*`、`icons/*`
- `meta-sr/character/<角色名>/calc.js`
- `meta-sr/character/<角色名>/calc_auto.js`（少数基线角色有；当前为 re-export shim）

### 4.2 SR 光锥（`meta-sr/weapon`）

**结构化数据来源**
- Hakush lightcone 列表/详情

**图片/资源来源**
- Hakush UI itemfigures（webp）

**落盘位置**
- `meta-sr/weapon/<命途>/<光锥名>/data.json`
- `meta-sr/weapon/<命途>/<光锥名>/icon.webp`（以及可能的附图）

### 4.3 SR 遗器（`meta-sr/artifact`）

**结构化数据来源**
- Hakush relicset 列表/详情

**图片/资源来源**
- Hakush UI itemfigures（webp）

**落盘位置**
- `meta-sr/artifact/data.json`
- `meta-sr/artifact/<套装名>/*.webp`

### 4.4 SR 材料（`meta-sr/material`）

**结构化数据来源**
- Hakush `item_all`：主数据
- Yatta item API：当 Hakush 漏项时用于“发现条目”（仍尽量从 Hakush UI 下图）

**图片/资源来源（按优先级）**
1. Hakush UI itemfigures webp
2. HoYoWiki 搜索 icon_url（PNG → webp）

**落盘位置**
- `meta-sr/material/data.json`
- `meta-sr/material/<分类>/<名称>.webp`

### 4.5 SR 公共图标（`meta-sr/public`）

**结构化数据来源**
- turnbasedgamedata：用于定位/映射部分显示配置（如星神/命途显示）

**图片/资源来源**
- Yatta：`.../assets/UI/profession/...`（PNG → webp）

---

## 5) 缓存、日志与验收文件（与 API 的关系）

### 5.1 缓存目录
- `temp/metaGenerator/.cache/hakush/`：Hakush JSON 缓存
- `temp/metaGenerator/.cache/animeGameData/`：AnimeGameData JSON 缓存
- `temp/metaGenerator/.cache/turnBasedGameData/`：turnbasedgamedata JSON 缓存
- `temp/metaGenerator/.cache/hoyoWiki/`：HoYoWiki API 缓存

### 5.2 日志与报告
- `temp/metaGenerator/logs/*-gen.log`：生成过程日志；缺失资源会写 `asset-error ...`
- `temp/metaGenerator/reports/*-validate.{json,md}`：与基线对照报告（用于发现差异/缺口）

