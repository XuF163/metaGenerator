/**
 * Generate `meta-gs/weapon/<type>/calc.js` from AnimeGameData (EquipAffix addProps).
 *
 * Why:
 * - Scaffold should stay minimal (skeleton only).
 * - Weapon passive effects update over time; we derive the unconditional parts from upstream structured data.
 *
 * Scope (deterministic):
 * - Only exports "static" buffs that are represented by EquipAffix `addProps`.
 * - Complex conditional mechanics are not modelled here (left absent).
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'

type WeaponTypeDir = 'sword' | 'claymore' | 'polearm' | 'catalyst' | 'bow'

const weaponTypeMap: Record<string, WeaponTypeDir | undefined> = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_CATALYST: 'catalyst',
  WEAPON_BOW: 'bow'
}

type PropRule = { key: string; scale: number }
const propToBuffKey: Record<string, PropRule | undefined> = {
  // Base attrs
  FIGHT_PROP_ATTACK: { key: 'atkPlus', scale: 1 },
  FIGHT_PROP_HP: { key: 'hpPlus', scale: 1 },
  FIGHT_PROP_DEFENSE: { key: 'defPlus', scale: 1 },

  // Percent attrs
  FIGHT_PROP_ATTACK_PERCENT: { key: 'atkPct', scale: 100 },
  FIGHT_PROP_HP_PERCENT: { key: 'hpPct', scale: 100 },
  FIGHT_PROP_DEFENSE_PERCENT: { key: 'defPct', scale: 100 },
  FIGHT_PROP_CRITICAL: { key: 'cpct', scale: 100 },
  FIGHT_PROP_CRITICAL_HURT: { key: 'cdmg', scale: 100 },
  FIGHT_PROP_CHARGE_EFFICIENCY: { key: 'recharge', scale: 100 },
  FIGHT_PROP_HEAL_ADD: { key: 'heal', scale: 100 },
  FIGHT_PROP_ADD_HURT: { key: 'dmg', scale: 100 },
  FIGHT_PROP_SHIELD_COST_MINUS_RATIO: { key: 'shield', scale: 100 },

  // Element / physical dmg bonus
  FIGHT_PROP_PHYSICAL_ADD_HURT: { key: 'phy', scale: 100 },
  FIGHT_PROP_FIRE_ADD_HURT: { key: 'pyro', scale: 100 },
  FIGHT_PROP_WATER_ADD_HURT: { key: 'hydro', scale: 100 },
  FIGHT_PROP_ELEC_ADD_HURT: { key: 'electro', scale: 100 },
  FIGHT_PROP_ICE_ADD_HURT: { key: 'cryo', scale: 100 },
  FIGHT_PROP_WIND_ADD_HURT: { key: 'anemo', scale: 100 },
  FIGHT_PROP_ROCK_ADD_HURT: { key: 'geo', scale: 100 },
  FIGHT_PROP_GRASS_ADD_HURT: { key: 'dendro', scale: 100 },

  // Flat mastery
  FIGHT_PROP_ELEMENT_MASTERY: { key: 'mastery', scale: 1 }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function firstNonZeroNumber(arr: unknown): number | null {
  if (!Array.isArray(arr)) return null
  for (const v of arr) {
    const n = toNumber(v)
    if (n != null && n > 0) return n
  }
  return null
}

type EquipAffixRow = {
  id: number
  level: number
  addProps: Array<{ propType: string; value: number }>
}

function parseEquipAffixRows(raw: unknown): EquipAffixRow[] {
  const rows: EquipAffixRow[] = []
  if (!Array.isArray(raw)) return rows
  for (const it of raw) {
    if (!isRecord(it)) continue
    const id = toNumber(it.id)
    const level = toNumber(it.level)
    const addPropsRaw = Array.isArray(it.addProps) ? (it.addProps as unknown[]) : []
    if (id == null || level == null) continue
    const addProps: Array<{ propType: string; value: number }> = []
    for (const p of addPropsRaw) {
      if (!isRecord(p)) continue
      const propType = typeof p.propType === 'string' ? (p.propType as string) : ''
      const value = toNumber(p.value)
      if (!propType || value == null) continue
      addProps.push({ propType, value })
    }
    rows.push({ id, level, addProps })
  }
  return rows
}

type WeaponAffixSeed = {
  id: number
  name: string
  typeDir: WeaponTypeDir
  skillAffixId: number
}

function buildStaticRefineFromAddProps(rows: EquipAffixRow[]): Record<string, number[]> {
  // Map: buffKey -> [r1..r5]
  const out: Record<string, number[]> = {}
  if (!rows.length) return out

  const sorted = rows.slice().sort((a, b) => a.level - b.level)
  const hasZeroBased = sorted.some((r) => r.level === 0)
  const hasOneBased = !hasZeroBased && sorted.some((r) => r.level === 1)

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!
    const idx = hasZeroBased ? row.level : hasOneBased ? row.level - 1 : i
    if (idx < 0 || idx > 4) continue

    for (const p of row.addProps) {
      const rule = propToBuffKey[p.propType]
      if (!rule) continue
      if (!p.value || !Number.isFinite(p.value)) continue
      const v = round2(p.value * rule.scale)
      if (!v) continue
      if (!out[rule.key]) out[rule.key] = [0, 0, 0, 0, 0]
      out[rule.key]![idx] = v
    }
  }

  // Remove all-zero keys.
  for (const [k, arr] of Object.entries(out)) {
    if (!arr.some((v) => v !== 0)) delete out[k]
  }
  return out
}

function renderCalcJs(buffByName: Record<string, { refine: Record<string, number[]> }>): string {
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * Auto-generated weapon buff table (static addProps only).')
  lines.push(' *')
  lines.push(' * Source: AnimeGameData EquipAffixExcelConfigData.addProps')
  lines.push(' * Notes:')
  lines.push(' * - Only unconditional addProps are modelled as isStatic buffs.')
  lines.push(' * - Complex conditional passives are intentionally omitted.')
  lines.push(' */')
  lines.push('export default function (step, staticStep) {')
  lines.push('  return {')
  const names = Object.keys(buffByName).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  for (const name of names) {
    const buff = buffByName[name]!
    const refine = buff.refine
    const refineKeys = Object.keys(refine).sort()
    if (refineKeys.length === 0) continue
    lines.push(`    ${JSON.stringify(name)}: {`)
    lines.push('      isStatic: true,')
    lines.push('      refine: {')
    for (const k of refineKeys) {
      lines.push(`        ${k}: ${JSON.stringify(refine[k])},`)
    }
    lines.push('      }')
    lines.push('    },')
  }
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

export async function generateGsWeaponCalcJs(opts: {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  animeGameData: AnimeGameDataClient
  log?: Pick<Console, 'info' | 'warn'>
}): Promise<void> {
  const weaponRoot = path.join(opts.metaGsRootAbs, 'weapon')

  // Load AGD weapon config to map (weaponId -> name/typeDir/skillAffixId).
  const weaponExcelRaw = await opts.animeGameData.getGsWeaponExcelConfigData()
  const weaponRows: Array<Record<string, unknown>> = Array.isArray(weaponExcelRaw)
    ? ((weaponExcelRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
    : []

  const textMapRaw = await opts.animeGameData.getGsTextMapCHS()
  const textMap: Record<string, string> = isRecord(textMapRaw) ? (textMapRaw as Record<string, string>) : {}
  const textMapGet = (hash: unknown): string => {
    const key = String(hash ?? '')
    return typeof textMap[key] === 'string' ? textMap[key]! : ''
  }

  const equipAffixRaw = await opts.animeGameData.getGsEquipAffixExcelConfigData()
  const equipAffixRows = parseEquipAffixRows(equipAffixRaw)

  const seeds: WeaponAffixSeed[] = []
  for (const row of weaponRows) {
    const id = toNumber(row.id)
    if (id == null) continue
    const weaponType = typeof row.weaponType === 'string' ? (row.weaponType as string) : ''
    const typeDir = weaponType ? weaponTypeMap[weaponType] : undefined
    if (!typeDir) continue

    const name = textMapGet(row.nameTextMapHash)
    if (!name) continue

    const skillAffixId = firstNonZeroNumber((row as any).skillAffix)
    if (!skillAffixId) continue

    seeds.push({ id, name, typeDir, skillAffixId })
  }

  const byType: Record<WeaponTypeDir, Record<string, { refine: Record<string, number[]> }>> = {
    sword: {},
    claymore: {},
    polearm: {},
    catalyst: {},
    bow: {}
  }

  for (const s of seeds) {
    const rows = equipAffixRows.filter((r) => r.id === s.skillAffixId)
    const refine = buildStaticRefineFromAddProps(rows)
    if (Object.keys(refine).length === 0) continue
    byType[s.typeDir][s.name] = { refine }
  }

  // Write per-type calc.js (always overwrite; derived file).
  for (const [typeDir, buffByName] of Object.entries(byType) as Array<
    [WeaponTypeDir, Record<string, { refine: Record<string, number[]> }>]
  >) {
    const outFile = path.join(weaponRoot, typeDir, 'calc.js')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, renderCalcJs(buffByName), 'utf8')
  }

  const total = Object.values(byType).reduce((acc, m) => acc + Object.keys(m).length, 0)
  opts.log?.info?.(`[meta-gen] (gs) weapon calc.js generated (static addProps): ${total}`)
}
