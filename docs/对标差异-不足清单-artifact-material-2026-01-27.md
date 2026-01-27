# 对标差异（仅列不足项）- artifact/material（GS+SR）


# 本文中基线指的是 https://cnb.cool/qsyhh_res/meta/-/tree/meta-gs https://cnb.cool/qsyhh_res/meta/-/tree/meta-sr (只读 演进直接从其中复用数据)
本文只写“相对基线的不足/不一致点”，**不列出生成版本“多出来的字段/文件”**；图片只关注“是否缺失/明显不可用”，不追求字节级一致。

## 对标基线与本次对照范围

- **基线（仅用于对照）**：`plugins/miao-plugin/resources/meta-{gs|sr}`
- **生成产物**：`temp/metaGenerator/.output/meta-{gs|sr}`
- **对照命令（抽样）**：`node dist/cli.js validate --games gs,sr --types artifact,material --sample 200`
- **报告**：`temp/metaGenerator/reports/2026-01-27T13-15-41-366Z-validate.{md,json}`
  - `totalCompared=223`（含 top-level 文件 + 随机抽样 200）
  - `missing=0`（抽样范围内未发现“基线存在但生成缺失”的文件）
  - `different=204`（大量为图片/脚本 hash 不同；本文只挑“影响可替代性”的不足）

## 总览：当前影响可替代性的核心不足

1. **关键 JSON 并非“基线的超集”**（validate 的 superset 规则不通过），主要集中在：
   - `meta-gs/material/data.json`：**所有差异都在 `.id` 字段格式**（基线是数字，生成是字符串如 `n104134`）。
   - `meta-sr/material/data.json`：**缺失大量条目**（见下文分组统计）。
   - `meta-sr/artifact/data.json`：**大量遗器部位的 `desc/lore` 为空**（信息缺失）。
   - `meta-gs/artifact/data.json`：少量圣遗物套装效果文本/ID 不一致（含数值、持续时间、月系反应条目等）。
2. **别名/标记等“体验类脚本”覆盖度显著低于基线**（可能影响用户输入容错与面板展示习惯）：
   - `artifact/alias.js`：GS 与 SR 都比基线短很多（见下文行数对比）。
   - `artifact/artis-mark.js`：GS 与 SR 都比基线短很多（标记/权重覆盖不足）。
   - `gs/material/abbr.js`：简称表明显精简，覆盖不足。

## 逐项不足清单（按 game/type）

### GS / artifact

**1) `meta-gs/artifact/data.json`：套装效果文本与 ID 不一致（13 处差异）**

- 现状：`validate` 报告为“json output is not a superset of baseline”
- 具体差异集中在以下 key（均为基线存在条目）：  
  - 2/4 件套效果文本差异（包含新反应/数值/持续时间）：`400028`、`400109`、`400154`、`400169`、`400221`、`400231`、`400261`、`400271`、`400281`、`400291`、`400301`、`400311`
  - **ID 值不一致**：`400391.id`（基线为 `400391`，生成值不同）

> 影响：面板展示的套装说明/计算映射可能与基线不同；ID 不一致可能导致基于 ID 的关联失败。

**2) `meta-gs/artifact/alias.js`：别名覆盖不足**

- 行数对比：生成 `24` 行 vs 基线 `114` 行

> 影响：用户输入套装简称/别名的命中率可能低于基线。

**3) `meta-gs/artifact/artis-mark.js`：标记/权重覆盖不足**

- 行数对比：生成 `11` 行 vs 基线 `113` 行

> 影响：圣遗物评分/标记（如果依赖此文件）覆盖度不如基线。

**4) `meta-gs/artifact/calc.js`：可计算的套装效果覆盖不足**

- 生成版 `calc.js` 的策略是“从套装文本做确定性映射”，会**主动跳过复杂条件**以避免算错；
- 基线包含更多**条件判断/参数化**（包含较新的机制与反应体系）。

> 影响：伤害/增益计算的“完整性”较基线偏弱（尤其是复杂条件型套装）。

### GS / material

**1) `meta-gs/material/data.json`：`.id` 字段格式与基线不一致（401 处，全部都是 `.id` 差异）**

- 统计：`mismatch=401`，且 `idMismatch=401`（非 `.id` 的 mismatch 为 `0`）
- 表现：基线 `.id` 多为数字（如 `374`），生成版为字符串且带前缀（如 `n104134`）

> 影响：若上层逻辑存在“按数字 ID 查找/比较”的实现，可能出现不兼容。

**2) `meta-gs/material/data.json`：缺失 6 个基线 key**

- `「诗文」的哲学.items.「自由」的教导`
- `「诗文」的哲学.items.「抗争」的指引`
- `「黄金」的哲学`
- `undefined`（基线中存在名为 `"undefined"` 的条目，生成版缺失）
- `精制机轴.items.磨损的执凭`
- `精制机轴.items.精致的执凭`

> 影响：对应材料在面板/合成/掉落描述等引用场景可能出现缺项。

**3) `meta-gs/material/abbr.js`：简称表覆盖不足**

- 行数对比：生成 `7` 行 vs 基线 `46` 行

> 影响：材料简称/别名检索的命中率低于基线。

### SR / artifact

**1) `meta-sr/artifact/data.json`：信息缺失（398 处 mismatch）**

- 统计（以“基线为准”对照）：
  - `mismatch=398`
  - 其中 **`desc/lore` 为空**导致的 mismatch：`319`
  - 其余常见为格式差异（如 `10.0%` vs `10%`）：`79`

> 影响：遗器部位描述/故事文本缺失（面板展示信息不全）；部分格式差异可能影响字符串级解析（若有）。

**2) `meta-sr/artifact/alias.js`：别名覆盖不足**

- 行数对比：生成 `15` 行 vs 基线 `146` 行

**3) `meta-sr/artifact/artis-mark.js`：标记/权重覆盖不足**

- 行数对比：生成 `10` 行 vs 基线 `90` 行

**4) `meta-sr/artifact/calc.js`：可计算效果覆盖不足**

- 同 GS：生成版偏“安全保守映射”，复杂条件/机制覆盖通常不如基线。

### SR / material

**1) `meta-sr/material/data.json`：缺失大量基线条目（110 个 missing_key + 1 个星级不一致）**

- 缺失统计（missing_key=110）：
  - `normal`：9
  - `char`：23
  - `exp`：3
  - `material`：75
- 星级不一致（mismatch=1）：`normal.110508.star`（基线 `5`，生成 `4`）

> 影响：材料/经验材料/角色培养材料的展示、合成、掉落来源等可能出现缺项或错误星级。

## 关于图片差异（按“看着差不多即可”的口径）

- 本次抽样 validate：`missing=0`，未发现“基线存在但生成缺失”的图片文件。
- 但 `sha256 differs` 的图片非常多：多来源下载/压缩参数差异会导致 hash 不同，这里不作为不足项逐个列出。

