# 对标差异（仅列不足项）- 全量（GS+SR）

> 文件名带 `artifact-material-2026-01-27` 是历史原因；本文内容会随最新对标结果更新。

本文只写“相对基线的不足/不一致点”。
- 对“图片/资源”只关注是否缺失/可用性；**不强求字节级一致**（但仍会统计 sha 差异，便于需要严格模式时推进）。
- “多出来的文件/字段”默认不视为错误（除非开启严格模式），但会作为“对标差异”记录。

## 对标基线与对照口径

- **基线（仅用于对照）**：`temp/metaBaselineRef/meta-{gs|sr}`（也可替换为 `plugins/miao-plugin/resources/meta-{gs|sr}`）
- **生成产物**：`temp/metaGenerator/.output/meta-{gs|sr}`
- **注意：先编译再跑 dist**：`npm run build`（否则 `node dist/cli.js ...` 可能仍是旧实现，出现“LLM 只写 details 不写 buffs”等错觉）
- **对照命令（全量）**：
  - `node dist/cli.js validate --games gs,sr --types all --full --baseline-root temp/metaBaselineRef --output-root temp/metaGenerator/.output`
- **最新报告**：`reports/2026-01-31T08-24-24-299Z-validate.{md,json}`

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
- 已补齐最低限度的“运行时可加载”回归：
  - `node circaltest/regression.mjs`：并发 `import` 全量 `meta-{gs|sr}/character/**/calc.js`，避免 miao-plugin 启动时报 `ReferenceError/SyntaxError`；同时校验 SR `character/alias.js` 是否导出 `abbr`。
  - LLM 输出写盘前会做 JS 自检（语法 + 顶层引用），失败自动重试，最终回退 heuristic，尽量保证“可加载”。
- 已补齐“运行时结果对照”的面板回归（证据链）：
  - `node circaltest/panel-regression.mjs --uid <UID>`：拉取 Enka 面板 JSON，在 **基线 meta** 与 **生成 meta** 两套环境中分别计算并落盘，输出 `diff/*.md + diff/*.json`。
  - 最新证据示例（滚动）：`circaltest/evidence/*/diff/gs/147962990.md`（同 UID、同角色对照）。
- SR 面板回归最新进展（`uid=100000296`）：
  - 证据链：`circaltest/evidence/2026-02-06T03-49-19-834Z/diff/sr/100000296.md`
  - 关键修正：SR calc 输入扩展到所有 talent blocks（含 `me/mt/...`）+ 推导 `defParams.Memosprite` + 过滤“秘技=开战伤害”类文案避免误生成 `atkPct` buff。
  - 指标观察：极端偏差显著收敛（max dev 约从 `~159` 降至 `~17`；仍存在少量 0 值/未匹配标题导致的 diff 观感偏大）。

仍需迭代点（运行时差异层面）：
- `details` 标题/粒度不一定与基线 1:1 对齐（基线可能输出“某技能总伤害/循环伤害”，生成侧可能输出“单段/每跳/分段”），导致 diff 中出现 baseline 行无法匹配或 ratio 看起来偏离。
- 复杂机制/条件（命座/被动触发窗/参数化 `params`/队伍联动/特殊反应）仍可能差异较大；目前策略是不复用基线逻辑，只能通过“提示词 + 启发式规则 + 运行时回归”逐步收敛。

### 4) “缺失即日志，不造数据”的策略导致信息完备度受限

- 当上游缺字段/缺资源时：不会写占位，只记录 `logs/*-gen.log` 的 `data-error/asset-error`。
- 若要达到“超越基线”的信息完备度：需要引入额外数据源/抓取策略（而不是在生成阶段填假数据）。

## 已修复/已对齐（相较早期抽样记录）

- JSON superset 问题已清零：当前全量对标 `diff=0`（artifact/material/character/weapon）。
- 体验脚本覆盖度不再明显落后：例如 `alias.js`、`artis-mark.js`、`abbr.js` 行数已达到或超过基线（但仍存在 sha 差异，需关注语义一致性）。
- LLM calc 生成吞吐已提升：GS/SR 角色 calc.js 生成改为批量并发（受 `llm.maxConcurrency` 控制），生成阶段明显提速。
- 常见 LLM 产物导入错误已兜底：对 `Unexpected token` / `Invalid token` / 顶层 `params is not defined` 等，会触发重试与回退。
- SR 角色根索引导入错误已修：`meta-sr/character/index.js` 依赖 `alias.js` 导出 `abbr`，已在 scaffold+compat 修复（避免 `does not provide an export named 'abbr'`）。
- GS/SR 角色 `calc.js` 的 `details` 已支持生成更多类型：`dmg/heal/shield/reaction`；并补齐了两类常见“极端错误”的根因：
  - 伤害倍率的 HP/DEF 误判（通过 `tableUnits` + 描述兜底推断，避免满级技能伤害只有几百）。
  - 治疗/护盾选择了展示用的“百分比+固定值”表导致数值离谱（对 heal/shield 自动优先使用同名 `*2` 表，通常为 `[pct, flat]` 结构）。

