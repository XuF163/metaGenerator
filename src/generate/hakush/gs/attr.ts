/**
 * GS character attr table generator.
 *
 * `attr` is used by miao-plugin for panel / profile calculations.
 * It contains "base stat at milestone levels" (hpBase/atkBase/defBase + growth stat)
 * following the same indexing convention used in baseline meta repos.
 *
 * Data source:
 * - Hakush GI character detail: StatsModifier.{HP,ATK,DEF,Ascension}
 *   where `Ascension` is an array of promotion bonuses for 20+/40+/.../80+.
 */

import { roundTo } from '../utils.js'

export interface GiAttrTable {
  keys: string[]
  details: Record<string, number[]>
}

export interface BuildGiAttrTableOptions {
  baseHP: number
  baseATK: number
  baseDEF: number
  hpMul: Record<string, unknown>
  atkMul: Record<string, unknown>
  defMul: Record<string, unknown>
  /** StatsModifier.Ascension array, representing promotion bonuses for 20+/40+/.../80+ */
  ascArr: Array<Record<string, unknown>>
  /** Growth key used by meta (e.g. cpct/cdmg/recharge/mastery/heal/dmg/phy). */
  growKey?: string
  /** Raw prop name in Hakush ascension objects (e.g. FIGHT_PROP_HEAL_ADD). */
  growProp?: string
}

function toNum(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

function getMul(mul: Record<string, unknown>, levelKey: string): number {
  return toNum(mul[levelKey])
}

function scaleGrowValue(growKey: string | undefined, raw: number): number {
  if (!growKey) return 0
  if (growKey === 'mastery') return roundTo(raw, 2)
  const v = raw >= 1 ? raw : raw * 100
  return roundTo(v, 2)
}

function promotionAtStage(
  stage: number,
  ascArr: Array<Record<string, unknown>>,
  growProp?: string,
  growKey?: string
): { hp: number; atk: number; def: number; grow: number } {
  // stage: 0 => no promotion bonus
  // stage: 1..6 => ascArr[stage-1] (20+/40+/.../80+)
  // stage: 7 => hypothetical 90+ (base stats extrapolated, grow stays at max)
  if (stage <= 0) return { hp: 0, atk: 0, def: 0, grow: 0 }

  const s6 = ascArr[5] || {}
  const s5 = ascArr[4] || {}

  const pick = (s: Record<string, unknown>) => ({
    hp: toNum(s.FIGHT_PROP_BASE_HP),
    atk: toNum(s.FIGHT_PROP_BASE_ATTACK),
    def: toNum(s.FIGHT_PROP_BASE_DEFENSE),
    growRaw: growProp ? toNum(s[growProp]) : 0
  })

  if (stage >= 7) {
    const a6 = pick(s6)
    const a5 = pick(s5)
    return {
      hp: a6.hp + (a6.hp - a5.hp),
      atk: a6.atk + (a6.atk - a5.atk),
      def: a6.def + (a6.def - a5.def),
      // No more ascension growth beyond stage 6; keep max value.
      grow: scaleGrowValue(growKey, a6.growRaw)
    }
  }

  const asc = ascArr[stage - 1] || {}
  const a = pick(asc)
  return {
    hp: a.hp,
    atk: a.atk,
    def: a.def,
    grow: scaleGrowValue(growKey, a.growRaw)
  }
}

export function buildGiAttrTable(opts: BuildGiAttrTableOptions): GiAttrTable {
  // Baseline meta generation rounds base stats to 3 decimals before applying multipliers.
  // This avoids edge-case 0.01 differences caused by float precision when rounding to 2 decimals later.
  const baseHP = roundTo(opts.baseHP, 3)
  const baseATK = roundTo(opts.baseATK, 3)
  const baseDEF = roundTo(opts.baseDEF, 3)

  const keys = ['hpBase', 'atkBase', 'defBase']
  if (opts.growKey) keys.push(opts.growKey)

  // Milestone keys follow the baseline meta convention.
  const milestones: Array<{ key: string; lv: string; stage: number }> = [
    { key: '1', lv: '1', stage: 0 },
    { key: '20', lv: '20', stage: 0 },
    { key: '20+', lv: '20', stage: 1 },
    { key: '40', lv: '40', stage: 1 },
    { key: '40+', lv: '40', stage: 2 },
    { key: '50', lv: '50', stage: 2 },
    { key: '50+', lv: '50', stage: 3 },
    { key: '60', lv: '60', stage: 3 },
    { key: '60+', lv: '60', stage: 4 },
    { key: '70', lv: '70', stage: 4 },
    { key: '70+', lv: '70', stage: 5 },
    { key: '80', lv: '80', stage: 5 },
    { key: '80+', lv: '80', stage: 6 },
    { key: '90', lv: '90', stage: 6 },
    { key: '90+', lv: '90', stage: 7 },
    { key: '100', lv: '100', stage: 6 }
  ]

  const details: Record<string, number[]> = {}

  for (const m of milestones) {
    const mulHp = getMul(opts.hpMul, m.lv)
    const mulAtk = getMul(opts.atkMul, m.lv)
    const mulDef = getMul(opts.defMul, m.lv)

    const promo = promotionAtStage(m.stage, opts.ascArr, opts.growProp, opts.growKey)

    const hp = roundTo(baseHP * mulHp + promo.hp, 2)
    const atk = roundTo(baseATK * mulAtk + promo.atk, 2)
    const def = roundTo(baseDEF * mulDef + promo.def, 2)

    const row = [hp, atk, def]
    if (opts.growKey) row.push(promo.grow)
    details[m.key] = row
  }

  return { keys, details }
}
