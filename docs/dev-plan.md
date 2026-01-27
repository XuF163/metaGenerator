# metaGenerator（TS）开发计划

> 背景材料：`temp/metaGenerator/docs/background.md`  
> 产物对标：`plugins/miao-plugin/resources/meta-gs`、`plugins/miao-plugin/resources/meta-sr`  
> 实现参考：`plugins/liangshi-calc`（尤其是 `plugins/liangshi-calc/apps/new.js` 的更新思路与落盘路径）

## 0. 目标与边界

### 0.1 目标（要做到什么）

1) 在 `temp/metaGenerator` 下实现一个 **TypeScript** 编写的 meta 资源生成器（以下简称 *metaGenerator*）。
2) 能生成/更新喵喵面板所需的 meta 资源，目录结构与文件形态 **对标**：
   - `plugins/miao-plugin/resources/meta-gs`
   - `plugins/miao-plugin/resources/meta-sr`
3) 生成链路至少覆盖：
   - **静态数据**（核心）：`data.json`、各类索引与实体元数据（角色/武器/遗物/材料）
   - **资源文件**（按需）：角色/武器/遗物等图片（`imgs/`、`icons/`、`public/` 等）
   - **伤害计算脚本**（可渐进）：`calc.js` 允许“自动脚手架 + 人工修正”，并支持接入低成本 LLM 做二次解析 wiki 文本以提升覆盖率
4) **验收要求（强约束）**：在“同一版本快照/同一输入 Profile”的前提下，使用“原版 meta”与“生成 meta”得到的 **面板产物、伤害计算结果、别名解析等表现保持一致**（详见 `2.7 验收标准`）。

### 0.2 非目标（本阶段不强求）

- 不要求一次性 100% 复刻 CNB(meta 仓库)的全部字段/全部脚本逻辑；以 **面板渲染可用 + 计算主链路可用** 为阶段性验收。
- 不要求完全自动理解所有机制文本；复杂机制允许生成占位符并进入人工校对流程。
- 不强制改造现有业务代码（本计划文档阶段只做方案设计，后续再按里程碑落地）。

---

## 1. 现状梳理（As-Is）

### 1.1 miao-plugin 如何消费 meta

- 热重载入口：`plugins/miao-plugin/tools/metaReload.js:updateAndReloadMeta()`
  - 会 `import`：`meta-{gs|sr}/{artifact,character,material,weapon}/index.js`
  - 会 `Meta.reset()` 清空缓存后重新加载，并清理若干模型缓存（`Base/Weapon/Material/CharCfg`）
- meta 仓库维护：`plugins/miao-plugin/tools/metaRepo.js`
  - 默认把 `meta-gs/meta-sr` 当作 git 仓库：缺失则 `git clone`，更新则 `git pull`
  - **关键冲突点**：`ensureMetaRepo()` 在检测到 `.git` 后会执行 `git checkout -- .` 清理改动；这会把本地生成产物当作“工作区改动”回滚
- 定时任务与指令：`plugins/miao-plugin/apps/metaRepoTask.js`
  - 每日 4 点 + `#更新meta` 默认执行 `updateAndReloadMeta({ pull: true })`（包含 git pull）

> 结论：如果 metaGenerator 直接写入 `plugins/miao-plugin/resources/meta-*`，必须同时解决“被 git 机制覆盖”的集成问题（见第 6 章）。

### 1.2 liangshi-calc 的可借鉴点

- 更新入口集中在 `plugins/liangshi-calc/apps/new.js`：
  - 存在“识别版本新内容 → 拉取数据 → 写入 miao meta 目录”的一键更新流程
  - 路径上可见写入：`./plugins/miao-plugin/resources/meta-${GamePath}/...`
- liangshi-calc 已形成“配置（YAML）+ 缓存（本地 JSON）+ 落盘（meta 目录）+ 日志”的基本工程闭环（可复用其工程经验，但本项目目标语言统一 TS）。

---

## 2. 产物规格（To-Be / Output Contract）

> 以“对标现有目录”为准：先把输出规格固定下来，生成器才能稳定演进。

### 2.1 顶层目录

目标输出根（本项目当前优先）：`temp/metaGenerator/.output/`  
可选部署/应用目标（后续里程碑）：`plugins/miao-plugin/resources/`

生成器需要对齐的目录：

- `meta-gs/`
  - `artifact/`、`character/`、`material/`、`weapon/`、`info/`
- `meta-sr/`
  - `artifact/`、`character/`、`material/`、`weapon/`、`info/`、（以及存在的 `public/` 等资源目录）

### 2.2 角色（character）

对齐参考（抽样）：
- `plugins/miao-plugin/resources/meta-gs/character/data.json`
- `plugins/miao-plugin/resources/meta-gs/character/重云/{data.json,calc.js,imgs/,icons/}`
- `plugins/miao-plugin/resources/meta-sr/character/data.json`
- `plugins/miao-plugin/resources/meta-sr/character/停云/{data.json,calc.js,imgs/}`

约定输出（阶段目标）：

1) `character/data.json`（索引/聚合）
   - GS：以 `id` 为 key 的对象（`{ [id: string]: {...} }`），至少包含 `id/name/star/elem/weapon/talentId/talentCons/...`
   - SR：同样为对象，至少包含 `id/key/name/star/elem/weapon/sp/talentId/talentCons/...`
2) `character/<角色名>/data.json`（实体元数据）
   - 保证面板/计算需要的字段齐全（后续用 schema 校验兜底）
3) `character/<角色名>/calc.js`（计算脚本）
   - M1~M2：可先生成“基础倍率/基础 buffs”脚手架
   - M3+：引入 LLM 二次解析 wiki 文本，提升复杂机制覆盖率
4) 资源目录
   - `imgs/`、`icons/` 等：按现有渲染器实际读取路径对齐（通过运行时冒烟测试反推缺失项）

### 2.3 遗器/圣遗物（artifact）

对齐参考（抽样）：
- `plugins/miao-plugin/resources/meta-gs/artifact/data.json`
- `plugins/miao-plugin/resources/meta-sr/artifact/data.json`
- 以及各套装目录/图片目录

阶段目标：

- `artifact/data.json` 生成：套装 id → 套装名称/2&4件效果/部位信息等
- `artifact/calc.js`：优先采用模板化与规则库（可选再接入 LLM）
- 图片：按套装/部位规则下载与落盘

### 2.4 武器（weapon）

对齐参考（抽样）：
- GS：`plugins/miao-plugin/resources/meta-gs/weapon/<type>/data.json` + `<type>/calc.js` + `<type>/<武器名>/...`
- SR：`plugins/miao-plugin/resources/meta-sr/weapon/data.json` + `weapon/<命途>/calc.js` + `<命途>/<光锥名>/...`

阶段目标：

- 先生成 `data.json`（索引/聚合）与图片（满足面板渲染）
- `calc.js`：优先从表格化数据生成（SR 的 `staticIdx/keyIdx` 风格、GS 的 `step/refine` 风格）

### 2.5 材料（material）

对齐参考（抽样）：
- GS：`plugins/miao-plugin/resources/meta-gs/material/data.json`
- SR：`plugins/miao-plugin/resources/meta-sr/material/data.json`

阶段目标：

- 生成材料索引与层级关系（如 `items` 子树）、来源 `source` 等
- 文本与富文本（`<br />`）保持兼容（必要时做 HTML/Markdown 规范化）

### 2.6 `info/` 与其他骨架文件

> 这类文件往往是“手工骨架”，变动频率低，建议与“自动生成物”分离（见第 6 章的 ownership 设计）。

对齐参考：
- `plugins/miao-plugin/resources/meta-gs/info/index.js`
- `plugins/miao-plugin/resources/meta-sr/info/index.js`

当前实现（已落地）：

- metaGenerator 会先把**内置脚手架快照**同步到输出目录（`temp/metaGenerator/scaffold/meta-{gs|sr}` → `temp/metaGenerator/.output/meta-{gs|sr}`）
  - 会覆盖低频“骨架文件”（`index.js/alias.js/extra.js/...`，以及 SR 的 `public/icons` 等）
  - **永远不会从 baseline 目录拷贝任何文件作为生成兜底**
  - **永远跳过任何 `data.json`**（`data.json` 必须由解析管线从数据源生成）

为什么这样做：

- 生成环境可能不存在 `plugins/miao-plugin/resources/fuck_qsyhh/meta-{gs|sr}` 之类目录；脚手架必须“随工具自带”
- 骨架文件变动频率低、但又是 miao-plugin 可加载的必要条件；因此由 metaGenerator 统一管理更可靠

关于“圣遗物（artifact）会随版本更新，脚手架能否自动更新？”：

- **会自动更新的部分**：圣遗物套装/部位名/套装效果/图片等属于高频数据，落在 `artifact/data.json` 与 `artifact/imgs/**`，由 Hakush/AnimeGameData 等数据源解析生成；只要数据源更新并触发生成（见下条），就会更新。
- **需要人工维护的部分**：`artifact/alias.js`（别名/缩写）、`artifact/artis-mark.js`（评分权重）、`artifact/extra.js`（词条映射/ID 映射）属于“规则/体验层骨架”，通常低频变动；若游戏机制层发生变化（例如新增主词条类型/槽位规则变化），需要更新脚手架快照并随工具版本发布。
- **缓存提醒**：metaGenerator 默认启用磁盘缓存以保证可复现；新版本数据要“自动跟随更新”，需要：
  - 运行 `meta-gen gen --force-cache`（或在 `temp/metaGenerator/config/config.json` 中设置 `gen.forceCache=true` 让每次生成自动刷新缓存），然后再生成即可。

---

### 2.7 验收标准（原版 meta 一致性 / Baseline Parity）

> 本项目的硬性验收口径：**生成 meta 的效果必须与原版 meta 一致**。  
> 注意：一致性验收必须建立在“同版本快照/同输入数据”的前提，否则对比没有意义。

#### 2.7.1 基线定义（什么是“原版 meta”）

- **原版 meta**：以 `plugins/miao-plugin/resources/meta-gs`、`plugins/miao-plugin/resources/meta-sr` 的 **git 模式**内容为准（通常来自 CNB meta 仓库）。验收时必须记录并固定基线版本（至少包含各自的 commit hash/更新时间戳）。
- **生成 meta**：由 metaGenerator 产出，且写入结构与文件形态对齐原版 meta（见第 2 章输出规格）。

#### 2.7.2 验收输入（必须可复现）

- 采用 **随机抽样验收** 为主（避免只覆盖固定角色/固定内容）：
  - 每次运行从 GS/SR 各类型目录中随机抽样一定数量的文件/实体进行对比
  - **必须记录 seed**，确保差异可复现与可回归
  - 仍保留“固定冒烟集”作为补充（用于排查已知问题与快速回归）
- 输入数据必须固定化（建议用本地 fixtures，而不是在线 Profile API）：
  - 角色：等级/命座/天赋等级/武器/圣遗物（或遗器）/面板属性等
  - 计算：指定使用的计算规则集（`calc.js`/buffs/details）与期望输出项

#### 2.7.3 验收项（必须全部通过）

1) **Meta 加载一致**  
   - `Meta.reset()` 后加载 `meta-{gs|sr}/{artifact,character,material,weapon}/index.js` 不报错  
   - 关键索引可用：角色/武器/套装/材料可被正确 `getId/getName` 等检索

2) **检索与别名一致**（alias/abbr/映射）  
   - 对验收集中的名称、别名、缩写，`meta.getId(<输入>)` 的解析结果与原版一致  
   - 关键派生数据（例如妻子设置、别名表补丁等）不应出现行为差异

3) **面板产物一致**（渲染结果）  
   - 对同一份输入（同一角色/同一装备/同一配置），面板产物在“原版 meta vs 生成 meta”下保持一致  
   - 对比方式建议分两档（由验收脚本配置）：
     - **严格模式**：输出图片文件的 hash（如 SHA256）完全一致
     - **宽松模式**：允许图片编码差异（webp 压缩等），采用像素级 diff 阈值（例如 diff 像素占比 ≤ 0.1%），并额外校验关键数值文本（建议通过渲染前数据快照而非 OCR）

4) **伤害计算一致**（计算结果）  
   - 对同一份输入与同一计算配置，计算输出结构（条目/顺序/标题）一致  
   - 数值一致性要求（建议配置化）：
     - **严格模式**：数值完全一致
     - **宽松模式**：允许浮点误差/显示四舍五入差异，采用 `absDiff` 与 `relDiff` 双阈值（例如 `abs ≤ 1e-6` 或 `rel ≤ 1e-4`）

5) **资源完整性一致**（可用性）  
   - 面板渲染与计算链路所需的 `data.json`、图片、脚本文件齐全  
   - 缺失资源必须在报告中列出，并判定为不通过（除非显式允许缺失并有占位策略）

#### 2.7.4 报告与门禁（必须有）

- 每次验收生成报告（建议输出 `md + json`）：
  - 基线版本（meta-gs/meta-sr commit hash 或快照标记）
  - 生成版本（metaGenerator 输入源版本/生成时间）
  - 抽样策略（sample size + seed + 强制包含的关键文件数）
  - 面板 diff 清单（含差异图片/像素 diff 指标）
  - 伤害计算 diff 清单（含字段/数值差异与阈值判定）
- 任一验收项未通过：视为 **阻断发布**，必须回滚到原版 meta 或修复生成器后重跑。

## 3. 总体技术方案（Architecture）

### 3.1 工程形态（建议）

- `temp/metaGenerator` 作为独立工具工程（ESM + TS），提供：
  - CLI：本地一键生成/更新
  - 可选：提供“库模式”供 bot 指令/定时任务调用
- 目标语言统一 TS：
  - 源码：TS（`src/`）
  - 可运行产物：编译后的 JS（`dist/`），由 `node` 执行
  - 写入到 miao 资源目录的脚本文件：运行期仍需是 JS（因此建议“TS 生成 → 输出 JS”或“模板直接输出 JS”）

### 3.1.1 工程质量要求（模块化 + 注释）

> 代码质量要求与验收同等重要：后续生成规则会持续增长，必须可维护、可扩展、可审计。

- **模块化**：按职责拆分目录与模块（`config/sources/normalize/mappers/assets/calc/writer/validate/report`），禁止把拉取/映射/落盘/校验混写在同一个文件里。
- **边界清晰**：每层只做一件事；上层只能依赖下层的公开接口，不允许跨层读写内部实现细节。
- **可测试**：核心映射与计算生成逻辑必须是纯函数或近似纯函数（可注入 IO 依赖），便于单测与回归。
- **注释规范**：
  - 导出的公共函数/类型必须写 JSDoc（用途、入参、返回、抛错/失败模式）。
  - 对“为什么这样做”的关键决策写注释（例如：字段映射依据、兼容性修复、阈值选择）。
  - 对“输入数据不可信”的位置写防御性注释（例如：文案解析、LLM 输出校验、富文本清洗）。
- **一致的编码风格**：统一 UTF-8、统一换行、统一命名（TS：`camelCase`/`PascalCase`；文件：`kebab-case` 或 `camelCase` 二选一并固定）。

### 3.2 分层与模块拆分

建议分层（从输入到输出）：

1) `config/`：配置加载（YAML/JSON + env 覆盖），校验与默认值
2) `sources/`：数据源适配层（GS/SR 分开，支持多源、可切换、带缓存）
3) `normalize/`：把不同数据源归一为内部统一模型（Internal DTO）
4) `mappers/`：DTO → miao meta schema 的确定性映射
5) `assets/`：图片下载/裁切/格式转换（优先 webp），并落盘到约定目录
6) `calc/`：脚本生成
   - rule-based：正则/模板/表格推导
   - llm-based：二次解析 wiki 文本 → 结构化 JSON → 渲染为 JS
7) `writer/`：原子写入（tmp → rename）、备份、差异化写入（减少无意义变更）
8) `validate/`：schema 校验、运行时冒烟（import 生成脚本，检查语法/导出）
9) `report/`：生成报告（新增/变更/失败清单），便于人工回归

### 3.3 内部 Schema（强制）

为避免“看起来生成了、实际用不了”，建议对关键输出引入 **强校验**：

- 使用 `zod`（或同类）为下列文件建立 schema：
  - `character/data.json`
  - `character/<name>/data.json`
  - `artifact/data.json`
  - `weapon/data.json` / `weapon/<type>/data.json`
  - `material/data.json`
- 每次生成后必须通过校验，否则：
  - 保留旧版本（原子写入 + 回滚）
  - 输出错误报告（字段缺失/类型不符/枚举不合法）

---

## 4. 数据源与缓存策略

> background.md 已论证：静态 meta 自动化可行性很高，但关键在于“稳定数据源 + 确定性映射”。

### 4.1 数据源抽象（必须）

定义接口（伪）：

- `MetaSource`：`getCharacters()` / `getWeapons()` / `getArtifacts()` / `getMaterials()` / `getTextMap()` / `getImages()`…
- 对同一游戏允许多实现：
  - `GsSourceGenshinData`、`GsSourceAmbr`、`GsSourceHakushin`
  - `SrSource...`（同理）

通过配置切换数据源，避免被单一源“卡死”。

### 4.2 缓存与增量

建议缓存到：

- `temp/metaGenerator/.cache/<source>/<game>/...`

策略：

- 网络拉取：支持 ETag/Last-Modified（若源支持）
- 版本标记：记录上次生成的版本号/commit hash/发布时间戳
- 增量生成：优先只处理新增/变更实体（角色/武器/套装/材料）

---

## 5. 伤害计算（calc.js）生成方案

> 重点：允许接入低成本 LLM 做二次解析 wiki 文本，但要做到“可控、可回滚、可人工介入”。
> 额外约束：生成的 `calc.js` 末尾必须包含 `export const createdBy = "awesome-gpt5.2-xhigh"`（用于溯源）。

### 5.1 两段式生成（推荐）

**阶段 A：确定性脚手架（rule-based）**

- 从数据源获取：
  - 技能倍率参数表（如 `paramList`）
  - 技能/天赋描述（TextMap/本地化文本）
- 通过模板与正则库生成：
  - `details`（展示项）
  - `buffs`（常规加成）
  - `mainAttr/defDmgIdx` 等基础配置
- 对无法识别的机制：
  - 生成占位符/最小可用逻辑
  - 记录 `TODO` 与“缺口原因”（用于后续 LLM/人工补齐）

**阶段 B：LLM 二次解析（llm-based）**

- 输入：清洗后的 wiki 文本（尽量结构化：技能段落/倍率段/触发条件段）
- 输出：严格的结构化 JSON（禁止自由发挥）
  - 例如 `{ details: [...], buffs: [...], notes: [...] }`
- 再由模板把 JSON 渲染为 `calc.js`（避免 LLM 直接吐 JS 带来不可控）

### 5.2 LLM 接入规范（必须）

配置化（不写死厂商）：

- 兼容 OpenAI API 形态（`baseUrl/apiKey/model`）
- 默认选择低成本模型，但保留“切到更强模型”的开关

安全与稳定性：

- 必须要求 LLM 输出 JSON 并通过 schema 校验
- 对关键字段（倍率、触发条件）做二次校验：
  - 数值范围检查
  - 与 paramList 对齐检查（能对齐则以表格为准）
- 失败策略：
  - 回退到阶段 A 的脚手架
  - 报告中标记“LLM 失败/不一致”

### 5.3 规则库与回归集

建立 `Regex Registry / Rule Registry`：

- 将常见句式固化为规则（提升无 LLM 情况下的覆盖率）
- 每次遇到新文案格式，只需补一条规则而非重写生成器

建立冒烟集（Smoke Set）：

- GS/SR 各选 10~20 个角色 + 若干武器/套装
- 每次生成后自动执行：
  - `import` 生成的 `calc.js`（语法/导出检查）
  - 对关键条目跑一次计算（防 NaN/undefined）

---

## 6. 与 miao-plugin 的集成与“所有权”设计（Ownership）

### 6.1 核心问题：git 仓库机制会覆盖本地生成物

当前 `plugins/miao-plugin/tools/metaRepo.js` 的行为决定了：

- 只要 `meta-*` 是 git repo（存在 `.git`），就会被 `git checkout -- .` 回滚工作区改动
- `updateAndReloadMeta({ pull: true })` 会继续 `git pull` 覆盖本地生成

### 6.2 推荐方案：引入 local 模式（与 background.md/现有计划一致）

建议将 `meta-*` 分为两类文件所有权：

- **手工骨架（稳定）**：`index.js/alias.js/extra.js/...`
- **自动生成物（高频）**：`data.json`、图片、（部分）`calc.js`

集成策略（后续里程碑落地）：

1) 在 `meta-*` 下引入哨兵文件（例如 `.meta-local`）
2) miao-plugin 在 local 模式下：
   - 不 clone、不 pull、不 checkout
   - 只做“目录存在性保障 + 热重载”
3) 初始化骨架：
   - 首次切到 local 模式时，从某个“骨架模板目录”复制 `index.js/alias.js/...`
   - 生成物由 metaGenerator 覆盖/补齐

> 注：仓库内已有类似讨论与方案雏形，可参考 `plugins/miao-plugin/docs/meta-replacement-plan.md`。

---

## 7. CLI 设计与配置约定

### 7.1 CLI 命令（建议）

示例（仅示意）：

- `meta-gen gs character`：生成/更新 GS 角色
- `meta-gen sr artifact`：生成/更新 SR 遗器
- `meta-gen all --dry-run`：全量生成到临时目录，仅输出报告
- `meta-gen gs character --only 新角色A,新角色B`
- `meta-gen gs --since <version|date>`：按版本/日期增量

### 7.2 配置文件（建议）

- 位置：`temp/metaGenerator/config/config.yaml`（用户私有，git 忽略）
- 模板：`temp/metaGenerator/config/config.example.yaml`
- 通过 env 覆盖敏感项：`META_LLM_API_KEY` 等

关键配置项：

- `outputRoot`：默认 `plugins/miao-plugin/resources`
- `games/types`：选择生成范围
- `source`：数据源选择与 baseUrl
- `cache`：缓存目录、过期策略、并发数、重试策略
- `llm`：是否启用、提供商配置、模型名、预算/速率限制
- `assets`：图片格式（webp/png）、尺寸策略、缺失容忍度

---

## 8. 里程碑（Milestones）

> 以“先面板可用，再追求计算覆盖率”为总节奏。

### M0：规格冻结与验收集（1~2 天）

- 固化输出规格（schema + 目录约定）
- 建立冒烟集与验收脚本（以“原版 meta 一致性”为硬门槛，详见 `2.7`）
- 明确“最小可用面板”需要哪些图片/字段
- 冻结并记录基线版本（原版 meta 的版本/commit），确保每次对比可复现
- 明确一致性判定策略：严格/宽松模式、数值容忍度、图片 diff 阈值、允许/不允许的差异清单

### M1：metaGenerator 工程骨架（1~2 天）

- 初始化 TS 工程、CLI、配置系统、缓存系统、原子写入、报告输出
- 仅做“空跑（dry-run）”：能读取配置、拉取最小数据、输出空报告

### M2：GS 静态数据生成（2~5 天）

- `character/data.json`、`character/<name>/data.json`
- 图片下载落盘（至少满足面板）
- `weapon/artifact/material` 先从索引类 `data.json` 切入（计算脚本暂不动）

### M3：SR 静态数据生成（2~5 天）

- 同 M2，但适配 SR 的 schema 与目录结构

### M4：calc.js 脚手架（2~6 天，持续迭代）

- 先支持规则化技能：纯倍率、线性加成、常见触发条件
- 建立规则库与回归集

### M5：LLM 二次解析接入（2~6 天，持续迭代）

- 接入 OpenAI 兼容客户端（可配置低成本模型）
- JSON 输出 + schema 校验 + 与 paramList 对齐校验
- 失败回退与报告

### M6：miao-plugin local 模式集成（0.5~2 天）

- 引入 `.meta-local` 并修改 `metaRepo/metaReload/metaRepoTask`（或新增旁路入口）
- 让 `#更新meta` 在 local 模式下只做热重载（不触发 git）

---

## 9. 风险与对策

1) **数据源变动/不可用**：多源适配 + 缓存 + 可回滚
2) **git 覆盖生成物**：local 模式 + 文件所有权分离
3) **LLM 幻觉/不一致**：强制 JSON + schema 校验 + 与参数表对齐 + 失败回退
4) **文本/编码/富文本差异**：统一 UTF-8；对 `<br>`/HTML 做规范化；保留原始文本快照便于 diff
5) **图片缺失/格式不一致**：下载重试 + 不创建占位图（仅记录 `temp/metaGenerator/logs/`）+ 报告缺失清单
6) **全量生成耗时**：增量策略 + 并发控制 + 分游戏/分类型拆分

---

## 10. 下一步（本仓库内的落地顺序建议）

> 本 PR/本轮仅输出计划文档，不改动代码。后续落地建议按下列顺序推进：

1) 先把“输出规格 + schema + 冒烟集”固定（避免越写越乱）
2) 先做 GS 静态数据（`data.json` + 图片）跑通面板
3) 再做 SR 静态数据
4) 再做 calc 脚手架与 LLM 增强
5) 最后做 miao-plugin 的 local 模式集成，彻底解决 git 覆盖问题
