# circaltest

本目录用于记录 metaGenerator 的关键验收/回归步骤，便于按“修复 -> 测试 -> 评估 -> 迭代”的方式持续对标基线 meta。

## 快速开始（建议顺序）

```powershell
# 0) 可选：初始化上游子模块（calc.channel="upstream" / "upstream-direct" 需要）
git submodule update --init --recursive

# 1) 构建
npm i
npm run build

# 2) 生成 meta（默认：纯 API 生成；不会从基线拷贝兜底）
node dist/cli.js gen

# 3) 生成/升级角色 calc.js（可选：启用 LLM）
node dist/cli.js calc --games gs,sr

# 4) 与基线对标（文件级）
node dist/cli.js validate --games gs,sr --types all --full
```

## 回归校验（可自动化）

```powershell
# 检查：所有角色 calc.js 可被 Node ESM 正常 import（避免 SyntaxError / ReferenceError 等导入期错误）
node circaltest/regression.mjs
```

## 实际面板差异回归（证据链）

目标：用 **同 UID、同角色** 的真实面板数据（Enka）在两套 meta 下分别计算伤害输出，并生成可追溯的对比证据。

说明：
- 全流程只在 `circaltest/` 下运行：会创建 `circaltest/.sandbox/`（隔离的 miao-plugin 环境）与 `circaltest/evidence/`（证据输出），**不会触碰你的生产环境**。
- 如需代理：优先读取 `--proxy`，否则读取环境变量 `HTTP_PROXY`。
- 约束：禁止使用 `uid=100000000` 作为测试 UID（脚本已强制拦截）。

```powershell
# 基本用法（GS）
node circaltest/panel-regression.mjs --uid 147962990

# 使用本地 testData（避免实时拉取；推荐用于可复现实验）
node circaltest/panel-regression.mjs --useTestdata --uid 147962990 --game gs

# SR：使用本地 testData（SR 不支持 Enka 拉取模式）
node circaltest/panel-regression.mjs --useTestdata --uid 100000296 --game sr

# 使用代理（按需：本地 10809）
node circaltest/panel-regression.mjs --uid 147962990 --proxy http://127.0.0.1:10809

# 产物：circaltest/evidence/<timestamp>/
# - enka/raw/<uid>.json           # 原始 Enka JSON
# - baseline/gs/<uid>.json        # 基线 meta 下的伤害输出
# - generated/gs/<uid>.json       # 生成 meta 下的伤害输出
# - diff/gs/<uid>.md              # 对比报告（按角色列出 avg/ratio/abs）
# - diff/gs/<uid>.json            # 结构化 diff
```

## 全角色覆盖回归（优先覆盖全角色，尽量少 UID）

说明：从 `testData/{gs|sr}/*.json` 中用贪心覆盖算法选取**最少 UID**，使得面板回归可以覆盖尽可能多的角色（避免“全 UID 覆盖”）。

```powershell
# GS + SR（推荐）
node circaltest/panel-regression-cover.mjs --game both

# 仅 GS / 仅 SR
node circaltest/panel-regression-cover.mjs --game gs
node circaltest/panel-regression-cover.mjs --game sr

# 产物：circaltest/evidence/<timestamp>-cover/summary/{gs|sr}.md
```

## calc.js 批量迭代（LLM）

当面板回归发现某些角色偏差较大时，可根据 diff.json 自动挑选 Top N 角色批量重生成 `calc.js`：

提示：可在 `config/config.json` 设置 `calc.channel` 切换 calc 生成渠道：
- `llm`（默认）：LLM 自生成
- `upstream`：追随上游（genshin-optimizer / hsr-optimizer）抽取上下文 + LLM 生成（需要先初始化子模块）
- `upstream-direct`：追随上游但不使用 LLM，上游脚本直出（需要先初始化子模块）

注意：`--baseline-overlay` 仅用于 debug（把基线 meta 作为 overlay 以排查差异），不应作为常态生成方案。

```powershell
node dist/cli.js gen --games sr --types character --baseline-overlay --force
node dist/cli.js calc --games sr
```

```powershell
# 从某次 panel-regression 的 diff.json 中挑选偏差最大角色批量重生成（仅 GS）
node circaltest/regen-calc-batch.mjs --fromDiff circaltest/evidence/<timestamp>/diff/gs/<uid>.json --minDev 1.4 --top 10 --concurrency 6
```

## 目录约定

- 输出：`temp/metaGenerator/.output/meta-{gs|sr}`
- 缓存：`.cache/`
- 日志：`logs/`
- 对标报告：`reports/`
- 脚手架：`scaffold/meta-{gs|sr}`（运行期加载入口/胶水文件）

## 当前仍可能的不足点（相较基线）

- **非 JSON 文件的字节级差异**：图片/派生脚本可能出现 `sha256 differs`，默认仅计为 `warn`；如需严格一致用 `--strict-sha`。
- **输出目录的“额外文件”**：默认允许（`strictExtra=false`）；如需严格集合一致用 `--strict-extra`。
- **calc.js 语义一致性**：目前以“结构/详细程度对标”为目标（details + buffs），但复杂条件/参数化/特殊机制仍可能与基线存在语义差异，需要按个案迭代提示词或补启发式规则。
- **上游缺失不造数据**：当上游缺字段/缺资源时不写占位符，只在 `logs/*-gen.log` 记录 `data-error/asset-error`；若要达到“超越基线”的信息完备度，需要扩充/替换数据源或增加抓取策略。

## 最新基线对标（文件级）

- 报告：`reports/2026-01-31T08-24-24-299Z-validate.{md,json}`
- 结果：compared=6637 / missing=0 / diff=0 / warn=5883 / extra=1387
- 不足汇总（滚动更新）：`docs/对标差异-不足清单-artifact-material-2026-01-31.md`
