/**
 * SR relic rule tables generator (TurnBasedGameData -> meta-sr/artifact/*).
 *
 * Why we generate these files:
 * - `meta-sr/artifact/meta.json` is required by miao-plugin to:
 *   - map main stat IDs to keys (mainIdx)
 *   - reconstruct main/sub values from panel API encoding (starData)
 * - `meta-sr/artifact/meta.js` provides relic scoring/display config (mainAttr/subAttr/attrMap)
 * - `meta-sr/artifact/star-meta.json` is a legacy-compatible export consumed by some older tooling.
 *
 * Source of truth:
 * - Dimbreath/turnbasedgamedata (StarRailData) ExcelOutput JSON:
 *   - RelicMainAffixConfig.json
 *   - RelicSubAffixConfig.json
 *
 * Notes:
 * - Always overwrite: these are derived tables and should track upstream changes.
 * - Do NOT read/copy baseline meta as a fallback (baseline is validate-only).
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import type { TurnBasedGameDataClient } from '../../../source/turnBasedGameData/client.js'

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

function firstNumberValue(obj: unknown): number | undefined {
  if (typeof obj === 'number' && Number.isFinite(obj)) return obj
  if (!isRecord(obj)) return undefined
  for (const v of Object.values(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

type MainAffixRow = {
  GroupID?: number
  AffixID?: number
  Property?: string
  BaseValue?: unknown
  LevelAdd?: unknown
}

type SubAffixRow = {
  GroupID?: number
  AffixID?: number
  Property?: string
  BaseValue?: unknown
  StepValue?: unknown
  StepNum?: number
}

function toSrRelicKeyFromProperty(property: string): string | undefined {
  switch (property) {
    case 'HPDelta':
      return 'hpPlus'
    case 'AttackDelta':
      return 'atkPlus'
    case 'DefenceDelta':
      return 'defPlus'
    case 'HPAddedRatio':
      return 'hp'
    case 'AttackAddedRatio':
      return 'atk'
    case 'DefenceAddedRatio':
      return 'def'
    case 'SpeedDelta':
      return 'speed'
    case 'CriticalChanceBase':
      return 'cpct'
    case 'CriticalDamageBase':
      return 'cdmg'
    case 'HealRatioBase':
      return 'heal'
    case 'StatusProbabilityBase':
      return 'effPct'
    case 'StatusResistanceBase':
      return 'effDef'
    case 'PhysicalAddedRatio':
      return 'phy'
    case 'FireAddedRatio':
      return 'fire'
    case 'IceAddedRatio':
      return 'ice'
    case 'ThunderAddedRatio':
      return 'elec'
    case 'WindAddedRatio':
      return 'wind'
    case 'QuantumAddedRatio':
      return 'quantum'
    case 'ImaginaryAddedRatio':
      return 'imaginary'
    case 'BreakDamageAddedRatioBase':
      return 'stance'
    case 'SPRatioBase':
      return 'recharge'
    default:
      return undefined
  }
}

const PCT_KEYS = new Set([
  'hp',
  'atk',
  'def',
  'cpct',
  'cdmg',
  'heal',
  'effPct',
  'effDef',
  'phy',
  'fire',
  'ice',
  'elec',
  'wind',
  'quantum',
  'imaginary',
  'stance',
  'recharge'
])

function normalizeValueByKey(key: string, v: number): number {
  return PCT_KEYS.has(key) ? v * 100 : v
}

// Kept for baseline parity; currently not used by miao-plugin core runtime.
const MAIN_ID_BY_KEY: Record<string, string> = {
  hpPlus: '1',
  atkPlus: '1',
  hp: '3',
  atk: '4',
  def: '5',
  cpct: '4',
  cdmg: '5',
  heal: '6',
  effPct: '7',
  speed: '4',
  phy: '4',
  fire: '5',
  ice: '6',
  elec: '7',
  wind: '8',
  quantum: '9',
  imaginary: '10',
  stance: '1',
  recharge: '2'
}

function buildMainIdx(mainRows: MainAffixRow[], star: number): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  for (let idx = 1; idx <= 6; idx++) {
    const groupId = star * 10 + idx
    const rows = mainRows
      .filter((r) => toNum(r.GroupID) === groupId)
      .filter((r) => toNum(r.AffixID) != null)
      .sort((a, b) => (toNum(a.AffixID) ?? 0) - (toNum(b.AffixID) ?? 0))

    const map: Record<string, string> = {}
    for (const r of rows) {
      const affixId = toNum(r.AffixID)
      const prop = toStr(r.Property)
      if (!affixId || !prop) continue
      const key = toSrRelicKeyFromProperty(prop)
      if (!key) continue
      map[String(affixId)] = key
    }
    if (Object.keys(map).length) out[String(idx)] = map
  }
  return out
}

function round2(n: number): number {
  return Number.isFinite(n) ? Number(n.toFixed(2)) : n
}

function buildSrArtifactMetaJs(opts: {
  star5Main: Record<string, { base: number; step: number }>
  star5SubRows: SubAffixRow[]
}): string {
  const subKeyCfg: Record<string, { base: number; step: number; stepNum: number }> = {}
  for (const r of opts.star5SubRows) {
    const prop = toStr(r.Property)
    const key = prop ? toSrRelicKeyFromProperty(prop) : undefined
    if (!key) continue
    const baseRaw = firstNumberValue(r.BaseValue)
    const stepRaw = firstNumberValue(r.StepValue)
    const stepNum = toNum(r.StepNum) ?? 0
    if (baseRaw == null || stepRaw == null || !Number.isFinite(stepNum)) continue

    const base = normalizeValueByKey(key, baseRaw)
    const step = normalizeValueByKey(key, stepRaw)
    subKeyCfg[key] = { base, step, stepNum }
  }

  const maxRoll = (key: string): number => {
    const cfg = subKeyCfg[key]
    if (!cfg) return 0
    return cfg.base + cfg.step * cfg.stepNum
  }

  const maxRollFrac6 = (key: string): string => {
    const v = maxRoll(key)
    const num = Math.round(v * 6)
    return `${num} / 6`
  }

  const mainBase = (key: string): number => {
    const cfg = opts.star5Main[key]
    return cfg ? cfg.base : 0
  }

  const healBase = round2(mainBase('heal'))
  const dmgBase = round2(mainBase('phy') || mainBase('fire') || mainBase('ice') || mainBase('elec') || mainBase('wind') || mainBase('quantum') || mainBase('imaginary'))
  const rechargeBase = round2(mainBase('recharge'))

  const lines: string[] = []
  lines.push('/**')
  lines.push(' * SR relic meta helpers (generated).')
  lines.push(' *')
  lines.push(' * Generated from turnbasedgamedata ExcelOutput:')
  lines.push(' * - RelicMainAffixConfig')
  lines.push(' * - RelicSubAffixConfig')
  lines.push(' *')
  lines.push(' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.')
  lines.push(' */')
  lines.push('')
  lines.push('import lodash from \"lodash\"')
  lines.push('import { Format } from \"#miao\"')
  lines.push('')
  lines.push('export const mainAttr = {')
  lines.push('  3: \"atk,def,hp,cpct,cdmg,heal,effPct\".split(\",\"),')
  lines.push('  4: \"atk,def,hp,speed\".split(\",\"),')
  lines.push('  5: \"atk,def,hp,dmg\".split(\",\"),')
  lines.push('  6: \"atk,def,hp,recharge,stance\".split(\",\")')
  lines.push('}')
  lines.push('')
  lines.push('export const subAttr = \"atk,atkPlus,def,defPlus,hp,hpPlus,speed,cpct,cdmg,effPct,effDef,stance\".split(\",\")')
  lines.push('')
  lines.push('/**')
  lines.push(' * Relic stat config.')
  lines.push(' * - `value` for sub stats: max single-roll value (5★).')
  lines.push(' * - `value` for main-only stats (heal/dmg/recharge): base main stat (5★, level 0).')
  lines.push(' */')
  lines.push('const attrMap = {')
  lines.push(`  atk: { title: \"大攻击\", format: \"pct\", calc: \"pct\", value: ${round2(maxRoll('atk'))} },`)
  lines.push(`  atkPlus: { title: \"小攻击\", format: \"comma\", value: ${maxRollFrac6('atkPlus')} },`)
  lines.push(`  def: { title: \"大防御\", format: \"pct\", calc: \"pct\", value: ${round2(maxRoll('def'))} },`)
  lines.push(`  defPlus: { title: \"小防御\", format: \"comma\", value: ${maxRollFrac6('defPlus')} },`)
  lines.push(`  hp: { title: \"大生命\", format: \"pct\", calc: \"pct\", value: ${round2(maxRoll('hp'))} },`)
  lines.push(`  hpPlus: { title: \"小生命\", format: \"comma\", value: ${maxRollFrac6('hpPlus')} },`)
  lines.push(`  speed: { title: \"速度\", format: \"comma\", calc: \"plus\", value: ${round2(maxRoll('speed'))} },`)
  lines.push(`  cpct: { title: \"暴击率\", format: \"pct\", calc: \"plus\", value: ${round2(maxRoll('cpct'))} },`)
  lines.push(`  cdmg: { title: \"暴击伤害\", format: \"pct\", calc: \"plus\", value: ${round2(maxRoll('cdmg'))} },`)
  lines.push(`  recharge: { title: \"充能效率\", format: \"pct\", calc: \"plus\", value: ${rechargeBase} },`)
  lines.push(`  dmg: { title: \"伤害加成\", format: \"pct\", value: ${dmgBase} },`)
  lines.push(`  heal: { title: \"治疗加成\", format: \"pct\", calc: \"pct\", value: ${healBase} },`)
  lines.push(`  stance: { title: \"击破特攻\", format: \"pct\", value: ${round2(maxRoll('stance'))}, calc: \"pct\" },`)
  lines.push(`  effPct: { title: \"效果命中\", format: \"pct\", value: ${round2(maxRoll('effPct'))}, calc: \"pct\" },`)
  lines.push(`  effDef: { title: \"效果抵抗\", format: \"pct\", value: ${round2(maxRoll('effDef'))}, calc: \"pct\" }`)
  lines.push('}')
  lines.push('')
  lines.push('lodash.forEach(attrMap, (attr, key) => {')
  lines.push('  // 设置value')
  lines.push('  if (!attr.value) return true')
  lines.push('')
  lines.push('  // 设置type')
  lines.push('  attr.base = { hpPlus: \"hp\", atkPlus: \"atk\", defPlus: \"def\" }[key]')
  lines.push('  attr.type = attr.base ? \"plus\" : \"normal\"')
  lines.push('')
  lines.push('  // 设置展示文字')
  lines.push('  attr.text = Format[attr.format](attr.value, 2)')
  lines.push('})')
  lines.push('')
  lines.push('export { attrMap }')
  lines.push('')
  return lines.join('\n')
}

export interface GenerateSrArtifactMetaOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  turnBasedGameData: TurnBasedGameDataClient
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateSrArtifactMetaFiles(opts: GenerateSrArtifactMetaOptions): Promise<void> {
  const artifactRoot = path.join(opts.metaSrRootAbs, 'artifact')
  fs.mkdirSync(artifactRoot, { recursive: true })

  const metaJsonPath = path.join(artifactRoot, 'meta.json')
  const starMetaJsonPath = path.join(artifactRoot, 'star-meta.json')
  const metaJsPath = path.join(artifactRoot, 'meta.js')

  const mainRaw = await opts.turnBasedGameData.getSrRelicMainAffixConfig()
  const subRaw = await opts.turnBasedGameData.getSrRelicSubAffixConfig()

  const mainRows: MainAffixRow[] = Array.isArray(mainRaw) ? (mainRaw as MainAffixRow[]) : []
  const subRows: SubAffixRow[] = Array.isArray(subRaw) ? (subRaw as SubAffixRow[]) : []

  if (!mainRows.length || !subRows.length) {
    opts.log?.warn?.('[meta-gen] (sr) artifact meta generation skipped: turnbasedgamedata relic affix tables unavailable')
    return
  }

  // mainIdx uses a canonical star group (5★) – mapping is stable across stars.
  const mainIdx = buildMainIdx(mainRows, 5)

  // starData: derive all star tiers required by runtime.
  const starData: Record<
    string,
    {
      main: Record<string, { id: string; base: number; step: number }>
      sub: Record<string, { key: string; base: number; step: number }>
    }
  > = {}

  for (const star of [2, 3, 4, 5]) {
    const main: Record<string, { id: string; base: number; step: number }> = {}

    for (let idx = 1; idx <= 6; idx++) {
      const groupId = star * 10 + idx
      const rows = mainRows.filter((r) => toNum(r.GroupID) === groupId)
      for (const r of rows) {
        const prop = toStr(r.Property)
        const key = prop ? toSrRelicKeyFromProperty(prop) : undefined
        if (!key) continue
        if (main[key]) continue // deterministic: first write wins

        const baseRaw = firstNumberValue(r.BaseValue)
        const stepRaw = firstNumberValue(r.LevelAdd)
        if (baseRaw == null || stepRaw == null) continue
        const base = normalizeValueByKey(key, baseRaw)
        const step = normalizeValueByKey(key, stepRaw)

        main[key] = {
          id: MAIN_ID_BY_KEY[key] || String(toNum(r.AffixID) ?? 0),
          base,
          step
        }
      }
    }

    const sub: Record<string, { key: string; base: number; step: number }> = {}
    const subGroup = subRows
      .filter((r) => toNum(r.GroupID) === star)
      .filter((r) => toNum(r.AffixID) != null)
      .sort((a, b) => (toNum(a.AffixID) ?? 0) - (toNum(b.AffixID) ?? 0))

    for (const r of subGroup) {
      const affixId = toNum(r.AffixID)
      const prop = toStr(r.Property)
      if (!affixId || !prop) continue
      const key = toSrRelicKeyFromProperty(prop)
      if (!key) continue

      const baseRaw = firstNumberValue(r.BaseValue)
      const stepRaw = firstNumberValue(r.StepValue)
      if (baseRaw == null || stepRaw == null) continue

      sub[String(affixId)] = {
        key,
        base: normalizeValueByKey(key, baseRaw),
        step: normalizeValueByKey(key, stepRaw)
      }
    }

    starData[String(star)] = { main, sub }
  }

  writeJsonFile(metaJsonPath, { mainIdx, starData })

  // star-meta.json (legacy export)
  const starMeta: Record<string, unknown> = {}
  for (const star of ['2', '3', '4', '5']) {
    const s = starData[star]
    if (!s) continue

    const main = s.main
    const sub = s.sub

    const mainOut: Record<string, { base: number; add: number }> = {}
    const setMain = (k: string, srcKey: string): void => {
      const cfg = main[srcKey]
      if (!cfg) return
      mainOut[k] = { base: cfg.base, add: cfg.step }
    }
    setMain('hp', 'hpPlus')
    setMain('atk', 'atkPlus')
    setMain('hpPct', 'hp')
    setMain('atkPct', 'atk')
    setMain('defPct', 'def')
    setMain('cpct', 'cpct')
    setMain('cdmg', 'cdmg')
    setMain('heal', 'heal')
    setMain('effPct', 'effPct')
    setMain('speed', 'speed')

    const subOut: Record<string, { base: number; add: number; step: number }> = {}
    const setSubByKey = (outKey: string, needKey: string): void => {
      const found = Object.values(sub).find((v) => v.key === needKey)
      if (!found) return
      subOut[outKey] = { base: found.base, add: found.base, step: found.step }
    }
    setSubByKey('hp', 'hpPlus')
    setSubByKey('atk', 'atkPlus')
    setSubByKey('def', 'defPlus')
    setSubByKey('hpPct', 'hp')
    setSubByKey('atkPct', 'atk')
    setSubByKey('defPct', 'def')
    setSubByKey('speed', 'speed')
    setSubByKey('cpct', 'cpct')
    setSubByKey('cdmg', 'cdmg')
    setSubByKey('effPct', 'effPct')
    setSubByKey('effDef', 'effDef')
    setSubByKey('stance', 'stance')

    starMeta[star] = {
      main: mainOut,
      sub: subOut,
      maxLv: Number(star) * 3
    }
  }
  writeJsonFile(starMetaJsonPath, starMeta)

  // meta.js (scoring helpers)
  const star5MainCfg: Record<string, { base: number; step: number }> = {}
  for (const [k, v] of Object.entries(starData['5']?.main || {})) {
    if (!v) continue
    star5MainCfg[k] = { base: v.base, step: v.step }
  }

  const star5SubRows = subRows.filter((r) => toNum(r.GroupID) === 5)
  const metaJs = buildSrArtifactMetaJs({ star5Main: star5MainCfg, star5SubRows })
  fs.writeFileSync(metaJsPath, metaJs.endsWith('\n') ? metaJs : metaJs + '\n', 'utf8')

  opts.log?.info?.('[meta-gen] (sr) generated artifact meta.json/star-meta.json/meta.js from turnbasedgamedata')
}

