# metaGenerator 

支持自托管的miao-plugin meta 资源生成工具  

## 安装

在仓库根目录执行：

```powershell
cd temp/metaGenerator
npm i
npm run build
```

### 1) 生成

```powershell
node dist/cli.js gen
```


```powershell
# 覆盖输出目录（重新生成）
node dist/cli.js gen --force

# 强制刷新 Hakush 缓存 JSON（调试/上游更新时）
node dist/cli.js gen --force-cache

# 强制重下图片资源（调试图片缺失/损坏时）
node dist/cli.js gen --force-assets
```


## 文档

- 开发计划：`temp/metaGenerator/docs/dev-plan.md`
- 数据源与产物映射：`temp/metaGenerator/docs/数据源与meta映射.md`
- LLM 接口说明：`temp/metaGenerator/docs/llmapi.md`

## 致谢（数据源 / API）
metaGenerator 的开发参考、引用、借鉴了以下项目，在此致谢：
- liangshi-calc ： https://github.com/liangshi233/liangshi-calc  
- miao-python :  https://gitee.com/Gaias/miao-python  

metaGenerator 的数据与图片资源主要来自以下公开数据源（按用途分组列出），在此致谢：

- Hakush（结构化数据 + UI 资源）：https://hakush.in/ 、https://api.hakush.in/
- Dimbreath AnimeGameData（GS Excel 数据/映射）：https://gitlab.com/Dimbreath/AnimeGameData
- Dimbreath turnbasedgamedata（SR Excel 数据/映射）：https://gitlab.com/Dimbreath/turnbasedgamedata
- HoYoWiki / HoYoLAB Wiki API（SR 部分图标补齐）：https://wiki.hoyolab.com/ 、https://sg-wiki-api.hoyolab.com/
- Yatta（补图/补资源）：https://gi.yatta.moe/chs 、https://sr.yatta.moe/
- Enka.Network（GS 武器图标后备）：https://enka.network/
- HoneyHunterWorld（部分图标/分件图后备）：https://gensh.honeyhunterworld.com/

## 许可证  
CC BY-NC  
