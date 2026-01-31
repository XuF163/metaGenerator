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

- 报告：`reports/2026-01-30T17-25-31-074Z-validate.{md,json}`
- 结果：compared=6637 / missing=0 / diff=0 / warn=5883 / extra=1387
- 不足汇总（滚动更新）：`docs/对标差异-不足清单-artifact-material-2026-01-27.md`
