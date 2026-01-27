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

function buildRankChainGroup(itemAll: Record<string, unknown>, id: number): number[] {
  const cur = itemAll[String(id)]
  if (!isRecord(cur)) return [id]

  const cat = typeof cur.Type === 'string' ? cur.Type : ''
  const matType = typeof cur.MaterialType === 'string' ? cur.MaterialType : ''
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

    if (!existingRec && existingNames.has(headName)) {
      // Head name exists as a sub-item of another entry (historical mis-grouping can cause this).
      //
      // For boss/weekly drops, the correct structure is "single item = head entry",
      // so we MUST create the head entry even if the name appeared as a sub-item before.
      const allowCreateSingleHead = (matType === 'boss' || matType === 'weekly') && groupItems.length === 1
      if (allowCreateSingleHead) {
        const entry: Record<string, unknown> = {
          id: `n${head.id}`,
          name: headName,
          type: matType,
          star: starFromRank(head.rank)
        }
        materialData[headName] = entry
        changed = true
        // Note: keep existingNames as-is (it already contains headName), avoid mutating sub-item parents here.
        added++
        opts.log?.info?.(`[meta-gen] (gs) material head repaired (single): ${headName} -> ${matType}`)
      }
    } else if (!existingRec && !existingNames.has(headName)) {
      added++
      if (added === 1 || added % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (gs) material added: ${added} (last=${headName})`)
      }

      const items: Record<string, unknown> = {}
      for (const it of groupItems) {
        items[it.name] = {
          id: `n${it.id}`,
          name: it.name,
          type: matType,
          star: starFromRank(it.rank)
        }
      }

      const entry: Record<string, unknown> = {
        id: `n${head.id}`,
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
