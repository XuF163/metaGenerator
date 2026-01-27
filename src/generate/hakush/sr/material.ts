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
  const purpose = toNum(item.PurposeType)

  // Special-case to follow existing meta convention for exp items.
  if (sub === 'AvatarExp') return 601

  // Virtual currencies: keep a stable small-ish code.
  if (main === 'Virtual') return 101

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

  const existingIndex = buildExistingNameIndex(root)

  const itemAllRaw = await opts.hakush.getSrItemAll()
  const itemAll: Record<string, unknown> = isRecord(itemAllRaw) ? (itemAllRaw as Record<string, unknown>) : {}

  // Full generation: iterate all items in item_all and keep only those we can classify.
  const idsToProcess = Object.keys(itemAll)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)

  let changed = !fs.existsSync(materialDataPath)
  let added = 0
  let moved = 0
  let yattaAdded = 0

  const iconJobs: Array<{ category: SrMaterialCategory; name: string; id: number }> = []
  const iconJobDedup = new Set<string>()

  for (const id of idsToProcess) {
    const raw = itemAll[String(id)]
    if (!isRecord(raw)) continue

    const name = typeof raw.ItemName === 'string' ? raw.ItemName : ''
    if (!name) continue

    const category = categoryFromItem(raw)
    if (!category) continue

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
    } else {
      const star = starFromRarity(raw.Rarity)
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

      const catObj = root[category]
      if (!isRecord(catObj)) continue

      const key = String(id)
      if (catObj[key]) continue

      added++
      if (added === 1 || added % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (sr) material added: ${added} (last=${name})`)
      }

      catObj[key] = {
        id,
        type: poseType,
        name,
        desc,
        star,
        source: sources
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

        const catObj = root[desiredCategory]
        if (isRecord(catObj)) {
          let key = String(id)
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
            catObj[key] = {
              id,
              type: poseType,
              name,
              desc,
              star: rank,
              source: sources
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
