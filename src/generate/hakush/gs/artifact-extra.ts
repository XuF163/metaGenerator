/**
 * GS artifact extra.js generator (AnimeGameData -> meta-gs/artifact/extra.js).
 *
 * Why we generate this file:
 * - miao-plugin runtime needs `mainIdMap/attrIdMap` to convert artifact stats from profile APIs.
 * - These tables are pure "Excel -> mapping" data, so keeping them in scaffold is high-maintenance.
 *
 * Source of truth:
 * - Dimbreath/AnimeGameData (GenshinData) ExcelBinOutput JSON
 *   - ReliquaryMainPropExcelConfigData.json
 *   - ReliquaryAffixExcelConfigData.json
 *
 * Notes:
 * - We do NOT read/copy baseline meta as a fallback. Baseline is validate-only.
 * - This generator intentionally overwrites the output file (derived artifact rule table).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'

type MainPropRow = {
  id?: number
  propType?: string
}

type AffixRow = {
  id?: number
  propType?: string
  propValue?: number
}

type ConsoleLike = Pick<Console, 'info' | 'warn'>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function isDigits(s: string): boolean {
  return /^\d+$/.test(s)
}

function jsKey(k: string): string {
  return isDigits(k) ? k : JSON.stringify(k)
}

function jsStr(s: string): string {
  return JSON.stringify(s)
}

function jsNum(n: number): string {
  // Keep stable & readable.
  if (Number.isInteger(n)) return String(n)
  return String(n)
}

function toGsAttrKeyFromFightProp(propType: string): string | null {
  // Flat stats
  if (propType === 'FIGHT_PROP_HP') return 'hpPlus'
  if (propType === 'FIGHT_PROP_ATTACK') return 'atkPlus'
  if (propType === 'FIGHT_PROP_DEFENSE') return 'defPlus'

  // Percent stats
  if (propType === 'FIGHT_PROP_HP_PERCENT') return 'hp'
  if (propType === 'FIGHT_PROP_ATTACK_PERCENT') return 'atk'
  if (propType === 'FIGHT_PROP_DEFENSE_PERCENT') return 'def'

  // Other common stats
  if (propType === 'FIGHT_PROP_ELEMENT_MASTERY') return 'mastery'
  if (propType === 'FIGHT_PROP_CHARGE_EFFICIENCY') return 'recharge'
  if (propType === 'FIGHT_PROP_CRITICAL') return 'cpct'
  if (propType === 'FIGHT_PROP_CRITICAL_HURT') return 'cdmg'
  if (propType === 'FIGHT_PROP_HEAL_ADD') return 'heal'

  // Damage bonuses (main only; still kept in mainIdMap).
  if (propType === 'FIGHT_PROP_PHYSICAL_ADD_HURT' || propType === 'FIGHT_PROP_PHYSICAL_SUB_HURT') return 'phy'
  if (propType === 'FIGHT_PROP_FIRE_ADD_HURT' || propType === 'FIGHT_PROP_FIRE_SUB_HURT') return 'pyro'
  if (propType === 'FIGHT_PROP_WATER_ADD_HURT' || propType === 'FIGHT_PROP_WATER_SUB_HURT') return 'hydro'
  if (propType === 'FIGHT_PROP_ICE_ADD_HURT' || propType === 'FIGHT_PROP_ICE_SUB_HURT') return 'cryo'
  if (propType === 'FIGHT_PROP_ELEC_ADD_HURT' || propType === 'FIGHT_PROP_ELEC_SUB_HURT') return 'electro'
  if (propType === 'FIGHT_PROP_WIND_ADD_HURT' || propType === 'FIGHT_PROP_WIND_SUB_HURT') return 'anemo'
  if (propType === 'FIGHT_PROP_ROCK_ADD_HURT' || propType === 'FIGHT_PROP_ROCK_SUB_HURT') return 'geo'
  if (propType === 'FIGHT_PROP_GRASS_ADD_HURT' || propType === 'FIGHT_PROP_GRASS_SUB_HURT') return 'dendro'

  return null
}

function toRollStatKey(propType: string): string | null {
  // Substats do NOT include:
  // - dmg bonuses (elements/phy)
  // - healing bonus
  const key = toGsAttrKeyFromFightProp(propType)
  if (!key) return null
  if (key === 'heal' || key === 'phy') return null
  if (
    key === 'pyro' ||
    key === 'hydro' ||
    key === 'cryo' ||
    key === 'electro' ||
    key === 'anemo' ||
    key === 'geo' ||
    key === 'dendro'
  ) {
    return null
  }
  return key
}

function formatJsObjectLines(kv: Array<{ k: string; v: string }>, indent = '  '): string[] {
  const out: string[] = ['{']
  for (const { k, v } of kv) {
    out.push(`${indent}${jsKey(k)}: ${v},`)
  }
  out.push('}')
  return out
}

export interface GenerateGsArtifactExtraJsOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  animeGameData: AnimeGameDataClient
  log?: ConsoleLike
}

export async function generateGsArtifactExtraJs(opts: GenerateGsArtifactExtraJsOptions): Promise<void> {
  const artifactRoot = path.join(opts.metaGsRootAbs, 'artifact')
  fs.mkdirSync(artifactRoot, { recursive: true })

  const outFile = path.join(artifactRoot, 'extra.js')

  // --- Read upstream tables ---
  const mainRaw = await opts.animeGameData.getGsReliquaryMainPropExcelConfigData()
  const affixRaw = await opts.animeGameData.getGsReliquaryAffixExcelConfigData()

  const mainRows = Array.isArray(mainRaw) ? (mainRaw as MainPropRow[]) : []
  const affixRows = Array.isArray(affixRaw) ? (affixRaw as AffixRow[]) : []

  if (!mainRows.length || !affixRows.length) {
    opts.log?.warn?.('[meta-gen] (gs) artifact extra.js skipped: AnimeGameData reliquary tables unavailable')
    return
  }

  // --- mainIdMap (main stat id -> key) ---
  const mainIdMap: Array<{ k: string; v: string }> = []
  for (const row of mainRows) {
    const id = toNum(row.id)
    const propType = toStr(row.propType)
    if (!id || !propType) continue
    const key = toGsAttrKeyFromFightProp(propType)
    if (!key) continue
    mainIdMap.push({ k: String(id), v: jsStr(key) })
  }
  mainIdMap.sort((a, b) => Number(a.k) - Number(b.k))

  // --- attrIdMap (substat roll id -> { key, value }) ---
  const attrIdMap: Array<{ k: string; v: string }> = []
  for (const row of affixRows) {
    const id = toNum(row.id)
    const propType = toStr(row.propType)
    const propValue = toNum(row.propValue)
    if (!id || !propType || propValue == null) continue

    const key = toRollStatKey(propType)
    if (!key) continue

    // Keep percent values as ratios (0.0389), same as AnimeGameData.
    attrIdMap.push({ k: String(id), v: `{ key: ${jsStr(key)}, value: ${jsNum(propValue)} }` })
  }
  attrIdMap.sort((a, b) => Number(a.k) - Number(b.k))

  // --- Derive roll max/min for 5★ for UI/scoring numbers (attrMap.value / valueMin) ---
  const pctKeys = new Set(['atk', 'def', 'hp', 'cpct', 'cdmg', 'recharge'])
  const rollStats = new Map<string, { min: number; max: number }>()
  for (const row of affixRows) {
    const id = toNum(row.id)
    const propType = toStr(row.propType)
    const propValue = toNum(row.propValue)
    if (!id || !propType || propValue == null) continue
    if (!String(id).startsWith('5')) continue // 5★

    const key = toRollStatKey(propType)
    if (!key) continue

    const v = pctKeys.has(key) ? propValue * 100 : propValue
    const cur = rollStats.get(key)
    if (!cur) {
      rollStats.set(key, { min: v, max: v })
      continue
    }
    cur.min = Math.min(cur.min, v)
    cur.max = Math.max(cur.max, v)
  }

  const maxAtkPct = rollStats.get('atk')?.max
  const maxDefPct = rollStats.get('def')?.max
  const maxCpct = rollStats.get('cpct')?.max
  const basicNum = typeof maxCpct === 'number' && Number.isFinite(maxCpct) ? maxCpct : 0

  // --- Build output JS ---
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * Artifact extra table (generated).')
  lines.push(' *')
  lines.push(' * Generated from AnimeGameData (GenshinData) ExcelBinOutput:')
  lines.push(' * - ReliquaryMainPropExcelConfigData')
  lines.push(' * - ReliquaryAffixExcelConfigData')
  lines.push(' *')
  lines.push(' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.')
  lines.push(' */')
  lines.push('')
  lines.push('import lodash from "lodash"')
  lines.push('import { Format } from "#miao"')
  lines.push('')
  lines.push('export const mainAttr = {')
  lines.push('  3: "atk,def,hp,mastery,recharge".split(","),')
  lines.push('  4: "atk,def,hp,mastery,dmg,phy".split(","),')
  lines.push('  5: "atk,def,hp,mastery,heal,cpct,cdmg".split(",")')
  lines.push('}')
  lines.push('')
  lines.push('export const subAttr = "atk,atkPlus,def,defPlus,hp,hpPlus,mastery,recharge,cpct,cdmg".split(",")')
  lines.push('')
  lines.push('/**')
  lines.push(' * Artifact stat config.')
  lines.push(' * - value/valueMin are derived from 5★ roll tables (for scoring/display).')
  lines.push(' */')
  lines.push('export const attrMap = {')
  lines.push('  atk: { title: "大攻击", format: "pct", calc: "pct" },')
  lines.push('  atkPlus: { title: "小攻击", format: "comma" },')
  lines.push('  def: { title: "大防御", format: "pct", calc: "pct" },')
  lines.push('  defPlus: { title: "小防御", format: "comma" },')
  lines.push('  hp: { title: "大生命", format: "pct", calc: "pct" },')
  lines.push('  hpPlus: { title: "小生命", format: "comma" },')
  lines.push('  cpct: { title: "暴击率", format: "pct", calc: "plus" },')
  lines.push('  cdmg: { title: "暴击伤害", format: "pct", calc: "plus" },')
  lines.push('  mastery: { title: "元素精通", format: "comma", calc: "plus" },')
  lines.push('  recharge: { title: "充能效率", format: "pct", calc: "plus" },')
  lines.push('  dmg: { title: "元素伤害", format: "pct", calc: "plus" },')
  lines.push('  phy: { title: "物伤加成", format: "pct", calc: "plus" },')
  lines.push('  heal: { title: "治疗加成", format: "pct", calc: "plus" }')
  lines.push('}')
  lines.push('')
  lines.push(`export const basicNum = ${jsNum(basicNum)}`)
  lines.push('export const attrPct = {')
  for (const k of [
    'atk',
    'atkPlus',
    'def',
    'defPlus',
    'hp',
    'hpPlus',
    'cpct',
    'cdmg',
    'mastery',
    'recharge',
    'dmg',
    'phy',
    'heal'
  ]) {
    const st = rollStats.get(k)
    let v = st?.max
    if (k === 'dmg') v = maxAtkPct
    if (k === 'phy') v = maxDefPct
    if (k === 'heal') v = typeof maxAtkPct === 'number' ? maxAtkPct / 1.3 : undefined
    if (typeof v !== 'number' || !Number.isFinite(v) || !basicNum) continue
    lines.push(`  ${k}: ${jsNum(v / basicNum)},`)
  }
  lines.push('}')
  lines.push('')
  lines.push('let anMap = {}')
  lines.push('lodash.forEach(attrMap, (attr, key) => {')
  lines.push('  anMap[attr.title] = key')
  lines.push('')
  lines.push('  // Fill derived roll values when possible (5★ max/min roll).')
  lines.push('  const roll = {')
  for (const k of [
    'atk',
    'atkPlus',
    'def',
    'defPlus',
    'hp',
    'hpPlus',
    'cpct',
    'cdmg',
    'mastery',
    'recharge'
  ]) {
    const st = rollStats.get(k)
    const max = st?.max
    const min = st?.min
    if (typeof max === 'number' && Number.isFinite(max)) {
      lines.push(`    ${k}: { max: ${jsNum(max)}, min: ${typeof min === 'number' ? jsNum(min) : jsNum(max)} },`)
    }
  }
  lines.push('  }')
  lines.push('')
  lines.push('  if (roll[key]?.max != null) {')
  lines.push('    attr.value = roll[key].max')
  lines.push('    if (subAttr.includes(key)) attr.valueMin = roll[key].min')
  lines.push('  }')
  lines.push('')
  lines.push('  // Main-only stats: derive from related max rolls (stable ratios).')
  lines.push('  if (!attr.value) {')
  lines.push('    if (key === "dmg" && roll.atk?.max != null) attr.value = roll.atk.max')
  lines.push('    if (key === "phy" && roll.def?.max != null) attr.value = roll.def.max')
  lines.push('    if (key === "heal" && roll.atk?.max != null) attr.value = roll.atk.max / 1.3')
  lines.push('  }')
  lines.push('')
  lines.push('  // type/base/text are runtime-facing convenience fields.')
  lines.push('  attr.base = { hpPlus: "hp", atkPlus: "atk", defPlus: "def" }[key]')
  lines.push('  attr.type = attr.base ? "plus" : "normal"')
  lines.push('  if (attr.value) attr.text = Format[attr.format](attr.value, 2)')
  lines.push('})')
  lines.push('export const attrNameMap = anMap')
  lines.push('')
  lines.push('export const mainIdMap = ' + formatJsObjectLines(mainIdMap).join('\n'))
  lines.push('')
  lines.push('export const attrIdMap = ' + formatJsObjectLines(attrIdMap).join('\n'))
  lines.push('')

  fs.writeFileSync(outFile, lines.join('\n') + '\n', 'utf8')
  opts.log?.info?.('[meta-gen] (gs) generated artifact extra.js from AnimeGameData')
}

