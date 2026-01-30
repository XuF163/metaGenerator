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

function roundToFixed(value: number, decimals: number): number {
  // Match baseline half-case behavior (`toFixed` is used in baseline generators for curve tables).
  return Number(value.toFixed(decimals))
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
  // Keep full base stat precision; baseline milestone rounding happens at the final 2-decimal step.
  const baseHP = opts.baseHP
  const baseATK = opts.baseATK
  const baseDEF = opts.baseDEF

  const keys = ['hpBase', 'atkBase', 'defBase']
  if (opts.growKey) keys.push(opts.growKey)

  const details: Record<string, number[]> = {}

  const buildBaseRow = (lv: string, stage: number): number[] => {
    const mulHp = getMul(opts.hpMul, lv)
    const mulAtk = getMul(opts.atkMul, lv)
    const mulDef = getMul(opts.defMul, lv)

    const promo = promotionAtStage(stage, opts.ascArr, opts.growProp, opts.growKey)

    const hpScaled = baseHP * mulHp
    const atkScaled = baseATK * mulAtk
    const defScaled = baseDEF * mulDef

    // Baseline rounds base milestones to 2 decimals.
    const hp = roundToFixed(hpScaled + promo.hp, 2)
    const atk = roundToFixed(atkScaled + promo.atk, 2)
    const def = roundToFixed(defScaled + promo.def, 2)

    const row = [hp, atk, def]
    if (opts.growKey) row.push(promo.grow)
    return row
  }

  // Non-plus milestones: compute directly from base scaling + cumulative promote bonus.
  // (These match baseline exactly and serve as the rounding base for `xx+` milestones.)
  const nonPlusMilestones: Array<{ key: string; lv: string; stage: number }> = [
    { key: '1', lv: '1', stage: 0 },
    { key: '20', lv: '20', stage: 0 },
    { key: '40', lv: '40', stage: 1 },
    { key: '50', lv: '50', stage: 2 },
    { key: '60', lv: '60', stage: 3 },
    { key: '70', lv: '70', stage: 4 },
    { key: '80', lv: '80', stage: 5 },
    { key: '90', lv: '90', stage: 6 },
    { key: '100', lv: '100', stage: 6 }
  ]
  for (const m of nonPlusMilestones) {
    details[m.key] = buildBaseRow(m.lv, m.stage)
  }

  // Plus milestones: baseline applies promote bonus *incrementally* on top of the already-rounded
  // non-plus milestone (e.g. `40+ = round2(40 + (promote2 - promote1))`), which can shift 0.01 at half-cases.
  const plusMilestones: Array<{ key: string; baseKey: string; lv: string; fromStage: number; toStage: number }> = [
    { key: '20+', baseKey: '20', lv: '20', fromStage: 0, toStage: 1 },
    { key: '40+', baseKey: '40', lv: '40', fromStage: 1, toStage: 2 },
    { key: '50+', baseKey: '50', lv: '50', fromStage: 2, toStage: 3 },
    { key: '60+', baseKey: '60', lv: '60', fromStage: 3, toStage: 4 },
    { key: '70+', baseKey: '70', lv: '70', fromStage: 4, toStage: 5 },
    { key: '80+', baseKey: '80', lv: '80', fromStage: 5, toStage: 6 },
    { key: '90+', baseKey: '90', lv: '90', fromStage: 6, toStage: 7 }
  ]
  for (const m of plusMilestones) {
    const baseRow = details[m.baseKey] || [0, 0, 0]

    const promoFrom = promotionAtStage(m.fromStage, opts.ascArr, opts.growProp, opts.growKey)
    const promoTo = promotionAtStage(m.toStage, opts.ascArr, opts.growProp, opts.growKey)

    const hp = roundToFixed((baseRow[0] ?? 0) + (promoTo.hp - promoFrom.hp), 2)
    const atk = roundToFixed((baseRow[1] ?? 0) + (promoTo.atk - promoFrom.atk), 2)
    const def = roundToFixed((baseRow[2] ?? 0) + (promoTo.def - promoFrom.def), 2)

    const row = [hp, atk, def]
    if (opts.growKey) row.push(promoTo.grow)
    details[m.key] = row
  }

  return { keys, details }
}
