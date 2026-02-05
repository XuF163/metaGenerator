# circaltest

本目录用于记录 metaGenerator 的关键验收/回归步骤，便于按“修复 -> 测试 -> 评估 -> 迭代”的方式持续对标基线 meta。

## 快速开始（建议顺序）

```powershell
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

```powershell
# 基本用法（GS）
node circaltest/panel-regression.mjs --uid 147962990

# 使用本地 testData（避免实时拉取；推荐用于可复现实验）
node circaltest/panel-regression.mjs --useTestdata --uid 147962990 --game gs

# 使用代理（按需：本地 10809）
node circaltest/panel-regression.mjs --uid 147962990 --proxy http://127.0.0.1:10809

# 产物：circaltest/evidence/<timestamp>/
# - enka/raw/<uid>.json           # 原始 Enka JSON
# - baseline/gs/<uid>.json        # 基线 meta 下的伤害输出
# - generated/gs/<uid>.json       # 生成 meta 下的伤害输出
# - diff/gs/<uid>.md              # 对比报告（按角色列出 avg/ratio/abs）
# - diff/gs/<uid>.json            # 结构化 diff
```

## calc.js 批量迭代（LLM）

当面板回归发现某些角色偏差较大时，可根据 diff.json 自动挑选 Top N 角色批量重生成 `calc.js`：

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
