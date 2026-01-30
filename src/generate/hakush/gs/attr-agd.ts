/**
 * GS character attr table generator from AnimeGameData (Avatar* excel tables).
 *
 * This is used to match baseline meta attr rounding/precision, since Hakush `StatsModifier`
 * curve multipliers are sometimes rounded and can cause 0.01 drift at milestone levels.
 */

import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'
import type { GiAttrTable } from './attr.js'
import { buildGiAttrTable } from './attr.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

type AgdCurveMap = Map<number, Map<string, number>>

function buildCurveMap(curveRaw: unknown): AgdCurveMap {
  const out: AgdCurveMap = new Map()
  if (!Array.isArray(curveRaw)) return out
  for (const row of curveRaw) {
    if (!isRecord(row)) continue
    const level = toNumber(row.level)
    if (level == null) continue
    const infos = Array.isArray(row.curveInfos) ? (row.curveInfos as unknown[]) : []
    const m = new Map<string, number>()
    for (const it of infos) {
      if (!isRecord(it)) continue
      const t = typeof it.type === 'string' ? (it.type as string) : ''
      const v = toNumber(it.value)
      if (!t || v == null) continue
      m.set(t, v)
    }
    out.set(level, m)
  }
  return out
}

function curveValue(curves: AgdCurveMap, level: number, type: string): number | undefined {
  return curves.get(level)?.get(type)
}

const growKeyMap: Record<string, string | undefined> = {
  FIGHT_PROP_HP_PERCENT: 'hpPct',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPct',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPct',
  FIGHT_PROP_ELEMENT_MASTERY: 'mastery',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'recharge',
  FIGHT_PROP_CRITICAL: 'cpct',
  FIGHT_PROP_CRITICAL_HURT: 'cdmg',
  FIGHT_PROP_HEAL_ADD: 'heal',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'phy',
  // Elemental DMG bonus (the element is inferred from character elem; meta uses key=dmg).
  FIGHT_PROP_FIRE_ADD_HURT: 'dmg',
  FIGHT_PROP_WATER_ADD_HURT: 'dmg',
  FIGHT_PROP_ICE_ADD_HURT: 'dmg',
  FIGHT_PROP_ELEC_ADD_HURT: 'dmg',
  FIGHT_PROP_WIND_ADD_HURT: 'dmg',
  FIGHT_PROP_ROCK_ADD_HURT: 'dmg',
  FIGHT_PROP_GRASS_ADD_HURT: 'dmg'
}

export interface AgdAvatarAttrContext {
  avatarById: Map<
    number,
    {
      id: number
      baseHP: number
      baseATK: number
      baseDEF: number
      promoteId: number
      curveHP: string
      curveATK: string
      curveDEF: string
    }
  >
  curves: AgdCurveMap
  promotePropsByIdAndLevel: Map<number, Map<number, Record<string, number>>>
}

export async function tryCreateAgdAvatarAttrContext(opts: {
  animeGameData: AnimeGameDataClient
  log?: Pick<Console, 'info' | 'warn'>
}): Promise<AgdAvatarAttrContext | null> {
  try {
    const [avatarRaw, curveRaw, promoteRaw] = await Promise.all([
      opts.animeGameData.getGsAvatarExcelConfigData(),
      opts.animeGameData.getGsAvatarCurveExcelConfigData(),
      opts.animeGameData.getGsAvatarPromoteExcelConfigData()
    ])

    const curves = buildCurveMap(curveRaw)

    const promotePropsByIdAndLevel = new Map<number, Map<number, Record<string, number>>>()
    if (Array.isArray(promoteRaw)) {
      for (const row of promoteRaw) {
        if (!isRecord(row)) continue
        const promoteId = toNumber((row as Record<string, unknown>).avatarPromoteId)
        const promoteLevel = toNumber((row as Record<string, unknown>).promoteLevel)
        if (promoteId == null || promoteLevel == null) continue
        const addProps = Array.isArray((row as Record<string, unknown>).addProps)
          ? (((row as Record<string, unknown>).addProps as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
          : []
        const byType: Record<string, number> = {}
        for (const p of addProps) {
          const t = typeof p.propType === 'string' ? (p.propType as string) : ''
          const v = toNumber(p.value)
          if (!t || v == null) continue
          byType[t] = v
        }
        if (!promotePropsByIdAndLevel.has(promoteId)) promotePropsByIdAndLevel.set(promoteId, new Map())
        promotePropsByIdAndLevel.get(promoteId)!.set(promoteLevel, byType)
      }
    }

    const avatarById = new Map<
      number,
      { id: number; baseHP: number; baseATK: number; baseDEF: number; promoteId: number; curveHP: string; curveATK: string; curveDEF: string }
    >()
    if (Array.isArray(avatarRaw)) {
      for (const row of avatarRaw) {
        if (!isRecord(row)) continue
        const id = toNumber(row.id)
        const baseHP = toNumber((row as Record<string, unknown>).hpBase)
        const baseATK = toNumber((row as Record<string, unknown>).attackBase)
        const baseDEF = toNumber((row as Record<string, unknown>).defenseBase)
        const promoteId = toNumber((row as Record<string, unknown>).avatarPromoteId)
        if (id == null || baseHP == null || baseATK == null || baseDEF == null || promoteId == null) continue

        const curvesRaw = Array.isArray((row as Record<string, unknown>).propGrowCurves)
          ? (((row as Record<string, unknown>).propGrowCurves as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
          : []
        const pickCurve = (propType: string): string => {
          for (const c of curvesRaw) {
            if (c.type !== propType) continue
            const growCurve = (c as Record<string, unknown>).growCurve
            if (typeof growCurve === 'string' && growCurve) return growCurve
          }
          return ''
        }

        const curveHP = pickCurve('FIGHT_PROP_BASE_HP')
        const curveATK = pickCurve('FIGHT_PROP_BASE_ATTACK')
        const curveDEF = pickCurve('FIGHT_PROP_BASE_DEFENSE')
        if (!curveHP || !curveATK || !curveDEF) continue

        avatarById.set(id, { id, baseHP, baseATK, baseDEF, promoteId, curveHP, curveATK, curveDEF })
      }
    }

    opts.log?.info?.(
      `[meta-gen] (gs) character attr: loaded AnimeGameData avatar tables (avatars=${avatarById.size} promotes=${promotePropsByIdAndLevel.size} curves=${curves.size})`
    )

    return { avatarById, curves, promotePropsByIdAndLevel }
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) character attr: AnimeGameData unavailable, fallback to Hakush StatsModifier: ${String(e)}`)
    return null
  }
}

export function buildGiAttrTableFromAgd(
  ctx: AgdAvatarAttrContext,
  avatarId: number
): { attr: GiAttrTable; baseAttr: { hp: number; atk: number; def: number }; growAttr: { key: string; value: number } } | null {
  const avatar = ctx.avatarById.get(avatarId)
  if (!avatar) return null

  const promoteByLevel = ctx.promotePropsByIdAndLevel.get(avatar.promoteId)
  if (!promoteByLevel) return null

  const baseProps = new Set(['FIGHT_PROP_BASE_HP', 'FIGHT_PROP_BASE_ATTACK', 'FIGHT_PROP_BASE_DEFENSE'])
  const maxProps = promoteByLevel.get(6) || {}
  const growPick = Object.entries(maxProps)
    .filter(([k]) => !baseProps.has(k))
    .map(([k, v]) => ({ prop: k, value: typeof v === 'number' ? v : Number(v) }))
    .filter((x) => Number.isFinite(x.value) && x.value !== 0)
    .reduce<{ prop: string; value: number } | null>(
      (best, cur) => (best && Math.abs(best.value) >= Math.abs(cur.value) ? best : cur),
      null
    )

  const growProp = growPick?.prop
  const growKey = growProp ? growKeyMap[growProp] : undefined

  const levels = [1, 20, 40, 50, 60, 70, 80, 90, 100]
  const mulMap = (curveType: string): Record<string, unknown> => {
    const out: Record<string, unknown> = {}
    for (const lv of levels) {
      const v = curveValue(ctx.curves, lv, curveType)
      if (typeof v === 'number') out[String(lv)] = v
    }
    return out
  }

  const hpMul = mulMap(avatar.curveHP)
  const atkMul = mulMap(avatar.curveATK)
  const defMul = mulMap(avatar.curveDEF)

  // Promotion bonus objects used by `buildGiAttrTable` (20+/40+/.../80+).
  const ascArr: Array<Record<string, unknown>> = []
  for (let promoteLevel = 1; promoteLevel <= 6; promoteLevel++) {
    const props = promoteByLevel.get(promoteLevel) || {}
    const rec: Record<string, unknown> = {
      FIGHT_PROP_BASE_HP: props.FIGHT_PROP_BASE_HP ?? 0,
      FIGHT_PROP_BASE_ATTACK: props.FIGHT_PROP_BASE_ATTACK ?? 0,
      FIGHT_PROP_BASE_DEFENSE: props.FIGHT_PROP_BASE_DEFENSE ?? 0
    }
    if (growProp) {
      rec[growProp] = props[growProp] ?? 0
    }
    ascArr.push(rec)
  }

  const attr = buildGiAttrTable({
    baseHP: avatar.baseHP,
    baseATK: avatar.baseATK,
    baseDEF: avatar.baseDEF,
    hpMul,
    atkMul,
    defMul,
    ascArr,
    growKey,
    growProp
  })

  const row100 = attr.details['100'] || []
  const baseAttr = { hp: row100[0] ?? 0, atk: row100[1] ?? 0, def: row100[2] ?? 0 }
  const growAttr = growKey ? { key: growKey, value: row100[3] ?? 0 } : { key: '', value: 0 }

  return { attr, baseAttr, growAttr }
}
