/**
 * SR material generator (Hakush -> meta-sr/material).
 *
 * Update-mode goals:
 * - Keep baseline parity for existing items (do not rewrite data.json unless changed)
 * - Add brand-new materials from Hakush new.json to keep meta usable when baseline is behind
 * - Download missing material images under `meta-sr/material/<cat>/<name>.webp`
 *
 * Schema target: `plugins/miao-plugin/resources/meta-sr/material/data.json`.
 *
 * Notes on IDs:
 * - The baseline meta often uses a different ID space than Hakush `item_all.json`.
 * - For brand-new items, we fallback to Hakush IDs. This is sufficient for panel display
 *   and future mapping (name -> id) in our own generators.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { fetchJsonWithRetry } from '../../../http/fetch.js'
import { downloadPngToWebpOptional } from '../../../image/download-png-to-webp.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import type { HoYoWikiClient } from '../../../source/hoyoWiki/client.js'
import { logAssetError } from '../../../log/run-log.js'
import { runPromisePool } from '../../../utils/promise-pool.js'

type SrMaterialCategory = 'normal' | 'char' | 'exp' | 'material'
const SR_MATERIAL_CATEGORIES: SrMaterialCategory[] = ['normal', 'char', 'exp', 'material']

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeSrRichText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replaceAll('\\n\\n', '<br /><br />')
    .replaceAll('\\n', '<br />')
    .replaceAll('\n\n', '<br /><br />')
    .replaceAll('\n', '<br />')
    .replaceAll('<unbreak>', '<nobr>')
    .replaceAll('</unbreak>', '</nobr>')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<\/?i>/g, '')
    .trim()
}

function isPlaceholderText(text: string): boolean {
  const t = text.trim()
  // Hakush occasionally ships placeholder localized strings as literal "..." for some items.
  // Treat those as missing to allow fallback sources (Yatta/HoYoWiki) to fill real names/descs.
  return t === '...' || t === '…'
}

function starFromRarity(rarity: unknown): number {
  const r = typeof rarity === 'string' ? rarity : ''
  // Matches baseline meta-sr stars:
  // - Rare: 3, VeryRare: 4, SuperRare: 5
  const map: Record<string, number> = {
    Normal: 1,
    NotNormal: 2,
    Rare: 3,
    VeryRare: 4,
    SuperRare: 5
  }
  return map[r] ?? 0
}

/**
 * Compatibility overrides for SR material stars.
 *
 * Rationale:
 * - Some upstream sources disagree on a few items' rarity grading.
 * - We keep this table minimal and only for confirmed baseline parity issues.
 */
const SR_MATERIAL_STAR_OVERRIDES: Record<number, number> = {
  // Baseline uses 5★; Hakush/Yatta currently report VeryRare (4★).
  110508: 5
}

/**
 * Compatibility mapping for SR material IDs.
 *
 * Rationale:
 * - Baseline meta uses a legacy ID space for a handful of materials.
 * - These items exist in Hakush/Yatta, but under different numeric IDs.
 * - We keep this table minimal and only for confirmed baseline parity issues.
 *
 * Key: Hakush/Yatta item ID
 * Value: Baseline meta item ID (also used as JSON key)
 */
const SR_MATERIAL_ID_COMPAT: Record<number, number> = {
  // Currencies
  2: 29328, // 信用点

  // EXP (AvatarExp): baseline uses a different ID space.
  211: 409962, // 旅情见闻
  212: 409961, // 冒险记录
  213: 409960, // 漫游指南

  // Weekly/rare materials
  241: 125435, // 命运的足迹

  // Trace materials (TracePath): baseline uses a different ID space.
  110111: 635673, // 破碎残刃
  110112: 920200, // 无生残刃
  110113: 836259, // 净世残刃
  110121: 635674, // 猎兽之矢
  110122: 920201, // 屠魔之矢
  110123: 836260, // 逐星之矢
  110131: 635675, // 灵感之钥
  110132: 920202, // 启迪之钥
  110133: 836261, // 智识之钥
  110141: 635668, // 青铜的执着
  110142: 920195, // 寒铁的誓言
  110143: 836254, // 琥珀的坚守
  110151: 635669, // 黯淡黑曜
  110152: 920196, // 虚空黑曜
  110153: 836255, // 沉沦黑曜
  110161: 635670, // 谐乐小调
  110162: 920197, // 家族颂歌
  110163: 836256, // 群星乐章
  110171: 635671, // 丰饶之种
  110172: 920198, // 生命之芽
  110173: 836257, // 永恒之花
  110181: 635680, // 步离犬牙
  110182: 920207, // 狼毒锯牙
  110183: 836266, // 月狂獠牙
  110191: 635681, // 陨铁弹丸
  110192: 920208, // 命定死因
  110193: 836267, // 逆时一击
  110201: 874343, // 凌乱草图
  110202: 589816, // 动态线稿
  110203: 673757, // 精致色稿
  110211: 874344, // 散逸星砂
  110212: 589817, // 流星棱晶
  110213: 673758, // 神体琥珀
  110221: 874345, // 炽情之灵
  110222: 589818, // 星火之精
  110223: 673759, // 焚天之魔
  110231: 874346, // 云际音符
  110232: 589819, // 空际小节
  110233: 673760, // 天外乐章
  110241: 874339, // 异木种籽
  110242: 589812, // 滋长花蜜
  110243: 673753, // 万相果实
  110251: 6744567, // 思量的种
  110252: 6471577, // 末那芽苗
  110253: 6720910, // 阿赖耶华

  // Character ascension (AvatarRank): baseline uses a different ID space for many items.
  110401: 866633, // 铁狼碎齿
  110402: 983278, // 恒温晶壳
  // Weekly boss drops (4★)
  110501: 985668, // 毁灭者的末路
  110502: 270195, // 守护者的悲愿
  110503: 186254, // 无穷假身的遗恨
  110504: 470781, // 蛀星孕灾的旧恶
  110505: 386840, // 同愿的遗音
  110506: 671367, // 吉光片羽
  110507: 554722, // 阳雷的遥想
  110411: 866634, // 幽府通令
  110412: 983279, // 过热钢刃
  110421: 866635, // 星际和平工作证
  110422: 983280, // 忿火之心
  110424: 151162, // 兽棺之钉
  110425: 267807, // 一杯酩酊的时代
  110426: 351748, // 炙梦喷枪
  110427: 468393, // 一曲合弦的幻景
  110436: 6103825, // 暗帷月华
  110437: 5837183, // 纷争先兆

  // Stagnant Shadow drops (char ascension)
  110403: 67219, // 风雪之角
  110413: 67220, // 苦寒晶壳
  110423: 67221, // 冷藏梦箱

  110404: 151160, // 往日之影的雷冠
  110405: 267805, // 暴风之眼
  110406: 351746, // 虚幻铸铁
  110407: 468391, // 往日之影的金饰
  110414: 151161, // 炼形者雷枝
  110415: 267806, // 天人遗垢
  110416: 351747, // 苍猿之钉
  110417: 468392, // 镇灵敕符

  // Monster drops / common materials: baseline uses a different ID space.
  111001: 549438, // 熄灭原核
  111002: 633379, // 微光原核
  111003: 717320, // 蠢动原核
  111011: 549437, // 掠夺的本能
  111012: 633378, // 篡改的野心
  111013: 717319, // 践踏的意志
  112001: 549407, // 铁卫扣饰
  112002: 633348, // 铁卫军徽
  112003: 717289, // 铁卫勋章
  112011: 549408, // 古代零件
  112012: 633349, // 古代转轴
  112013: 717290, // 古代引擎
  113001: 549504, // 永寿幼芽
  113002: 633445, // 永寿天华
  113003: 717386, // 永寿荣枝
  113011: 549503, // 工造机杼
  113012: 633444, // 工造迴轮
  113013: 717385, // 工造浑心
  114001: 549209, // 蓄梦元件
  114002: 633150, // 流梦阀门
  114003: 717091, // 造梦马达
  114011: 549210, // 思绪末屑
  114012: 633151, // 印象残晶
  114013: 717092, // 欲念碎镜
  115001: 20445700, // 恐惧踏碎血肉
  115002: 20170864, // 勇气撕裂胸膛
  115003: 20389475, // 荣耀洗礼身躯
  115011: 3517880, // 预兆似有若无
  115012: 3276614, // 悲鸣由远及近
  115013: 3526997 // 哀叹漫无止息
}

function metaIdFromHakushId(id: number): number {
  return SR_MATERIAL_ID_COMPAT[id] ?? id
}

/**
 * Compatibility overrides for SR material sources.
 *
 * Rationale:
 * - Baseline meta uses a curated `source` list for some materials.
 * - Upstream sources may add new acquisition routes (e.g. newer modes) or adjust ordering.
 * - For baseline parity, we pin these to the baseline list.
 *
 * Key: Hakush/Yatta item ID
 * Value: baseline `source` array (order preserved)
 */
const SR_MATERIAL_SOURCE_OVERRIDES: Record<number, string[]> = {
  110111: ['拟造花萼【收容舱段】', '拟造花萼【收容舱段】', '余烬兑换'], // 破碎残刃
  110112: ['拟造花萼【收容舱段】', '拟造花萼【收容舱段】', '「万能合成机」- 材料合成', '余烬兑换'], // 无生残刃
  110113: ['拟造花萼【收容舱段】', '拟造花萼【收容舱段】', '「万能合成机」- 材料合成'], // 净世残刃
  110121: ['拟造花萼【城郊雪原】', '拟造花萼【城郊雪原】', '余烬兑换'], // 猎兽之矢
  110122: ['拟造花萼【城郊雪原】', '拟造花萼【城郊雪原】', '「万能合成机」- 材料合成', '余烬兑换'], // 屠魔之矢
  110123: ['拟造花萼【城郊雪原】', '拟造花萼【城郊雪原】', '「万能合成机」- 材料合成'], // 逐星之矢
  110131: ['拟造花萼【铆钉镇】', '余烬兑换'], // 灵感之钥
  110132: ['拟造花萼【铆钉镇】', '「万能合成机」- 材料合成', '余烬兑换'], // 启迪之钥
  110133: ['拟造花萼【铆钉镇】', '「万能合成机」- 材料合成'], // 智识之钥
  110141: ['拟造花萼【支援舱段】', '余烬兑换'], // 青铜的执着
  110142: ['拟造花萼【支援舱段】', '「万能合成机」- 材料合成', '余烬兑换'], // 寒铁的誓言
  110143: ['拟造花萼【支援舱段】', '「万能合成机」- 材料合成'], // 琥珀的坚守
  110151: ['拟造花萼【大矿区】', '余烬兑换'], // 黯淡黑曜
  110152: ['拟造花萼【大矿区】', '「万能合成机」- 材料合成', '余烬兑换'], // 虚空黑曜
  110153: ['拟造花萼【大矿区】', '「万能合成机」- 材料合成'], // 沉沦黑曜
  110161: ['拟造花萼【机械聚落】', '拟造花萼【机械聚落】', '余烬兑换'], // 谐乐小调
  110162: ['拟造花萼【机械聚落】', '拟造花萼【机械聚落】', '「万能合成机」- 材料合成', '余烬兑换'], // 家族颂歌
  110163: ['拟造花萼【机械聚落】', '拟造花萼【机械聚落】', '「万能合成机」- 材料合成'], // 群星乐章
  110171: ['拟造花萼【边缘通路】', '余烬兑换'], // 丰饶之种
  110172: ['拟造花萼【边缘通路】', '「万能合成机」- 材料合成', '余烬兑换'], // 生命之芽
  110173: ['拟造花萼【边缘通路】', '「万能合成机」- 材料合成'], // 永恒之花
  110413: ['凝滞虚影【流云渡】', '凝滞虚影【流云渡】', '「万能合成机」- 材料置换'], // 苦寒晶壳
  110416: ['凝滞虚影【鳞渊境】', '凝滞虚影【鳞渊境】', '「万能合成机」- 材料置换'], // 苍猿之钉
  111011: ['反物质军团掉落', '「模拟宇宙」中敌方掉落', '委托奖励', '余烬兑换', '「万能合成机」- 材料置换'], // 掠夺的本能
  111012: ['突破至均衡等级2后，反物质军团掉落', '「万能合成机」- 材料合成', '「模拟宇宙」中敌方掉落', '「万能合成机」- 材料置换'], // 篡改的野心
  111013: ['突破至均衡等级4后，反物质军团掉落', '「万能合成机」- 材料合成', '「模拟宇宙」中敌方掉落', '「万能合成机」- 材料置换'], // 践踏的意志
  112001: ['永冬灾影、火焚灾影掉落', '银鬃铁卫、流浪者掉落', '「模拟宇宙」中敌方掉落', '委托奖励', '余烬兑换', '「万能合成机」- 材料置换'], // 铁卫扣饰
  112002: [
    '突破至均衡等级2后，永冬灾影、火焚灾影掉落',
    '突破至均衡等级2后，银鬃铁卫、流浪者掉落',
    '「万能合成机」- 材料合成',
    '「模拟宇宙」中敌方掉落',
    '「万能合成机」- 材料置换'
  ], // 铁卫军徽
  112003: [
    '突破至均衡等级4后，永冬灾影、火焚灾影掉落',
    '突破至均衡等级4后，银鬃铁卫、流浪者掉落',
    '「万能合成机」- 材料合成',
    '「模拟宇宙」中敌方掉落',
    '「万能合成机」- 材料置换'
  ], // 铁卫勋章
  112011: ['自动机兵掉落', '「模拟宇宙」中敌方掉落', '委托奖励', '余烬兑换', '「万能合成机」- 材料置换'], // 古代零件
  112012: ['突破至均衡等级2后，自动机兵掉落', '「万能合成机」- 材料合成', '「模拟宇宙」中敌方掉落', '「万能合成机」- 材料置换'], // 古代转轴
  112013: ['突破至均衡等级4后，自动机兵掉落', '「万能合成机」- 材料合成', '「模拟宇宙」中敌方掉落', '「万能合成机」- 材料置换'] // 古代引擎
}

function applyMaterialBaselineFixups(itemId: number, sources: string[]): string[] {
  const override = SR_MATERIAL_SOURCE_OVERRIDES[itemId]
  if (override) return override.slice()

  // Baseline excludes one ephemeral source for `命运的足迹`.
  if (itemId === 241) {
    return sources.filter((s) => s !== '「货币战争」积分奖励')
  }
  return sources
}

function categoryFromItem(item: Record<string, unknown>): SrMaterialCategory | null {
  const sub = typeof item.ItemSubType === 'string' ? item.ItemSubType : ''
  const main = typeof item.ItemMainType === 'string' ? item.ItemMainType : ''

  if (sub === 'AvatarExp') return 'exp'
  if (sub === 'AvatarRank') return 'char'

  // Trace materials (path-specific) are stored under `material` in baseline meta.
  if (sub === 'TracePath') return 'material'

  if (sub === 'CommonMonsterDrop' || sub === 'EliteMonsterDrop') return 'material'
  if (sub === 'WeeklyMonsterDrop') return 'normal'

  // Many "general" materials or virtual currencies end up here.
  if (main === 'Material' || main === 'Virtual') return 'normal'

  return null
}

function poseTypeFromItem(item: Record<string, unknown>): number {
  const sub = typeof item.ItemSubType === 'string' ? item.ItemSubType : ''
  const main = typeof item.ItemMainType === 'string' ? item.ItemMainType : ''
  const itemId = toNum(item.ID) ?? 0
  const purpose = toNum(item.PurposeType)

  // Special-case to follow existing meta convention for exp items.
  if (sub === 'AvatarExp') return 601

  // Virtual currencies: keep a stable small-ish code.
  if (main === 'Virtual') return 101

  // Baseline uses a distinct type code for `命运的足迹`.
  if (itemId === 241) return 501

  if (purpose == null) return 0
  return purpose * 100 + 1
}

function toArrayOfStrings(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x) => typeof x === 'string') as string[]
}

async function ensureIcon(
  metaSrRootAbs: string,
  category: SrMaterialCategory,
  name: string,
  itemId: number,
  forceAssets: boolean,
  hoyoWiki?: HoYoWikiClient,
  log?: Pick<Console, 'warn'>
): Promise<void> {
  const dir = path.join(metaSrRootAbs, 'material', category)
  fs.mkdirSync(dir, { recursive: true })

  const out = path.join(dir, `${name}.webp`)

  if (!forceAssets && fs.existsSync(out)) return

  // If an icon exists in another category (from earlier mis-classification),
  // copy it locally to avoid a network re-download.
  if (!forceAssets && !fs.existsSync(out)) {
    for (const other of SR_MATERIAL_CATEGORIES) {
      if (other === category) continue
      const src = path.join(metaSrRootAbs, 'material', other, `${name}.webp`)
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, out)
          return
        } catch (e) {
          log?.warn?.(`[meta-gen] (sr) material icon copy failed: ${name} (${other} -> ${category}) -> ${String(e)}`)
        }
      }
    }
  }

  // 1) Hakush webp (fast path for most icons).
  const hakushUrl = `https://api.hakush.in/hsr/UI/itemfigures/${itemId}.webp`
  const hakushRes = await downloadToFileOptional(hakushUrl, out, { force: forceAssets })
  if (hakushRes.ok && hakushRes.action !== 'missing') return
  if (hakushRes.ok && hakushRes.action === 'missing' && forceAssets && fs.existsSync(out)) {
    // Remove stale file when forcing refresh and upstream no longer has it.
    try {
      fs.unlinkSync(out)
    } catch {
      // Ignore delete failures.
    }
  }

  // 2) HoYoWiki search (png) -> webp.
  let hoyoErr: string | null = null
  if (hoyoWiki) {
    try {
      const entry = await hoyoWiki.findHsrEntryByName(name, 'zh-cn')
      if (entry?.icon_url) {
        const res = await downloadPngToWebpOptional(entry.icon_url, out, { force: forceAssets })
        if (res.ok && res.action !== 'missing') {
          return
        }
        if (res.ok && res.action === 'missing' && forceAssets && fs.existsSync(out)) {
          try {
            fs.unlinkSync(out)
          } catch {
            // Ignore delete failures.
          }
        }
        hoyoErr = res.ok ? 'HTTP 404' : res.error
      } else {
        hoyoErr = 'no match'
      }
    } catch (e) {
      hoyoErr = e instanceof Error ? e.message : String(e)
    }
  }

  // 3) Requirement: do NOT create placeholder images. Log and continue.
  const hakushErr = hakushRes.ok ? (hakushRes.action === 'missing' ? 'HTTP 404' : 'unknown') : hakushRes.error
  const errParts = [`hakush=${hakushErr}`]
  if (hoyoWiki) errParts.push(`hoyowiki=${hoyoErr || 'unknown'}`)

  log?.warn?.(`[meta-gen] (sr) material icon missing: ${name} (${category}) -> ${errParts.join(' ')}`)
  logAssetError({
    game: 'sr',
    type: 'material',
    name,
    url: hakushUrl,
    out,
    error: `missing from all sources (hakush/hoyowiki) ${errParts.join(' ')}`
  })
}

function buildExistingNameIndex(root: Record<string, unknown>): Map<string, { category: SrMaterialCategory; key: string }> {
  const map = new Map<string, { category: SrMaterialCategory; key: string }>()
  for (const category of SR_MATERIAL_CATEGORIES) {
    const catObj = root[category]
    if (!isRecord(catObj)) continue
    for (const [key, item] of Object.entries(catObj)) {
      if (!isRecord(item)) continue
      const name = typeof item.name === 'string' ? item.name : ''
      if (!name) continue
      if (!map.has(name)) map.set(name, { category, key })
    }
  }
  return map
}

export interface GenerateSrMaterialOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  hakush: HakushClient
  forceAssets: boolean
  hoyoWiki?: HoYoWikiClient
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateSrMaterials(opts: GenerateSrMaterialOptions): Promise<void> {
  const materialRoot = path.join(opts.metaSrRootAbs, 'material')
  const materialDataPath = path.join(materialRoot, 'data.json')

  const dataRaw = fs.existsSync(materialDataPath) ? (JSON.parse(fs.readFileSync(materialDataPath, 'utf8')) as unknown) : {}
  const root: Record<string, unknown> = isRecord(dataRaw) ? (dataRaw as Record<string, unknown>) : {}

  // Ensure category containers exist (do not reorder keys).
  for (const k of SR_MATERIAL_CATEGORIES) {
    if (!isRecord(root[k])) root[k] = {}
  }

  // Cleanup: drop placeholder-name entries from previous runs so fallback sources can re-insert them under stable keys.
  // (Keeping them would force y-prefixed collision keys and pollute the name index.)
  let changed = !fs.existsSync(materialDataPath)
  for (const category of SR_MATERIAL_CATEGORIES) {
    const catObj = root[category]
    if (!isRecord(catObj)) continue
    for (const [k, item] of Object.entries(catObj)) {
      if (!isRecord(item)) continue
      const name = typeof item.name === 'string' ? item.name : ''
      if (!name || isPlaceholderText(name)) {
        delete catObj[k]
        changed = true
      }
    }
  }

  const existingIndex = buildExistingNameIndex(root)

  const itemAllRaw = await opts.hakush.getSrItemAll()
  const itemAll: Record<string, unknown> = isRecord(itemAllRaw) ? (itemAllRaw as Record<string, unknown>) : {}

  // Full generation: iterate all items in item_all and keep only those we can classify.
  const idsToProcess = Object.keys(itemAll)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  let added = 0
  let moved = 0
  let yattaAdded = 0

  const iconJobs: Array<{ category: SrMaterialCategory; name: string; id: number }> = []
  const iconJobDedup = new Set<string>()

  for (const id of idsToProcess) {
    const raw = itemAll[String(id)]
    if (!isRecord(raw)) continue

    const name = typeof raw.ItemName === 'string' ? raw.ItemName : ''
    if (!name || isPlaceholderText(name)) continue

    const category = categoryFromItem(raw)
    if (!category) continue

    const metaId = metaIdFromHakushId(id)
    const desiredKey = String(metaId)

    const existing = existingIndex.get(name)
    if (existing) {
      // Repair: move item across categories when our previous classification was wrong
      // (e.g. TracePath items should live under `material`).
      if (existing.category !== category) {
        const fromObj = root[existing.category]
        const toObj = root[category]
        if (isRecord(fromObj) && isRecord(toObj) && fromObj[existing.key] && !toObj[existing.key]) {
          toObj[existing.key] = fromObj[existing.key]
          delete fromObj[existing.key]
          existingIndex.set(name, { category, key: existing.key })
          moved++
          changed = true
        }
      }

      // Baseline-compat: some items use a legacy ID/key space.
      const catObj = root[category]
      if (isRecord(catObj) && existing.key !== desiredKey && catObj[existing.key] && !catObj[desiredKey]) {
        catObj[desiredKey] = catObj[existing.key]
        delete catObj[existing.key]
        existingIndex.set(name, { category, key: desiredKey })
        changed = true
      }

      // Apply field-level fixups (id/type/source) even when entry exists.
      const now = existingIndex.get(name)
      const k = now?.category === category ? now.key : existing.key
      if (isRecord(catObj) && catObj[k] && isRecord(catObj[k])) {
        const obj = catObj[k] as Record<string, unknown>
        if (obj.id !== metaId) {
          obj.id = metaId
          changed = true
        }

        const poseType = poseTypeFromItem(raw)
        if (obj.type !== poseType) {
          obj.type = poseType
          changed = true
        }

        const srcArr = Array.isArray(obj.source) ? (obj.source as Array<unknown>) : []
        const src = srcArr.filter((x) => typeof x === 'string') as string[]
        const fixed = applyMaterialBaselineFixups(id, src)
        if (JSON.stringify(src) !== JSON.stringify(fixed)) {
          obj.source = fixed
          changed = true
        }
      }
    } else {
      const overrideStar = SR_MATERIAL_STAR_OVERRIDES[id]
      const star = typeof overrideStar === 'number' ? overrideStar : starFromRarity(raw.Rarity)
      const poseType = poseTypeFromItem(raw)
      const descSrc =
        (typeof raw.ItemBGDesc === 'string' && raw.ItemBGDesc) || (typeof raw.ItemDesc === 'string' ? raw.ItemDesc : '')
      const desc = normalizeSrRichText(descSrc)

      const sources: string[] = []
      const come = Array.isArray(raw.ItemComefrom) ? (raw.ItemComefrom as Array<unknown>) : []
      for (const c of come) {
        if (!isRecord(c)) continue
        const d = typeof c.Desc === 'string' ? c.Desc : ''
        if (d) sources.push(d)
      }
      const fixedSources = applyMaterialBaselineFixups(id, sources)

      const catObj = root[category]
      if (!isRecord(catObj)) continue

      const key = desiredKey
      if (catObj[key]) continue

      added++
      if (added === 1 || added % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (sr) material added: ${added} (last=${name})`)
      }

      catObj[key] = {
        id: metaId,
        type: poseType,
        name,
        desc,
        star,
        source: fixedSources
      }

      existingIndex.set(name, { category, key })
      changed = true
    }

    // Always ensure icons exist under the classified category.
    // This keeps `meta-sr/material/<cat>/<name>.webp` usable even for baseline items.
    const iconKey = `${category}::${name}`
    if (!iconJobDedup.has(iconKey)) {
      iconJobDedup.add(iconKey)
      iconJobs.push({ category, name, id })
    }
  }

  // Secondary source: sr.yatta.moe item database (Ambr successor).
  //
  // Hakush `item_all.json` occasionally misses some items that exist in baseline meta (notably some WeeklyMonsterDrop).
  // We use Yatta to discover those items (name/id/desc/source) but still download images from Hakush UI itemfigures,
  // so output remains in webp format and follows the same cache/URL strategy as the rest of the generator.
  try {
    const listRaw = await fetchJsonWithRetry('https://sr.yatta.moe/api/v2/cn/item', {}, 2, 60_000)
    const list = isRecord(listRaw) ? (listRaw as Record<string, unknown>) : {}
    const data = isRecord(list.data) ? (list.data as Record<string, unknown>) : {}
    const items = isRecord(data.items) ? (data.items as Record<string, unknown>) : {}

    for (const v of Object.values(items)) {
      if (!isRecord(v)) continue
      const id = toNum(v.id)
      const name = typeof v.name === 'string' ? v.name : ''
      const rank = toNum(v.rank)
      const tags = toArrayOfStrings(v.tags)
      if (!id || !name || !rank) continue
      if (!tags.includes('WeeklyMonsterDrop')) continue

      const existing = existingIndex.get(name)
      const desiredCategory: SrMaterialCategory = 'normal'
      const metaId = metaIdFromHakushId(id)
      const desiredKey = String(metaId)

      if (existing && existing.category !== desiredCategory) {
        const fromObj = root[existing.category]
        const toObj = root[desiredCategory]
        if (isRecord(fromObj) && isRecord(toObj) && fromObj[existing.key] && !toObj[existing.key]) {
          toObj[existing.key] = fromObj[existing.key]
          delete fromObj[existing.key]
          existingIndex.set(name, { category: desiredCategory, key: existing.key })
          moved++
          changed = true
        }
      }

      // Baseline-compat: some items use a legacy ID/key space, and Hakush may ship placeholder strings for them.
      // Ensure we migrate their existing entries to the expected baseline key.
      if (existing) {
        const catObj = root[desiredCategory]
        const now = existingIndex.get(name) ?? existing
        if (isRecord(catObj) && now.key !== desiredKey && catObj[now.key] && !catObj[desiredKey]) {
          catObj[desiredKey] = catObj[now.key]
          delete catObj[now.key]
          existingIndex.set(name, { category: desiredCategory, key: desiredKey })
          changed = true
        }

        const finalKey = existingIndex.get(name)?.key ?? desiredKey
        if (isRecord(catObj) && catObj[finalKey] && isRecord(catObj[finalKey])) {
          const obj = catObj[finalKey] as Record<string, unknown>
          if (obj.id !== metaId) {
            obj.id = metaId
            changed = true
          }

          const srcArr = Array.isArray(obj.source) ? (obj.source as Array<unknown>) : []
          const src = srcArr.filter((x) => typeof x === 'string') as string[]
          const fixed = applyMaterialBaselineFixups(id, src)
          if (JSON.stringify(src) !== JSON.stringify(fixed)) {
            obj.source = fixed
            changed = true
          }
        }
      }

      if (!existing) {
        const detailRaw = await fetchJsonWithRetry(`https://sr.yatta.moe/api/v2/cn/item/${id}`, {}, 2, 60_000)
        const detail = isRecord(detailRaw) ? (detailRaw as Record<string, unknown>) : {}
        const d = isRecord(detail.data) ? (detail.data as Record<string, unknown>) : detail

        const typeObj = isRecord(d.type) ? (d.type as Record<string, unknown>) : {}
        const typeId = toNum(typeObj.id) ?? 0
        const poseType = typeId ? typeId * 100 + 1 : 0
        const story = typeof d.story === 'string' ? d.story : ''
        const desc = normalizeSrRichText(story || (typeof d.description === 'string' ? d.description : ''))

        const sources: string[] = []
        const srcArr = Array.isArray(d.source) ? (d.source as Array<unknown>) : []
        for (const s of srcArr) {
          if (!isRecord(s)) continue
          const sd = typeof s.description === 'string' ? s.description : ''
          if (sd) sources.push(sd)
        }
        const fixedSources = applyMaterialBaselineFixups(id, sources)

        const catObj = root[desiredCategory]
        if (isRecord(catObj)) {
          let key = desiredKey
          if (catObj[key]) {
            // Yatta item IDs may collide with existing baseline keys (baseline uses a different ID space for some items).
            // Use a stable prefixed key to avoid overwriting unrelated entries.
            let i = 0
            while (catObj[key]) {
              key = `y${id}${i ? `_${i}` : ''}`
              i++
            }
          }
          if (!catObj[key]) {
            const overrideStar = SR_MATERIAL_STAR_OVERRIDES[id]
            catObj[key] = {
              id: metaId,
              type: poseType,
              name,
              desc,
              star: typeof overrideStar === 'number' ? overrideStar : rank,
              source: fixedSources
            }
            existingIndex.set(name, { category: desiredCategory, key })
            yattaAdded++
            changed = true
          }
        }
      }

      iconJobs.push({ category: desiredCategory, name, id })
    }
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) yatta item fallback skipped: ${String(e)}`)
  }

  if (changed) {
    writeJsonFile(materialDataPath, root)
  }

  // Keep concurrency conservative: `--force-assets` triggers a lot of downloads and conversions
  // on Windows, and aggressive parallelism has shown to cause native crashes in some environments.
  // Download icons concurrently (keep modest to avoid upstream throttling).
  const ICON_CONCURRENCY = 6
  let iconDone = 0
  await runPromisePool(iconJobs, ICON_CONCURRENCY, async (job) => {
    iconDone++
    if (iconDone === 1 || iconDone % 50 === 0) {
      opts.log?.info?.(`[meta-gen] (sr) material icon progress: ${iconDone}/${iconJobs.length} (id=${job.id} ${job.name})`)
    }
    await ensureIcon(opts.metaSrRootAbs, job.category, job.name, job.id, opts.forceAssets, opts.hoyoWiki, opts.log)
  })

  opts.log?.info?.(
    `[meta-gen] (sr) material done: added=${added} moved=${moved} yattaAdded=${yattaAdded} icons=${iconJobs.length} changed=${changed}`
  )
}
