/**
 * GS material generator (Hakush -> meta-gs/material).
 *
 * Update-mode goals:
 * - Keep baseline parity for existing items (do not rewrite data.json unless changed)
 * - When baseline is behind, add new materials referenced by new content
 * - Download missing material icons to keep panel/material display usable
 *
 * Data source notes:
 * - We primarily use `gi/new.json.item` (new item IDs) to keep the update set small.
 * - As a safety net, we also scan generated meta for material names and fill any
 *   missing ones from `gi/data/zh/item_all.json`.
 *
 * Schema target: `plugins/miao-plugin/resources/meta-gs/material/data.json`.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import { logAssetError } from '../../../log/run-log.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { generateGsMaterialDailyAndAbbr } from './material-daily.js'

type GsMaterialType = 'boss' | 'gem' | 'monster' | 'normal' | 'specialty' | 'talent' | 'weapon' | 'weekly'
const GS_MATERIAL_TYPES: GsMaterialType[] = ['boss', 'gem', 'monster', 'normal', 'specialty', 'talent', 'weapon', 'weekly']

type GsMaterialMetaId = number | string

/**
 * GS material id mapping rules for baseline parity.
 *
 * Baseline (miao-plugin resources) uses a mixed id space:
 * - legacy compact numeric ids for early materials (e.g. gems 3xx, talent 4xx, weapon 5xx, some drops 2xx/1xx)
 * - later materials often use the real in-game id but prefixed with `n` for some categories
 * - newer monster/weapon materials typically keep numeric in-game ids
 *
 * We must not rely on baseline as an input; the mapping below is derived from public game Excel data
 * (AnimeGameData MaterialExcelConfigData.rank / rankLevel) plus a small set of legacy fixed overrides
 * that are stable and unlikely to grow (new content uses the `n<id>` / numeric id scheme).
 */
const GS_MATERIAL_META_ID_FIXED: Record<number, GsMaterialMetaId> = {
  // ---- boss drops (legacy compact ids) ----
  113011: 201, // 常燃火种
  113012: 202, // 净水之心
  113002: 203, // 雷光棱镜
  113010: 204, // 极寒之核
  113001: 205, // 飓风之种
  113009: 206, // 玄岩之塔
  113016: 207, // 未熟之玉
  113020: 208, // 晶凝之华
  113022: 210, // 魔偶机心
  113023: 211, // 恒常机关之心
  113024: 212, // 阴燃之珠
  113028: 213, // 排异之露
  113029: 214, // 雷霆数珠
  113030: 215, // 兽境王器
  113031: 216, // 龙嗣伪鳍
  113035: 486, // 符纹之齿

  // ---- weekly boss materials (legacy compact ids) ----
  113003: 461, // 东风之翎
  113004: 462, // 东风之爪
  113005: 463, // 东风的吐息
  113006: 464, // 北风之尾
  113007: 465, // 北风之环
  113008: 466, // 北风的魂匣
  113013: 467, // 吞天之鲸·只角
  113014: 468, // 魔王之刃·残片
  113015: 469, // 武炼之魂·孤影
  113017: 470, // 龙王之冕
  113018: 471, // 血玉之枝
  113019: 472, // 鎏金之鳞
  113025: 480, // 熔毁之刻
  113026: 481, // 狱火之蝶
  113027: 482, // 灰烬之心
  113032: 483, // 凶将之手眼
  113033: 484, // 祸神之禊泪
  113034: 485, // 万劫之真意

  // ---- regional specialties (legacy compact ids; interactive-map style) ----
  100056: 600, // 嘟嘟莲
  100023: 601, // 塞西莉亚花
  100058: 602, // 石珀
  100057: 603, // 蒲公英籽
  100030: 604, // 琉璃百合
  100027: 605, // 绝云椒椒
  100028: 606, // 夜泊石
  100025: 607, // 慕风蘑菇
  100029: 608, // 霓裳花
  100055: 609, // 小灯草
  100022: 610, // 落落莓
  100034: 611, // 琉璃袋
  100024: 612, // 风车菊
  100021: 613, // 钩钩果
  100031: 614, // 清心
  100033: 663, // 星螺
  101206: 675, // 海灵芝
  101201: 677, // 鬼兜虫
  101202: 678, // 绯樱绣球
  101203: 679, // 晶化骨髓
  101204: 680, // 血斛
  101205: 681, // 鸣草
  101207: 685, // 珊瑚真珠
  101208: 686, // 天云草实
  101209: 688, // 幽灯蕈

  // ---- baseline quirks / legacy mismatches ----
  // Baseline has `便携轴承.id = n101261` even though current upstream uses id=101257.
  101257: 'n101261'
}

// rank -> baseline base (then add rankLevel / (rankLevel-1) depending on category)
const GS_NORMAL_BASE_BY_RANK: Record<number, number> = {
  10601: 20,
  10602: 30,
  10603: 40,
  10604: 50,
  10611: 110,
  10612: 120,
  10613: 130,
  10615: 160,
  10618: 184
}

const GS_MONSTER_BASE_BY_RANK: Record<number, number> = {
  10105: 60,
  10107: 70,
  10108: 80,
  10109: 90,
  10110: 100,
  10114: 140,
  10116: 170,
  10117: 180,
  10119: 173,
  10120: 150
}

const GS_GEM_BASE_BY_RANK: Record<number, number> = {
  12101: 300, // diamond
  12102: 310, // pyro
  12103: 320, // hydro
  12105: 330, // electro
  12107: 340, // cryo
  12106: 350, // anemo
  12108: 360, // geo
  12104: 370 // dendro (appended; avoid shifting older ids)
}

const GS_TALENT_BASE_BY_RANK: Record<number, number> = {
  13101: 420, // 自由
  13102: 450, // 抗争
  13103: 400, // 诗文 (baseline only keeps the 4★ item)
  13104: 440, // 繁荣
  13105: 410, // 勤劳
  13106: 430, // 黄金
  13107: 405, // 浮世
  13108: 415, // 风雅
  13109: 425 // 天光
}

const GS_WEAPON_BASE_BY_RANK: Record<number, number> = {
  15101: 500,
  15102: 520,
  15103: 540,
  15104: 510,
  15105: 530,
  15106: 550,
  15107: 560,
  15108: 570,
  15109: 580
}

// Some newer normal-drop chains use `n<id>` in baseline even though they have real numeric ids.
const GS_NORMAL_FORCE_N_PREFIX_RANKS = new Set<number>([10621, 10623, 10629])

// Legacy/renamed material names that still exist in baseline as keys.
const GS_LEGACY_NAME_TO_OFFICIAL_ID: Record<string, number> = {}

// Baseline has a few per-entry item id quirks (same name but different id under different heads).
const GS_SUBITEM_OFFICIAL_ID_OVERRIDE_BY_HEAD: Record<string, Record<string, number>> = {
  '精制机轴': {
    '磨损的执凭': 112122,
    '精致的执凭': 112123
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function starFromRank(rank: number): number {
  // Hakush GI uses Rank 0 for some 1-star materials (e.g. specialties).
  if (rank <= 0) return 1
  return Math.max(1, Math.min(5, Math.floor(rank)))
}

function classifyGsMaterialType(item: Record<string, unknown>): GsMaterialType | null {
  const itemType = typeof item.ItemType === 'string' ? item.ItemType : ''
  if (itemType !== 'ITEM_MATERIAL') return null

  const cat = typeof item.Type === 'string' ? item.Type : ''
  const rank = toNum(item.Rank) ?? 0

  if (!cat) return null
  if (cat.includes('区域特产')) return 'specialty'
  if (cat.includes('武器突破素材')) return 'weapon'
  if (cat.includes('天赋培养素材') || cat.includes('角色天赋素材')) return 'talent'
  if (cat.includes('角色突破素材')) return 'gem'
  if (cat.includes('角色培养素材')) return rank >= 5 ? 'weekly' : 'boss'
  if (cat.includes('角色与武器培养素材')) return rank >= 4 ? 'monster' : 'normal'

  return null
}

function buildExistingNameSet(materialData: Record<string, unknown>): Set<string> {
  const names = new Set<string>()
  for (const [name, raw] of Object.entries(materialData)) {
    names.add(name)
    if (!isRecord(raw)) continue
    const items = raw.items
    if (!isRecord(items)) continue
    for (const subName of Object.keys(items)) {
      names.add(subName)
    }
  }
  return names
}

function buildItemAllNameToIdMap(itemAll: Record<string, unknown>): Map<string, number> {
  const map = new Map<string, number>()
  for (const [idStr, raw] of Object.entries(itemAll)) {
    const id = Number.parseInt(idStr, 10)
    if (!Number.isFinite(id)) continue
    if (!isRecord(raw)) continue
    const name = typeof raw.Name === 'string' ? raw.Name : ''
    if (!name) continue
    if (!map.has(name)) map.set(name, id)
  }
  return map
}

function collectReferencedMaterialNames(metaGsRootAbs: string, log?: Pick<Console, 'warn'>): Set<string> {
  const names = new Set<string>()

  const addFromRecordValues = (obj: unknown): void => {
    if (!isRecord(obj)) return
    for (const v of Object.values(obj)) {
      if (typeof v === 'string' && v.trim()) names.add(v.trim())
    }
  }

  // Characters: meta-gs/character/<name>/data.json
  const charRoot = path.join(metaGsRootAbs, 'character')
  if (fs.existsSync(charRoot)) {
    for (const ent of fs.readdirSync(charRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const file = path.join(charRoot, ent.name, 'data.json')
      if (!fs.existsSync(file)) continue
      try {
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (isRecord(raw)) addFromRecordValues(raw.materials)
      } catch (e) {
        log?.warn?.(`[meta-gen] (gs) failed to parse char material refs: ${file} -> ${String(e)}`)
      }
    }
  }

  // Weapons: meta-gs/weapon/<type>/<name>/data.json
  const weaponRoot = path.join(metaGsRootAbs, 'weapon')
  if (fs.existsSync(weaponRoot)) {
    for (const typeDir of fs.readdirSync(weaponRoot, { withFileTypes: true })) {
      if (!typeDir.isDirectory()) continue
      const typeAbs = path.join(weaponRoot, typeDir.name)
      for (const wDir of fs.readdirSync(typeAbs, { withFileTypes: true })) {
        if (!wDir.isDirectory()) continue
        const file = path.join(typeAbs, wDir.name, 'data.json')
        if (!fs.existsSync(file)) continue
        try {
          const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
          if (isRecord(raw)) addFromRecordValues(raw.materials)
        } catch (e) {
          log?.warn?.(`[meta-gen] (gs) failed to parse weapon material refs: ${file} -> ${String(e)}`)
        }
      }
    }
  }

  return names
}

function toGsMaterialMetaId(id: number, type: GsMaterialType, rank: number, rankLevel: number): GsMaterialMetaId {
  const fixed = GS_MATERIAL_META_ID_FIXED[id]
  if (typeof fixed === 'number' || typeof fixed === 'string') return fixed

  if (type === 'gem') {
    const base = GS_GEM_BASE_BY_RANK[rank]
    if (typeof base === 'number' && base > 0) return base + Math.max(0, rankLevel - 1)
    return id
  }

  if (type === 'talent') {
    const base = GS_TALENT_BASE_BY_RANK[rank]
    if (typeof base === 'number' && base > 0) return base + Math.max(0, rankLevel - 1)
    return `n${id}`
  }

  if (type === 'weapon') {
    const base = GS_WEAPON_BASE_BY_RANK[rank]
    if (typeof base === 'number' && base > 0) return base + Math.max(0, rankLevel - 1)
    // Newer weapon materials keep numeric ids in baseline.
    return id
  }

  if (type === 'monster') {
    const base = GS_MONSTER_BASE_BY_RANK[rank]
    if (typeof base === 'number' && base > 0) return base + Math.max(0, rankLevel - 1)
    // Newer monster drops keep numeric ids in baseline.
    return id
  }

  if (type === 'normal') {
    const base = GS_NORMAL_BASE_BY_RANK[rank]
    if (typeof base === 'number' && base > 0) return base + Math.max(0, rankLevel)
    if (GS_NORMAL_FORCE_N_PREFIX_RANKS.has(rank)) return `n${id}`
    // Most newer normal drops keep numeric ids in baseline.
    return id
  }

  if (type === 'specialty') {
    // Only a small legacy set uses compact numeric ids; newer specialties use `n<id>`.
    return `n${id}`
  }

  if (type === 'boss' || type === 'weekly') {
    // Newer boss/weekly materials use `n<id>` in baseline.
    return `n${id}`
  }

  return id
}

function buildRankChainGroup(itemAll: Record<string, unknown>, id: number): number[] {
  const cur = itemAll[String(id)]
  if (!isRecord(cur)) return [id]

  const cat = typeof cur.Type === 'string' ? cur.Type : ''
  const matType = typeof cur.MaterialType === 'string' ? cur.MaterialType : ''
  const week0 = toNum((cur as Record<string, unknown>).Week)
  const rank0 = toNum(cur.Rank)
  if (rank0 == null) return [id]

  // `角色培养素材` (boss/weekly drops) IDs are often sequential but do NOT represent a tier chain.
  // Chaining them would incorrectly merge boss materials (rank=4) into weekly materials (rank=5),
  // causing icons to be written into the wrong bucket (boss vs weekly).
  if (cat.includes('角色培养素材')) return [id]

  const ids = new Map<number, { rank: number }>()
  ids.set(id, { rank: rank0 })

  // Walk down by rank - 1.
  let downId = id
  let downRank = rank0
  while (true) {
    const prevId = downId - 1
    const prev = itemAll[String(prevId)]
    if (!isRecord(prev)) break
    if ((typeof prev.Type === 'string' ? prev.Type : '') !== cat) break
    if ((typeof prev.MaterialType === 'string' ? prev.MaterialType : '') !== matType) break
    if (toNum((prev as Record<string, unknown>).Week) !== week0) break
    const r = toNum(prev.Rank)
    if (r == null || r !== downRank - 1) break
    ids.set(prevId, { rank: r })
    downId = prevId
    downRank = r
  }

  // Walk up by rank + 1.
  let upId = id
  let upRank = rank0
  while (true) {
    const nextId = upId + 1
    const next = itemAll[String(nextId)]
    if (!isRecord(next)) break
    if ((typeof next.Type === 'string' ? next.Type : '') !== cat) break
    if ((typeof next.MaterialType === 'string' ? next.MaterialType : '') !== matType) break
    if (toNum((next as Record<string, unknown>).Week) !== week0) break
    const r = toNum(next.Rank)
    if (r == null || r !== upRank + 1) break
    ids.set(nextId, { rank: r })
    upId = nextId
    upRank = r
  }

  const out = Array.from(ids.entries())
  out.sort((a, b) => a[1].rank - b[1].rank)
  return out.map(([k]) => k)
}

async function ensureIcon(
  metaGsRootAbs: string,
  type: GsMaterialType,
  name: string,
  icon: string,
  forceAssets: boolean,
  log?: Pick<Console, 'warn'>
): Promise<void> {
  if (!icon) return
  const dir = path.join(metaGsRootAbs, 'material', type)
  fs.mkdirSync(dir, { recursive: true })

  const url = `https://api.hakush.in/gi/UI/${icon}.webp`
  const out = path.join(dir, `${name}.webp`)

  // If this icon already exists in another bucket (due to earlier mis-classification),
  // copy it locally to avoid a network re-download.
  if (!forceAssets && !fs.existsSync(out)) {
    for (const other of GS_MATERIAL_TYPES) {
      if (other === type) continue
      const src = path.join(metaGsRootAbs, 'material', other, `${name}.webp`)
      if (fs.existsSync(src)) {
        try {
          fs.copyFileSync(src, out)
          return
        } catch (e) {
          log?.warn?.(`[meta-gen] (gs) material icon copy failed: ${name} (${other} -> ${type}) -> ${String(e)}`)
        }
      }
    }
  }

  const res = await downloadToFileOptional(url, out, { force: forceAssets })
  if (!res.ok) {
    log?.warn?.(`[meta-gen] (gs) material icon failed: ${name} (${type}) -> ${res.error}`)
    logAssetError({ game: 'gs', type: 'material', name, url, out, error: res.error })
  } else if (res.action === 'missing') {
    log?.warn?.(`[meta-gen] (gs) material icon missing: ${name} (${type}) -> ${url}`)
    logAssetError({ game: 'gs', type: 'material', name, url, out, error: 'HTTP 404' })
  }
}

export interface GenerateGsMaterialOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  hakush: HakushClient
  animeGameData: AnimeGameDataClient
  /** When true, overwrite downloaded images if they exist. */
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateGsMaterials(opts: GenerateGsMaterialOptions): Promise<void> {
  const materialRoot = path.join(opts.metaGsRootAbs, 'material')
  const materialDataPath = path.join(materialRoot, 'data.json')

  const matExcelRaw = await opts.animeGameData.getGsMaterialExcelConfigData()
  const matExcelRows: Array<Record<string, unknown>> = Array.isArray(matExcelRaw)
    ? ((matExcelRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
    : []
  const rankInfoById = new Map<number, { rank: number; rankLevel: number }>()
  for (const row of matExcelRows) {
    const id = toNum(row.id)
    if (!id) continue
    const rank = toNum(row.rank) ?? 0
    const rankLevel = toNum(row.rankLevel) ?? 0
    rankInfoById.set(id, { rank, rankLevel })
  }

  const dataRaw = fs.existsSync(materialDataPath) ? (JSON.parse(fs.readFileSync(materialDataPath, 'utf8')) as unknown) : {}
  const materialData: Record<string, unknown> = isRecord(dataRaw) ? (dataRaw as Record<string, unknown>) : {}

  const existingNames = buildExistingNameSet(materialData)

  const itemAllRaw = await opts.hakush.getGsItemAll()
  const itemAll: Record<string, unknown> = isRecord(itemAllRaw) ? (itemAllRaw as Record<string, unknown>) : {}
  const nameToId = buildItemAllNameToIdMap(itemAll)

  // Full generation: iterate all candidate material IDs from item_all.
  // This is slower than update-mode, but allows meta generation without relying on baseline.
  const idsToProcess = new Set<number>()
  for (const k of Object.keys(itemAll)) {
    const n = Number(k)
    if (Number.isFinite(n) && n > 0) idsToProcess.add(n)
  }

  // Safety net: also ensure referenced materials exist (from already-generated character/weapon).
  // This helps when upstream classifications are incomplete.
  const referencedNames = collectReferencedMaterialNames(opts.metaGsRootAbs, opts.log)
  for (const name of referencedNames) {
    if (existingNames.has(name)) continue
    const id = nameToId.get(name)
    if (typeof id === 'number') idsToProcess.add(id)
    else opts.log?.warn?.(`[meta-gen] (gs) material not found in item_all by name: ${name}`)
  }

  // Repair set: boss/weekly drops are not a tier chain but were historically easy to mis-classify
  // (IDs are often sequential). Ensure we always revisit them when:
  // - head entry missing (name exists only as a sub-item), or
  // - icon missing in the correct bucket, or
  // - type drift exists in data.json
  for (const [idStr, raw] of Object.entries(itemAll)) {
    const id = Number.parseInt(idStr, 10)
    if (!Number.isFinite(id)) continue
    if (!isRecord(raw)) continue
    if (raw.ItemType !== 'ITEM_MATERIAL') continue

    const matType = classifyGsMaterialType(raw)
    if (matType !== 'boss' && matType !== 'weekly') continue

    const name = typeof raw.Name === 'string' ? raw.Name : ''
    if (!name) continue

    const existing = materialData[name]
    const existingRec = isRecord(existing) ? (existing as Record<string, unknown>) : undefined
    const existingType = existingRec && typeof existingRec.type === 'string' ? (existingRec.type as string) : undefined

    const iconPath = path.join(opts.metaGsRootAbs, 'material', matType, `${name}.webp`)
    const needHead = !existingRec
    const needIcon = !fs.existsSync(iconPath)
    const needTypeRepair = Boolean(existingRec && existingType && existingType !== matType)
    if (needHead || needIcon || needTypeRepair) idsToProcess.add(id)
  }

  let changed = !fs.existsSync(materialDataPath)
  let added = 0

  const iconJobs: Array<{ type: GsMaterialType; name: string; icon: string }> = []
  const iconJobDedup = new Set<string>()
  const processedHeads = new Set<string>()

  for (const id of Array.from(idsToProcess).sort((a, b) => a - b)) {
    const raw = itemAll[String(id)]
    if (!isRecord(raw)) continue
    // Quick pre-filter: only consider material items.
    if (raw.ItemType !== 'ITEM_MATERIAL') continue

    // Build a small group by rank chain (e.g. 1-3, 2-4, 2-5).
    const groupIds = buildRankChainGroup(itemAll, id)

    // Resolve group items.
    const groupItems = groupIds
      .map((gid) => {
        const it = itemAll[String(gid)]
        if (!isRecord(it)) return null
        const name = typeof it.Name === 'string' ? it.Name : ''
        const icon = typeof it.Icon === 'string' ? it.Icon : ''
        const rank = toNum(it.Rank)
        return name && rank != null ? { id: gid, name, icon, rank } : null
      })
      .filter(Boolean) as Array<{ id: number; name: string; icon: string; rank: number }>

    if (groupItems.length === 0) continue

    // Highest-rank item is the group head.
    groupItems.sort((a, b) => a.rank - b.rank)
    const head = groupItems[groupItems.length - 1]!
    const headName = head.name
    if (processedHeads.has(headName)) continue
    processedHeads.add(headName)

    // Classify by group head to avoid order-dependent type mistakes.
    const headRaw = itemAll[String(head.id)]
    const matType = isRecord(headRaw) ? classifyGsMaterialType(headRaw) : null
    if (!matType) continue

    // If the material already exists, we may still need to reconcile type and ensure icons.
    const existingEntry = materialData[headName]
    const existingRec = isRecord(existingEntry) ? (existingEntry as Record<string, unknown>) : undefined
    const existingType = existingRec && typeof existingRec.type === 'string' ? (existingRec.type as string) : undefined

    const headRankInfo = rankInfoById.get(head.id) ?? { rank: 0, rankLevel: 0 }
    const headMetaId = toGsMaterialMetaId(head.id, matType, headRankInfo.rank, headRankInfo.rankLevel)

    if (!existingRec && existingNames.has(headName)) {
      // Head name exists as a sub-item of another entry (historical mis-grouping can cause this).
      // Create a real head entry so lookups can find it by name at top-level.
      const items: Record<string, unknown> = {}
      for (const it of groupItems) {
        const info = rankInfoById.get(it.id) ?? { rank: 0, rankLevel: 0 }
        const metaId = toGsMaterialMetaId(it.id, matType, info.rank, info.rankLevel)
        items[it.name] = {
          id: metaId,
          name: it.name,
          type: matType,
          star: starFromRank(it.rank)
        }
      }

      const entry: Record<string, unknown> = {
        id: headMetaId,
        name: headName,
        type: matType,
        star: starFromRank(head.rank)
      }

      // Only include `items` when the group contains multiple tiers.
      if (Object.keys(items).length > 1) {
        entry.items = items
      }

      materialData[headName] = entry
      changed = true
      // Note: keep existingNames as-is (it already contains headName), avoid mutating sub-item parents here.
      added++
      opts.log?.info?.(`[meta-gen] (gs) material head repaired: ${headName} -> ${matType}`)
    } else if (!existingRec && !existingNames.has(headName)) {
      added++
      if (added === 1 || added % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (gs) material added: ${added} (last=${headName})`)
      }

      const items: Record<string, unknown> = {}
      for (const it of groupItems) {
        const info = rankInfoById.get(it.id) ?? { rank: 0, rankLevel: 0 }
        const metaId = toGsMaterialMetaId(it.id, matType, info.rank, info.rankLevel)
        items[it.name] = {
          id: metaId,
          name: it.name,
          type: matType,
          star: starFromRank(it.rank)
        }
      }

      const entry: Record<string, unknown> = {
        id: headMetaId,
        name: headName,
        type: matType,
        star: starFromRank(head.rank)
      }

      // Only include `items` when the group contains multiple tiers.
      if (Object.keys(items).length > 1) {
        entry.items = items
      }

      // Append without reordering existing keys (baseline parity).
      materialData[headName] = entry
      changed = true

      // Update name set.
      existingNames.add(headName)
      for (const it of groupItems) {
        existingNames.add(it.name)
      }
    } else if (existingRec && existingType && existingType !== matType) {
      // Repair: reconcile type drift (previous runs could be order-dependent).
      existingRec.type = matType
      if (typeof existingRec.star === 'number') {
        existingRec.star = starFromRank(head.rank)
      }
      const itemsRaw = existingRec.items
      if (isRecord(itemsRaw)) {
        for (const it of Object.values(itemsRaw)) {
          if (!isRecord(it)) continue
          it.type = matType
        }
      }
      changed = true
      opts.log?.info?.(`[meta-gen] (gs) material type repaired: ${headName} ${existingType} -> ${matType}`)
    }

    // Ensure icons for each tier under the classified type bucket.
    for (const it of groupItems) {
      const key = `${matType}::${it.name}::${it.icon}`
      if (iconJobDedup.has(key)) continue
      iconJobDedup.add(key)
      iconJobs.push({ type: matType, name: it.name, icon: it.icon })
    }
  }

  // ----- Baseline compatibility fixups (ids + legacy key gaps) -----
  // 1) Ensure baseline's `undefined` placeholder exists.
  if (!materialData.undefined) {
    materialData.undefined = { id: 0, name: 'undefined', type: 'boss', star: 1 }
    changed = true
  }

  const ensureItemsRecord = (entry: Record<string, unknown>): Record<string, unknown> => {
    const itemsRaw = entry.items
    if (isRecord(itemsRaw)) return itemsRaw as Record<string, unknown>
    const items: Record<string, unknown> = {}
    entry.items = items
    changed = true
    return items
  }

  const ensureSubItem = (entryType: GsMaterialType, items: Record<string, unknown>, name: string): void => {
    if (items[name]) return
    const oid = nameToId.get(name) ?? GS_LEGACY_NAME_TO_OFFICIAL_ID[name]
    if (!oid) return
    const info = rankInfoById.get(oid) ?? { rank: 0, rankLevel: 0 }
    items[name] = {
      id: toGsMaterialMetaId(oid, entryType, info.rank, info.rankLevel),
      name,
      type: entryType,
      star: starFromRank(info.rankLevel)
    }
    changed = true
  }

  // 2) Ensure baseline's unusual cross-family items under `「诗文」的哲学` exist (superset compatibility).
  const shiw = materialData['「诗文」的哲学']
  if (isRecord(shiw) && shiw.type === 'talent') {
    const items = ensureItemsRecord(shiw)
    ensureSubItem('talent', items, '「自由」的教导')
    ensureSubItem('talent', items, '「抗争」的指引')
  }

  // 3) Ensure baseline's legacy renamed sub-item keys exist (IDs are stable).
  const jizhou = materialData['精制机轴']
  if (isRecord(jizhou) && jizhou.type === 'normal') {
    const itemsRaw = jizhou.items
    if (isRecord(itemsRaw)) {
      const items = itemsRaw as Record<string, unknown>
      const applyPinned = (subName: string, officialId: number): void => {
        const info = rankInfoById.get(officialId) ?? { rank: 0, rankLevel: 0 }
        const metaId = toGsMaterialMetaId(officialId, 'normal', info.rank, info.rankLevel)
        const desiredStar = starFromRank(info.rankLevel)

        const cur = items[subName]
        if (!isRecord(cur)) {
          items[subName] = { id: metaId, name: subName, type: 'normal', star: desiredStar }
          changed = true
          return
        }

        if (cur.id !== metaId) {
          cur.id = metaId
          changed = true
        }
        if (cur.name !== subName) {
          cur.name = subName
          changed = true
        }
        if (cur.type !== 'normal') {
          cur.type = 'normal'
          changed = true
        }
        if (cur.star !== desiredStar) {
          cur.star = desiredStar
          changed = true
        }
      }

      applyPinned('磨损的执凭', 112122)
      applyPinned('精致的执凭', 112123)
    }
  }

  // 4) Reconcile ids to baseline scheme for all known entries.
  for (const [headName, raw] of Object.entries(materialData)) {
    if (headName === 'undefined') continue
    if (!isRecord(raw)) continue
    const type = typeof raw.type === 'string' ? (raw.type as string) : ''
    if (!GS_MATERIAL_TYPES.includes(type as GsMaterialType)) continue
    const matType = type as GsMaterialType

    const officialId = nameToId.get(headName) ?? GS_LEGACY_NAME_TO_OFFICIAL_ID[headName]
    if (typeof officialId === 'number') {
      const info = rankInfoById.get(officialId) ?? { rank: 0, rankLevel: 0 }
      const metaId = toGsMaterialMetaId(officialId, matType, info.rank, info.rankLevel)
      if (raw.id !== metaId) {
        raw.id = metaId
        changed = true
      }
    }

    const itemsRaw = raw.items
    if (isRecord(itemsRaw)) {
      for (const [subName, subRaw] of Object.entries(itemsRaw)) {
        if (!isRecord(subRaw)) continue
        const pinned = GS_SUBITEM_OFFICIAL_ID_OVERRIDE_BY_HEAD[headName]?.[subName]
        const oid = typeof pinned === 'number' ? pinned : nameToId.get(subName) ?? GS_LEGACY_NAME_TO_OFFICIAL_ID[subName]
        if (typeof oid !== 'number') continue
        const info = rankInfoById.get(oid) ?? { rank: 0, rankLevel: 0 }
        const metaId = toGsMaterialMetaId(oid, matType, info.rank, info.rankLevel)
        if (subRaw.id !== metaId) {
          subRaw.id = metaId
          changed = true
        }
      }
    }
  }

  if (changed) {
    writeJsonFile(materialDataPath, materialData)
  }

  // Download icons concurrently (lower concurrency to reduce throttling risk).
  const ICON_CONCURRENCY = 6
  await runPromisePool(iconJobs, ICON_CONCURRENCY, async (job) => {
    await ensureIcon(opts.metaGsRootAbs, job.type, job.name, job.icon, opts.forceAssets, opts.log)
  })

  // Generate daily calendar + minimal abbr overrides (always overwrite).
  // This keeps new regions / new domains up-to-date without manual scaffold edits.
  try {
    await generateGsMaterialDailyAndAbbr({ metaGsRootAbs: opts.metaGsRootAbs, animeGameData: opts.animeGameData, log: opts.log })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) material daily.js/abbr.js generation failed: ${String(e)}`)
  }

  opts.log?.info?.(`[meta-gen] (gs) material done: added=${added} icons=${iconJobs.length} changed=${changed}`)
}
