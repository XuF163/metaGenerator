/**
 * GS artifact set generator (Hakush -> meta-gs/artifact).
 *
 * Note: meta-gs/artifact is a "flat" module:
 * - `artifact/data.json` stores all set metadata (idxs + set bonus texts)
 * - `artifact/imgs/<setName>/*.webp` stores piece images
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import { logAssetError } from '../../../log/run-log.js'
import { sortRecordByKey } from '../utils.js'
import { buildGsArtifactCalcJs } from './artifact-calc.js'
import { generateGsArtifactExtraJs } from './artifact-extra.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type GiEquipType = 'EQUIP_BRACER' | 'EQUIP_NECKLACE' | 'EQUIP_SHOES' | 'EQUIP_RING' | 'EQUIP_DRESS'

type GiEquipTypeToItemId = Partial<Record<GiEquipType, number>>
type GiEquipTypeToBest = Partial<Record<GiEquipType, { id: number; rankLevel: number; appendPropNum: number }>>
type GiEquipTypeToName = Partial<Record<GiEquipType, string>>

type GiSetStaticMeta = {
  /** Hakush/Excel `setId` (e.g. 15001) */
  setId: number
  /** miao-plugin meta id (baseline style, e.g. 400089) */
  metaId: string
  /** Maximum artifact rarity used by baseline (3/4/5). */
  maxRankLevel: number
  /** In-game equipAffixId (e.g. 215001) used to derive metaId deterministically. */
  equipAffixId: number
  /** setNeedNum length (1 for “祭”系列单件套, otherwise usually 2). */
  needLen: number
}

function isGiEquipType(v: unknown): v is GiEquipType {
  return (
    v === 'EQUIP_BRACER' ||
    v === 'EQUIP_NECKLACE' ||
    v === 'EQUIP_SHOES' ||
    v === 'EQUIP_RING' ||
    v === 'EQUIP_DRESS'
  )
}

function toNumber(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return null
}

function betterReliquaryCandidate(a: { id: number; rankLevel: number; appendPropNum: number }, b: { id: number; rankLevel: number; appendPropNum: number }): boolean {
  // Prefer higher rarity, then lower appendPropNum, then ids ending with 0 (stable "base" id), then smaller id.
  if (a.rankLevel !== b.rankLevel) return a.rankLevel > b.rankLevel
  if (a.appendPropNum !== b.appendPropNum) return a.appendPropNum < b.appendPropNum
  const aBase = a.id % 10 === 0
  const bBase = b.id % 10 === 0
  if (aBase !== bBase) return aBase
  return a.id < b.id
}

function toGsArtifactMetaId(meta: GiSetStaticMeta): string {
  // This id scheme is required for baseline parity. It is deterministic and derived solely from Excel config:
  // - equipAffixId prefix: 210/214/215
  // - suffix: equipAffixId % 1000
  // - some special-case spacing for newer 5★ sets (suffix >= 27) and 1-piece “祭” sets.
  const affix = meta.equipAffixId
  const prefix = Math.floor(affix / 1000)
  const suffix = affix % 1000

  let offset: number
  if (prefix === 210) {
    // 3★ sets use a slightly different spacing.
    offset = suffix * 5 - 2 - (meta.maxRankLevel === 3 ? 1 : 0)
  } else if (prefix === 214) {
    offset = suffix * 5 + 64
  } else if (prefix === 215) {
    if (suffix >= 27) {
      offset = suffix * 10 - 49
    } else {
      // 1-piece sets shift by -1.
      offset = suffix * 5 + 84 - (meta.needLen === 1 ? 1 : 0)
    }
  } else {
    // Unknown prefix; fall back to a stable but non-baseline id.
    return String(meta.setId)
  }

  return String(400000 + offset)
}

async function buildGiSetStaticMetaMap(
  animeGameData: AnimeGameDataClient,
  log?: Pick<Console, 'warn'>
): Promise<Map<number, GiSetStaticMeta>> {
  const setRaw = await animeGameData.getGsReliquarySetExcelConfigData()
  const setMeta = new Map<number, GiSetStaticMeta>()

  if (!Array.isArray(setRaw)) {
    log?.warn?.(`[meta-gen] (gs) AnimeGameData ReliquarySetExcelConfigData is not an array; artifact ids may be wrong`)
    return setMeta
  }

  for (const row of setRaw) {
    if (!isRecord(row)) continue
    const setId = toNumber(row.setId)
    const equipAffixId = toNumber(row.equipAffixId)
    if (!setId || !equipAffixId) continue

    const maxRankLevel = toNumber((row as any).FHEGKGFDCLE) ?? 0
    const needLen = Array.isArray(row.setNeedNum) ? (row.setNeedNum as unknown[]).length : 2

    // We need maxRankLevel for correct itemId selection; if it's missing, assume 5★ as a reasonable default.
    const normalizedMax = maxRankLevel >= 3 && maxRankLevel <= 5 ? maxRankLevel : 5

    const meta0: GiSetStaticMeta = {
      setId,
      metaId: '',
      maxRankLevel: normalizedMax,
      equipAffixId,
      needLen
    }
    meta0.metaId = toGsArtifactMetaId(meta0)
    setMeta.set(setId, meta0)
  }

  return setMeta
}

async function buildGiSetEquipIdMap(
  animeGameData: AnimeGameDataClient,
  setMetaBySetId: Map<number, GiSetStaticMeta>,
  log?: Pick<Console, 'warn'>
): Promise<Map<number, GiEquipTypeToItemId>> {
  const best = new Map<number, GiEquipTypeToBest>()

  // Primary: ReliquaryExcelConfigData provides per-piece real item IDs (5 digits like 77540).
  // We intentionally select item IDs at the set's "baseline max rarity" instead of blindly choosing rankLevel=5,
  // because some low-tier sets have unobtainable/unused 5★ rows in raw Excel data.
  const reliquaryRaw = await animeGameData.getGsReliquaryExcelConfigData()
  if (Array.isArray(reliquaryRaw)) {
    for (const row of reliquaryRaw) {
      if (!isRecord(row)) continue
      const setId = toNumber(row.setId)
      const itemId = toNumber(row.id)
      const equipType = row.equipType
      if (!setId || !itemId || !isGiEquipType(equipType)) continue

      // rankLevel exists on most rows; if missing treat as 0 so it loses to real rows.
      const rankLevel = toNumber(row.rankLevel) ?? 0
      const appendPropNum = toNumber(row.appendPropNum) ?? 999

      const desired = setMetaBySetId.get(setId)?.maxRankLevel
      if (desired && rankLevel !== desired) continue

      const slotBest = best.get(setId) ?? {}
      const current = slotBest[equipType]
      const incoming = { id: itemId, rankLevel, appendPropNum }
      if (!current || betterReliquaryCandidate(incoming, current)) {
        slotBest[equipType] = incoming
        best.set(setId, slotBest)
      }
    }
  } else {
    log?.warn?.(`[meta-gen] (gs) AnimeGameData ReliquaryExcelConfigData is not an array; artifact ids may be wrong`)
  }

  const out = new Map<number, GiEquipTypeToItemId>()
  for (const [setId, slotBest] of best.entries()) {
    out.set(setId, {
      EQUIP_BRACER: slotBest.EQUIP_BRACER?.id,
      EQUIP_NECKLACE: slotBest.EQUIP_NECKLACE?.id,
      EQUIP_SHOES: slotBest.EQUIP_SHOES?.id,
      EQUIP_RING: slotBest.EQUIP_RING?.id,
      EQUIP_DRESS: slotBest.EQUIP_DRESS?.id
    })
  }

  return out
}

function normalizeGiText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replaceAll('\\n', '').replaceAll('\n', '').trim()
}

export interface GenerateGsArtifactOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  hakush: HakushClient
  animeGameData: AnimeGameDataClient
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateGsArtifacts(opts: GenerateGsArtifactOptions): Promise<void> {
  const artifactRoot = path.join(opts.metaGsRootAbs, 'artifact')
  const artifactDataPath = path.join(artifactRoot, 'data.json')
  const artifactCalcPath = path.join(artifactRoot, 'calc.js')

  // We always rebuild `artifact/data.json` to keep IDs and piece mappings consistent with baseline rules.
  // Asset downloads remain incremental (`forceAssets` controls overwriting images).
  const artifactIndex: Record<string, unknown> = {}
  const setsForCalc: Array<{ setName: string; skills: Record<string, string> }> = []

  // GS artifact profile matching requires REAL in-game reliquary item IDs (5 digits like 77540).
  // Hakush detail endpoint doesn't expose them, so we fill them via AnimeGameData.
  const setMetaBySetId = await buildGiSetStaticMetaMap(opts.animeGameData, opts.log)
  const equipIdMapBySetId = await buildGiSetEquipIdMap(opts.animeGameData, setMetaBySetId, opts.log)

  // Hakush `gi/data/artifact.json` lists artifact set IDs (used by Hakush localized detail endpoint).
  // In full-gen mode we can iterate all of them; update-mode remains idempotent via `artifactIndex[id]` checks.
  const list = await opts.hakush.getGsArtifactList()
  const setIds = Object.keys(list)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
    .map((n) => String(n))

  for (const id of setIds) {
    opts.log?.info?.(`[meta-gen] (gs) artifact set: ${id}`)

    const detail = await opts.hakush.getGsArtifactDetail(id)
    if (!isRecord(detail)) {
      opts.log?.warn?.(`[meta-gen] (gs) artifact detail not an object: ${id}`)
      continue
    }

    const affixArr = Array.isArray(detail.Affix) ? (detail.Affix as Array<unknown>) : []
    const affix0 = isRecord(affixArr[0]) ? (affixArr[0] as Record<string, unknown>) : undefined
    const affix1 = isRecord(affixArr[1]) ? (affixArr[1] as Record<string, unknown>) : undefined
    const setName = typeof affix0?.Name === 'string' ? affix0.Name : undefined
    if (!setName) {
      opts.log?.warn?.(`[meta-gen] (gs) artifact missing set name: ${id}`)
      continue
    }

    const need = Array.isArray(detail.Need) ? (detail.Need as Array<unknown>) : []
    const need2 = need[0]
    const need4 = need[1]

    const skills: Record<string, string> = {}
    if (typeof need2 === 'number' && typeof affix0?.Desc === 'string') {
      skills[String(need2)] = normalizeGiText(affix0.Desc)
    }
    if (typeof need4 === 'number' && typeof affix1?.Desc === 'string') {
      skills[String(need4)] = normalizeGiText(affix1.Desc)
    }
    setsForCalc.push({ setName, skills })

    const parts = isRecord(detail.Parts) ? (detail.Parts as Record<string, unknown>) : {}
    const getPart = (k: string): Record<string, unknown> | undefined => (isRecord(parts[k]) ? (parts[k] as Record<string, unknown>) : undefined)

    // Piece mapping follows miao-plugin conventions (same as liangshi-calc):
    // 1: flower (BRACER), 2: feather (NECKLACE), 3: sands (SHOES), 4: goblet (RING), 5: circlet (DRESS)
    const setIdNum = Number(id)
    const equipIds = Number.isFinite(setIdNum) ? equipIdMapBySetId.get(setIdNum) : undefined
    if (!equipIds) {
      opts.log?.warn?.(`[meta-gen] (gs) artifact missing itemId mapping (setId=${id}); profile matching may break`)
    }

    const addPart = (idx: string, equipType: GiEquipType): void => {
      const p = getPart(equipType)
      const name = p && typeof p.Name === 'string' ? (p.Name as string) : ''
      if (!name) return
      const itemId = equipIds?.[equipType]
      if (typeof itemId === 'number' && Number.isFinite(itemId)) {
        ;(idxs as any)[idx] = { id: String(itemId), name }
      } else {
        ;(idxs as any)[idx] = { name }
      }
    }

    // Only include existing pieces; 1-piece “祭”系列套装只会有头冠。
    const idxs: Record<string, { id?: string; name?: string }> = {}
    addPart('1', 'EQUIP_BRACER')
    addPart('2', 'EQUIP_NECKLACE')
    addPart('3', 'EQUIP_SHOES')
    addPart('4', 'EQUIP_RING')
    addPart('5', 'EQUIP_DRESS')

    const setIdNumOk = Number.isFinite(setIdNum) ? setIdNum : null
    const metaId = setIdNumOk ? setMetaBySetId.get(setIdNumOk)?.metaId : undefined
    const outId = metaId || String(id)

    artifactIndex[outId] = { id: outId, name: setName, idxs, skills }

    // Download piece images into artifact/imgs/<setName>/.
    const imgsDir = path.join(artifactRoot, 'imgs', setName)
    fs.mkdirSync(imgsDir, { recursive: true })
    const uiBase = 'https://api.hakush.in/gi/UI/'
    const iconOf = (k: string): string | undefined => {
      const p = getPart(k)
      return p && typeof p.Icon === 'string' ? p.Icon : undefined
    }

    const downloads: Array<{ partKey: string; fileName: string }> = [
      { partKey: 'EQUIP_BRACER', fileName: '1.webp' },
      { partKey: 'EQUIP_NECKLACE', fileName: '2.webp' },
      { partKey: 'EQUIP_SHOES', fileName: '3.webp' },
      { partKey: 'EQUIP_RING', fileName: '4.webp' },
      { partKey: 'EQUIP_DRESS', fileName: '5.webp' }
    ]

    for (const d of downloads) {
      const filePath = path.join(imgsDir, d.fileName)
      // Fallback: HoneyHunter hosts many legacy/unlisted set piece icons by set id.
      const idx = d.fileName.replace(/\.webp$/i, '')
      const honeyUrl = `https://gensh.honeyhunterworld.com/img/i_n${id}_${idx}.webp`

      const icon = iconOf(d.partKey)
      if (!icon) {
        const honeyRes = await downloadToFileOptional(honeyUrl, filePath, { force: opts.forceAssets })
        if (honeyRes.ok && honeyRes.action !== 'missing') continue

        const honeyErr = honeyRes.ok ? (honeyRes.action === 'missing' ? 'HTTP 404' : 'unknown') : honeyRes.error
        opts.log?.warn?.(
          `[meta-gen] (gs) artifact img missing: ${id} ${setName} ${d.fileName} -> hakush=missing-icon honey=${honeyErr}`
        )
        logAssetError({
          game: 'gs',
          type: 'artifact',
          id: String(id),
          name: setName,
          url: honeyUrl,
          out: filePath,
          error: `missing (no hakush icon name) honey=${honeyErr}`
        })
        continue
      }

      const url = `${uiBase}${icon}.webp`
      const res = await downloadToFileOptional(url, filePath, { force: opts.forceAssets })
      if (res.ok && res.action !== 'missing') continue

      if (!res.ok) {
        opts.log?.warn?.(`[meta-gen] (gs) artifact img failed: ${id} ${setName} ${d.fileName} -> ${res.error}`)
        logAssetError({ game: 'gs', type: 'artifact', id: String(id), name: setName, url, out: filePath, error: res.error })
        continue
      }

      // Hakush returned HTTP 404; try HoneyHunter as a fallback.
      const honeyRes = await downloadToFileOptional(honeyUrl, filePath, { force: opts.forceAssets })
      if (honeyRes.ok && honeyRes.action !== 'missing') continue

      const honeyErr = honeyRes.ok ? (honeyRes.action === 'missing' ? 'HTTP 404' : 'unknown') : honeyRes.error
      opts.log?.warn?.(`[meta-gen] (gs) artifact img missing: ${id} ${setName} ${d.fileName} -> hakush=HTTP 404 honey=${honeyErr}`)
      logAssetError({
        game: 'gs',
        type: 'artifact',
        id: String(id),
        name: setName,
        url,
        out: filePath,
        error: `missing from all sources (hakush/honeyhunter) hakush=HTTP 404 honey=${honeyErr}`
      })
    }
  }

  // Write updated artifact index (may be unchanged when no new sets exist).
  writeJsonFile(artifactDataPath, sortRecordByKey(artifactIndex))

  // Build artifact buff table from upstream bonus texts (deterministic subset).
  try {
    fs.writeFileSync(artifactCalcPath, buildGsArtifactCalcJs(setsForCalc), 'utf8')
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) artifact calc.js write failed: ${String(e)}`)
  }

  // Generate `extra.js` (rule tables) from AnimeGameData.
  // Always overwrite: it is a derived file and should track upstream changes.
  try {
    await generateGsArtifactExtraJs({ metaGsRootAbs: opts.metaGsRootAbs, animeGameData: opts.animeGameData, log: opts.log })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) artifact extra.js generation failed: ${String(e)}`)
  }
}
