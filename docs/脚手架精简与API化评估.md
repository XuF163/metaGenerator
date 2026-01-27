# 脚手架（scaffold）还能怎么简化/改为 API 生成？（GS + SR）

本文面向 `temp/metaGenerator/scaffold`，目标是：**让脚手架只承担“可运行骨架”职责**，把“高频变动/可推导的数据”尽量交给 `meta-gen gen` 从数据源 **现场生成**（必要时可用 LLM 辅助解析），从而降低维护成本并提高版本自适应能力。

> 约束重申：**严禁**用基线 meta（`plugins/miao-plugin/resources/meta-*` 或 `resources/fuck_qsyhh/...`）做生成兜底；基线仅用于 `validate` 对比查漏。

---

## 1. scaffold 的定位（建议保持的边界）

### 1.1 必须留在 scaffold 的内容（建议保留）

这些文件属于“运行期加载入口/胶水”，本质是 **Meta 的加载方式**，不属于游戏数据本身：

- `*/artifact/index.js`
- `*/character/index.js`
- `*/weapon/index.js`
- `*/material/index.js`
- `*/info/index.js`（若存在）

理由：
- 这些文件描述了 miao-plugin 的 meta 组织方式（`Meta.create`、`Data.readJSON`、`meta.addMeta` 等），不是游戏数据源能直接提供的。
- 变动频率低、且逻辑集中，保留为骨架是合理的。

### 1.2 不应该放在 scaffold 的内容（建议迁移）

原则：**只要能从结构化数据源推导，就不应手工/预置在 scaffold。**

典型包括：
- 各类 `data.json`（已在 `src/generate/scaffold.ts` 中强制跳过拷贝）
- 角色/武器/圣遗物等“实体级目录”（应由生成器产出）
- 可由数据表推导出的数值映射、词条表、掉落日历、图标集等

---

## 2. 分模块评估（能 API 化/能进一步简化的点）

下面按“是否影响兼容性”与“是否可从数据源推导”给出建议。

### 2.1 GS / artifact

**现状（scaffold 内）：**
- `scaffold/meta-gs/artifact/extra.js`：主/副词条集合、词条数值、ID 映射等（兼容性关键）
- `scaffold/meta-gs/artifact/calc.js`：示例（生成器会覆盖）
- `scaffold/meta-gs/artifact/artis-mark.js`：少量权重样例（可选）
- `scaffold/meta-gs/artifact/alias.js`：少量简称（可选）

**可 API 化（建议优先级：P0 / 兼容性关键）：**
- `extra.js` 可以从 **AnimeGameData（GenshinData）** 的圣遗物相关表推导生成，例如：
  - 主词条可选项：`ReliquaryMainPropExcelConfigData`
  - 副词条数值与档位：`ReliquaryAffixExcelConfigData`
  - 主词条/副词条与内部 `FIGHT_PROP_*` 对应：可复用项目现有的属性映射逻辑

**论证：**
- `extra.js` 的内容是“数据表的另一种序列化形式”，预置在 scaffold 会带来：表结构变更/新增属性时需要手工维护。
- 这部分数据稳定但**并非不会变**（新属性/新规则出现时必须同步），因此更适合“生成时从源表推导”。

**可进一步简化（建议优先级：P2 / QoL）：**
- `alias.js`、`artis-mark.js` 可以保持极简甚至空表；昵称/权重属于社区约定或玩法偏好，不是官方数据，且高频过时。
- `calc.js` 继续保留“极小样例”即可（真正的效果表应由生成器覆盖产出）。

---

### 2.2 GS / character

**现状（scaffold 内）：**
- `scaffold/meta-gs/character/alias.js`：已是极简
- `scaffold/meta-gs/character/extra.js`：`extraChars` / `wifeCfg`（功能性弱、偏好型）

**可简化（建议优先级：P0）：**
- `extraChars`：可以为空（不影响正式角色 meta）。
- `wifeCfg`：属于“用户/社区偏好”，非官方数据；建议移到用户配置（或保持空对象），避免 scaffold 带大段名单。

**论证：**
- 这类名单不可能从 Hakush/官方数据“客观推导”，预置只会膨胀脚手架且争议大。
- 不影响角色面板/伤害计算等核心能力。

---

### 2.3 GS / weapon

**现状（scaffold 内）：**
- `scaffold/meta-gs/weapon/<type>/calc.js`：骨架（生成器已覆盖写入）
- `scaffold/meta-gs/weapon/extra.js`：武器类型映射、系列名集合（小）
- `scaffold/meta-gs/weapon/alias.js`、`desc.js`：已极简

**可进一步 API 化（建议优先级：P1）：**
- `weaponSet`（系列名集合）可以不预置：要么删除（meta 仍可用），要么从武器列表/名称规则推导（不建议投入过多）。

**论证：**
- 武器“系列”更像 UI/筛选辅助；即使缺失也不影响武器基础数据与被动（calc）生成。
- 当前生成器已经能从 AnimeGameData 的 `EquipAffixExcelConfigData.addProps` 推导静态被动（这是“替代性”的关键部分），脚手架不应再预置大量规则。

---

### 2.4 GS / material

**现状（scaffold 内）：**
- `scaffold/meta-gs/material/daily.js`：天赋/武器材料开放日（高频新增）
- `scaffold/meta-gs/material/abbr.js`：材料简称修正（高频且口径不统一）

**可 API 化（建议优先级：P1）：**
1) `daily.js`：可从 **GenshinData 的秘境/掉落/材料关联表** 推导（或从 HoYoWiki/第三方 wiki 的结构化接口提取）。
2) `abbr.js`：更适合“生成时按规则自动缩写”，必要时再允许小型 override（用户自定义）。

**论证：**
- 新国家/新材料出现时，`daily.js` 是最典型的“每版本都要补”的手工表；API 化收益大。
- `abbr.js` 属于展示层，缺失也不影响 meta 正确性；用规则生成比手写列表更稳。

---

### 2.5 GS / info

**现状（scaffold 内）：**
- `scaffold/meta-gs/info/pool.js`：卡池历史（体量大，且极易过时）
- `scaffold/meta-gs/info/index.js`：`export *` + `chestInfo`

**建议（优先级：P0）：**
- **不建议**把卡池历史作为“核心替代能力”的一部分。可以：
  - 作为独立可选生成任务（单独命令/开关），或
  - 直接保持极简/空数据（避免 scaffold 臃肿与过时）

**论证：**
- 卡池数据来源复杂，稳定 API 不可靠；一旦停更/口径变更，手工表就立刻失真。
- 对角色面板/伤害/圣遗物/武器的核心 meta 替代能力贡献很小。

---

## 3. SR 模块评估

### 3.1 SR / artifact

**现状（scaffold 内）：**
- `scaffold/meta-sr/artifact/meta.json` + `star-meta.json`：主词条/副词条数值表（兼容性关键）
- `scaffold/meta-sr/artifact/meta.js`：把词条表包装成运行期使用的结构（兼容性关键）

**可 API 化（建议优先级：P0 / 兼容性关键）：**
- `meta.json` / `star-meta.json` 可从 **TurnBasedGameData** 的遗器主/副词条配置表推导生成。

**论证：**
- 这部分是“遗器数值规则”的结构化数据，属于可推导对象，不应长期手工维护。
- 做成生成器产物后：新增属性/数值口径变动可自动同步，替代性更强。

**可简化（建议优先级：P2 / QoL）：**
- `artis-mark.js`、`alias.js`：保持空或少量示例即可（同 GS：偏好/昵称不稳定）。

---

### 3.2 SR / character

**现状（scaffold 内）：**
- `scaffold/meta-sr/character/extra.js`：`wifeCfg`（偏好型）

**可简化（建议优先级：P0）：**
- 建议保持空或迁移到用户配置，避免脚手架内置大量名单。

---

### 3.3 SR / weapon

**现状：**
- 生成器已覆盖写入 `meta-sr/weapon/<path>/calc.js`（脚手架可保持空表/骨架即可）
- `scaffold/meta-sr/weapon/index.js` 仅需要“路径列表”作为遍历入口

**可进一步简化（建议优先级：P2）：**
- `types` 常量可以保留（固定 8 命途），也可以从 `weapon/data.json` 自动收集去重生成；属于很小的维护点。

---

### 3.4 SR / public/icons

**现状：**
- `scaffold/meta-sr/public/icons/*` 预置大量低频图标
- 生成器目前只补“欢愉”缺失图标（`src/generate/hakush/sr/public-icons.ts`）

**可 API 化（建议优先级：P1）：**
- 把“公共图标集”改为 **生成阶段下载**（可缓存 + 可强制刷新），脚手架仅保留目录结构。

**论证：**
- 图标属于“文件集合接近”的验收点；生成式下载能最大化对齐、并减少仓库内置资源体积。
- 风险是上游 404/改路径；但你已接受“缺失即记日志、不做占位图”，因此可控。

---

## 4. 建议的落地优先级（最小成本 → 最大收益）

- **P0（立刻做、收益大）**：清空/瘦身偏好型/高噪音表（`wifeCfg`、`pool.js` 等），脚手架只保留结构不保留“大名单”。
- **P0（兼容性关键）**：API 化生成 `GS artifact extra.js`、`SR artifact meta.json/star-meta.json/meta.js`（这些是遗器/圣遗物“规则表”，直接影响面板与计算）。
- **P1（体验增强）**：`GS material daily.js`（材料日历）、`SR public/icons`（公共图标集）改为下载生成。
- **P2（锦上添花）**：昵称/简称/权重类（alias、artis-mark）改为可选生成（可 LLM 辅助），默认保持极简。

---

## 5. 验收口径建议（与“替代性”相关）

当我们把高频内容从 scaffold 迁移为“生成产物”后，验收更关注：

1) **文件集合接近**：目录结构一致、关键入口 JS 存在、`data.json` 与 calc/规则表落盘齐全。
2) **行为一致**：相同输入下（面板/伤害计算/套装效果/光锥被动）结果一致或可解释差异。
3) **不依赖基线**：删掉基线目录后仍可 `meta-gen gen` 生成完整 meta（缺资源只记日志）。

