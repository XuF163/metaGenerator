/**
 * GS daily material calendar generator (AnimeGameData -> meta-gs/material/daily.js + abbr.js).
 *
 * Why we generate these files:
 * - `daily.js` is required by miao-plugin to map talent/weapon domain materials to:
 *   - week group (Mon/Thu, Tue/Fri, Wed/Sat)
 *   - city/region
 * - `abbr.js` is an optional override table. We keep it minimal to avoid stale maintenance.
 *
 * Source of truth:
 * - Dimbreath/AnimeGameData (GenshinData) ExcelBinOutput JSON:
 *   - MaterialExcelConfigData
 *   - MaterialSourceDataExcelConfigData
 *   - DailyDungeonConfigData
 *   - DungeonExcelConfigData
 *   - CityConfigData
 *   - TextMapCHS
 *
 * Notes:
 * - Always overwrite: derived files should track upstream changes.
 * - Do NOT read/copy baseline meta as a fallback (baseline is validate-only).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim()) {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return undefined
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function firstNonZeroNumber(arr: unknown): number | undefined {
  if (!Array.isArray(arr)) return undefined
  for (const v of arr) {
    const n = toNum(v)
    if (n && n > 0) return n
  }
  return undefined
}

function extractBetween(name: string, left: string, right: string): string {
  const a = name.indexOf(left)
  if (a === -1) return ''
  const b = name.indexOf(right, a + left.length)
  if (b === -1) return ''
  const inner = name.slice(a + left.length, b).trim()
  return inner
}

function deriveTalentAbbr(name: string): string {
  return (
    extractBetween(name, '「', '」') ||
    extractBetween(name, '《', '》') ||
    extractBetween(name, '『', '』') ||
    name
  )
}

export interface GenerateGsMaterialDailyOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  animeGameData: AnimeGameDataClient
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateGsMaterialDailyAndAbbr(opts: GenerateGsMaterialDailyOptions): Promise<void> {
  const materialRoot = path.join(opts.metaGsRootAbs, 'material')
  fs.mkdirSync(materialRoot, { recursive: true })

  const outDaily = path.join(materialRoot, 'daily.js')
  const outAbbr = path.join(materialRoot, 'abbr.js')

  const [textMapRaw, matRaw, srcRaw, dailyRaw, dungeonRaw, cityRaw] = await Promise.all([
    opts.animeGameData.getGsTextMapCHS(),
    opts.animeGameData.getGsMaterialExcelConfigData(),
    opts.animeGameData.getGsMaterialSourceDataExcelConfigData(),
    opts.animeGameData.getGsDailyDungeonConfigData(),
    opts.animeGameData.getGsDungeonExcelConfigData(),
    opts.animeGameData.getGsCityConfigData()
  ])

  const textMap: Record<string, string> = isRecord(textMapRaw) ? (textMapRaw as Record<string, string>) : {}
  const textMapGet = (hash: unknown): string => {
    const k = String(hash ?? '')
    return typeof textMap[k] === 'string' ? textMap[k]! : ''
  }

  const mats: Array<Record<string, unknown>> = Array.isArray(matRaw) ? (matRaw.filter(isRecord) as Array<Record<string, unknown>>) : []
  const sources: Array<Record<string, unknown>> = Array.isArray(srcRaw) ? (srcRaw.filter(isRecord) as Array<Record<string, unknown>>) : []
  const dailyRows: Array<Record<string, unknown>> = Array.isArray(dailyRaw)
    ? (dailyRaw.filter(isRecord) as Array<Record<string, unknown>>)
    : []
  const dungeons: Array<Record<string, unknown>> = Array.isArray(dungeonRaw)
    ? (dungeonRaw.filter(isRecord) as Array<Record<string, unknown>>)
    : []
  const cities: Array<Record<string, unknown>> = Array.isArray(cityRaw) ? (cityRaw.filter(isRecord) as Array<Record<string, unknown>>) : []

  if (!mats.length || !sources.length || !dailyRows.length || !dungeons.length || !cities.length) {
    opts.log?.warn?.('[meta-gen] (gs) material daily/abbr skipped: AnimeGameData tables unavailable')
    return
  }

  // city order: use main regions (cityId 1..7) sorted by cityId.
  const cityIdToName = new Map<number, string>()
  for (const c of cities) {
    const id = toNum(c.cityId)
    if (!id) continue
    const name = textMapGet(c.cityNameTextMapHash)
    if (!name) continue
    cityIdToName.set(id, name)
  }
  const cityOrder = [...cityIdToName.entries()]
    .filter(([id]) => id >= 1 && id <= 7)
    .sort((a, b) => a[0] - b[0])
    .map(([, name]) => name)

  // dungeonId -> { cityId, subType }
  const dungeonInfo = new Map<number, { cityId: number; subType: string }>()
  for (const d of dungeons) {
    const id = toNum(d.id)
    const cityId = toNum(d.cityID)
    if (!id || !cityId) continue
    const subType = toStr(d.subType)
    dungeonInfo.set(id, { cityId, subType })
  }

  // base dungeonId -> week group (1..3)
  const weekByDungeonBaseId = new Map<number, number>()
  for (const row of dailyRows) {
    const baseIds = new Set<number>()
    for (const v of Object.values(row)) {
      if (!Array.isArray(v) || v.length !== 1) continue
      const n = toNum(v[0])
      if (n && n > 0) baseIds.add(n)
    }
    if (baseIds.size !== 3) continue
    const sorted = [...baseIds].sort((a, b) => a - b)
    weekByDungeonBaseId.set(sorted[0]!, 1)
    weekByDungeonBaseId.set(sorted[1]!, 2)
    weekByDungeonBaseId.set(sorted[2]!, 3)
  }

  // material id -> { name, rankLevel }
  const materialInfo = new Map<number, { name: string; rankLevel: number }>()
  for (const m of mats) {
    const id = toNum(m.id)
    if (!id) continue
    const name = textMapGet(m.nameTextMapHash)
    if (!name) continue
    const rankLevel = toNum(m.rankLevel) ?? 0
    materialInfo.set(id, { name, rankLevel })
  }

  // daily output is aligned with `scaffold/meta-gs/material/index.js` city order (cityOrder).
  const initWeekArray = (): string[] => Array.from({ length: cityOrder.length }).map(() => '')
  const dailyOut: {
    talent: Record<number, string[]>
    weapon: Record<number, string[]>
  } = {
    talent: { 1: initWeekArray(), 2: initWeekArray(), 3: initWeekArray() },
    weapon: { 1: initWeekArray(), 2: initWeekArray(), 3: initWeekArray() }
  }

  for (const s of sources) {
    const id = toNum(s.id)
    if (!id) continue

    const info = materialInfo.get(id)
    if (!info) continue
    // only take the base rarity entry to avoid duplicates
    if (info.rankLevel !== 2) continue

    const baseDungeonId = firstNonZeroNumber(s.dungeonList) ?? firstNonZeroNumber(s.dungeonGroup)
    if (!baseDungeonId) continue

    const week = weekByDungeonBaseId.get(baseDungeonId)
    if (!week) continue

    const dInfo = dungeonInfo.get(baseDungeonId)
    if (!dInfo) continue

    const cityName = cityIdToName.get(dInfo.cityId) || ''
    const cityIdx = cityOrder.indexOf(cityName)
    if (cityIdx === -1) continue

    const subType = dInfo.subType
    const isTalent = subType.includes('TALENT')
    const isWeapon = subType.includes('WEAPON')
    if (!isTalent && !isWeapon) continue

    const abbr = isTalent ? deriveTalentAbbr(info.name) : info.name.slice(0, 4) || info.name
    const bucket = isTalent ? dailyOut.talent : dailyOut.weapon
    const arr = bucket[week]
    if (!arr) continue

    if (!arr[cityIdx]) {
      arr[cityIdx] = abbr
    } else if (arr[cityIdx] !== abbr) {
      opts.log?.warn?.(
        `[meta-gen] (gs) daily.js conflict: ${subType} week=${week} city=${cityName} existing=${arr[cityIdx]} new=${abbr} (material=${info.name})`
      )
    }
  }

  const dailyJs = [
    '/**',
    ' * Daily dungeon material calendar (generated).',
    ' *',
    ' * Generated from AnimeGameData (GenshinData) ExcelBinOutput:',
    ' * - DailyDungeonConfigData',
    ' * - DungeonExcelConfigData',
    ' * - MaterialSourceDataExcelConfigData',
    ' *',
    ' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.',
    ' */',
    '',
    `export default ${JSON.stringify(dailyOut, null, 2)}`,
    ''
  ].join('\n')
  fs.writeFileSync(outDaily, dailyJs, 'utf8')

  // Keep abbr overrides minimal and user-extensible; most abbr is derived at runtime (abbr2).
  const abbrJs = [
    '/**',
    ' * Material abbreviation overrides (generated).',
    ' *',
    ' * Intentionally minimal: prefer deriving abbreviations from material names and daily.js.',
    ' * Users can extend this file after generation if they need extra nicknames.',
    ' */',
    '',
    'export const abbr = {}',
    ''
  ].join('\n')
  fs.writeFileSync(outAbbr, abbrJs, 'utf8')

  opts.log?.info?.('[meta-gen] (gs) generated material daily.js/abbr.js from AnimeGameData')
}

