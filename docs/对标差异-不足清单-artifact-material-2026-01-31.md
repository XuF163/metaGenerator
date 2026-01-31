# 对标差异（仅列不足项）- 全量（GS+SR）

> 文件名带 `artifact-material-2026-01-27` 是历史原因；本文内容会随最新对标结果更新。

本文只写“相对基线的不足/不一致点”。
- 对“图片/资源”只关注是否缺失/可用性；**不强求字节级一致**（但仍会统计 sha 差异，便于需要严格模式时推进）。
- “多出来的文件/字段”默认不视为错误（除非开启严格模式），但会作为“对标差异”记录。

## 对标基线与对照口径

- **基线（仅用于对照）**：`temp/metaBaselineRef/meta-{gs|sr}`（也可替换为 `plugins/miao-plugin/resources/meta-{gs|sr}`）
- **生成产物**：`temp/metaGenerator/.output/meta-{gs|sr}`
- **对照命令（全量）**：
  - `node dist/cli.js validate --games gs,sr --types all --full --baseline-root temp/metaBaselineRef --output-root temp/metaGenerator/.output`
- **最新报告**：`reports/2026-01-30T17-25-31-074Z-validate.{md,json}`

### 最新对标摘要（文件级）

- compared=6637
- missing=0
- diff=0（JSON：生成版对基线保持 superset/一致）
- warn=5883（非 JSON：sha256 differs；默认 `strictSha=false`）
- extra=1387（输出多出文件；默认 `strictExtra=false`）

> validate 的“OK”含义：只要 `missing=0` 且 `diff=0`，并且未启用 `--strict-extra` / `--strict-sha`，就视为通过。  
> validate 目前不做“运行时一致性”验证（miao-plugin 加载/面板渲染/伤害结果），仅做文件级对标。

## 当前核心不足（相较基线）

### 1) 非 JSON 文件未做到字节级一致（warn=5883）

- 扩展名分布：`webp=5417`、`png=185`、`js=281`
- 桶分布：character=3662、weapon=1156、material=567、artifact=498

影响/风险：
- 默认仅告警，不影响 validate 通过；但 `validate --strict-sha` 会直接失败。
- 图片 `sha` 不同通常来自“来源/压缩参数差异”，不一定影响可用性。
- `js` 的 `sha` 不同往往意味着逻辑不同（不是“压缩差异”），需要按文件/按功能评估（例如 `calc.js`、`extra.js`）。

### 2) 输出文件集合是“基线超集”（extra=1387）

- 桶分布：character=1215、material=100、artifact=36、weapon=36
- 扩展名分布：`webp=1102`、`js=262`、`png=14`、`json=9`
- 常见 extra 示例：
  - `meta-*/character/<角色>/artis.js`、`calc_auto.js`
  - `meta-*/character/<角色>/icons/**`、`imgs/**`
  - `meta-gs/artifact/imgs/<套装>/**`（分件图）

影响/风险：
- 默认允许（`strictExtra=false`）；如果需要“目录集合严格一致”，需提供“prune/compat 模式”或将额外产物移到独立目录。

### 3) calc.js 的语义一致性仍需运行时对齐

- 现状：角色 `calc.js` 已支持通过 LLM 生成 `details + buffs`，并尽量对齐基线“极限”中 `buffs` 的结构形态（`title/sort/cons/tree/check/data`）。
- 差距：复杂条件/参数化（`check/params`）、特殊机制/反应/队伍联动等仍可能与基线不一致；且 validate 不执行 JS，无法直接判定“算得是否一致”。

### 4) “缺失即日志，不造数据”的策略导致信息完备度受限

- 当上游缺字段/缺资源时：不会写占位，只记录 `logs/*-gen.log` 的 `data-error/asset-error`。
- 若要达到“超越基线”的信息完备度：需要引入额外数据源/抓取策略（而不是在生成阶段填假数据）。

## 已修复/已对齐（相较早期抽样记录）

- JSON superset 问题已清零：当前全量对标 `diff=0`（artifact/material/character/weapon）。
- 体验脚本覆盖度不再明显落后：例如 `alias.js`、`artis-mark.js`、`abbr.js` 行数已达到或超过基线（但仍存在 sha 差异，需关注语义一致性）。

