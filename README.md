# metaGenerator 

支持自托管的miao-plugin meta 资源生成工具    

> [!CAUTION]
> 本项目仍处于快速迭代阶段，无法保证与你所用分支/基线的字段 100% 对齐。

## 安装

在仓库根目录执行：

```powershell
# 可选：仅当使用 calc.channel="upstream" 时需要
git submodule update --init --recursive

npm i
npm run build
```

## 配置（可选）

复制示例配置（`config/config.json` 已被 `.gitignore` 忽略，仅用于本地）：

```powershell
Copy-Item config/config.example.json config/config.json
```

常用目录（默认）：
- 输出：`temp/metaGenerator/.output/`
- 缓存：`.cache/`
- 日志：`logs/`
- 对标报告：`reports/`

### 代理（可选）

如需走本地 HTTP 代理：

```json
{
  "network": { "httpProxy": "http://127.0.0.1:10809" }
}
```

说明：
- `httpProxy` 会影响所有出网请求（上游数据/图片下载 + LLM API 请求）。

### LLM（可选，用于 calc.js）

详见：`docs/llmapi.md`

## 生成 meta

```powershell
node dist/cli.js gen
```


```powershell
# 覆盖输出目录（重新生成）
node dist/cli.js gen --force

# 强制刷新 Hakush 缓存 JSON（调试/上游更新时）
node dist/cli.js gen --force-cache


```

## 生成/升级角色 calc.js（LLM 可选）

```powershell
node dist/cli.js calc --games gs,sr
```

渠道（可选）：
- `calc.channel="llm"`（默认）：LLM JSON plan -> 校验 -> 渲染 calc.js
- `calc.channel="upstream"`：追随上游（genshin-optimizer / hsr-optimizer）抽取上下文 + LLM 生成 calc.js
  - 前置：初始化子模块 `git submodule update --init --recursive`
  - 可选：`calc.upstream.includeTeamBuffs=true`（默认 false，单人面板回归更稳定）

说明：
- 启用 LLM：设置 `config/config.json` 的 `llm.enabled=true`，并配置 `llm.model` + key（推荐 env；见 `docs/llmapi.md`）。
- `--force`：会升级“自动生成但 `buffs=[]`”的 calc.js（用于补齐 buffs）。
- `--force-cache`：绕过 `.cache/llm`，强制重新请求 LLM。

## 对标验证（baseline parity）

```powershell
node dist/cli.js validate --games gs,sr --types all --full
```

- `baselineRoot`：指向基线 meta 根目录（例如 `plugins/miao-plugin/resources` 或本地 clone 的 `temp/metaBaselineRef`）。

## 致谢
metaGenerator 的开发参考、引用、借鉴了以下项目，在此致谢：
- liangshi-calc ： https://github.com/liangshi233/liangshi-calc  
- miao-python :  https://gitee.com/Gaias/miao-python  

metaGenerator 的数据与图片资源主要来自以下公开数据源（按用途分组列出），在此致谢：

- Hakush（结构化数据 + UI 资源）：https://hakush.in/ 、https://api.hakush.in/
- Dimbreath AnimeGameData（GS Excel 数据/映射）：https://gitlab.com/Dimbreath/AnimeGameData
- Dimbreath turnbasedgamedata（SR Excel 数据/映射）：https://gitlab.com/Dimbreath/turnbasedgamedata
- HoYoWiki / HoYoLAB Wiki API（SR 部分图标）：https://wiki.hoyolab.com/ 、https://sg-wiki-api.hoyolab.com/
- Yatta（部分图标）：https://gi.yatta.moe/chs 、https://sr.yatta.moe/
- Enka.Network（GS 武器图标）：https://enka.network/
- HoneyHunterWorld（部分图标/分件图）：https://gensh.honeyhunterworld.com/

## 许可证  
CC BY-NC  
