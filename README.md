# metaGenerator 

支持自托管的miao-plugin meta 资源生成工具    

> [!CAUTION]
> 本项目尚处于开发阶段,无法保证与你所用分支字段完全对齐    

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


```

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
