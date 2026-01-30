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

function stripQuotes(s: string): string {
  return s.replace(/[「」『』《》“”]/g, '').trim()
}

function splitAfterLast(s: string, sep: string): string {
  const i = s.lastIndexOf(sep)
  if (i === -1) return ''
  return s.slice(i + sep.length).trim()
}

function tryReadJson(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function collectMaterialNamesFromDataJson(data: unknown): Array<{ name: string; type: string }> {
  const out: Array<{ name: string; type: string }> = []
  if (!isRecord(data)) return out

  const walk = (v: unknown): void => {
    if (!isRecord(v)) return
    const name = typeof v.name === 'string' ? v.name.trim() : ''
    const type = typeof v.type === 'string' ? v.type.trim() : ''
    if (name && type) out.push({ name, type })

    const items = v.items
    if (!isRecord(items)) return
    for (const child of Object.values(items)) walk(child)
  }

  for (const v of Object.values(data)) walk(v)
  return out
}

function deriveMaterialAbbr(nameRaw: string): string[] {
  const name = nameRaw.trim()
  if (!name) return []

  const out: string[] = []
  const push = (s: string): void => {
    const t = s.trim()
    if (!t) return
    if (t === name) return
    if (t.length < 2) return
    if (t.length > 12) return
    if (!out.includes(t)) out.push(t)
  }

  // Common punctuation/quote stripping (e.g. 「图比昂装置」 -> 图比昂装置).
  const noQuotes = stripQuotes(name)
  if (noQuotes && noQuotes !== name) push(noQuotes)

  // "未能达成X" -> "未X" (baseline convention for some boss drops).
  if (name.startsWith('未能达成')) push(`未${name.slice('未能达成'.length)}`)

  // "奇械..." -> drop the prefix for brevity (common Fontaine chain naming).
  if (name.startsWith('奇械') && name.length > 2) push(name.slice(2))

  // "xxx·yyy" -> yyy
  const afterDot = splitAfterLast(name, '·')
  if (afterDot) push(afterDot)

  // Pattern compression for "...之X": keep the leading 2 chars + trailing 2 chars.
  if (/之.$/.test(name) && name.length >= 5) {
    push(`${name.slice(0, 2)}${name.slice(-2)}`)
  }

  // Generic fallbacks (only useful when unique).
  if (name.length >= 4) push(name.slice(-4))
  if (name.length >= 4) push(name.slice(2))

  return out
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

  // Abbr overrides: derive a small, collision-safe set from material/data.json.
  // (Talent/weapon abbreviations are already derived at runtime via abbr2; focus on boss/weekly/normal/etc.)
  const abbr: Record<string, string> = {}
  try {
    const materialDataPath = path.join(materialRoot, 'data.json')
    if (fs.existsSync(materialDataPath)) {
      const raw = tryReadJson(materialDataPath)
      if (!raw) return
      const entries = collectMaterialNamesFromDataJson(raw)
      const used = new Set<string>()

      // Skip types that already have derived abbr (abbr2) to avoid conflicts.
      const skipTypes = new Set(['talent', 'weapon'])

      // Stable order for deterministic output.
      entries
        .filter((e) => !skipTypes.has(e.type))
        .map((e) => e.name)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
        .forEach((name) => {
          const cands = deriveMaterialAbbr(name)
          const pick = cands.find((c) => !used.has(c))
          if (!pick) return
          used.add(pick)
          abbr[name] = pick
        })
    }
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) material abbr.js derive failed: ${String(e)}`)
  }

  const keys = Object.keys(abbr).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * Material abbreviation overrides (generated).')
  lines.push(' *')
  lines.push(' * Derived from meta-gs/material/data.json names.')
  lines.push(' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.')
  lines.push(' */')
  lines.push('')
  lines.push('export const abbr = {')
  for (const k of keys) {
    lines.push(`  ${JSON.stringify(k)}: ${JSON.stringify(abbr[k])},`)
  }
  lines.push('}')
  lines.push('')

  fs.writeFileSync(outAbbr, lines.join('\n'), 'utf8')

  opts.log?.info?.('[meta-gen] (gs) generated material daily.js/abbr.js from AnimeGameData')
}

