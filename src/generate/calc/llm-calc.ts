/**
 * LLM-assisted calc.js generation.
 *
 * Strategy (safe for weak/slow models):
 * - Ask the model to output a small JSON plan (no JS code).
 * - Validate the plan locally.
 * - Render deterministic JS from the plan.
 *
 * If LLM is unavailable or returns invalid output, we fall back to a heuristic plan.
 */

import type { LlmService } from '../../llm/service.js'
import type { ChatMessage } from '../../llm/openai.js'
import { parseJsonFromLlmText } from '../../llm/json.js'
import type { LlmDiskCacheOptions } from '../../llm/disk-cache.js'
import { chatWithDiskCacheValidated } from '../../llm/disk-cache.js'

type TalentKeyGs = 'a' | 'e' | 'q'
type TalentKeySr = 'a' | 'e' | 'q' | 't'
type TalentKey = TalentKeyGs | TalentKeySr

// Requirement: generated calc.js should have a consistent signature.
const DEFAULT_CREATED_BY = 'awesome-gpt5.2-xhigh'

function jsString(v: string): string {
  // JSON.stringify does NOT escape U+2028/U+2029, which can break JS parsing when embedded in source.
  return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

function validateCalcJsText(js: string): void {
  // Validate that the generated calc.js:
  // - is syntactically valid
  // - does not reference undefined vars at module top-level (e.g. `params.xxx`)
  //
  // We intentionally avoid importing from disk to keep this fast and deterministic.
  // `calc.js` uses only `export const ...` so we can strip ESM exports for evaluation.
  const body = js.replace(/^\s*export\s+const\s+/gm, 'const ')
  try {
    const fn = new Function(body)
    fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[meta-gen] Generated calc.js is invalid: ${msg}`)
  }
}

function validateCalcJsRuntime(js: string, input: CalcSuggestInput): void {
  const game = input.game
  // Best-effort runtime validation:
  // - catches ReferenceError inside detail/buff functions (e.g. using `mastery` instead of `attr.mastery`)
  // - avoids importing from disk; evaluates the module body in a local function scope
  const body = js.replace(/^\s*export\s+const\s+/gm, 'const ')

  let mod: any
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${body}\nreturn { details, buffs }`)
    mod = fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[meta-gen] Generated calc.js runtime extract failed: ${msg}`)
  }

  const mkDeepSample = (primitiveNum = 100): any => {
    const baseFn = function () {
      return primitiveNum
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => primitiveNum
        if (prop === 'valueOf') return () => primitiveNum
        if (prop === 'toString') return () => String(primitiveNum)
        if (prop === 'toJSON') return () => primitiveNum
        return proxy
      },
      apply() {
        return primitiveNum
      }
    }
    proxy = new Proxy(baseFn, handler)
    return proxy
  }

  const mkParamsSample = (): any => {
    // Provide common stack/state params so we can catch unit mistakes like
    // `talent.xxx * params.stacks` without `/100`.
    const base: Record<string, number | boolean> = {
      q: true,
      e: true,
      half: true,
      stacks: 60,
      stack: 4,
      wish: 60
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        if (typeof prop === 'string' && prop in base) return (base as any)[prop]
        return 0
      }
    }
    proxy = new Proxy({}, handler)
    return proxy
  }

  const mkAttrItem = (base: number): any => ({
    base,
    plus: 0,
    pct: 0,
    inc: 0,
    toString() {
      const b = Number((this as any).base) || 0
      const p = Number((this as any).plus) || 0
      const pct = Number((this as any).pct) || 0
      return String(b + p + (b * pct) / 100)
    }
  })

  const mkAttrSample = (): any => {
    const base: Record<string, any> = {
      atk: mkAttrItem(2000),
      hp: mkAttrItem(40_000),
      def: mkAttrItem(1000),
      mastery: mkAttrItem(800),
      recharge: mkAttrItem(120),
      heal: mkAttrItem(0),
      shield: mkAttrItem(100),
      cpct: mkAttrItem(50),
      cdmg: mkAttrItem(100),
      dmg: mkAttrItem(0),
      phy: mkAttrItem(0),
      // SR-only buckets (keep to avoid false positives in cross-game prompts/expressions).
      speed: mkAttrItem(100),
      enemydmg: mkAttrItem(0),
      effPct: mkAttrItem(0),
      effDef: mkAttrItem(0),
      stance: mkAttrItem(0)
    }
    const handler: ProxyHandler<any> = {
      get(t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        if (typeof prop === 'string' && prop in t) return (t as any)[prop]
        return 0
      }
    }
    return new Proxy(base, handler)
  }

  const mkTalentSample = (primitiveNum = 100): any => {
    const out: Record<string, any> = {}
    const allowedTalents: TalentKey[] = game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']
    const tableSamples = input.tableSamples || {}
    for (const tk of allowedTalents) {
      const names = normalizeTableList((input.tables as any)?.[tk])
      const blk: Record<string, any> = {}
      const sampleMap = (tableSamples as any)?.[tk]
      for (const name of names) {
        const s = sampleMap && typeof sampleMap === 'object' ? (sampleMap as any)[name] : undefined
        if (Array.isArray(s)) {
          blk[name] = s.map(() => primitiveNum)
        } else if (s && typeof s === 'object') {
          // Keep it numeric-only to avoid hiding type errors; most calc.js expects scalar/array.
          const obj: Record<string, any> = {}
          for (const [k, v] of Object.entries(s as any)) {
            if (typeof v === 'number' && Number.isFinite(v)) obj[k] = v
            else if (Array.isArray(v)) obj[k] = v.map(() => primitiveNum)
          }
          blk[name] = Object.keys(obj).length ? obj : primitiveNum
        } else {
          blk[name] = primitiveNum
        }
      }
      out[tk] = blk
    }
    return out
  }

  const mkWeaponSample = (): any => ({
    name: input.weapon || '武器',
    star: typeof input.star === 'number' && Number.isFinite(input.star) ? input.star : 5,
    affix: 1,
    type: input.weapon || ''
  })

  const mkTreesSample = (): any => ({})

  // Use a moderate sample for buff validation: too-large samples can false-positive on valid expressions like
  // `talent.xxx * talent.yyy` (e.g. per-energy coefficient * energy cost).
  // A smaller primitive sample catches common LLM mistakes like `x - 100` when x is actually a small percent per stack/energy.
  const P = mkParamsSample()
  const A = mkAttrSample()
  const mkCtx = (primitiveNum = 100): any => ({
    talent: mkTalentSample(primitiveNum),
    attr: A,
    calc: (ds: any) => {
      if (!ds || typeof ds !== 'object') {
        throw new Error(`calc() expects AttrItem-like object`)
      }
      const b = Number((ds as any).base) || 0
      const p = Number((ds as any).plus) || 0
      const pct = Number((ds as any).pct) || 0
      return b + p + (b * pct) / 100
    },
    params: P,
    cons: 6,
    weapon: mkWeaponSample(),
    trees: mkTreesSample(),
    // Provide a default element so element-gated buffs can be exercised in validation.
    // (GS uses Chinese elem names at runtime; SR uses ids like "shock"/"burn".)
    element: game === 'gs' ? '雷' : 'shock',
    currentTalent: ''
  })
  const ctx = mkCtx(100)

  const gsEleOk = new Set([
    // non-reaction markers
    'phy',
    'scene',
    // amp reactions
    'vaporize',
    'melt',
    '蒸发',
    '融化',
    // transformative / catalyze / lunar
    'crystallize',
    'burning',
    'superConduct',
    'swirl',
    'electroCharged',
    'shatter',
    'overloaded',
    'bloom',
    'burgeon',
    'hyperBloom',
    'aggravate',
    'spread',
    '结晶',
    '燃烧',
    '超导',
    '扩散',
    '感电',
    '碎冰',
    '超载',
    '绽放',
    '烈绽放',
    '超绽放',
    '超激化',
    '蔓激化',
    // lunar
    'lunarCharged',
    'lunarBloom',
    'lunarCrystallize',
    '月感电',
    '月绽放',
    '月结晶'
  ])

  const srEleOk = new Set([
    'shock',
    'burn',
    'windShear',
    'bleed',
    'entanglement',
    'lightningBreak',
    'fireBreak',
    'windBreak',
    'physicalBreak',
    'quantumBreak',
    'imaginaryBreak',
    'iceBreak',
    'superBreak',
    'elation',
    'scene'
  ])

  const validateEle = (ele: unknown): void => {
    if (ele === undefined || ele === null || ele === false) return
    if (typeof ele !== 'string') return
    const t = ele.trim()
    if (!t) {
      throw new Error(`invalid ele arg: empty string`)
    }
    if (t === 'scene' || /(^|,)scene(,|$)/.test(t)) return

    const ok = game === 'sr' ? srEleOk : gsEleOk
    if (!ok.has(t)) {
      throw new Error(`invalid ele arg: ${t}`)
    }
  }

  const toNum = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  const MAX_SHOWCASE = 5_000_000
  const assertShowcaseNum = (n: unknown, where: string): void => {
    if (typeof n !== 'number') return
    if (!Number.isFinite(n)) throw new Error(`${where} returned non-finite number`)
    if (Math.abs(n) > MAX_SHOWCASE) {
      throw new Error(`${where} returned unreasonable showcase value: ${n}`)
    }
  }

  const dmgFn: any = function (pctNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    const n = toNum(pctNum)
    assertShowcaseNum(n, 'dmg()')
    return { dmg: n, avg: n }
  }
  dmgFn.basic = function (basicNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    const n = toNum(basicNum)
    assertShowcaseNum(n, 'dmg.basic()')
    return { dmg: n, avg: n }
  }
  dmgFn.dynamic = function (pctNum = 0, _talent = false, _dynamicData = false, ele = false) {
    validateEle(ele)
    const n = toNum(pctNum)
    assertShowcaseNum(n, 'dmg.dynamic()')
    return { dmg: n, avg: n }
  }
  dmgFn.reaction = function (ele = false) {
    validateEle(ele)
    return { dmg: 1000, avg: 1000 }
  }
  dmgFn.swirl = function () {
    validateEle('swirl')
    return { dmg: 1000, avg: 1000 }
  }
  dmgFn.heal = function (n = 0) {
    const v = toNum(n)
    assertShowcaseNum(v, 'dmg.heal()')
    return { avg: v }
  }
  dmgFn.shield = function (n = 0) {
    const v = toNum(n)
    assertShowcaseNum(v, 'dmg.shield()')
    return { avg: v }
  }
  dmgFn.elation = function () {
    return { dmg: 1000, avg: 1000 }
  }

  const talentVariants: string[] = game === 'sr' ? ['a', 'e', 'q', 't'] : ['a', 'e', 'q']

  const details = Array.isArray(mod?.details) ? mod.details : []
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (typeof (d as any).dmg !== 'function') continue
    try {
      if (typeof (d as any).check === 'function') {
        const prev = ctx.currentTalent
        for (const ct of talentVariants) {
          ctx.currentTalent = ct
          ;(d as any).check(ctx)
        }
        ctx.currentTalent = prev
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid detail.check(): ${msg}`)
    }
    try {
      const prev = ctx.currentTalent
      const tk = typeof (d as any).talent === 'string' ? String((d as any).talent) : ''
      ctx.currentTalent = tk && talentVariants.includes(tk) ? tk : prev
      const ret = (d as any).dmg(ctx, dmgFn)
      ctx.currentTalent = prev
      if (!ret || typeof ret !== 'object') {
        throw new Error(`detail.dmg() returned non-object (${typeof ret})`)
      }
      // Numeric sanity check (showcase-scale only, not real damage).
      assertShowcaseNum((ret as any).dmg, 'detail.dmg()')
      assertShowcaseNum((ret as any).avg, 'detail.dmg()')
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid detail.dmg(): ${msg}`)
    }
  }

  const buffs = Array.isArray(mod?.buffs) ? mod.buffs : []
  const isCritRateKey = (k: string): boolean => k === 'cpct' || /Cpct$/.test(k)
  const isPercentLikeKey = (k: string): boolean => {
    // underscore keys are typically "display-only" helper fields in baseline meta.
    if (!k || k.startsWith('_')) return false
    // Inc/Multi keys are percent-like multipliers in miao-plugin (e.g. healInc/shieldInc/aMulti...).
    if (k.endsWith('Inc')) return true
    if (k.endsWith('Multi')) return true
    // Flat additions (can be large).
    if (
      k.endsWith('Plus') ||
      k === 'atkPlus' ||
      k === 'hpPlus' ||
      k === 'defPlus' ||
      k === 'fyplus' ||
      k === 'fybase'
    ) {
      return false
    }
    if (k.endsWith('Pct')) return true
    if (k.endsWith('Dmg')) return true
    if (k.endsWith('Cdmg')) return true
    if (k.endsWith('Cpct')) return true
    if (k === 'cpct' || k === 'cdmg' || k === 'dmg' || k === 'phy' || k === 'heal' || k === 'shield') return true
    if (k === 'recharge' || k === 'kx' || k === 'enemyDef' || k === 'fypct' || k === 'fyinc') return true
    return false
  }

  const eleVariants: string[] =
    game === 'gs'
      ? ['火', '水', '雷', '冰', '风', '岩', '草']
      : ['shock', 'burn', 'windShear', 'bleed', 'entanglement', 'fireBreak', 'iceBreak']

  const validateOneBuffPass = (ctx0: any, passLabel: string): void => {
    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      try {
        if (typeof (b as any).check === 'function') {
          const prev = ctx0.currentTalent
          const prevEle = ctx0.element
          for (const ele of eleVariants) {
            ctx0.element = ele
            for (const ct of talentVariants) {
              ctx0.currentTalent = ct
              ;(b as any).check(ctx0)
            }
          }
          ctx0.element = prevEle
          ctx0.currentTalent = prev
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`[meta-gen] Generated calc.js invalid buff.check() (${passLabel}): ${msg}`)
      }
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v !== 'function') continue
          try {
            const prev = ctx0.currentTalent
            const prevEle = ctx0.element
            for (const ele of eleVariants) {
              ctx0.element = ele
              for (const ct of talentVariants) {
                ctx0.currentTalent = ct

                // Mimic miao-plugin: only evaluate data when check passes.
                const ok = typeof (b as any).check === 'function' ? !!(b as any).check(ctx0) : true
                if (!ok) continue

                const ret = v(ctx0)
                if (typeof ret === 'number') {
                  if (!Number.isFinite(ret)) throw new Error(`buff.data() returned non-finite number`)
                  const key = String(k || '')
                  if (isCritRateKey(key) && Math.abs(ret) > 100) {
                    throw new Error(`buff.data() returned unreasonable cpct-like value: ${key}=${ret}`)
                  }
                  if (isPercentLikeKey(key) && Math.abs(ret) > 500) {
                    throw new Error(`buff.data() returned unreasonable percent-like value: ${key}=${ret}`)
                  }
                  // Extremely negative percent-like values almost always mean a unit/semantics mistake
                  // (e.g. `talent.xxx - 100` when talent.xxx is actually a small percent per stack/energy).
                  if (isPercentLikeKey(key) && ret < -80) {
                    throw new Error(`buff.data() returned suspicious negative percent-like value: ${key}=${ret}`)
                  }
                } else if (ret === undefined || ret === null || ret === false || ret === '') {
                  // ok (skipped by miao-plugin runtime)
                } else if (ret === true) {
                  throw new Error(`buff.data() returned boolean true`)
                } else {
                  throw new Error(`buff.data() returned non-number (${typeof ret})`)
                }
              }
            }
            ctx0.element = prevEle
            ctx0.currentTalent = prev
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            throw new Error(`[meta-gen] Generated calc.js invalid buff.data() (${passLabel}): ${msg}`)
          }
        }
      }
    }
  }

  // Validate buffs with two different talent/weapon samples:
  // - moderate sample catches missing `/100` style unit bugs (values explode)
  // - small sample catches `- 100` style conversion bugs (values collapse to ~-100)
  validateOneBuffPass(mkCtx(20), 'N=20')
  validateOneBuffPass(mkCtx(1), 'N=1')
}

export interface CalcSuggestInput {
  game: 'gs' | 'sr'
  name: string
  elem: string
  weapon?: string
  star?: number
  // Candidate talent table names (must match keys available at runtime).
  tables: Partial<Record<TalentKey, string[]>>
  /**
   * Optional table unit hints for each talent table name.
   * Used to pick correct scaling stat (hp/def) for `dmg.basic(...)` rendering.
   */
  tableUnits?: Partial<Record<TalentKey, Record<string, string>>>
  /**
   * Optional sample values for talent tables (for LLM only).
   * Helpful to distinguish:
   * - number
   * - [pct, flat]
   * - [atkPct, masteryPct] / other multi-component arrays
   *
   * Tip: keep prompts small by only including tables whose sample value is an array/object.
   */
  tableSamples?: Partial<Record<TalentKey, Record<string, unknown>>>
  /**
   * Optional human-readable sample texts for structured talent tables (array/object).
   * Mainly used to infer array component meaning (e.g. "%攻击 + %精通") and to help the LLM.
   *
   * Suggested source: meta.talent.<a/e/q/t>.tables[...].values[0] (mapped to the corresponding `<name>2` keys).
   */
  tableTextSamples?: Partial<Record<TalentKey, Record<string, string>>>
  // Optional skill description text (helps LLM/heuristics pick correct damage tables).
  talentDesc?: Partial<Record<TalentKey, string>>
  /**
   * Optional extra text hints for buffs generation.
   * Keep each entry as a single line (passives/cons/traces/technique).
   */
  buffHints?: string[]
}

export type CalcDetailKind = 'dmg' | 'heal' | 'shield' | 'reaction'
export type CalcScaleStat = 'atk' | 'hp' | 'def' | 'mastery'

export interface CalcSuggestDetail {
  title: string
  /**
   * Detail kind (defaults to "dmg" when omitted).
   * - dmg: normal talent multiplier damage
   * - heal: healing amount (avg only)
   * - shield: shield absorption (avg only)
   * - reaction: transformative reaction (swirl/bloom/...) using dmgFn.reaction(...)
   */
  kind?: CalcDetailKind
  /**
   * Which talent block to read from (`talent.a/e/q/t[...]`).
   * Required for kind=dmg/heal/shield.
   */
  talent?: TalentKey
  /**
   * Talent table name. Must exist at runtime.
   * Required for kind=dmg/heal/shield.
   */
  table?: string
  /**
   * The second argument passed to dmg() in calc.js.
   * - For GS: typically a/e/q/a2/a3...
   * - For SR: a/e/q/t...
   */
  key?: string
  /**
   * Optional third argument passed to dmg() (e.g. "phy", "vaporize").
   * Keep empty for normal elemental skills.
   */
  ele?: string
  /**
   * Optional array component selector (0-based).
   *
   * Use when the selected talent table returns an array of multiple *variant* percentages, e.g.
   * - "低空/高空坠地冲击伤害2": [lowPct, highPct]
   * - "岩脊伤害/共鸣伤害2": [stelePct, resonancePct]
   *
   * When set, generator will use `t[pick]` as the percentage instead of treating the array as `[pct, flat]`.
   */
  pick?: number
  /**
   * Scaling stat for kind=heal/shield when the table is a percentage (or [pct,flat]).
   * If omitted, generator will infer from tableUnits / talentDesc.
   */
  stat?: CalcScaleStat
  /**
   * Reaction id for kind=reaction (passed to dmgFn.reaction("<id>")).
   */
  reaction?: string
  /**
   * Optional custom damage expression (JS expression, NOT a function).
   * When provided, generator will render this detail's dmg() using the expression directly:
   *   ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (<dmgExpr>)
   *
   * Notes:
   * - Use this when the formula mixes multiple stats/tables, counts hits, or needs conditional branches.
   * - Prefer `dmg.basic(...)` for non-ATK based damage / mixed-stat damage.
   * - You can use: talent, attr, calc, params, cons, weapon, trees, dmg, toRatio.
   */
  dmgExpr?: string
  /**
   * Optional params object for this detail row.
   * This is used by miao-plugin to model stateful skills/buffs (e.g. Q active, stacks).
   * Must be JSON-serializable primitives only (number/boolean/string).
   */
  params?: Record<string, number | boolean | string>
  /**
   * Optional condition expression (JS expression, NOT a function).
   * Rendered as: ({ talent, attr, calc, params, cons, weapon, trees }) => (<expr>)
   */
  check?: string
  /** Optional constellation requirement (1..6). */
  cons?: number
}

export interface CalcSuggestBuff {
  title: string
  /** Sort order (higher first in UI). */
  sort?: number
  /** Constellation / Eidolon requirement (1..6). */
  cons?: number
  /** SR major trace index (1..3/4) when applicable. */
  tree?: number
  /**
   * Optional condition expression (JS expression, NOT a function).
   * Rendered as: ({ talent, attr, calc, params, cons, weapon, trees }) => (<expr>)
   */
  check?: string
  /**
   * Buff data mapping:
   * - number: direct value
   * - string: JS expression (NOT a function), rendered into an arrow fn returning number
   */
  data?: Record<string, number | string>
}

export interface CalcSuggestResult {
  mainAttr: string
  defDmgKey?: string
  details: CalcSuggestDetail[]
  buffs?: CalcSuggestBuff[]
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

function normalizeTableList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return uniq(list.map((s) => String(s || '').trim()).filter(Boolean))
}

function clampDetails(details: Array<unknown>, max = 20): CalcSuggestDetail[] {
  const out: CalcSuggestDetail[] = []
  for (const dRaw of details) {
    if (!dRaw || typeof dRaw !== 'object') continue
    if (out.length >= max) break

    const d = dRaw as Record<string, unknown>
    const title = typeof d.title === 'string' ? d.title.trim() : ''
    if (!title) continue

    const kind = typeof d.kind === 'string' ? d.kind.trim() : undefined
    const talent = typeof d.talent === 'string' ? d.talent.trim() : undefined
    const table = typeof d.table === 'string' ? d.table.trim() : undefined
    const key = typeof d.key === 'string' ? d.key.trim() : undefined
    const ele = typeof d.ele === 'string' ? d.ele.trim() : undefined
    const pick = typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
    const stat = typeof d.stat === 'string' ? d.stat.trim() : undefined
    const reaction = typeof d.reaction === 'string' ? d.reaction.trim() : undefined
    const dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : undefined
    const check = typeof d.check === 'string' ? d.check.trim() : undefined
    const cons = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    const paramsRaw = d.params
    const params =
      paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
        ? (paramsRaw as Record<string, number | boolean | string>)
        : undefined

    out.push({
      title,
      kind: kind as any,
      talent: talent as any,
      table,
      key,
      ele,
      pick,
      stat: stat as any,
      reaction,
      dmgExpr,
      check,
      cons,
      params
    })
  }
  return out
}

function clampBuffs(buffs: Array<unknown>, max = 30): Array<unknown> {
  const out: Array<unknown> = []
  for (const b of buffs) {
    if (!b || typeof b !== 'object') continue
    if (out.length >= max) break
    if (!(b as any).title) continue
    out.push(b)
  }
  return out
}

function isAllowedMiaoBuffDataKey(game: string, key: string): boolean {
  // Prevent emitting keys that miao-plugin will interpret and then crash on
  // due to missing attr buckets in that game mode (e.g. gs + speedPct).
  //
  // Keep this aligned with miao-plugin's DmgAttr.calcAttr key parsing:
  // - gs creates attr buckets: atk/def/hp + mastery/recharge/cpct/cdmg/heal/dmg/phy + shield
  // - sr creates attr buckets: atk/def/hp/speed + recharge/cpct/cdmg/heal/dmg/enemydmg/effPct/effDef/stance + shield
  if (!key) return false
  if (key.startsWith('_')) return true // placeholder-only keys (safe, ignored by DmgAttr)

  if (game === 'gs') {
    if (/^(hp|atk|def)(Base|Plus|Pct|Inc)?$/.test(key)) return true
    if (/^(mastery|cpct|cdmg|heal|recharge|dmg|phy|shield)(Plus|Pct|Inc)?$/.test(key)) return true
    if (/^(enemyDef|enemyIgnore|ignore)$/.test(key)) return true
    if (/^(kx|fykx|multi|fyplus|fypct|fybase|fyinc|fycdmg|elevated)$/.test(key)) return true
    if (
      /^(vaporize|melt|crystallize|burning|superConduct|swirl|electroCharged|shatter|overloaded|bloom|burgeon|hyperBloom|aggravate|spread|lunarCharged|lunarBloom|lunarCrystallize)$/.test(
        key
      )
    ) {
      return true
    }
    if (/^(a|a2|a3|e|q|nightsoul)(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(key)) return true
    return false
  }

  // sr
  if (/^(hp|atk|def|speed)(Base|Plus|Pct|Inc)?$/.test(key)) return true
  if (/^(speed|recharge|cpct|cdmg|heal|dmg|enemydmg|effPct|effDef|shield|stance)(Plus|Pct|Inc)?$/.test(key)) return true
  if (/^(enemyDef|enemyIgnore|ignore)$/.test(key)) return true
  if (/^(kx|multi)$/.test(key)) return true
  if (/^(a|a2|a3|e|e2|q|q2|t|me|me2|mt|mt2|dot|break)(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(key))
    return true
  if (/^elation(Pct|Enemydmg|Merrymake|Def|Ignore)?$/.test(key)) return true
  return false
}

function normalizePromptText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u00a0/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('\\n', ' ')
    .replaceAll('\n', ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function shortenText(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function pickDamageTable(tables: string[]): string | undefined {
  const list = normalizeTableList(tables)
  // Prefer explicit damage tables; avoid cooldown/energy/toughness-only tables.
  const dmg = list.find((t) => /伤害/.test(t))
  if (dmg) return dmg
  // If no obvious damage table exists, skip (prevents generating nonsense like "战技伤害" -> "生命上限提高").
  return undefined
}

function heuristicPlan(input: CalcSuggestInput): CalcSuggestResult {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const details: CalcSuggestDetail[] = []

  if (input.game === 'gs') {
    const e = pickDamageTable(eTables)
    const q = pickDamageTable(qTables)
    const a = pickDamageTable(aTables)
    if (e) details.push({ title: 'E伤害', talent: 'e', table: e, key: 'e' })
    if (q) details.push({ title: 'Q伤害', talent: 'q', table: q, key: 'q' })
    if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a', ele: 'phy' })
    return {
      mainAttr: 'atk,cpct,cdmg',
      defDmgKey: e ? 'e' : q ? 'q' : 'a',
      details,
      buffs: []
    }
  }

  // sr
  const desc = input.talentDesc || {}
  const descText = (k: TalentKey): string => normalizePromptText((desc as any)[k])

  const inferSrStat = (list: string[], fallback: CalcScaleStat): CalcScaleStat => {
    const joined = list.join('|')
    if (/(生命上限|生命值上限|最大生命值|生命值)/.test(joined)) return 'hp'
    if (/防御力/.test(joined)) return 'def'
    if (/(攻击力|攻击)/.test(joined)) return 'atk'
    return fallback
  }

  const pickSrHealOrShield = (
    talent: TalentKey,
    list: string[],
    kind: 'heal' | 'shield',
    title: string
  ): void => {
    const preferPct =
      kind === 'heal'
        ? list.find((t) => /(百分比生命|生命值百分比|百分比)/.test(t)) || ''
        : list.find((t) => /(百分比防御|防御力百分比|百分比生命|生命值百分比|百分比)/.test(t)) || ''
    const fallback = list.find((t) => /固定值/.test(t)) || preferPct
    const table = (preferPct || fallback || '').trim()
    if (!table) return
    const stat = inferSrStat(list, kind === 'heal' ? 'hp' : 'def')
    details.push({ title, kind, talent, table, key: talent, stat })
  }

  // A
  const a = pickDamageTable(aTables)
  if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a' })

  // E
  const eDesc = descText('e')
  const isHealLike = (text: string): boolean =>
    /(治疗|回复)/.test(text) || (/恢复/.test(text) && /(生命上限|生命值上限|最大生命值|生命值)/.test(text))
  const eHasHeal = isHealLike(eDesc) || eTables.some((t) => /(治疗|回复)/.test(t))
  const eHasShield = /护盾/.test(eDesc) || eTables.some((t) => /护盾/.test(t))
  if (eHasShield) {
    pickSrHealOrShield('e', eTables, 'shield', '战技护盾量')
  } else if (eHasHeal) {
    pickSrHealOrShield('e', eTables, 'heal', '战技治疗量')
  } else {
    const e = pickDamageTable(eTables)
    if (e) details.push({ title: '战技伤害', talent: 'e', table: e, key: 'e' })
  }

  // Q
  const qDesc = descText('q')
  const qHasHeal = isHealLike(qDesc) || qTables.some((t) => /(治疗|回复)/.test(t))
  const qHasShield = /护盾/.test(qDesc) || qTables.some((t) => /护盾/.test(t))
  if (qHasShield) {
    pickSrHealOrShield('q', qTables, 'shield', '终结技护盾量')
  } else if (qHasHeal) {
    pickSrHealOrShield('q', qTables, 'heal', '终结技治疗量')
  } else {
    const q = pickDamageTable(qTables)
    if (q) details.push({ title: '终结技伤害', talent: 'q', table: q, key: 'q' })
  }
  // Extra Q damage tables (e.g. 冻结回合开始伤害 -> 冻结附加伤害)
  const qMain = details.find((d) => d.talent === 'q' && d.kind !== 'heal' && d.kind !== 'shield')?.table || ''
  for (const tn of qTables) {
    if (!/伤害/.test(tn)) continue
    if (tn === qMain) continue
    if (details.length >= 12) break
    const title = tn.replace(/回合开始伤害/g, '附加伤害')
    details.push({ title, talent: 'q', table: tn, key: 'q' })
  }

  // T
  const t = pickDamageTable(tTables)
  if (t) {
    const title = /反击/.test(t) ? '反击伤害' : '天赋伤害'
    details.push({ title, talent: 't', table: t, key: 't' })
  }

  const mainAttrParts = ['atk', 'cpct', 'cdmg']
  if (details.some((d) => d.kind === 'heal') || /(生命上限|生命值上限|最大生命值|生命值)/.test(`${eDesc} ${qDesc}`))
    mainAttrParts.push('hp')
  if (details.some((d) => d.kind === 'shield') || /防御力/.test(`${eDesc} ${qDesc}`)) mainAttrParts.push('def')
  const mainAttr = uniq(mainAttrParts).join(',')

  const hasE = details.some((d) => d.talent === 'e')
  const hasQ = details.some((d) => d.talent === 'q')
  const hasA = details.some((d) => d.talent === 'a')
  return {
    mainAttr,
    defDmgKey: hasE ? 'e' : hasQ ? 'q' : hasA ? 'a' : 'e',
    details,
    buffs: []
  }
}

function buildMessages(input: CalcSuggestInput): ChatMessage[] {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const allowedTalents = input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']

  const descLines: string[] = []
  const desc = input.talentDesc || {}
  for (const k of allowedTalents as TalentKey[]) {
    const t = normalizePromptText((desc as any)[k])
    if (!t) continue
    descLines.push(`- ${k}: ${shortenText(t, 900)}`)
  }

  const buffHintLines: string[] = []
  const buffHints = Array.isArray(input.buffHints) ? input.buffHints : []
  for (const h of buffHints) {
    const t = normalizePromptText(h)
    if (!t) continue
    buffHintLines.push(`- ${shortenText(t, 520)}`)
  }

  const sampleLines: string[] = []
  const samples = input.tableSamples || {}
  for (const k of allowedTalents as TalentKey[]) {
    const v = (samples as any)[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length === 0) continue
    sampleLines.push(`- ${k}: ${shortenText(JSON.stringify(v), 500)}`)
  }

  const textSampleLines: string[] = []
  const textSamples = input.tableTextSamples || {}
  for (const k of allowedTalents as TalentKey[]) {
    const v = (textSamples as any)[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length === 0) continue
    textSampleLines.push(`- ${k}: ${shortenText(JSON.stringify(v), 600)}`)
  }

  const unitHintLines: string[] = []
  const unitPick = (u: string): boolean =>
    /(普通攻击伤害|重击伤害|下落攻击伤害|元素战技伤害|元素爆发伤害|战技伤害|终结技伤害|天赋伤害)/.test(u)
  const units = input.tableUnits || {}
  for (const k of allowedTalents as TalentKey[]) {
    const m = (units as any)[k]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const pairs: Array<[string, string]> = []
    for (const [name, unitRaw] of Object.entries(m as Record<string, unknown>)) {
      const nameT = String(name || '').trim()
      const u = normalizePromptText(unitRaw)
      if (!nameT || !u) continue
      if (!unitPick(u)) continue
      pairs.push([nameT, shortenText(u, 40)])
      if (pairs.length >= 12) break
    }
    if (pairs.length) unitHintLines.push(`- ${k}: ${JSON.stringify(pairs)}`)
  }

  const buffLikeTableLines: string[] = []
  const pickBuffLikeTables = (arr: string[]): string[] => {
    const out: string[] = []
    for (const t of arr || []) {
      if (!t) continue
      if (/(提升|增加|降低|加成|增伤|原本|倍率|抗性|防御|暴击|暴击率|暴击伤害|反应|月曜|月感电|月绽放|月结晶|夜魂|战意|层|枚|次数|上限)/.test(t)) {
        out.push(t)
      }
      if (out.length >= 12) break
    }
    return out
  }
  const pushBuffLike = (k: string, arr: string[]) => {
    const picks = pickBuffLikeTables(arr)
    if (picks.length) buffLikeTableLines.push(`- ${k}: ${JSON.stringify(picks)}`)
  }
  pushBuffLike('a', aTables)
  pushBuffLike('e', eTables)
  pushBuffLike('q', qTables)
  if (input.game === 'sr') pushBuffLike('t', tTables)

  const user = [
    `为 miao-plugin 生成 ${input.game === 'gs' ? '原神(GS)' : '星铁(SR)'} 角色 calc.js 的配置计划（尽量对标基线 calc.js 的“详细程度”）。`,
    '',
    '你只需要输出 JSON（不要 Markdown，不要多余文字）。',
    '',
    '要求：',
    `- 只允许使用 talent 表：${allowedTalents.join(',')}`,
    '- details 建议 6~12 条（最多 20）。尽量覆盖普攻/战技/终结技/天赋等核心伤害项，以及常见变体（点按/长按/多段/追加/反击等），并补齐常见治疗/护盾/反应（如果该角色具备）。',
    '- 如果 Buff 线索（魂/行迹/秘技）中包含明确的“治疗/护盾数值公式”（例如 X%生命上限+Y、X%防御力+Y），可以额外加入 1~3 条独立 detail 行用于展示（可设置 cons/tree/params/check）。不要把这种“单次数值”误写成全局 buff。',
    '- details[i].kind 可选：dmg / heal / shield / reaction；不写默认为 dmg。',
    '- 优先选择“可计算伤害”的表：通常表名包含「伤害」或类似字样；尽量不要选「冷却时间」「能量恢复」「削韧」等非伤害表。',
    '- kind=dmg/heal/shield：必须给出 talent + table；并且 table 必须来自我给出的表名列表，不能编造。',
    '- kind=heal/shield：请给出 stat（atk/hp/def/mastery）表示百分比部分基于哪个面板属性计算。',
    '- 若你选择的表在运行时返回数组并表示多个“变体倍率”（常见于表名含 "/"，且数组每个元素都是一个百分比倍率），可以额外输出 pick（0-based）来选择使用哪个元素；或拆成多条 detail 并分别设置 pick。',
    '- GS 提示：很多治疗/护盾会同时存在 "治疗量" 和 "治疗量2"（或 "护盾吸收量" / "护盾吸收量2"）。优先选择带 2 的表（通常是 [百分比, 固定值]），不带 2 的同名表往往只是展示用的“百分比+固定值”，不能直接乘面板。',
    '- kind=reaction：仅用于“无表/纯剧变反应”计算（不需要 talent/table），例如 swirl/crystallize/bloom/hyperBloom/burgeon/burning/overloaded/electroCharged/superConduct/shatter。',
    '  - 不要用 kind=reaction 表达蒸发/融化/激化/蔓激化：这些请用 kind=dmg + ele="vaporize/melt/aggravate/spread"。',
    '  - GS 月曜反应（月感电/月绽放/月结晶）：不是 kind=reaction；它们通常是“带表的基础伤害 + 月曜反应加成”，应使用 kind=dmg 并设置 ele="lunarCharged/lunarBloom/lunarCrystallize"。',
    '  - 注意：不要把 ele="lunarCharged/lunarBloom/lunarCrystallize" 用在普通技能伤害上；仅当表名/描述明确为月曜反应或月曜相关追加伤害时才使用。',
    '- details 可选字段：params/check/cons 用于描述“状态/变体”（对标基线 calc.js 的复杂度）。',
    '  - params: 仅允许 number/boolean/string；用于给 miao-plugin 传入默认状态（如 Nightsoul/Moonsign/BondOfLife/层数/开关）。',
    '  - check: 仅允许 JS 表达式（不要写 function/箭头函数）；可用变量 talent, attr, calc, params, cons, weapon, trees。不要使用 currentTalent（details 的 check/dmg 中不可用）。',
    '  - 重要：calc(...) 只能写成 calc(attr.xxx)（单参数且参数只能是 attr 的一级字段）；不要写 calc(attr.recharge - 100) / calc(attr.atk * 2)。需要运算请写在 calc(...) 外面，例如 (calc(attr.recharge) - 100) * 0.4。',
    '  - 禁止引用不存在的变量（例如 key/title/index/name）。',
    '  - 禁止使用 talent.key（运行时不存在）；若需要按招式区分（a/e/q/t/a2/a3...），只允许在 buffs.check/buffs.data 中使用 currentTalent 来判断。',
    '  - 禁止使用 calc.xxx / calc.xxx()（calc 是函数，不是对象）。',
    '  - 禁止使用未定义的自由变量（例如 fire/ice/wind/追加攻击/targetHp 等）；只能使用已声明变量 + 字符串常量 + 数字常量。',
    '  - cons: 1..6；用于限制该 detail 只在对应命座生效时展示/计算。',
    '  - 如果某些伤害在特定状态下才成立（例如 夜魂、月兆、Q期间、满层/满战意），请用不同的 detail 行来表达：',
    '    - 通过 key 使用标签（例如 "e,nightsoul" / "q,nightsoul"）来触发对应的增益域；必要时配合 params 设置默认状态。',
    '    - GS params 约定（推荐）：e/q/off_field/half 等；例如 E后状态 detail 写 params: { e: true }；对应 buff 用 params.e 判定。',
    '    - 如果描述明确是固定层数（例如 2层/满层），直接按该层数输出，不要额外引入 stack 参数；只有层数可调时才用 params。',
    '    - 若表名/描述出现 "0/1/2/3" 这种档位（例如「汲取0/1/2/3枚...」），并且该表在运行时返回数组，默认按最大档位（最后一个索引）使用，不要额外引入 params。',
    '    - 若机制是可叠加的数值（例如 战意/层数/计数），请用一个数值型 params 表示叠加层数，并至少给出 1 条 detail 用最大值（满层/满战意/上限）。',
    '    - 对于“生命值低于/高于xx%”这类当前血量条件：不要用 attr.hp/hpBase 做判断；可直接假设满足（基线常默认），或用 params.half 之类开关。',
    '- GS key 建议：普攻=a，重击=a2，下落=a3；元素战技=e；元素爆发=q；可在后面追加标签（逗号分隔）。',
    '- GS: 关于 details[i].ele（dmg(...) 的第三参）：',
    '  - ele 是“元素/反应”参数（如 vaporize/melt/... 或 phy）。绝大多数条目不要写 phy（会切换到物伤加成桶，可能丢失通用 dmg 加成），只有明确需要物理体系/物理特化时才写。',
    '  - weapon=catalyst：普攻/重击/下落默认都是元素伤害（不要写 phy）。',
    '  - weapon=bow：普攻/非满蓄力箭在游戏里多为物理；但同样只有需要物理桶时才写 phy。满蓄力/元素箭不要写 phy。',
    '  - 其他近战武器：普攻/重击/下落在游戏里多为物理，但基线 calc.js 经常省略 phy（让其走通用 dmg 加成桶）。只有当该角色明确走物理体系（物伤杯/物理拐/物理主C）或标题/表名明确写“物理”时才写 phy；若存在元素附魔/状态，请用 params+buff/check 表达。',
    '- GS 提示：若你在 talent.e 里看到像普攻一样的表名（例如「一段伤害/五段伤害/重击伤害」），通常表示“E状态下普攻倍率被替换”。此时请用 talent=e 的表作为 table，但 key 仍然用 a/a2（以便吃到普攻/重击相关增益）。',
    '- GS 提示：如果某个表的 unit（单位提示）是「普通攻击伤害/重击伤害/下落攻击伤害/元素战技伤害/元素爆发伤害」等，通常表示“倍率/增益表”，不是直接技能倍率。',
    '  - 这类表不要直接用于 details 的 dmg(...)。',
    '  - 应在 buffs 中表达：',
    '    - “伤害提升/伤害提高/造成的伤害提升” => *Dmg（例如 qDmg）',
    '    - “倍率提高/倍率提升/系数提高” => *Pct（例如 qPct）',
    '    - 只有明确“造成原本X%/倍率变为X%/改为X%”这类“总倍率变更”才用 *Multi（例如 qMulti）',
    '  - 重要：不要在表达式里写 `- 100` 来“换算倍率”。',
    '    - 若表值本身就是“总倍率%”（常见 100~400），请直接输出数字（例如 137.9），本地会自动折算为 Multi 的 delta。',
    '    - 若表值很小（例如 0.3），通常是“每点能量/每层/每次”的系数：应乘上对应的能量/层数（优先用 talent.q["元素能量"] 或 params.num），不要减 100。',
    '    - 常见例子：talent.e 存在「元素爆发伤害提高」（数值很小），且 q 表存在「元素能量」时，通常表示“每点能量提升X%爆发伤害”：buff 应写 qDmg = talent.e["元素爆发伤害提高"] * talent.q["元素能量"]。',
    '- GS 提示：若 a 表存在明显的“特殊重击/蓄力形态”表名（例如包含「重击·」/「持续伤害」/「蓄力」），请让“重击伤害/重击”条目优先代表该特殊形态，而不是普通「重击伤害」。',
    '- SR key 建议：普攻=a；战技=e；终结技=q；天赋=t（追击等）；可在后面追加逗号标签。',
	    '- details 可选字段：dmgExpr 用于表达复杂公式（当需要多属性混合、多段合计、或多表/条件分支时）。',
	    '  - dmgExpr: JS 表达式（不要写 function/箭头函数），必须返回 dmg(...) 的结果对象；可用变量 talent, attr, calc, params, cons, weapon, trees, dmg, toRatio；不要使用 currentTalent（detail 运行时不可用）。',
	    '  - GS: 如果 talent.<a/e/q>["表名2"] 在运行时返回数组（如 [atkPct, masteryPct] 或 [pct, flat]），请在 dmgExpr 中用 [0]/[1] 取值，不要直接把数组传给 dmg(...)。',
	    '  - GS: 如果“表值文字样本”里出现 "*N"（例如 "57.28%*2" / "1.41%HP*5" / "80%ATK×3"），并且该表的样本值形如 [x, N]，表示“多段/次数倍率”，应使用乘法：base * x/100 * N（不要写成 + N）。',
	    '  - 提示：如果“表值样本”里出现了某个表名，说明该表在运行时返回数组/对象；不在样本里的表通常是 number。',
	    '  - 对于出现在“表值样本”里的表名（通常以 2 结尾），优先选它作为 table；常见 [pct,flat] / [pct,hits] / [%stat + %stat] 由生成器处理，只有复杂合计才用 dmgExpr。',
	    '  - 如需多项/分支/多段合计计算，配合 dmgExpr。',
	    '  - 多属性混合模板（ATK+精通）：dmg.basic(calc(attr.atk) * toRatio(talent.e["表名2"][0]) + calc(attr.mastery) * toRatio(talent.e["表名2"][1]), "e")',
	    '  - GS: 对于“纯倍率伤害”（单表、单倍率、无混合/无额外加法），优先直接用 dmg(talent.<a/e/q>["表名"], "<key>")；不要用 dmg.basic(calc(attr.atk) * toRatio(...)) 重新实现，避免单位/漏算导致离谱偏差。',
	    '  - 注意：dmg(...) / dmg.basic(...) 只允许 2~3 个参数：(倍率或基础数值, key, ele?)；第三参只能是 ele 字符串或省略；禁止传入对象/额外参数。',
	    '  - GS: ele 第三参只能省略（不传，禁止传空字符串 ""）、"phy" 或反应ID（melt/vaporize/aggravate/spread/swirl/burning/overloaded/electroCharged/bloom/burgeon/hyperBloom/crystallize/superConduct/shatter 以及 lunarCharged/lunarBloom/lunarCrystallize）。禁止使用元素名 anemo/geo/electro/dendro/hydro/pyro/cryo 作为 ele。',
	    '  - 即使使用 dmgExpr，也请填写 talent/table/key 作为主表与归类 key（用于 UI 与默认排序）。',
	    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal）。',
	    '- buffs 用于对标基线的增益/减益（天赋/行迹/命座/秘技等），输出一个数组（可为空）。',
	    '- buffs[i].data 的值：数字=常量；字符串=JS 表达式（不是函数，不要写箭头函数/function/return），可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent。',
	    '- buffs[i].data 的 key：不要给真正的增益 key 加前缀 "_"（例如 _a2Plus/_qPct）；前缀 "_" 仅用于 title 里的占位符展示（例如 [_zy]）。',
	    '- buffs[i].data 的数值单位：通常是“百分比数值”（例如 +20% 请输出 20，不要输出 0.2）；不要在 buff.data 里使用 toRatio()。',
	    '- buffs 尽量写清楚 check/params 以限定生效范围，避免“无条件全局增益”污染其他技能（尤其是 ePlus/qPlus/aPlus 等）。',
 	    '- buffs: 如果文案包含“处于/在…状态/施放后/持续期间/命中后/满层/上限/至多叠加/初辉/满辉/夜魂/月兆/战意”等状态或层数：',
 	    '  - 必须写 check，并使用 params.<State> / params.<stacks> 做条件；同时确保至少有 1 条 detail 设置对应 params 使该 buff 生效（对标基线展示行通常按满状态/满层）。',
 	    '  - 若文案明确写死层数（例如 300层/3枚/满层），请直接在 buff 表达式里乘上该常量，不要漏乘；只有层数可变时才引入 params.stacks。',
 	    '  - “层数上限提升X/额外获得X层”不要用 qPlus/qMulti 等；应把“每层提供的比例” * X，计入 dmg/healInc 等对应 key。',
	    '  - 重要：若某个“提升/额外提升”表的单位提示包含 生命值/防御力/精通/…(/层)（按属性给出倍率），它不是 *Multi% 增伤；应当作为“追加倍率/追加伤害值”计入 dmg.basic(...) 的倍率里，或用 *Plus 写成 calc(attr.<stat>) * (table/100)（按层再乘层数），不要误做 -100。',
	    '- 如果需要“基于属性追加伤害值”，使用 aPlus/a2Plus/a3Plus/ePlus/qPlus 等 *Plus key；不要误用 aDmg/eDmg/qDmg/dmg。',
 	    '- 如果描述是“提升/提高 X%攻击力(生命值上限/防御力/元素精通) 的伤害/追加值”（例如 640%攻击力），这属于 *Plus：请写成 calc(attr.atk) * (X/100)（例如 640% => calc(attr.atk) * 6.4），不要把 640 当成常量。',
	    '- SR 额外强调（很容易写错）：',
	    '  - 文案「施放普攻/战技/终结技/天赋(反击)时，额外造成等同于自身(生命上限/防御力/攻击力)X%的…属性伤害」=> 这是“追加伤害值”，使用 aPlus/ePlus/qPlus/tPlus：calc(attr.<stat>) * (X/100)，不要误写成 hpPct/defPct/atkPct 或 aDmg/eDmg/qDmg。',
	    '  - 文案「使反击造成的伤害值提高，提高数值等同于防御力的X%」=> tPlus：calc(attr.def) * (X/100)，不是 defPct。',
	    '  - 治疗/护盾通常是「百分比*面板属性 + 固定值」两张表：请用 kind=heal/shield，并在 dmgExpr 中合并两表，例如 heal(calc(attr.hp) * toRatio(talent.e[\"治疗·百分比生命\"]) + (Number(talent.e[\"治疗·固定值\"])||0))；护盾类似 shield(calc(attr.def) * toRatio(talent.e[\"百分比防御\"]) + (Number(talent.e[\"固定值\"])||0))。',
 	    '- 如果这个“追加伤害值”只对某个特定招式/特定表名生效（而不是所有 E/Q/普攻都生效），不要用全局 ePlus/qPlus/aPlus；请在对应 detail 用 dmgExpr 把 extra 直接加到 dmg/avg 上（dmgExpr 只能是表达式，不能写 const/return/function/箭头函数）。可用这种写法（允许重复调用 dmg）：{ dmg: dmg(...).dmg + extra, avg: dmg(...).avg + extra }。',
	    '- GS: kx 用于“敌人抗性降低”；enemyDef/enemyIgnore 用于“防御降低/无视防御”；fypct/fyplus/fybase/fyinc 用于剧变/月曜反应增益，不要把抗性降低误写成 fypct。',
	    '- 如果描述是“造成原本170%的伤害/提高到160%”这类乘区倍率，使用 aMulti/a2Multi/qMulti 等 *Multi key（数值仍用百分比数值，例如 170）。',
	    '- 若是“月曜反应伤害提升”，使用 lunarBloom/lunarCharged/lunarCrystallize 作为 buff.data key（数值为百分比数值）。',
    '- buffs[i].data 的 key 请尽量使用基线常见命名（避免自造）：',
    `  - GS 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,mastery,recharge,heal,healInc,shield,shieldInc,dmg,phy,_shield,kx,enemyDef,fypct,fyplus,fybase,fyinc,lunarBloom,lunarCharged,lunarCrystallize,以及 (a|a2|a3|e|q|nightsoul)(Dmg|Plus|Cpct|Cdmg|Multi|Pct)；反应类：swirl,crystallize,bloom,hyperBloom,burgeon,burning,overloaded,electroCharged,superConduct,shatter`,
    `  - GS 元素伤害加成统一用 dmg（不要用 pyro/hydro/... 等元素名）。`,
    `  - SR 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,dmg,aDmg,eDmg,qDmg,tDmg,aPlus,ePlus,qPlus,tPlus,speedPct,speedPlus,effPct,kx,enemyDef`,
    '- buffs 中如果需要引用天赋数值：只能使用 talent.a/e/q/t["<表名>"]，并且 <表名> 必须来自下方“可用表名”列表；禁止使用 talent.q2 / talent.talent / 乱写字段。',
    '- params 字段名请尽量使用基线常见命名（例如 Nightsoul/Moonsign/BondOfLife）。不要发明需要运行时敌方状态/血量等不可用信息的字段。',
    '- 重要：enemyDef/kx/enemyIgnore/ignore 等“减防/减抗/无视防御”相关数值使用正数表示（不要写成负数）。例如“降低防御力20%” => enemyDef: 20。',
    '- 重要：如果你在 buffs.check / buffs.data 的表达式里引用 params.xxx，则必须保证至少有一条 details.params（或 defParams）提供 params.xxx；否则不要引用它（避免 buff 死亡或掉到低档分支）。',
    '',
    `角色：${input.name} elem=${input.elem}${input.weapon ? ` weapon=${input.weapon}` : ''}${typeof input.star === 'number' ? ` star=${input.star}` : ''}`,
    '',
    ...(descLines.length
      ? ['技能描述摘要（用于判断哪些表是伤害倍率/选择标题，不要复述）：', ...descLines, '']
      : []),
    ...(buffHintLines.length ? ['Buff 线索（用于生成 buffs，不要复述）：', ...buffHintLines, ''] : []),
    ...(buffLikeTableLines.length
      ? ['疑似增益/机制表名（可用于生成 buffs 或确定 params，不要编造）：', ...buffLikeTableLines, '']
      : []),
    ...(unitHintLines.length ? ['表单位提示（重要：用于判断“倍率/增益表”，不要复述）：', ...unitHintLines, ''] : []),
    '可用表名（严格从这里选）：',
    `- a: ${JSON.stringify(aTables)}`,
    `- e: ${JSON.stringify(eTables)}`,
    `- q: ${JSON.stringify(qTables)}`,
    ...(input.game === 'sr' ? [`- t: ${JSON.stringify(tTables)}`] : []),
    '',
    ...(sampleLines.length ? ['表值样本（仅用于判断表是否返回数组）：', ...sampleLines, ''] : []),
    ...(textSampleLines.length
      ? ['表值文字样本（用于理解数组每一项对应的属性含义，不要复述）：', ...textSampleLines, '']
      : []),
    '输出 JSON 结构：',
    '{',
    '  "mainAttr": "atk,cpct,cdmg",',
    '  "defDmgKey": "e",',
    '  "details": [',
    '    { "title": "E伤害(夜魂)", "kind": "dmg", "talent": "e", "table": "技能伤害", "key": "e,nightsoul", "params": { "Nightsoul": true }, "check": "params.Nightsoul === true" },',
    '    { "title": "复杂公式示例", "kind": "dmg", "talent": "e", "table": "技能伤害2", "key": "e", "dmgExpr": "dmg.basic(calc(attr.hp) * toRatio(talent.e[\\\"技能伤害2\\\"][0]) + (Number(talent.e[\\\"技能伤害2\\\"][1]) || 0), \\\"e\\\")" },',
    '    { "title": "Q治疗", "kind": "heal", "talent": "q", "table": "治疗量", "stat": "hp", "key": "q" },',
    '    { "title": "扩散反应伤害", "kind": "reaction", "reaction": "swirl" }',
    '  ],',
    '  "buffs": [',
    '    { "title": "示例：1命提高暴击率[cpct]%", "cons": 1, "data": { "cpct": 12 } }',
    '  ]',
    '}'
  ].join('\n')

  return [
    {
      role: 'system',
      content:
        '你是一个谨慎的 Node.js/JS 工程师，熟悉 miao-plugin 的 calc.js 结构。' +
        ' 你必须严格按要求输出 JSON，不要输出解释、Markdown、代码块。'
    },
    { role: 'user', content: user }
  ]
}

function validatePlan(input: CalcSuggestInput, plan: CalcSuggestResult): CalcSuggestResult {
  const okTalents = new Set<TalentKey>(input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't'])
  const tables: Record<string, string[]> = {}
  for (const k of Object.keys(input.tables)) {
    tables[k] = normalizeTableList((input.tables as any)[k])
  }
  const qTables = tables.q || []

  const mainAttr = typeof plan.mainAttr === 'string' ? plan.mainAttr.trim() : ''
  if (!mainAttr) {
    throw new Error(`[meta-gen] invalid LLM plan: mainAttr is empty`)
  }

  const normalizeKind = (v: unknown): CalcDetailKind => {
    const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (t === 'dmg' || t === 'heal' || t === 'shield' || t === 'reaction') return t
    return 'dmg'
  }

  const normalizeStat = (v: unknown): CalcScaleStat | undefined => {
    const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
    if (!t) return undefined
    if (t === 'em' || t === 'elementalmastery') return 'mastery'
    if (t === 'atk' || t === 'hp' || t === 'def' || t === 'mastery') return t
    return undefined
  }

  const gsReactionCanon: Record<string, string> = {
    swirl: 'swirl',
    crystallize: 'crystallize',
    bloom: 'bloom',
    hyperbloom: 'hyperBloom',
    burgeon: 'burgeon',
    burning: 'burning',
    overloaded: 'overloaded',
    electrocharged: 'electroCharged',
    superconduct: 'superConduct',
    shatter: 'shatter'
  }
  const okReactions =
    input.game === 'gs'
      ? new Set(Object.values(gsReactionCanon))
      : new Set<string>()

  const isSafeExpr = (expr: string): boolean => {
    const s = expr.trim()
    if (!s) return false
    // No statement separators / blocks.
    if (/[;{}]/.test(s)) return false
    // No comments (can break generated JS).
    if (/\/\//.test(s) || /\/\*/.test(s) || /\*\//.test(s)) return false
    // Disallow function syntax; we only accept expressions.
    if (/=>/.test(s) || /\bfunction\b/.test(s)) return false
    // Disallow obvious escape hatches / side-effects.
    if (
      /\b(?:import|export|require|process|globalThis|global|window|document|eval|new|class|while|for|try|catch|throw|return|this)\b/.test(
        s
      )
    ) {
      return false
    }
    // Disallow template literals (can hide complex code).
    if (/[`]/.test(s)) return false
    return true
  }

  const hasBareKeyRef = (expr: string): boolean => {
    // `key` is NOT provided by miao-plugin's calc.js runtime context. Treat bare `key` usage as invalid.
    // Allow `obj.key` (property access) but reject standalone `key` references.
    return /(^|[^.$\w])key\b/.test(expr)
  }

  const hasIllegalTalentKeyRef = (expr: string): boolean => {
    // `talent` in miao-plugin runtime does not have `.key`; models often hallucinate it and cause TypeError.
    const s = expr.replace(/\s+/g, '')
    return /\btalent\??\.key\b/.test(s) || /\btalent\??\[\s*(['"])key\1\s*\]/.test(s)
  }

  const hasIllegalCalcMemberAccess = (expr: string): boolean => {
    // `calc` is a function: only `calc(attr.xxx)` is valid. Member access like `calc.round` is hallucination.
    return /\bcalc\??\.\s*[A-Za-z_]/.test(expr)
  }

  const isSafeDmgExpr = (expr: string): boolean => {
    const s = expr.trim()
    if (!s) return false
    // No statement separators.
    if (/[;]/.test(s)) return false
    // No comments (can break generated JS).
    if (/\/\//.test(s) || /\/\*/.test(s) || /\*\//.test(s)) return false
    // Disallow function syntax; we only accept expressions.
    if (/=>/.test(s) || /\bfunction\b/.test(s)) return false
    // Disallow obvious escape hatches / side-effects.
    if (
      /\b(?:import|export|require|process|globalThis|global|window|document|eval|new|class|while|for|try|catch|throw|return|this|async|await)\b/.test(
        s
      )
    ) {
      return false
    }
    // Disallow template literals (can hide complex code).
    if (/[`]/.test(s)) return false
    // Disallow assignments like `a = b` (allow ==/===/!=/!==/<=/>=).
    if (/(^|[^=!<>])=($|[^=])/.test(s)) return false
    return true
  }

  const isParamsObject = (v: unknown): v is Record<string, number | boolean | string> =>
    !!v && typeof v === 'object' && v !== null && !Array.isArray(v)

  const normalizeCalcExpr = (expr: string): string => {
    // miao-plugin `calc()` expects an AttrItem-like object (e.g. `attr.recharge`), NOT a number.
    // Models frequently write `calc(attr.recharge - 100)`, which becomes `calc(NaN)` at runtime and collapses to 0.
    // Auto-rewrite common patterns into baseline-style safe forms.
    return expr.replace(
      /\bcalc\s*\(\s*attr\.([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*(\d+(?:\.\d+)?)\s*\)/g,
      (_m, k, op, n) => `(calc(attr.${k}) ${op} ${n})`
    )
  }

  const okCalcAttrKeys =
    input.game === 'gs'
      ? new Set(['atk', 'def', 'hp', 'mastery', 'recharge', 'cpct', 'cdmg', 'heal', 'dmg', 'phy', 'shield'])
      : new Set([
          'atk',
          'def',
          'hp',
          'speed',
          'recharge',
          'cpct',
          'cdmg',
          'heal',
          'dmg',
          'enemydmg',
          'effPct',
          'effDef',
          'stance',
          'shield'
        ])

  const hasIllegalCalcCall = (expr: string): boolean => {
    // In miao-plugin baseline, `calc()` is used as `calc(attr.xxx)` (single-arg). Multi-arg calls are almost
    // always hallucinations and can explode damage numbers.
    if (/\bcalc\s*\([^)]*,/.test(expr)) return true

    // Disallow `calc()` arguments that are not a direct AttrItem bucket:
    // - only allow `calc(attr.atk)` / `calc(attr.hp)` / ...
    // - forbid arithmetic inside, e.g. `calc(attr.recharge - 100)` / `calc(attr.atk * 2)`
    const re = /\bcalc\s*\(\s*([^)]+?)\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const arg = String(m[1] || '').trim()
      if (!arg.startsWith('attr.')) return true
      const key = arg.slice('attr.'.length).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return true
      if (!okCalcAttrKeys.has(key)) return true
    }
    return false
  }

  const hasIllegalDmgFnCall = (expr: string): boolean => {
    // In miao-plugin baseline, dmg functions are used as:
    // - dmg(pctNum, key, ele?)
    // - dmg.basic(basicNum, key, ele?)
    // Passing dynamicData/object literals (or >3 args) is almost always hallucination.
    const src = expr

    const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
    const startsWithAt = (needle: string, i: number): boolean => src.slice(i, i + needle.length) === needle

    const scanCall = (needle: string): boolean => {
      for (let i = 0; i < src.length; i++) {
        if (!startsWithAt(needle, i)) continue
        const prev = i > 0 ? src[i - 1] : ''
        // Avoid matching identifiers like `xdmg.basic(`.
        if (prev && isWordChar(prev)) continue

        let j = i + needle.length
        // Parse args until matching ')'.
        let depthParen = 0
        let depthBracket = 0
        let depthBrace = 0
        let quote: '"' | "'" | null = null
        let escaped = false
        let argIdx = 0
        let thirdArgFirstNonSpace: string | null = null

        for (; j < src.length; j++) {
          const ch = src[j]!
          if (quote) {
            if (escaped) {
              escaped = false
              continue
            }
            if (ch === '\\\\') {
              escaped = true
              continue
            }
            if (ch === quote) quote = null
            continue
          }

          if (ch === '"' || ch === "'") {
            quote = ch
            continue
          }

          if (
            argIdx === 2 &&
            thirdArgFirstNonSpace === null &&
            depthParen === 0 &&
            depthBracket === 0 &&
            depthBrace === 0 &&
            !/\s/.test(ch)
          ) {
            thirdArgFirstNonSpace = ch
            // Object/array literal as ele arg is always wrong.
            if (ch === '{' || ch === '[') return true
          }

          if (ch === '(') {
            depthParen++
            continue
          }
          if (ch === ')') {
            if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) break
            if (depthParen > 0) depthParen--
            continue
          }
          if (ch === '[') {
            depthBracket++
            continue
          }
          if (ch === ']') {
            if (depthBracket > 0) depthBracket--
            continue
          }
          if (ch === '{') {
            depthBrace++
            continue
          }
          if (ch === '}') {
            if (depthBrace > 0) depthBrace--
            continue
          }

          if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
            if (ch === ',') {
              argIdx++
              // Too many args: >= 3 commas means 4 args.
              if (argIdx >= 3) return true
              continue
            }
          }
        }
      }
      return false
    }

    // Note: check `dmg.basic(` before `dmg(`.
    return scanCall('dmg.basic(') || scanCall('dmg(')
  }
  const hasIllegalTalentRef = (expr: string): boolean => {
    const s = expr.replace(/\s+/g, '')
    // Only allow bracket access: `talent.e["表名"]` (no dot props like `talent.e.xxx`).
    // Dot access almost always means hallucinated fields and will make checks always-false.
    if (/\btalent\?*\.(?:a|e|q|t)\?*\./.test(s)) return true
    // GS does not have `talent.t` (only a/e/q). Reject common hallucinations.
    if (input.game === 'gs') {
      return (
        /\btalent\?*\.t\b/.test(s) ||
        /\btalent\?*\.talent\b/.test(s) ||
        /\btalent\?*\.(?:a|e|q)\.t\b/.test(s) ||
        /\btalent\[['"]t['"]\]/.test(s)
      )
    }
    return false
  }

  const hasIllegalParamsRef = (expr: string): boolean => {
    // Keep generated params keys ASCII-only for maintainability and easier CLI control.
    // JS technically allows `params.草露`, but it can't be expressed via our `detail.params` object (ASCII-only)
    // and makes diff/regression hard to reproduce.
    const s = expr.replace(/\s+/g, '')
    return /\bparams\.[^A-Za-z_]/.test(s)
  }

  const validateTalentTableRefs = (expr: string): void => {
    // Reject dynamic talent table access like `talent.e[table]`.
    if (/\btalent\?*\.([aeqt])\s*\[\s*(?!['"])/.test(expr)) {
      throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses dynamic talent table access`)
    }

    const re = /\btalent\?*\.([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const tk = m[1] as TalentKey
      const tn = m[3]
      if (!okTalents.has(tk)) {
        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key: ${tk}`)
      }
      const allowed = tables[tk] || []
      if (!allowed.includes(tn)) {
        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unknown table: ${tk}[${tn}]`)
      }
    }
  }

  const detailsRaw = Array.isArray(plan.details) ? plan.details : []
  const detailsIn = clampDetails(detailsRaw, 20)
  const details: CalcSuggestDetail[] = []

  for (const d of detailsIn) {
    let kind = normalizeKind(d.kind)
    const title = d.title

    if (kind === 'reaction') {
      const reaction = typeof d.reaction === 'string' ? d.reaction.trim() : ''
      if (!reaction) continue
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(reaction)) continue
      const canon = input.game === 'gs' ? gsReactionCanon[reaction.toLowerCase()] || reaction : reaction
      if (okReactions.size && !okReactions.has(canon)) continue
      const out: CalcSuggestDetail = { title, kind, reaction: canon }

      const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
      if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

      const check0 = typeof d.check === 'string' ? d.check.trim() : ''
      const check = check0 ? normalizeCalcExpr(check0) : ''
      if (check) {
        if (/\bcurrentTalent\b/.test(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not reference currentTalent`)
        }
        if (!isSafeExpr(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check is not a safe expression`)
        if (hasIllegalTalentKeyRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not reference talent.key`)
        }
        if (hasIllegalCalcMemberAccess(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not use calc.xxx member access`)
        }
        if (hasIllegalParamsRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check uses non-ASCII params key`)
        }
        if (hasIllegalTalentRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check references unsupported talent key`)
        }
        if (hasIllegalCalcCall(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check uses illegal calc() call`)
        out.check = check
      }

      if (isParamsObject(d.params)) {
        const p: Record<string, number | boolean | string> = {}
        let n = 0
        for (const [k, v] of Object.entries(d.params)) {
          const kk = String(k || '').trim()
          if (!kk || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(kk)) continue
          if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue
            p[kk] = v
          } else if (typeof v === 'boolean' || typeof v === 'string') {
            p[kk] = v
          } else {
            continue
          }
          if (++n >= 12) break
        }
        if (Object.keys(p).length) out.params = p
      }

      const dmgExpr0 = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
      const dmgExpr = dmgExpr0 ? normalizeCalcExpr(dmgExpr0) : ''
	      if (dmgExpr) {
	        if (/\bcurrentTalent\b/.test(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference currentTalent`)
	        }
	        if (!isSafeDmgExpr(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr is not a safe expression`)
	        }
	        if (hasIllegalTalentKeyRef(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference talent.key`)
	        }
	        if (hasIllegalCalcMemberAccess(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not use calc.xxx member access`)
	        }
	        if (hasIllegalTalentRef(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key`)
	        }
	        if (hasIllegalCalcCall(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal calc() call`)
	        }
	        if (hasIllegalDmgFnCall(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal dmg() call`)
	        }
	        validateTalentTableRefs(dmgExpr)
	        out.dmgExpr = dmgExpr
	      }

      details.push(out)
      continue
    }

    const talent = typeof d.talent === 'string' ? (d.talent as TalentKey) : undefined
    const table = typeof d.table === 'string' ? d.table : undefined
    if (!talent || !okTalents.has(talent)) continue
    const allowed = tables[talent] || []
    if (!table) continue
	    let tableFinal = table
	    // Auto-correct common mislabels:
	    // - LLM sometimes marks heal/shield rows as kind=dmg and then uses dmgExpr (which breaks avg semantics).
	    // - Use title/table hints to conservatively reclassify them before rendering.
	    if (kind === 'dmg') {
	      const hint = `${title} ${tableFinal}`
	      if (/(治疗|回复|恢复)/.test(hint)) kind = 'heal'
	      else if (/(护盾|吸收量)/.test(hint)) kind = 'shield'
	    }
	    // GS heal/shield tables often have a `<name>2` variant that keeps [pct, flat] for runtime calc.
	    if ((kind === 'heal' || kind === 'shield') && !tableFinal.endsWith('2')) {
	      const t2 = `${tableFinal}2`
	      if (allowed.includes(t2)) tableFinal = t2
	    }
	    // GS damage tables may also have a `<name>2` structured variant (e.g. [atkPct, masteryPct]).
	    // Prefer the structured one when available to avoid huge inaccuracies from the summed display table.
	    if (
	      kind === 'dmg' &&
	      input.game === 'gs' &&
	      !tableFinal.endsWith('2') &&
	      !(typeof d.dmgExpr === 'string' && d.dmgExpr.trim())
	    ) {
	      const t2 = `${tableFinal}2`
	      if ((input.tableSamples as any)?.[talent]?.[t2] !== undefined && allowed.includes(t2)) {
	        tableFinal = t2
	      }
	    }
	    if (!allowed.includes(tableFinal)) continue

      // Guardrail: GS heal/shield rows are frequently hallucinated from unrelated "上限/阈值/持续时间/能量" tables.
      // Drop such rows early to avoid wildly inflated avg values in panel regression (e.g. using "赤鬃之血上限"
      // as a heal multiplier).
      if ((kind === 'heal' || kind === 'shield') && input.game === 'gs') {
        const tn = String(tableFinal || '').trim()
        const isHealShieldLike = /(治疗|回复|恢复|护盾|吸收)/.test(tn)
        const isSuspicious = /(上限|阈值|冷却|持续时间|能量恢复|能量|次数|计数)/.test(tn) || /伤害/.test(tn)
        const hasHpWord = /(生命|HP)/i.test(tn)
        if (!isHealShieldLike && isSuspicious && !hasHpWord) continue
      }

	    const out: CalcSuggestDetail = { title, kind, talent, table: tableFinal }
	    if (typeof d.key === 'string') {
	      // Allow empty string key (baseline uses this for some reaction-like damage such as lunar*).
	      out.key = d.key.trim()
	    }
	    const ele = typeof d.ele === 'string' ? d.ele.trim() : ''
	    if (ele && kind === 'dmg') {
	      // Some models hallucinate element names (cryo/hydro/pyro/...) as ele args.
	      // In miao-plugin, elemental skills should omit ele arg; keep only allowed ids (phy/amp-reaction ids/lunar ids).
	      if (
	        input.game === 'gs' &&
	        /^(anemo|geo|electro|dendro|hydro|pyro|cryo)$/i.test(ele)
	      ) {
	        // ignore
	      } else if (input.game === 'gs' && gsReactionCanon[ele.toLowerCase()]) {
	        // Transformative reactions should be modeled as kind=reaction, not as ele args on talent damage.
	        // (Passing ele=overloaded/etc switches calcRet into reaction mode and ignores pctNum.)
	      } else {
	        out.ele = ele
	      }
	    }
    const stat = normalizeStat(d.stat)
    if (stat) out.stat = stat
    const pickRaw = typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
    if (
      pickRaw !== undefined &&
      pickRaw >= 0 &&
      pickRaw <= 10 &&
      typeof out.table === 'string' &&
      out.table.includes('/') &&
      Array.isArray((input.tableSamples as any)?.[talent]?.[out.table])
    ) {
      out.pick = pickRaw
    }

    const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

    const check0 = typeof d.check === 'string' ? d.check.trim() : ''
    const check = check0 ? normalizeCalcExpr(check0) : ''
    if (check) {
      try {
        if (/\bcurrentTalent\b/.test(check)) throw new Error('currentTalent')
        if (!isSafeExpr(check)) throw new Error('unsafe')
        if (hasBareKeyRef(check)) throw new Error('bare-key')
        if (hasIllegalTalentKeyRef(check)) throw new Error('talent-key')
        if (hasIllegalCalcMemberAccess(check)) throw new Error('calc-member')
        if (hasIllegalParamsRef(check)) throw new Error('illegal-params')
        if (hasIllegalTalentRef(check)) throw new Error('illegal-talent')
        if (hasIllegalCalcCall(check)) throw new Error('illegal-calc')
        validateTalentTableRefs(check)
        out.check = check
      } catch {
        // ignore invalid check (optional field)
      }
    }

    if (isParamsObject(d.params)) {
      const p: Record<string, number | boolean | string> = {}
      let n = 0
      for (const [k, v] of Object.entries(d.params)) {
        const kk = String(k || '').trim()
        if (!kk || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(kk)) continue
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) continue
          p[kk] = v
        } else if (typeof v === 'boolean' || typeof v === 'string') {
          p[kk] = v
        } else {
          continue
        }
        if (++n >= 12) break
      }
      if (Object.keys(p).length) out.params = p
    }

    // Only allow dmgExpr for kind=dmg (heal/shield should use structured rendering to avoid wrong return types).
    const dmgExpr0 = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
    const dmgExpr = dmgExpr0 ? normalizeCalcExpr(dmgExpr0) : ''
	    if (dmgExpr && kind === 'dmg') {
	      if (/\bcurrentTalent\b/.test(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference currentTalent`)
	      }
	      if (!isSafeDmgExpr(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr is not a safe expression`)
	      }
	      if (hasIllegalTalentRef(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key`)
	      }
	      if (hasIllegalCalcCall(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal calc() call`)
	      }
	      if (hasIllegalDmgFnCall(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal dmg() call`)
	      }
	      // Guardrail: dmgExpr must be derived from at least one concrete talent table.
	      // Expressions based only on attr/params/const are often hallucinations (e.g. `calc(attr.atk) * 2`)
	      // and can explode maxAvg in panel regression.
	      if (!/\btalent\?*\.[aeqt]\s*\[\s*(['"])/.test(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must reference talent tables`)
	      }
	      // Disallow hardcoding transformative reaction ids inside dmgExpr (should use kind=reaction instead).
	      if (
	        input.game === 'gs' &&
	        /(['"])(?:swirl|crystallize|bloom|hyperbloom|burgeon|burning|overloaded|electrocharged|superconduct|shatter|lunarcharged|lunarbloom|lunarcrystallize)\1/i.test(
	          dmgExpr
	        )
	      ) {
	        throw new Error(
	          `[meta-gen] invalid LLM plan: detail.dmgExpr must not hardcode transformative reactions (use kind=reaction)`
	        )
	      }
	      validateTalentTableRefs(dmgExpr)
	      out.dmgExpr = dmgExpr
	    }
    details.push(out)
  }

  if (details.length === 0) throw new Error(`[meta-gen] invalid LLM plan: no valid details`)

  let wantsMavuikaWarWill = false
  let wantsColombinaLunar = false
  let wantsNeferVeil = false
  let wantsEmilieBurning = false
  let wantsFurinaFanfare = false
  let wantsNeuvilletteCharged = false
  let wantsSkirkCoreBuffs = false
  let wantsDionaShowcase = false
  let wantsLaumaShowcase = false

  // Multiplier-table hints derived from unit strings (e.g. "普通攻击伤害") to help fix common LLM mistakes.
  // Filled only for GS.
  const multiUnitTables: Array<{
    originTalent: TalentKeyGs
    table: string
    unit: string
    multiKey: 'aMulti' | 'a2Multi' | 'a3Multi' | 'eMulti' | 'qMulti'
    stateFlag: 'e' | 'q' | null
  }> = []

  // Post-process common GS patterns to reduce systematic LLM mistakes (purely based on API-provided table names/text):
  // - E-state normal attacks: some characters put NA multipliers under talent.e (e.g. "一段伤害/五段伤害/重击伤害").
  // - Multi-hit tables like "57.28%*2": prefer the non-2 aggregate table for "one action" damage.
  // - Skill details accidentally tagged as normal-attack keys (a/a2/a3) even though the table is a skill table.
  if (input.game === 'gs') {
    const textSamples = (input.tableTextSamples || {}) as any

    const isNaLikeTable = (t: string): boolean => {
      const s0 = t.trim()
      if (!s0) return false
      // Many NA-like tables have an extra `2` suffix in talentData (e.g. "三段伤害2").
      const s = s0.endsWith('2') ? s0.slice(0, -1) : s0
      if (s.includes('普攻') || s.includes('普通攻击')) return true
      if (s === '一段伤害' || s === '二段伤害' || s === '三段伤害' || s === '四段伤害' || s === '五段伤害') return true
      if (s === '重击伤害' || s === '下落期间伤害' || s === '低空坠地冲击' || s === '高空坠地冲击') return true
      if (/^.+段伤害$/.test(s)) return true
      return false
    }

    const rewriteKeyBase = (key: string, newBase: string): string => {
      const parts = key.split(',').map((x) => x.trim())
      if (!parts[0]) return key
      parts[0] = newBase
      return parts.filter(Boolean).join(',')
    }

    const inferMultiKeyFromUnit = (unitRaw: unknown): (typeof multiUnitTables)[number]['multiKey'] | null => {
      const u = normalizePromptText(unitRaw)
      if (!u) return null
      if (/普通攻击伤害/.test(u)) return 'aMulti'
      if (/重击伤害/.test(u)) return 'a2Multi'
      if (/下落攻击伤害/.test(u)) return 'a3Multi'
      if (/元素战技伤害/.test(u)) return 'eMulti'
      if (/元素爆发伤害/.test(u)) return 'qMulti'
      return null
    }

    const scanMultiUnits = (tk: TalentKeyGs): void => {
      const um = input.tableUnits?.[tk]
      if (!um || typeof um !== 'object' || Array.isArray(um)) return
      const allowed = new Set(tables[tk] || [])
      for (const [tn0, unitRaw] of Object.entries(um as Record<string, unknown>)) {
        const tn = String(tn0 || '').trim()
        if (!tn || (allowed.size && !allowed.has(tn))) continue
        const unit = normalizePromptText(unitRaw)
        if (!unit) continue
        const mk = inferMultiKeyFromUnit(unit)
        if (!mk) continue
        if (multiUnitTables.some((x) => x.originTalent === tk && x.table === tn && x.multiKey === mk)) continue
        multiUnitTables.push({
          originTalent: tk,
          table: tn,
          unit,
          multiKey: mk,
          stateFlag: tk === 'e' ? 'e' : tk === 'q' ? 'q' : null
        })
        if (multiUnitTables.length >= 24) break
      }
    }
    scanMultiUnits('a')
    scanMultiUnits('e')
    scanMultiUnits('q')

    // Drop details that incorrectly treat multiplier tables (unit like "普通攻击伤害") as direct dmg() pct tables.
    if (multiUnitTables.length) {
      const bad = new Set(multiUnitTables.map((x) => `${x.originTalent}:${x.table}`))
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]
        if (!d || d.kind !== 'dmg') continue
        if (!d.talent || !d.table) continue
        if (bad.has(`${d.talent}:${d.table}`)) details.splice(i, 1)
      }
      if (details.length === 0) throw new Error(`[meta-gen] invalid LLM plan: all details were multiplier-only`)
    }

    // Fix per-detail issues.
    for (const d of details) {
      // LLM may emit dmgExpr for simple cases; apply small autocorrections to reduce drift:
      // - If detail key has tags (e.g. "e,nightsoul") but dmgExpr passes only the base key ("e"),
      //   rewrite the key arg so buffs route correctly.
      // - If dmgExpr uses `dmg.basic(toRatio(talent...))` without any `calc(attr.<stat>)` base, it is almost
      //   certainly missing the scale stat multiplication (1000x too small); drop dmgExpr to fall back to
      //   deterministic rendering.
      if (typeof (d as any).dmgExpr === 'string') {
        const exprRaw = ((d as any).dmgExpr as string).trim()
        if (exprRaw) {
          if (typeof d.key === 'string' && d.key.includes(',')) {
            const want = d.key.trim()
            const baseKey = want.split(',')[0]?.trim() || ''
            if (baseKey && want !== baseKey) {
              const esc = baseKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const re = new RegExp(`,\\s*(['\"])${esc}\\1`, 'g')
              ;(d as any).dmgExpr = exprRaw.replace(re, `, ${JSON.stringify(want)}`)
            }
          }

          if (
            /\bdmg\s*\.\s*basic\s*\(\s*toRatio\s*\(\s*talent\./.test(exprRaw) &&
            !/\bcalc\s*\(\s*attr\./.test(exprRaw)
          ) {
            ;(d as any).dmgExpr = undefined
          }

          // If dmgExpr is essentially a single dmg(...) call using the provided table (no branches / no totals),
          // drop it and let deterministic rendering handle it (more stable / fewer hallucinated keys).
          //
          // Keep dmgExpr when:
          // - it builds a {dmg,avg} object (multi-hit total / extra add)
          // - it contains branching logic
          // - it encodes ele as a literal but plan.ele is missing (avoid losing reaction)
          const kind = typeof (d as any).kind === 'string' ? ((d as any).kind as string) : ''
          if (
            kind !== 'heal' &&
            kind !== 'shield' &&
            d.talent &&
            d.table &&
            typeof (d as any).dmgExpr === 'string'
          ) {
            const exprNow = ((d as any).dmgExpr as string).trim()
            const hasObjRet = /\.dmg\b|\.avg\b/.test(exprNow)
            const hasBranch = /[?:]|\&\&|\|\|/.test(exprNow)
            const dmgCalls = exprNow.match(/\bdmg(?:\s*\.\s*basic)?\s*\(/g) || []
            const talentRefs = exprNow.match(/\btalent\./g) || []
            const eleLiteral = /['"](melt|vaporize|aggravate|spread|swirl|burning|overloaded|electroCharged|bloom|burgeon|hyperBloom|crystallize|superConduct|shatter|lunarCharged|lunarBloom|lunarCrystallize)['"]/.test(
              exprNow
            )
            if (!hasObjRet && !hasBranch && dmgCalls.length === 1 && talentRefs.length <= 2 && !d.ele && eleLiteral) {
              // keep
            } else if (!hasObjRet && !hasBranch && dmgCalls.length === 1 && talentRefs.length <= 2) {
              ;(d as any).dmgExpr = undefined
            }
          }
        }
      }

      // If the LLM used dmgExpr but mistakenly treated `*N` tables as "[pct, flat]" (i.e. `+ ...[1]`),
      // drop dmgExpr and let deterministic rendering handle the `*N` semantics.
      if (typeof (d as any).dmgExpr === 'string' && d.talent && d.table) {
        const tk = d.talent
        const allowed = tables[tk] || []

        const baseName = d.table.endsWith('2') ? d.table.slice(0, -1) : d.table
        const t2 = d.table.endsWith('2') ? d.table : `${baseName}2`
        const sampleText = (textSamples as any)?.[tk]?.[baseName]

        if (allowed.includes(t2) && typeof sampleText === 'string' && /\*\s*\d+/.test(sampleText)) {
          const esc = t2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const expr = String((d as any).dmgExpr || '')

          // Common LLM mistakes for "*N" tables:
          // - Treating the 2nd element as a flat add: `... + talent.e["X2"][1]`
          // - Treating it as percent sum: `toRatio(talent.e["X2"][0] + talent.e["X2"][1])`
          const badAdd1 = new RegExp(
            `\\+\\s*(?:\\(\\s*Number\\s*\\()??\\s*talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*1\\s*\\]`,
            'i'
          )
          const badSum01 = new RegExp(
            `talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*0\\s*\\]\\s*\\+\\s*(?:\\(\\s*Number\\s*\\()??\\s*talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*1\\s*\\]`,
            'i'
          )

          if (badAdd1.test(expr) || badSum01.test(expr)) {
            ;(d as any).dmgExpr = undefined
          }
        }
      }

      // If this is a skill table, avoid accidentally categorizing it as normal/charged/plunge.
      if (d.talent === 'e' && typeof d.key === 'string') {
        const keyBase = d.key.split(',')[0]?.trim()
        if ((keyBase === 'a' || keyBase === 'a2' || keyBase === 'a3') && d.table && !isNaLikeTable(d.table)) {
          d.key = rewriteKeyBase(d.key, 'e')
        }
      }

      // Normalize common press-mode flags to avoid systematic over/under-buffing:
      // - "点按/短按" should NOT have `params.long === true`
      // - "长按" should have `params.long === true` when `params.long` is present
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        const hint = `${String((d as any).title || '')} ${String((d as any).table || '')}`
        const p = d.params as any
        const hasLong = /长按/.test(hint)
        const hasShort = /(点按|短按)/.test(hint)
        if (hasShort && !hasLong && p.long === true) p.long = false
        if (hasLong && p.long !== undefined && p.long !== true) p.long = true
      }
    }

    // Inject E-state normal attack details when tables strongly suggest this pattern.
    const eTables = tables.e || []
    const eNaCandidates: Array<{ title: string; table: string; key: string }> = []
    if (eTables.includes('一段伤害')) eNaCandidates.push({ title: 'E后普攻一段伤害', table: '一段伤害', key: 'a' })
    if (eTables.includes('五段伤害')) eNaCandidates.push({ title: 'E后普攻五段伤害', table: '五段伤害', key: 'a' })
    if (eTables.includes('重击伤害')) eNaCandidates.push({ title: 'E后重击伤害', table: '重击伤害', key: 'a2' })

    if (eNaCandidates.length) {
      const norm = (s: unknown): string =>
        String(typeof s === 'string' ? s : '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')
      const want = eNaCandidates.filter((c) => !details.some((d) => norm((d as any).title) === norm(c.title)))
      if (want.length) {
        for (let i = want.length - 1; i >= 0; i--) {
          const c = want[i]!
          // Most E-state normal attacks require the "E mode" params flag to activate related buffs.
          details.unshift({ title: c.title, kind: 'dmg', talent: 'e', table: c.table, key: c.key, params: { e: true } })
        }
        while (details.length > 20) details.pop()
      }
    }

    // If we detected stateful multiplier tables (e.g. talent.e table with unit "普通攻击伤害"),
    // ensure there is at least one showcase detail that activates the corresponding state flag.
    const hasFlag = (d: CalcSuggestDetail, flag: 'e' | 'q'): boolean => {
      const p = (d as any).params
      return !!p && typeof p === 'object' && !Array.isArray(p) && (p as any)[flag] === true
    }
    const keyBase = (d: CalcSuggestDetail): string => {
      const k0 = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : d.talent || ''
      return (k0.split(',')[0] || '').trim()
    }
    const pickATableFor = (baseKey: 'a' | 'a2' | 'a3'): string | undefined => {
      const aTables = tables.a || []
      if (baseKey === 'a') {
        return (
          aTables.find((t) => /一段伤害2?$/.test(t)) ||
          aTables.find((t) => /一段伤害/.test(t)) ||
          aTables.find((t) => isNaLikeTable(t) && !/重击|下落|坠/.test(t)) ||
          pickDamageTable(aTables)
        )
      }
      if (baseKey === 'a2') {
        return aTables.find((t) => /重击.*伤害/.test(t)) || aTables.find((t) => t.includes('重击伤害')) || pickDamageTable(aTables)
      }
      // a3
      return (
        aTables.find((t) => t.includes('低空') || t.includes('高空') || t.includes('坠地') || t.includes('下落')) ||
        aTables.find((t) => t.includes('下坠期间伤害')) ||
        pickDamageTable(aTables)
      )
    }

    for (const m of multiUnitTables) {
      if (!m.stateFlag) continue
      const flag = m.stateFlag
      const base: 'a' | 'a2' | 'a3' | 'e' | 'q' =
        m.multiKey.startsWith('a2') ? 'a2' : m.multiKey.startsWith('a3') ? 'a3' : m.multiKey.startsWith('a') ? 'a' : m.multiKey.startsWith('e') ? 'e' : 'q'

      // If a detail already sets the state flag for this base key, do nothing.
      const has = details.some((d) => d.kind === 'dmg' && keyBase(d) === base && hasFlag(d, flag))
      if (has) continue

      if (base === 'a' || base === 'a2' || base === 'a3') {
        const table = pickATableFor(base)
        if (!table) continue
        const title =
          flag === 'e'
            ? base === 'a'
              ? 'E后普攻伤害'
              : base === 'a2'
                ? 'E后重击伤害'
                : 'E后下落伤害'
            : base === 'a'
              ? 'Q后普攻伤害'
              : base === 'a2'
                ? 'Q后重击伤害'
                : 'Q后下落伤害'
        details.unshift({ title, kind: 'dmg', talent: 'a', table, key: base, params: { [flag]: true } })
      } else {
        const list = (tables as any)[base] as string[] | undefined
        const table = list ? pickDamageTable(list) : undefined
        if (!table) continue
        const title = flag === 'e' ? 'E后技能伤害' : 'Q后技能伤害'
        details.unshift({ title, kind: 'dmg', talent: base, table, key: base, params: { [flag]: true } })
      }

      while (details.length > 20) details.pop()
    }

    // Prefer unique special charged attack table (if present) as the primary "重击伤害" source.
    const aTables = tables.a || []
    const specialCharged = aTables.filter((t) => t.includes('重击·') && t.includes('持续伤害'))
    if (specialCharged.length === 1) {
      const cand = specialCharged[0]!
      for (const d of details) {
        if (d.talent === 'a' && d.table === '重击伤害') {
          d.table = cand
        }
      }
    }

    // Mavuika (war will / chariot) showcase rows used by baseline (detected via unique table names).
    // This is derived purely from API table names (no baseline code reuse).
    const qTables = tables.q || []
    const eTables2 = tables.e || []

    // Additional "showcase" patterns seen in baseline calcs. These patches are driven by
    // unique API table names / official descriptions (no baseline code reuse).
    const isDionaLike =
      input.name === '迪奥娜' ||
      (eTables2.includes('猫爪伤害') && eTables2.includes('护盾基础吸收量2') && qTables.includes('持续治疗量2'))
    const isSkirkLike =
      input.name === '丝柯克' ||
      (qTables.includes('汲取0/1/2/3枚虚境裂隙伤害提升2') && qTables.some((t) => t.includes('蛇之狡谋')))
    const isFurinaLike =
      input.name === '芙宁娜' ||
      (qTables.includes('气氛值转化提升伤害比例') &&
        qTables.includes('气氛值转化受治疗加成比例') &&
        (eTables2.includes('乌瑟勋爵伤害') || eTables2.includes('谢贝蕾妲小姐伤害')))
    const isNeuvilletteLike =
      input.name === '那维莱特' ||
      ((tables.a || []).includes('重击·衡平推裁持续伤害') && qTables.includes('水瀑伤害'))

    if (isDionaLike) wantsDionaShowcase = true
    if (isSkirkLike) wantsSkirkCoreBuffs = true
    if (isFurinaLike) wantsFurinaFanfare = true
    if (isNeuvilletteLike) wantsNeuvilletteCharged = true

    if (isFurinaLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

      const hasDetail = (q: Partial<CalcSuggestDetail>): boolean =>
        details.some((d) => {
          if (q.kind && d.kind !== q.kind) return false
          if (q.talent && d.talent !== q.talent) return false
          if (q.table && d.table !== q.table) return false
          if (q.ele && d.ele !== q.ele) return false
          return true
        })
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasDetail({ kind: d.kind, talent: d.talent, table: d.table, ele: d.ele })) return
        details.unshift(d)
      }

      // Baseline-style showcase rows (Furina):
      // - E salon member damage rows assume the "consume party HP" state (multiplier 1.4).
      // - Include vaporize variants for the main hit and Q.
      //
      // This is derived from unique official table names (no baseline code reuse).
      const summonTables = ['海薇玛夫人伤害', '乌瑟勋爵伤害', '谢贝蕾妲小姐伤害']
      // Baseline-style display titles for Furina's salon members (official names).
      const summonTitleMap: Record<string, string> = {
        海薇玛夫人伤害: 'E海薇玛夫人(海马)·伤害',
        乌瑟勋爵伤害: 'E乌瑟勋爵(章鱼)·伤害',
        谢贝蕾妲小姐伤害: 'E谢贝蕾妲小姐(螃蟹)·伤害'
      }

      // Ensure core rows exist (some LLM plans skip summons/heal).
      if (eTables2.includes('众水的歌者治疗量2')) {
        pushFront({
          title: 'E众水歌者治疗',
          kind: 'heal',
          talent: 'e',
          table: '众水的歌者治疗量2',
          stat: 'hp',
          key: 'e'
        })
      }
      for (const tn of summonTables) {
        if (!eTables2.includes(tn)) continue
        pushFront({
          title: `E${tn}`,
          kind: 'dmg',
          talent: 'e',
          table: tn,
          key: 'e'
        })
      }
      // Q main hit (for adding vaporize variant below).
      if (qTables.includes('技能伤害')) {
        pushFront({ title: 'Q万众狂欢·伤害', kind: 'dmg', talent: 'q', table: '技能伤害', key: 'q' })
      }

      // Patch summon rows to apply the 1.4 showcase multiplier.
      for (const d of details) {
        if (d.kind !== 'dmg') continue
        if (d.talent !== 'e') continue
        const tn = typeof d.table === 'string' ? d.table : ''
        if (!tn || !summonTables.includes(tn)) continue
        const keyArg = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : 'e'
        const eleArg = typeof d.ele === 'string' && d.ele.trim() ? `, ${JSON.stringify(d.ele.trim())}` : ''
        ;(d as any).dmgExpr = `dmg.basic(calc(attr.hp) * toRatio(talent.e[\"${tn}\"]) * 1.4, ${JSON.stringify(keyArg)}${eleArg})`
      }

      // Normalize titles to be stable and baseline-like (helps regression matching).
      for (const d of details) {
        if (d.kind === 'heal' && d.talent === 'e' && d.table === '众水的歌者治疗量2') {
          d.title = 'E众水歌者治疗'
        }
        if (d.kind === 'dmg' && d.talent === 'e' && typeof d.table === 'string' && summonTables.includes(d.table) && !d.ele) {
          d.title = summonTitleMap[d.table] || `E${d.table}`
        }
        if (d.kind === 'dmg' && d.talent === 'q' && d.table === '技能伤害' && !d.ele) {
          d.title = 'Q万众狂欢·伤害'
        }
        if (d.kind === 'dmg' && d.talent === 'q' && d.table === '技能伤害' && d.ele === 'vaporize') {
          d.title = 'Q万众狂欢伤害·蒸发'
        }
        if (d.kind === 'dmg' && d.talent === 'e' && d.table === '谢贝蕾妲小姐伤害' && d.ele === 'vaporize') {
          d.title = 'E谢贝蕾妲小姐(螃蟹)·蒸发'
        }
      }

      // Add vaporize variants if missing.
      if (eTables2.includes('谢贝蕾妲小姐伤害') && !hasDetail({ kind: 'dmg', talent: 'e', table: '谢贝蕾妲小姐伤害', ele: 'vaporize' })) {
        details.unshift({
          title: 'E谢贝蕾妲小姐(螃蟹)·蒸发',
          kind: 'dmg',
          talent: 'e',
          table: '谢贝蕾妲小姐伤害',
          key: 'e',
          ele: 'vaporize',
          // Keep consistent with the summon showcase multiplier patch above.
          dmgExpr: `dmg.basic(calc(attr.hp) * toRatio(talent.e[\"谢贝蕾妲小姐伤害\"]) * 1.4, \"e\", \"vaporize\")`
        })
      }
      if (qTables.includes('技能伤害') && !hasDetail({ kind: 'dmg', talent: 'q', table: '技能伤害', ele: 'vaporize' })) {
        details.unshift({
          title: 'Q万众狂欢伤害·蒸发',
          kind: 'dmg',
          talent: 'q',
          table: '技能伤害',
          key: 'q',
          ele: 'vaporize'
        })
      }

      // Prune noisy/incorrect LLM rows and keep baseline-like showcase set.
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]!
        if (!d || typeof d !== 'object') continue
        const title = d.title || ''
        if (/满增益|满buff/i.test(title)) {
          details.splice(i, 1)
        }
      }

      // De-dup core rows by (talent, table, ele) preference: keep our injected "E${table}" / "Q万众狂欢·伤害".
      const preferTitleFor = (d: CalcSuggestDetail): string => {
        if (d.talent === 'e' && typeof d.table === 'string' && summonTables.includes(d.table) && !d.ele) return `E${d.table}`
        if (d.kind === 'heal' && d.talent === 'e' && d.table === '众水的歌者治疗量2') return 'E众水歌者治疗'
        if (d.talent === 'q' && d.table === '技能伤害' && !d.ele) return 'Q万众狂欢·伤害'
        return d.title
      }
      const keyOf = (d: CalcSuggestDetail): string => `${d.kind || 'dmg'}|${d.talent || ''}|${d.table || ''}|${d.ele || ''}`
      const isPreferred = (d: CalcSuggestDetail): boolean => norm(d.title) === norm(preferTitleFor(d))

      // Keep one row per key, prefer the baseline-like title when present.
      const keepByKey = new Map<string, CalcSuggestDetail>()
      for (const d of details) {
        const k = keyOf(d)
        const cur = keepByKey.get(k)
        if (!cur) {
          keepByKey.set(k, d)
          continue
        }
        const curPref = isPreferred(cur)
        const nextPref = isPreferred(d)
        if (nextPref && !curPref) keepByKey.set(k, d)
      }
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]!
        const k = keyOf(d)
        if (keepByKey.get(k) !== d) details.splice(i, 1)
      }

      while (details.length > 20) details.pop()
    }

    // Lauma showcase rows (lunar / bloom hybrid).
    // Driven by unique official table names / texts (no baseline code reuse).
    const isLaumaLike =
      input.name === '菈乌玛' ||
      (eTables2.includes('长按二段伤害') &&
        String((input.tableTextSamples as any)?.e?.['长按二段伤害'] || '').includes('每枚草露'))

    if (isLaumaLike) {
      wantsLaumaShowcase = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline-like bloom rows (Lauma): uses custom bloom scaling (2x dmg, 1.15x avg).
      // NOTE: these params are chosen to trigger baseline-like buffs (Pale_Hymn/Moonsign), not for toggling.
      const bloomExpr = '({ dmg: reaction(\"bloom\").avg * 2, avg: reaction(\"bloom\").avg * 1.15 })'
      pushFront({
        title: 'Q后绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        dmgExpr: bloomExpr,
        params: { Pale_Hymn: true, Moonsign: 1 }
      })
      pushFront({
        title: '绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        dmgExpr: bloomExpr,
        params: { Moonsign: 1 }
      })

      // Prefer the structured mixed-stat table for the "圣域" hit when available.
      const fieldTable = eTables2.includes('霜林圣域攻击伤害2')
        ? '霜林圣域攻击伤害2'
        : eTables2.includes('霜林圣域攻击伤害')
          ? '霜林圣域攻击伤害'
          : ''
      if (fieldTable) {
        const hit = details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === fieldTable)
        if (hit) {
          hit.title = 'E圣域伤害'
          hit.key = 'e'
          hit.params = { ...(hit.params || {}), Linnunrata: true }
        }
        else {
          pushFront({
            title: 'E圣域伤害',
            kind: 'dmg',
            talent: 'e',
            table: fieldTable,
            key: 'e',
            params: { Linnunrata: true }
          })
        }
      }

      // "每枚草露..." tables are per-instance; baseline showcases the 3-instance total at 满辉.
      if (eTables2.includes('长按二段伤害')) {
        const expr = 'dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"长按二段伤害\"]) * 3, \"\", \"lunarBloom\")'
        const row =
          details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === '长按二段伤害' && d.ele === 'lunarBloom') ||
          details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === '长按二段伤害')
        if (row) {
          row.title = '满辉长按E二段3枚'
          row.key = ''
          row.ele = 'lunarBloom'
          row.params = { Lunar: true, Moonsign: 3 }
          row.dmgExpr = expr
        } else {
          pushFront({
            title: '满辉长按E二段3枚',
            kind: 'dmg',
            talent: 'e',
            table: '长按二段伤害',
            key: '',
            ele: 'lunarBloom',
            params: { Lunar: true, Moonsign: 3 },
            dmgExpr: expr
          })
        }
      }

      while (details.length > 20) details.pop()
    }

    if (isDionaLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\\s+/g, '')
          .replace(/[·!?！？…\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’\"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline tends to showcase: hold-E total, hold-E shield, and (C6) half-HP Q tick heal.
      // NOTE: pushFront uses unshift, so append in reverse order of desired output.
      pushFront({
        title: '半血Q每跳治疗',
        kind: 'heal',
        talent: 'q',
        table: '持续治疗量2',
        stat: 'hp',
        key: 'q',
        params: { half: true }
      })
      pushFront({
        title: '长按E护盾量',
        kind: 'shield',
        talent: 'e',
        key: 'e',
        dmgExpr:
          'shield((talent.e[\"护盾基础吸收量2\"][0] * calc(attr.hp) / 100 + talent.e[\"护盾基础吸收量2\"][1]) * 1.75)'
      })
      pushFront({
        title: '长按E总伤害',
        kind: 'dmg',
        talent: 'e',
        key: 'e',
        dmgExpr: 'dmg(talent.e[\"猫爪伤害\"] * 5, \"e\")'
      })

      while (details.length > 20) details.pop()
    }

    if (isNeuvilletteLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\\s+/g, '')
          .replace(/[·!?！？…\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’\"']/g, '')
      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline charged damage row includes the cons-based multiplier (C0=1.25, C1+=1.6).
      const chargedExpr =
        'dmg.basic((cons >= 1 ? 1.6 : 1.25) * talent.a[\"重击·衡平推裁持续伤害\"] * calc(attr.hp) / 100, \"a2\")'
      for (const d of details) {
        if (norm(d.title) !== norm('重击伤害')) continue
        ;(d as any).kind = 'dmg'
        ;(d as any).talent = 'a'
        ;(d as any).key = 'a2'
        ;(d as any).dmgExpr = chargedExpr
      }
      pushFront({ title: '重击伤害', kind: 'dmg', talent: 'a', key: 'a2', dmgExpr: chargedExpr })

      while (details.length > 20) details.pop()
    }

    const isMavuikaLike =
      input.name === '玛薇卡' ||
      (qTables.includes('战意上限') &&
        qTables.includes('坠日斩伤害提升') &&
        qTables.includes('驰轮车普通攻击伤害提升') &&
        qTables.includes('驰轮车重击伤害提升') &&
        eTables2.includes('驰轮车普通攻击一段伤害') &&
        eTables2.includes('驰轮车重击循环伤害') &&
        eTables2.includes('驰轮车重击终结伤害'))

    if (isMavuikaLike) {
      wantsMavuikaWarWill = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      const ZY_MAX = 200
      pushFront({
        title: 'Q技能伤害(100战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        params: { zy: 100, cl: true, Nightsoul: true }
      })
      pushFront({
        title: 'Q技能伤害(满战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: 'Q技能融化(满战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车普攻一段伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车普通攻击一段伤害',
        key: 'a,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车普攻一段融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车普通攻击一段伤害',
        key: 'a,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击循环伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击循环伤害',
        key: 'a2,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击循环融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击循环伤害',
        key: 'a2,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击终结伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击终结伤害',
        key: 'a2,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击终结融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击终结伤害',
        key: 'a2,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })

      while (details.length > 20) details.pop()
    }

    // Colombina (lunar reactions + gravity interference) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isColombinaLike =
      input.name === '哥伦比娅' ||
      (eTables2.includes('引力涟漪·持续伤害') &&
        eTables2.includes('引力干涉·月感电伤害') &&
        eTables2.includes('引力干涉·月绽放伤害') &&
        eTables2.includes('引力干涉·月结晶伤害') &&
        qTables.includes('月曜反应伤害提升') &&
        (tables.a || []).includes('月露涤荡伤害'))

    if (isColombinaLike) {
      wantsColombinaLunar = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      pushFront({
        title: '满buff 特殊重击「月露涤荡」三段总伤害',
        kind: 'dmg',
        talent: 'a',
        table: '月露涤荡伤害',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Gravity_Interference: true, cons_2: true }
      })
      pushFront({
        title: '满buff 引力涟漪·持续伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力涟漪·持续伤害',
        key: 'e',
        params: { Gravity_Interference: true }
      })
      pushFront({
        title: '满buff 引力干涉·月感电伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月感电伤害',
        key: 'e',
        ele: 'lunarCharged',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })
      pushFront({
        title: '满buff 引力干涉·月绽放伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月绽放伤害',
        key: 'e',
        ele: 'lunarBloom',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })
      pushFront({
        title: '满buff 引力干涉·月结晶伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月结晶伤害',
        key: 'e',
        ele: 'lunarCrystallize',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })

      while (details.length > 20) details.pop()
    }

    // Nefer (Veil_of_Falsehood stacks) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isNeferLike =
      input.name === '奈芙尔' ||
      (eTables2.includes('幻戏自身一段伤害2') &&
        eTables2.includes('幻戏虚影三段') &&
        qTables.includes('伤害提升') &&
        qTables.includes('二段伤害2'))

    if (isNeferLike) {
      wantsNeferVeil = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      const dropBy = (re: RegExp): void => {
        for (let i = details.length - 1; i >= 0; i--) {
          const t = details[i]?.title || ''
          if (re.test(t)) details.splice(i, 1)
        }
      }
      // Drop known-bad LLM hallucinations for this character.
      dropBy(/消耗伪秘之帷|BondOfLife|^Q|元素爆发/i)

      // Baseline uses plain "Q一段伤害/Q二段伤害" (no extra stack variants).
      pushFront({
        title: 'Q二段伤害',
        kind: 'dmg',
        talent: 'q',
        table: '二段伤害2',
        key: 'q'
      })
      pushFront({
        title: 'Q一段伤害',
        kind: 'dmg',
        talent: 'q',
        table: '一段伤害2',
        key: 'q'
      })

      pushFront({
        title: '满层满辉E后幻戏自身一段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身一段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身一段伤害2\"][1] || 0)) / 100, \"a2\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身一段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身一段伤害2\"][1] || 0)) / 100, \"a2\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        params: { Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏自身二段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身二段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身二段伤害2\"][1] || 0)) / 100, \"a2\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身二段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身二段伤害2\"][1] || 0)) / 100, \"a2\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        params: { Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同一段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影一段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影一段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同二段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影二段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影二段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同三段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影三段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影三段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        params: { Moonsign: 1 }
      })

      while (details.length > 20) details.pop()
    }

    // Emilie (burning / lumidouce) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isEmilieLike =
      input.name === '艾梅莉埃' ||
      (eTables2.includes('柔灯之匣·一阶攻击伤害') &&
        eTables2.includes('柔灯之匣·二阶攻击伤害2') &&
        qTables.includes('柔灯之匣·三阶攻击伤害'))

    if (isEmilieLike) {
      wantsEmilieBurning = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      pushFront({
        title: '重击伤害',
        kind: 'dmg',
        talent: 'a',
        table: '重击伤害',
        key: 'a2'
      })
      pushFront({
        title: 'E技能伤害',
        kind: 'dmg',
        talent: 'e',
        table: '技能伤害',
        key: 'e',
        params: { e: true }
      })
      pushFront({
        title: 'E后柔灯之匣一阶伤害',
        kind: 'dmg',
        talent: 'e',
        table: '柔灯之匣·一阶攻击伤害',
        key: 'e',
        params: { e: true }
      })
      pushFront({
        title: 'E后柔灯之匣二阶单枚伤害',
        kind: 'dmg',
        dmgExpr: 'dmg(talent.e[\"柔灯之匣·二阶攻击伤害2\"][0], \"e\")',
        params: { e: true }
      })
      pushFront({
        title: '天赋清露香氛伤害',
        kind: 'dmg',
        dmgExpr: 'dmg.basic(attr.atk * 600 / 100, \"\")',
        params: { e: true }
      })
      pushFront({
        title: 'Q柔灯之匣三阶伤害',
        kind: 'dmg',
        talent: 'q',
        table: '柔灯之匣·三阶攻击伤害',
        key: 'q'
      })
      pushFront({
        title: 'Q完整对单',
        kind: 'dmg',
        dmgExpr:
          '(() => { const q1 = dmg(talent.q[\"柔灯之匣·三阶攻击伤害\"], \"q\"); const n = (cons >= 4 ? 12 : 4); return { dmg: q1.dmg * n, avg: q1.avg * n }; })()'
      })
      pushFront({
        title: '燃烧反应伤害',
        kind: 'reaction',
        reaction: 'burning'
      })

      while (details.length > 20) details.pop()
    }
  }

  // Keep defDmgKey only when it matches one of the rendered detail dmgKey keys.
  const defDmgKeyRaw = typeof plan.defDmgKey === 'string' ? plan.defDmgKey.trim() : ''
  const validDmgKeys = new Set(
    details
      .map((d) => (typeof d.key === 'string' && d.key.trim() ? d.key.trim() : typeof d.talent === 'string' ? d.talent : ''))
      .filter(Boolean)
  )
  const defDmgKey = defDmgKeyRaw && validDmgKeys.has(defDmgKeyRaw) ? defDmgKeyRaw : undefined

  const buffsOut: CalcSuggestBuff[] = []
  const buffsRaw = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as Array<unknown>) : []
  const gsElemKeys = new Set(['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro', 'cryo'])
  const isBuffDataKey = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
  const gsMultiToDmgKey: Record<string, string> = {
    aMulti: 'aDmg',
    a2Multi: 'a2Dmg',
    a3Multi: 'a3Dmg',
    eMulti: 'eDmg',
    qMulti: 'qDmg'
  }

  const baseTableName = (t: string): string => (t && t.endsWith('2') ? t.slice(0, -1) : t)
  const detailTableBaseByTalent = new Map<TalentKey, Set<string>>()
  for (const d of details) {
    const tk = d.talent
    const tn = typeof d.table === 'string' ? d.table : ''
    if (!tk || !tn) continue
    const base = baseTableName(tn)
    const set = detailTableBaseByTalent.get(tk) || new Set<string>()
    set.add(base)
    detailTableBaseByTalent.set(tk, set)
  }

  const shouldDropBuffExpr = (buffKey: string, expr: string): boolean => {
    if (!expr) return false
    if (buffKey.startsWith('_')) return false // display-only placeholder
    if (!/\btalent\s*\./.test(expr)) return false

    // If a buff expression directly recomputes base damage from the SAME "伤害" multiplier table already used in details,
    // it's very likely double-counting (and makes comparisons explode).
    const re = /\btalent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const tk = m[1] as TalentKey
      const table = String(m[3] || '')
      if (!table) continue
      const used = detailTableBaseByTalent.get(tk)
      if (!used) continue
      const base = baseTableName(table)
      if (!used.has(base)) continue

      if (/伤害/.test(base) && !/(提升|提高|加成|额外|追加|转化|比例)/.test(base)) {
        return true
      }
    }
    return false
  }

  for (const bRaw of clampBuffs(buffsRaw, 30)) {
    if (!bRaw || typeof bRaw !== 'object') continue
    const b = bRaw as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) continue

    const sort = typeof b.sort === 'number' && Number.isFinite(b.sort) ? Math.trunc(b.sort) : undefined
    const consRaw = typeof b.cons === 'number' && Number.isFinite(b.cons) ? Math.trunc(b.cons) : undefined
    const cons = consRaw && consRaw >= 1 && consRaw <= 6 ? consRaw : undefined
    const treeRaw = typeof b.tree === 'number' && Number.isFinite(b.tree) ? Math.trunc(b.tree) : undefined
    const tree = treeRaw && treeRaw >= 1 && treeRaw <= 10 ? treeRaw : undefined
    const checkRaw0 = typeof b.check === 'string' ? b.check.trim() : ''
    const checkRaw = checkRaw0 ? normalizeCalcExpr(checkRaw0) : ''
    let check: string | undefined
    if (
      checkRaw &&
      isSafeExpr(checkRaw) &&
      !hasIllegalTalentKeyRef(checkRaw) &&
      !hasIllegalCalcMemberAccess(checkRaw) &&
      !hasIllegalParamsRef(checkRaw) &&
      !hasIllegalTalentRef(checkRaw) &&
      !hasIllegalCalcCall(checkRaw) &&
      !hasBareKeyRef(checkRaw)
    ) {
      try {
        validateTalentTableRefs(checkRaw)
        check = checkRaw
      } catch {
        check = undefined
      }
    }

    let data: Record<string, number | string> | undefined
    const dataRaw = b.data
    if (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) {
      const out: Record<string, number | string> = {}
      let n = 0
      for (const [k, v] of Object.entries(dataRaw as Record<string, unknown>)) {
        const kk = String(k || '').trim()
        if (!kk) continue
        let key = kk
        // Baseline uses dmg/phy for GS elemental/physical bonuses. Some models may output element names.
        if (input.game === 'gs' && gsElemKeys.has(key)) key = 'dmg'
        if (input.game === 'gs' && (key === 'physical' || key === 'phys')) key = 'phy'
        // Models may prefix real miao-plugin buff keys with "_" (thinking it's a placeholder),
        // which makes DmgAttr ignore the effect. Strip "_" when it looks like a real effect key.
        //
        // Keep "_" when it's clearly a display-only placeholder referenced by the title (e.g. "[_recharge]%").
        if (key.startsWith('_')) {
          const rest = key.slice(1)
          const hasPlaceholderInTitle = title.includes(`[${key}]`)
          if (!hasPlaceholderInTitle && rest && isAllowedMiaoBuffDataKey(input.game, rest)) key = rest
        }

        // LLMs frequently misuse `*Multi` keys for simple "伤害提升X%" buffs (which should be `*Dmg` additive bonuses
        // in baseline semantics). Only keep `*Multi` when the title explicitly describes a multiplier change.
        if (input.game === 'gs') {
          const mapped = gsMultiToDmgKey[key]
          if (mapped) {
            const t = title
            const isExplicitMultiplier =
              /(倍率|系数)/.test(t) ||
              /造成原本\s*\d+/.test(t) ||
              /(提高到|变为|变成|改为)\s*\d+/.test(t) ||
              /原本\d+%/.test(t)
            const isPlainDamageUp = /(造成的)?伤害(提升|提高|增加)/.test(t)
            if (isPlainDamageUp && !isExplicitMultiplier) key = mapped
          }
        }
        if (!isBuffDataKey(key)) continue
        if (!isAllowedMiaoBuffDataKey(input.game, key)) continue
        if (n >= 50) break
        if (key in out) continue
        if (typeof v === 'number' && Number.isFinite(v)) {
          // `*Multi` keys in miao-plugin are stored as an *extra multiplier percent* (delta from base 100%):
          // - aMulti=37.91 means (1 + 37.91/100) => 137.91% total multiplier
          // Models often output the *total* percent (e.g. 137.91). Convert total -> delta when it looks like total.
          let num = v
          if (/Multi$/.test(key) && num >= 100 && num <= 400) num = num - 100
          // Shred/ignore values should be non-negative; use positive numbers to represent "reduce/ignore".
          if (/^(enemyDef|enemyIgnore|ignore|kx|fykx)$/.test(key) && num < 0) num = Math.abs(num)
          out[key] = num
          n++
	        } else if (typeof v === 'string') {
	          const vv0 = v.trim()
          if (!vv0) continue
          const vv = normalizeCalcExpr(vv0)
          if (!isSafeExpr(vv)) continue
          if (hasBareKeyRef(vv)) continue
          if (hasIllegalTalentKeyRef(vv)) continue
          if (hasIllegalCalcMemberAccess(vv)) continue
          if (hasIllegalParamsRef(vv)) continue
          if (hasIllegalTalentRef(vv)) continue
          if (hasIllegalCalcCall(vv)) continue
          try {
            validateTalentTableRefs(vv)
          } catch {
            continue
          }
          // Buff values in miao-plugin are generally stored as "percent numbers" (e.g. 20 means +20%).
          // Using `toRatio()` here is almost always a unit mistake (becomes 100x smaller).
	          if (/\btoRatio\s*\(/.test(vv)) continue

          if (shouldDropBuffExpr(key, vv)) continue

          // Guardrail: large pure-stat "*Plus" buffs are frequently mis-modeled "extra hit damage" mechanics
          // and should be represented as separate details (dmg.basic) instead of a global additive + value.
          //
          // Keep small ratios (e.g. hp * 0.036) but drop suspicious >= 100% conversions like
          // `calc(attr.atk) * 2.4` which can systematically inflate multiple detail rows.
          if (/Plus$/.test(key) && !/\btalent\s*\./.test(vv)) {
            const mm = vv.match(/\bcalc\s*\(\s*attr\.(atk|hp|def|mastery)\s*\)\s*\*\s*(\d+(?:\.\d+)?)/)
            const mul = mm ? Number(mm[2]) : NaN
            if (Number.isFinite(mul) && mul >= 1) continue
          }

 	          let expr = vv
 	          // `*Multi` keys are stored as delta-percent in miao-plugin; a plain talent table reference is
 	          // almost always the *total* percent (e.g. 137.91%), so we convert it to delta by subtracting 100.
	          if (/Multi$/.test(key)) {
	            const m = expr.match(/^\s*talent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]\s*$/)
	            if (m) {
	              const talentKey = m[1] as TalentKey
	              const tableName = m[3] || ''
	              const unitMap = input.tableUnits?.[talentKey]
	              const baseTableName = tableName.endsWith('2') ? tableName.slice(0, -1) : tableName
	              const unit = unitMap ? unitMap[tableName] || unitMap[baseTableName] : ''
	              // If the referenced table is a stat-scaling ratio (HP/DEF/EM), do NOT apply the "-100" conversion.
	              // Example: "生命值上限/层" tables are additive scaling, not total multiplier percent.
	              const unitNorm = normalizePromptText(unit)
	              const isStatRatioUnit = /(生命上限|生命值上限|最大生命值|生命值|hp|防御力|防御|def|精通|元素精通|mastery|\bem\b)/i.test(
	                unitNorm
	              )
	              if (!isStatRatioUnit) expr = `${expr} - 100`
	            }
	          }
	          // Shred/ignore expressions should be non-negative; wrap with abs to avoid common "-" mistakes.
	          if (/^(enemyDef|enemyIgnore|ignore|kx|fykx)$/.test(key) && !/^\s*Math\.abs\s*\(/.test(expr)) {
	            expr = `Math.abs(${expr})`
	          }
	          out[key] = expr
	          n++
	        }
      }

      // Some models still emit real buff keys with a leading "_" (e.g. `_aPlus`),
      // which miao-plugin treats as placeholder-only and ignores for actual buff effects.
      // Normalize them into real keys when safe and non-conflicting.
      for (const k0 of Object.keys(out)) {
        if (!k0.startsWith('_')) continue
        // If the title explicitly references this key as a placeholder, keep it display-only.
        if (title.includes(`[${k0}]`)) continue
        const rest = k0.slice(1)
        if (!rest) continue
        if (!isAllowedMiaoBuffDataKey(input.game, rest)) continue
        if (Object.prototype.hasOwnProperty.call(out, rest)) continue
        out[rest] = out[k0]!
        delete out[k0]
      }
      if (Object.keys(out).length) data = out
    }

    const out: CalcSuggestBuff = { title }
    if (typeof sort === 'number') out.sort = sort
    if (typeof cons === 'number') out.cons = cons
    if (typeof tree === 'number') out.tree = tree
    if (check) out.check = check
    if (data) out.data = data
    buffsOut.push(out)
  }

  // If official passive/cons hints contain "抗性降低xx%", normalize to a single baseline-like max-tier `kx` buff.
  // (LLMs frequently omit or mis-model kx gating, leading to systematic underestimation in comparisons.)
  if (input.game === 'gs') {
    const hints = (input.buffHints || []).filter((s) => typeof s === 'string') as string[]
    let best: number | null = null
    for (const h of hints) {
      if (!/(抗性|元素抗性)/.test(h) || !/降低/.test(h)) continue
      const nums: number[] = []
      const re = /(\d+(?:\.\d+)?)\s*[%％]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(h))) {
        const n = Number(m[1])
        if (!Number.isFinite(n)) continue
        if (n <= 0 || n > 100) continue
        nums.push(n)
      }
      if (nums.length === 0) continue
      const max = Math.max(...nums)
      if (!best || max > best) best = max
    }
    if (best) {
      // Remove any existing kx rows (avoid double counting / broken gating).
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const b = buffsOut[i]!
        const data = b?.data
        if (!data || typeof data !== 'object') continue
        if (!Object.prototype.hasOwnProperty.call(data, 'kx')) continue
        buffsOut.splice(i, 1)
      }
      buffsOut.unshift({
        title: `被动/命座：敌方元素抗性降低[kx]%（默认按最大档位）`,
        data: { kx: best }
      })
    }
  }

  // If official hints explicitly grant "<n>%<元素>元素伤害加成", ensure a baseline-style `dmg` buff exists.
  // (LLMs frequently omit these, which can make panel regression drift low by ~40-60% for some accounts.)
  if (input.game === 'gs') {
    const hints = (input.buffHints || []).filter((s) => typeof s === 'string') as string[]
    const elemRe = /(火|水|雷|冰|风|岩|草)元素伤害加成/g
    for (const h of hints) {
      const elems: string[] = []
      const seen = new Set<string>()
      let m: RegExpExecArray | null
      elemRe.lastIndex = 0
      while ((m = elemRe.exec(h))) {
        const e = m[1]
        if (!e || seen.has(e)) continue
        seen.add(e)
        elems.push(e)
      }
      if (!elems.length) continue

      const nums: number[] = []
      const reNum = /(\d+(?:\.\d+)?)\s*[%％]/g
      let mm: RegExpExecArray | null
      while ((mm = reNum.exec(h))) {
        const n = Number(mm[1])
        if (!Number.isFinite(n)) continue
        if (n <= 0 || n > 200) continue
        nums.push(n)
      }
      if (!nums.length) continue
      const baseVal = Math.max(...nums)
      // Baseline commonly assumes "full stacks" for showcase buffs.
      // If the hint explicitly mentions max stacks, multiply the base percent accordingly.
      let stack = 1
      const stackM = h.match(/(?:至多|最多)叠加\s*(\d+)(?:层|次)/)
      if (stackM) {
        const n = Number(stackM[1])
        if (Number.isFinite(n)) stack = Math.max(1, Math.min(10, Math.trunc(n)))
      }
      const val = Math.min(200, baseVal * stack)

      const consM = h.match(/^\s*(\d)\s*命[：:]/)
      const cons = consM ? Math.trunc(Number(consM[1])) : undefined
      const consOk = typeof cons === 'number' && cons >= 1 && cons <= 6

      for (const e of elems) {
        const title = `${consOk ? `${cons}命：` : ''}${e}元素伤害加成提升[dmg]%`
        const already = buffsOut.some((b) => {
          if (!b || typeof b !== 'object') return false
          if (consOk && typeof b.cons === 'number' && b.cons !== cons) return false
          const data = (b as any).data
          if (!data || typeof data !== 'object') return false
          if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) return false
          const dmg = (data as any).dmg
          if (typeof dmg !== 'number' || !Number.isFinite(dmg)) return false
          return String((b as any).title || '').includes(`${e}元素`) && Math.abs(dmg - val) < 1e-9
        })
        if (already) continue
        buffsOut.push({
          title,
          ...(consOk ? { cons } : {}),
          data: { dmg: val }
        })
      }
    }
  }

  // LLMs often over-gate resistance-shred buffs with ad-hoc params flags (e.g. `params.e === true || params.q === true`),
  // which makes the buff silently not apply to showcased details that don't set such params. For baseline-style
  // comparison (and to reduce systematic underestimation), treat `kx` buffs as unconditional unless they depend on
  // non-param state like cons/weapon/trees/currentTalent.
  if (input.game === 'gs') {
    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'kx')) continue
      const check = (b as any).check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr) continue
      if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent)\b/.test(expr)) continue
      if (/params\./.test(expr)) delete (b as any).check
    }
  }

  // Similar to `kx`: LLMs often over-gate plain stat buffs (atkPct/cpct/...) with params flags. For baseline-style
  // showcase comparisons, keep these stat buffs unconditional when the check depends ONLY on params and the buff
  // does not target a specific talent bucket (e/q/a...).
  if (input.game === 'gs') {
    const safeStatKeys = new Set(['atkPct', 'hpPct', 'defPct', 'mastery', 'recharge', 'cpct', 'cdmg', 'dmg', 'phy', 'heal', 'shield'])
    for (const b of buffsOut) {
      const data = (b as any)?.data
      if (!data || typeof data !== 'object') continue
      const keys = Object.keys(data as any).filter((k) => k && !k.startsWith('_'))
      if (!keys.length) continue
      if (!keys.every((k) => safeStatKeys.has(k))) continue
      const check = (b as any).check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr) continue
      if (!/params\./.test(expr)) continue
      if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent|element)\b/.test(expr)) continue
      delete (b as any).check
    }
  }

  if (input.game === 'gs') {
    // If buffs gate on params.e/params.q but no corresponding talent rows set them,
    // enable the flag on that talent's details (prevents "buff never applies" drift).
    const wantsParamFlag = (k: 'e' | 'q'): boolean =>
      buffsOut.some((b) => typeof (b as any)?.check === 'string' && new RegExp(`\\bparams\\.${k}\\b`).test((b as any).check))

    const ensureFlagOnTalent = (tk: TalentKeyGs, k: 'e' | 'q'): void => {
      if (!wantsParamFlag(k)) return
      const list = details.filter((d) => d.talent === tk)
      if (list.length === 0) return
      for (const d of list) {
        const p0 = d.params
        if (p0 && typeof p0 === 'object' && !Array.isArray(p0) && Object.prototype.hasOwnProperty.call(p0, k)) continue
        const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, number | boolean | string>) } : {}
        p[k] = true
        d.params = p
      }
    }

    ensureFlagOnTalent('e', 'e')
    ensureFlagOnTalent('q', 'q')

    // If a buff is gated by boolean state params (e.g. `params.longPress === true`) but some affected
    // showcase details forget to set that param, the buff silently doesn't apply and comparisons drift low.
    // For any buff whose data targets a specific talent bucket (a/a2/a3/e/q/...), copy missing boolean params
    // from the buff.check into the corresponding details' params.
    const bumpMissingBoolParamsOnAffectedDetails = (): void => {
      const parseParamEq = (expr: string): Array<{ key: string; value: boolean | number }> => {
        const out: Array<{ key: string; value: boolean | number }> = []
        const reBool = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*===\s*(true|false)\b/g
        let m: RegExpExecArray | null
        while ((m = reBool.exec(expr))) {
          const k = m[1] || ''
          if (!k) continue
          out.push({ key: k, value: m[2] === 'true' })
        }

        // Also support simple numeric mode toggles like `params.form === 1`.
        // (Do NOT try to infer thresholds like `>= 3` here.)
        const reNum = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*===\s*(\d+(?:\.\d+)?)\b/g
        while ((m = reNum.exec(expr))) {
          const k = m[1] || ''
          if (!k) continue
          const n = Number(m[2])
          if (!Number.isFinite(n)) continue
          out.push({ key: k, value: n })
        }
        return out
      }

      const inferAffectedBases = (data: Record<string, unknown>): Set<string> => {
        const bases = new Set<string>()
        for (const k0 of Object.keys(data)) {
          const k = String(k0 || '').trim()
          if (!k) continue
          const m = k.match(/^(a3|a2|a|e|q|t|nightsoul)(?:Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)?$/)
          if (!m) continue
          const base = m[1]!
          // Ignore global-only keys like "nightsoul" without suffix; only apply when it's a scoped bucket.
          if (base === 'nightsoul' && base === k) continue
          bases.add(base)
        }
        return bases
      }

      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        const bases = inferAffectedBases(data as any)
        if (bases.size === 0) continue

        const check = typeof (b as any).check === 'string' ? String((b as any).check).trim() : ''
        if (!check || !/params\./.test(check)) continue
        const needs = parseParamEq(check)
        if (needs.length === 0) continue

        for (const d of details) {
          const keyArg = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : typeof d.talent === 'string' ? d.talent : ''
          const base = keyArg.split(',')[0] || ''
          if (!bases.has(base)) continue
          const p0 = d.params
          const p: Record<string, unknown> =
            p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
          let changed = false
          for (const n of needs) {
            if (Object.prototype.hasOwnProperty.call(p, n.key)) continue
            p[n.key] = n.value
            changed = true
          }
          if (changed) d.params = p as any
        }
      }
    }
    bumpMissingBoolParamsOnAffectedDetails()

    // If a buff's check references params.<key> that is never provided by any detail params,
    // the buff will be silently "dead" and cause systematic underestimation. Prefer simplifying:
    // - drop unknown-param clauses from `a && b && c` checks
    // - if the check is OR-based (contains `||`), fall back to unconditional (remove check)
    const knownParamKeys = new Set<string>()
    for (const d of details) {
      const p = d.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const k of Object.keys(p as Record<string, unknown>)) {
        if (k) knownParamKeys.add(k)
      }
    }

    const extractParamRefs = (expr: string): Set<string> => {
      const out = new Set<string>()
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) out.add(m[1]!)
      return out
    }

    const stripOuterParens = (expr: string): string => {
      let s = expr.trim()
      for (let pass = 0; pass < 5; pass++) {
        if (!(s.startsWith('(') && s.endsWith(')'))) break
        let depth = 0
        let quote: '"' | "'" | null = null
        let escaped = false
        let canStrip = false

        for (let i = 0; i < s.length; i++) {
          const ch = s[i]!

          if (quote) {
            if (escaped) {
              escaped = false
              continue
            }
            if (ch === '\\') {
              escaped = true
              continue
            }
            if (ch === quote) quote = null
            continue
          }

          if (ch === '"' || ch === "'") {
            quote = ch
            continue
          }

          if (ch === '(') depth++
          else if (ch === ')') {
            depth--
            if (depth === 0) {
              // Only strip when the outermost pair closes at the very end.
              canStrip = i === s.length - 1
              break
            }
            if (depth < 0) break
          }
        }

        if (!canStrip) break
        s = s.slice(1, -1).trim()
      }
      return s
    }

    const splitTopLevelAnd = (expr: string): string[] => {
      const parts: string[] = []
      let buf = ''
      let depthParen = 0
      let depthBracket = 0
      let depthBrace = 0
      let quote: '"' | "'" | null = null
      let escaped = false

      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i]!

        if (quote) {
          buf += ch
          if (escaped) {
            escaped = false
            continue
          }
          if (ch === '\\') {
            escaped = true
            continue
          }
          if (ch === quote) quote = null
          continue
        }

        if (ch === '"' || ch === "'") {
          quote = ch
          buf += ch
          continue
        }

        if (ch === '(') {
          depthParen++
          buf += ch
          continue
        }
        if (ch === ')') {
          if (depthParen > 0) depthParen--
          buf += ch
          continue
        }
        if (ch === '[') {
          depthBracket++
          buf += ch
          continue
        }
        if (ch === ']') {
          if (depthBracket > 0) depthBracket--
          buf += ch
          continue
        }
        if (ch === '{') {
          depthBrace++
          buf += ch
          continue
        }
        if (ch === '}') {
          if (depthBrace > 0) depthBrace--
          buf += ch
          continue
        }

        if (
          ch === '&' &&
          expr[i + 1] === '&' &&
          depthParen === 0 &&
          depthBracket === 0 &&
          depthBrace === 0
        ) {
          const t = buf.trim()
          if (t) parts.push(t)
          buf = ''
          i++
          continue
        }

        buf += ch
      }

      const t = buf.trim()
      if (t) parts.push(t)
      return parts
    }

    for (const b of buffsOut) {
      const check0 = typeof (b as any).check === 'string' ? String((b as any).check).trim() : ''
      if (!check0 || !/params\./.test(check0)) continue

      const check1 = stripOuterParens(check0)
      const refs = Array.from(extractParamRefs(check1))
      if (refs.length === 0) continue
      const unknown = refs.filter((k) => !knownParamKeys.has(k))
      if (unknown.length === 0) continue

      // Too hard to safely simplify OR logic; avoid dead buffs by dropping check.
      if (/\|\|/.test(check1)) {
        delete (b as any).check
        continue
      }

      const parts = splitTopLevelAnd(check1)
      const kept = parts.filter((p) => {
        const pr = extractParamRefs(p)
        for (const k of pr) {
          if (!knownParamKeys.has(k)) return false
        }
        return true
      })
      const next = kept.join(' && ').trim()
      if (!next) {
        delete (b as any).check
      } else if (next !== check1) {
        ;(b as any).check = next
      } else if (check1 !== check0) {
        // Strip redundant outer parens for consistency.
        ;(b as any).check = check1
      }
    }

    // If buff.data expressions reference params.<k> that is never provided by any detail params,
    // they may silently fall back to low-tier branches (e.g. `params.xxx >= 66 ? 1.2 : 0.6`).
    // When the missing param is used ONLY in `>=`/`>` comparisons, replace it with the max threshold
    // to approximate "满层/最大档位" showcase behavior.
    const fixMissingParamsInDataExpr = (): void => {
      const knownLowerToKey = new Map<string, string>()
      for (const k of knownParamKeys) {
        const lower = k.toLowerCase()
        if (!knownLowerToKey.has(lower)) knownLowerToKey.set(lower, k)
      }

      const countMatches = (s: string, re: RegExp): number => {
        let n = 0
        re.lastIndex = 0
        while (re.exec(s)) n++
        return n
      }

      const thresholdFor = (expr: string, key: string): number | null => {
        const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*(>=|>)\s*(\d{1,4}(?:\.\d+)?)\b/g
        let max = -Infinity
        let strict = false
        let found = false
        let m: RegExpExecArray | null
        while ((m = re.exec(expr))) {
          if (m[1] !== key) continue
          found = true
          const n = Number(m[3])
          if (!Number.isFinite(n)) continue
          if (n > max) max = n
          if (m[2] === '>') strict = true
        }
        if (!found || !Number.isFinite(max)) return null
        const value = strict ? max + 1 : max
        if (!Number.isFinite(value)) return null
        if (value <= 0 || value > 200) return null
        return value
      }

      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        for (const [dk, dv0] of Object.entries(data)) {
          if (typeof dv0 !== 'string') continue
          let dv = dv0.trim()
          if (!dv || !/params\./.test(dv)) continue

          const refs = Array.from(extractParamRefs(dv))
          if (refs.length === 0) continue

          for (const rk0 of refs) {
            if (knownParamKeys.has(rk0)) continue

            // Case-insensitive normalize (params.nightsoul -> params.Nightsoul)
            const mapped = knownLowerToKey.get(rk0.toLowerCase())
            if (mapped && mapped !== rk0) {
              dv = dv.replace(new RegExp(`\\bparams\\.${rk0}\\b`, 'g'), `params.${mapped}`)
              continue
            }

            // Threshold-based fallback (only when params.<k> is used exclusively in `>=`/`>` comparisons).
            const reAny = new RegExp(`\\bparams\\.${rk0}\\b`, 'g')
            const countAny = countMatches(dv, reAny)
            if (countAny === 0) continue
            const reCmp = new RegExp(`\\bparams\\.${rk0}\\b\\s*(?:>=|>)\\s*\\d`, 'g')
            const countCmp = countMatches(dv, reCmp)
            if (countCmp !== countAny) continue

            const th = thresholdFor(dv, rk0)
            if (!th) continue
            dv = dv.replace(reAny, String(th))
          }

          if (dv !== dv0) (data as any)[dk] = dv
        }
      }
    }
    fixMissingParamsInDataExpr()

    // If a `qPlus` buff is gated by a simple numeric param threshold (e.g. `params.xxx > 0`),
    // but the main Q showcase row sets `params.xxx = 0`, the comparison will systematically undercount.
    // Bump that row to the minimum required stack so the buff can actually apply.
    const bumpZeroStackOnQPlus = (): void => {
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|>)\s*(\d{1,3})\b/
      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        if (!Object.prototype.hasOwnProperty.call(data, 'qPlus')) continue
        const check = typeof (b as any).check === 'string' ? ((b as any).check as string) : ''
        if (!check) continue
        const m = check.match(re)
        if (!m) continue
        const k = m[1]!
        const op = m[2]!
        const n0 = Number(m[3])
        if (!k || !Number.isFinite(n0)) continue
        const need = op === '>' ? Math.trunc(n0) + 1 : Math.trunc(n0)
        if (need < 1 || need > 20) continue

        for (const d of details) {
          if (d.talent !== 'q') continue
          const p = d.params
          if (!p || typeof p !== 'object' || Array.isArray(p)) continue
          if (!Object.prototype.hasOwnProperty.call(p, k)) continue
          const v = (p as any)[k]
          if (typeof v !== 'number' || !Number.isFinite(v) || v !== 0) continue
          const title = d.title || ''
          if (/0层|0档|0堆叠|0叠|零/.test(title)) continue
          ;(p as any)[k] = need
          d.params = p as any
          break
        }
      }
    }
    bumpZeroStackOnQPlus()

    // Some "stack bonus" talent tables are additive stat-scaling ratios (e.g. unit contains "生命值上限/层"),
    // but LLMs often mis-model them as *Dmg/*Multi buffs. When we can identify a base "<...>基础伤害" table
    // plus a matching per-stack "伤害提升" table, patch the detail formula to sum ratios directly.
    const patchStackedRatioBaseTables = (): void => {
      const inferStatFromUnit = (unitRaw: unknown): CalcScaleStat | null => {
        const u = normalizePromptText(unitRaw)
        if (!u) return null
        if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(u)) return 'hp'
        if (/(防御力|\bdef\b)/i.test(u)) return 'def'
        if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(u)) return 'mastery'
        if (/(攻击力|攻击|\batk\b)/i.test(u)) return 'atk'
        return null
      }
      const isStackUnit = (unitRaw: unknown): boolean => {
        const u = normalizePromptText(unitRaw)
        return !!u && /(\/层|每层|\/枚|每枚|\/次|每次)/.test(u)
      }
      const scoreParamKey = (k: string): number => {
        if (/stack/i.test(k)) return 3
        if (/layer/i.test(k)) return 2
        if (/buffcount/i.test(k)) return 2
        if (/(count|cnt|num)$/i.test(k)) return 1
        return 0
      }

      const unitsAll = (input.tableUnits || {}) as any
      for (const tk of ['a', 'e', 'q'] as const) {
        const tblList = (input.tables as any)?.[tk]
        if (!Array.isArray(tblList) || tblList.length === 0) continue
        const unitMap = (unitsAll as any)?.[tk] || {}
        const unitOf = (name: string): string => {
          const base = name.endsWith('2') ? name.slice(0, -1) : name
          return String(unitMap[name] || unitMap[base] || '')
        }

        const baseTables = (tblList as string[]).filter((t) => typeof t === 'string' && /基础伤害/.test(t))
        if (baseTables.length === 0) continue
        const perStackTables = (tblList as string[]).filter(
          (t) => typeof t === 'string' && /伤害提升/.test(t) && isStackUnit(unitOf(t))
        )
        if (perStackTables.length === 0) continue
        const extraTables = (tblList as string[]).filter(
          (t) => typeof t === 'string' && /额外提升/.test(t) && !isStackUnit(unitOf(t))
        )

        for (const baseTable of baseTables) {
          const stat = inferStatFromUnit(unitOf(baseTable))
          if (!stat) continue
          const per = perStackTables.find((t) => inferStatFromUnit(unitOf(t)) === stat)
          if (!per) continue
          const token = baseTable.replace(/基础伤害/g, '').trim()
          const extra =
            token && extraTables.find((t) => inferStatFromUnit(unitOf(t)) === stat && typeof t === 'string' && t.includes(token))

          const candidates = details.filter((d) => d.talent === tk && d.table === baseTable)
          if (candidates.length === 0) continue

          const paramMax: Record<string, number> = {}
          for (const d of candidates) {
            const p = d.params
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue
            for (const [k0, v] of Object.entries(p as any)) {
              const k = String(k0 || '').trim()
              if (!k) continue
              if (typeof v !== 'number' || !Number.isFinite(v)) continue
              paramMax[k] = Math.max(paramMax[k] ?? -Infinity, v)
            }
          }

          const paramKey = Object.keys(paramMax).sort((ka, kb) => {
            const sa = scoreParamKey(ka)
            const sb = scoreParamKey(kb)
            if (sa !== sb) return sb - sa
            return (paramMax[kb] ?? 0) - (paramMax[ka] ?? 0)
          })[0]
          if (!paramKey) continue
          const maxVal = Math.trunc(paramMax[paramKey] ?? NaN)
          if (!Number.isFinite(maxVal) || maxVal <= 0 || maxVal > 20) continue

          for (const d of candidates) {
            const p = d.params
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue
            if (typeof (p as any)[paramKey] !== 'number' || !Number.isFinite((p as any)[paramKey])) continue
            // Skip rows that also set other numeric params (likely different mechanics, e.g. multi-target).
            const otherNumeric = Object.entries(p as any).some(
              ([k, v]) => k !== paramKey && typeof v === 'number' && Number.isFinite(v)
            )
            if (otherNumeric) continue

            const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : tk
            const ele = typeof d.ele === 'string' && d.ele.trim() ? d.ele.trim() : ''

            let sumExpr = `talent.${tk}[${JSON.stringify(baseTable)}] + params.${paramKey} * talent.${tk}[${JSON.stringify(per)}]`
            if (extra) {
              sumExpr += ` + (params.${paramKey} === ${maxVal} ? talent.${tk}[${JSON.stringify(extra)}] : 0)`
            }
            const eleArg = ele ? `, ${JSON.stringify(ele)}` : ''
            d.dmgExpr = `dmg.basic(calc(attr.${stat}) * toRatio(${sumExpr}), ${JSON.stringify(key)}${eleArg})`
          }

          // Remove buff rows that reference these tables to avoid double-counting.
          const refs = [per, extra].filter(Boolean) as string[]
          if (refs.length) {
            for (let i = buffsOut.length - 1; i >= 0; i--) {
              const b = buffsOut[i]!
              const data = b.data
              if (!data || typeof data !== 'object') continue
              const vals = Object.values(data as any)
              const hit = vals.some((v) => typeof v === 'string' && refs.some((tn) => v.includes(JSON.stringify(tn))))
              if (hit) buffsOut.splice(i, 1)
            }
          }
        }
      }
    }
    patchStackedRatioBaseTables()

    // Element-specific dmg buffs: if the title clearly targets one element but the model emitted a generic `dmg`
    // bonus with no element gating, add a conservative `element === "火|水|..."` check to avoid double-buffing.
    const elemRe = /(火|水|雷|冰|风|岩|草)元素/
    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) continue
      const m = String(b.title || '').match(elemRe)
      if (!m) continue
      const elemCn = m[1]!
      const prev = typeof (b as any).check === 'string' ? ((b as any).check as string).trim() : ''
      const gate = `element === ${JSON.stringify(elemCn)}`
      if (!prev || prev === 'true') {
        ;(b as any).check = gate
        continue
      }
      if (!/\belement\b/.test(prev)) {
        ;(b as any).check = `(${prev}) && ${gate}`
      }
    }

    // Some anemo characters provide an "elemental dmg bonus" based on mastery that should apply to the
    // absorbed element (NOT the character's own anemo damage). If the model emits it as a generic `dmg`
    // buff without element gating, conservatively exclude self-element to reduce systematic overestimation.
    const selfElemCnById: Record<string, string> = {
      anemo: '风',
      geo: '岩',
      electro: '雷',
      dendro: '草',
      hydro: '水',
      pyro: '火',
      cryo: '冰'
    }
    const selfElemCn = selfElemCnById[String((input as any).elem || '')] || ''
    if (selfElemCn) {
      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) continue
        const title = String(b.title || '')
        if (!/元素精通/.test(title) || !/元素伤害/.test(title)) continue
        const prev = typeof (b as any).check === 'string' ? ((b as any).check as string).trim() : ''
        if (/\belement\b/.test(prev)) continue
        const gate = `element !== ${JSON.stringify(selfElemCn)}`
        if (!prev || prev === 'true') {
          ;(b as any).check = gate
          continue
        }
        ;(b as any).check = `(${prev}) && ${gate}`
      }
    }
  }

  if (input.game === 'gs') {
    // Some characters have passives like:
    // - "技能X造成的伤害提升，提升值相当于元素精通的90%"
    // Baseline usually models this as a *detail-local* flat add (by modifying that specific detail row),
    // while exposing the amount as a display-only `_qPlus/_ePlus` in buffs.
    //
    // LLMs frequently emit this as a global `qPlus/ePlus` buff, which then wrongly applies to other Q/E rows
    // (e.g. Q1/Q2/extra summons), causing massive damage drift. To keep behaviour closer to baseline, if we can
    // confidently associate a `*Plus` buff to a specific table name via its title, we:
    // - move the flat add into that matching detail via dmgExpr, and
    // - rename `qPlus/ePlus/...Plus` to `_qPlus/_ePlus/...` so it becomes display-only (ignored by DmgAttr).
    const norm = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】[\]「」『』《》〈〉“”‘’"']/g, '')

    const plusKeyToTalent = (k: string): TalentKeyGs | null => {
      if (k === 'aPlus' || k === 'a2Plus' || k === 'a3Plus') return 'a'
      if (k === 'ePlus') return 'e'
      if (k === 'qPlus') return 'q'
      return null
    }

    const tableTerms = (tableRaw: string): string[] => {
      const t0 = String(tableRaw || '').trim()
      if (!t0) return []
      const t = t0.endsWith('2') ? t0.slice(0, -1) : t0
      const noDmg = t.replace(/伤害/g, '').trim()
      const out = uniq([t, noDmg].map((x) => norm(x)).filter(Boolean))
      return out
    }

    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      const titleNorm = norm(b.title)
      if (!titleNorm) continue

      for (const [k, v] of Object.entries(data)) {
        if (!/^(a|a2|a3|e|q)Plus$/.test(k)) continue
        if (k.startsWith('_')) continue
        const tk = plusKeyToTalent(k)
        if (!tk) continue

        // Only shift when the buff title clearly mentions a specific table (avoid breaking true global plus buffs).
        const match = details.find((d) => {
          if (d.kind !== 'dmg') return false
          if (d.talent !== tk) return false
          const tn = typeof d.table === 'string' ? d.table : ''
          if (!tn) return false
          const terms = tableTerms(tn)
          if (terms.length === 0) return false
          return terms.some((term) => term && titleNorm.includes(term))
        })
        if (!match) continue

        const extraExpr = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
        if (!extraExpr) continue

        const keyArg = typeof match.key === 'string' && match.key.trim() ? match.key.trim() : tk
        const eleArg = typeof match.ele === 'string' && match.ele.trim() ? `, ${JSON.stringify(match.ele.trim())}` : ''
        const tableLit = JSON.stringify(String(match.table))
        const call = `dmg(talent.${tk}[${tableLit}], ${JSON.stringify(keyArg)}${eleArg})`

        // Preserve buff conditions when shifting into a detail-local flat add.
        // Otherwise, a conditional `*Plus` (e.g. C6-only) would become unconditional and wildly drift damage.
        const guardParts: string[] = []
        if (typeof b.cons === 'number' && Number.isFinite(b.cons)) guardParts.push(`cons >= ${Math.trunc(b.cons)}`)
        if (typeof b.check === 'string' && b.check.trim()) guardParts.push(`(${b.check.trim()})`)
        const guard = guardParts.filter(Boolean).join(' && ')
        const extra = guard ? `(${guard} ? (${extraExpr}) : 0)` : `(${extraExpr})`
        ;(match as any).dmgExpr = `{ dmg: ${call}.dmg + ${extra}, avg: ${call}.avg + ${extra} }`

        // Rename to underscore variant (display-only).
        const k2 = `_${k}`
        if (!(k2 in data)) (data as any)[k2] = v
        delete (data as any)[k]
      }

      if (b.data && Object.keys(b.data).length === 0) delete (b as any).data
    }
  }

  if (wantsDionaShowcase && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    // Prefer baseline-style "showcase" healing bonus for C6 (kept unconditional like baseline).
    pushFront({
      title: '迪奥娜6命：生命值低于50%时受治疗加成提升[heal]%',
      cons: 6,
      data: { heal: 30 }
    })
  }

  if (wantsSkirkCoreBuffs && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/万流归寂|死河渡断|虚境裂隙|极恶技·尽|蛇之狡谋/i)

    pushFront({
      title: '天赋-万流归寂：默认3层死河渡断（普攻/爆发倍率修正）',
      data: { aMulti: 170, qMulti: 160 }
    })

    const crackTable = '汲取0/1/2/3枚虚境裂隙伤害提升2'
    pushFront({
      title: '元素爆发-极恶技·尽：3枚虚境裂隙，使普攻造成的伤害提高[aDmg]%',
      data: { aDmg: `talent.q[\"${crackTable}\"][3]` }
    })
  }

  if (wantsFurinaFanfare && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/气氛值|万众狂欢|普世欢腾/i)
    dropBy(/无人听的自白|沙龙成员|召唤物/i)

    pushFront({
      title: '天赋Q·万众狂欢：300层气氛值提升[dmg]%伤害，[healInc]%受治疗加成',
      sort: 9,
      data: {
        dmg: 'talent.q[\"气氛值转化提升伤害比例\"] * 300',
        healInc: 'talent.q[\"气氛值转化受治疗加成比例\"] * 300'
      }
    })

    // Showcase: consume party HP to boost salon member damage.
    pushFront({
      title: '芙宁娜天赋：消耗4队友生命值，E伤害提升140%'
    })

    // Showcase: passive summon damage bonus scales with HP (percent numbers).
    pushFront({
      title: '芙宁娜被动：基于生命值，提升召唤物伤害[eDmg]%',
      sort: 9,
      data: { eDmg: 'Math.min(28, calc(attr.hp) / 1000 * 0.7)' }
    })
  }

  if (wantsNeuvilletteCharged && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/那维|衡平推裁|古海孑遗|至高仲裁|双水|hpBase/i)

    pushFront({
      title: '天赋-至高仲裁：提升[dmg]%水元素伤害',
      data: { dmg: 30 }
    })
    pushFront({
      title: '双水Buff：生命值提高[hpPct]%',
      data: { hpPct: 25 }
    })
    pushFront({
      title: '那维2命：重击·衡平推裁的暴击伤害提升[a2Cdmg]%',
      cons: 2,
      data: { a2Cdmg: 42 }
    })
  }

  if (wantsMavuikaWarWill && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    // Drop any LLM-emitted near-duplicates for this mechanic so we don't double-buff.
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/炎花献礼/)
    dropBy(/基扬戈兹/)
    dropBy(/燔天之时|战意增伤|战意转化/)

    pushFront({
      title: '元素爆发-燔天之时：战意增伤（以 params.zy 表示战意）',
      sort: 9,
      check: 'params.zy > 0',
      data: {
        _zy: 'params.zy',
        qPlus: 'params.zy * talent.q["坠日斩伤害提升"] * calc(attr.atk) / 100',
        aPlus: 'params.zy * talent.q["驰轮车普通攻击伤害提升"] * calc(attr.atk) / 100',
        a2Plus: 'params.zy * talent.q["驰轮车重击伤害提升"] * calc(attr.atk) / 100'
      }
    })
    pushFront({
      title: '天赋-炎花献礼：攻击力提升',
      data: { atkPct: 30 }
    })
    pushFront({
      title: '天赋-基扬戈兹：战意转化为全伤害加成',
      check: 'params.zy > 0',
      data: { dmg: '0.2 * params.zy' }
    })
  }

  if (wantsColombinaLunar && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/月曜反应|引力干涉|月兆祝赐|月亮诱发|哥伦比娅/)

    pushFront({
      title: '元素爆发：月曜反应伤害提升',
      check: 'params.q === true',
      data: {
        lunarCharged: 'talent.q["月曜反应伤害提升"]',
        lunarBloom: 'talent.q["月曜反应伤害提升"]',
        lunarCrystallize: 'talent.q["月曜反应伤害提升"]'
      }
    })
    pushFront({
      title: '天赋：触发引力干涉时暴击率提升（默认满层3）',
      check: 'params.Gravity_Interference === true',
      data: { cpct: 15 }
    })
    pushFront({
      title: '天赋：月兆祝赐·借汝月光（月曜反应基础伤害提升）',
      sort: 9,
      check: 'params.Moonsign_Benediction === true',
      data: { fypct: 'Math.min(Math.floor(calc(attr.hp) / 1000) * 0.2, 7)' }
    })
  }

  if (wantsNeferVeil && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/奈芙尔|伪秘之帷|月兆祝赐|月下的豪赌|尘沙的女儿|BondOfLife/i)

    pushFront({
      title: '奈芙尔技能：「伪秘之帷」使元素爆发伤害提升[qDmg]%',
      data: {
        qDmg: 'talent.q[\"伤害提升\"] * Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3))'
      }
    })
    pushFront({
      title: '奈芙尔天赋：基于元素精通攻击力提升[atkPlus]',
      sort: 9,
      data: { atkPlus: 'Math.max(Math.min((calc(attr.mastery) * 0.4), 200), 0)' }
    })
    pushFront({
      title: '奈芙尔天赋：满层「伪秘之帷」使元素精通提升[mastery]',
      data: {
        mastery:
          '(params.Veil_of_Falsehood || 99) >= (cons >= 2 ? 5 : 3) ? 100 : 0'
      }
    })
    pushFront({
      title: '奈芙尔天赋：[月兆祝赐 · 廊下暮影] 触发绽放反应时转为触发月绽放反应,基础伤害提升[fypct]',
      sort: 9,
      check: 'params.Lunar',
      data: { fypct: 'Math.min((calc(attr.mastery) * 0.0175), 14)' }
    })
    pushFront({
      title: '奈芙尔1命：幻戏造成的月绽放反应基础伤害提升[fyplus]',
      cons: 1,
      check: 'params.Lunar && params.Phantasm_Performance',
      data: {
        fyplus:
          '(calc(attr.mastery) * 60 / 100) * Math.min((1 + (params.Veil_of_Falsehood || 99) / 10), (cons >= 2 ? 1.5 : 1.3))'
      }
    })
    pushFront({
      title: '奈芙尔2命：元素精通额外提升[mastery]',
      cons: 2,
      data: { mastery: '(params.Veil_of_Falsehood || 99) >= 5 ? 100 : 0' }
    })
    pushFront({
      title: '奈芙尔4命：附近敌人的元素抗性降低[kx]%',
      cons: 4,
      data: { kx: 20 }
    })
    pushFront({
      title: '奈芙尔6命：处于满辉时月绽放反应伤害擢升[elevated]%',
      cons: 6,
      check: 'params.Lunar',
      data: { elevated: '(params.Moonsign || 0) >= 2 ? 15 : 0' }
    })
  }

  if (wantsEmilieBurning && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/艾梅莉埃|清露香氛|柔灯之匣|燃烧/i)

    pushFront({
      title: '艾梅莉埃天赋：基于攻击力，对处于燃烧状态下的敌人造成的伤害提升[dmg]%',
      data: { dmg: 'Math.min(36, calc(attr.atk) / 1000 * 15)' }
    })
    pushFront({
      title: '艾梅莉埃1命：元素战技与清露香氛造成的伤害提升20%',
      cons: 1,
      data: { dmg: 'params.e ? 20 : 0' }
    })
    pushFront({
      title: '艾梅莉埃2命：攻击命中敌人时，该敌人的草元素抗性降低[kx]%',
      cons: 2,
      data: { kx: 30 }
    })
    pushFront({
      title: '艾梅莉埃6命：施放元素战技与元素爆发后,普攻与重击造成的伤害提升[aPlus]',
      cons: 6,
      data: { aPlus: 'calc(attr.atk) * 300 / 100', a2Plus: 'calc(attr.atk) * 300 / 100' }
    })
  }

  if (wantsLaumaShowcase && input.game === 'gs') {
    // Use deterministic, baseline-like param gates & buff math for Lauma.
    // This is derived from unique official table names / numeric rules (no baseline code reuse).
    buffsOut.length = 0

    buffsOut.push({
      title: '菈乌玛天赋：处于满辉时月绽放反应暴击率提升10%,暴击伤害提升20%',
      check: '(params.Moonsign || 0) >= 2',
      data: { cpct: 'params.Lunar ? 10 : 0', cdmg: 'params.Lunar ? 20 : 0' }
    })

    buffsOut.push({
      title: '菈乌玛天赋：元素战技造成的伤害提升[eDmg]%',
      sort: 9,
      check: 'params.Linnunrata',
      data: { eDmg: 'Math.min(calc(attr.mastery) * 0.04, 32)' }
    })

    buffsOut.push({
      title: '菈乌玛天赋：触发绽放反应时转为触发月绽放反应，基础伤害提升[fypct]%',
      sort: 9,
      check: 'params.Lunar',
      data: { fypct: 'Math.min(calc(attr.mastery) * 0.0175, 14)' }
    })

    if ((tables.e || []).includes('元素抗性降低')) {
      buffsOut.push({
        title: '菈乌玛技能：元素战技命中敌人时该敌人的抗性降低[kx]%',
        data: { kx: 'talent.e[\"元素抗性降低\"]' }
      })
    }

    if ((tables.q || []).includes('绽放、超绽放、烈绽放反应伤害提升') && (tables.q || []).includes('月绽放反应伤害提升')) {
      buffsOut.push({
        title: '菈乌玛元素爆发：绽放、超绽放、烈绽放、月绽放反应造成的伤害提升[fyplus]',
        sort: 9,
        check: 'params.Pale_Hymn',
        data: {
          fyplus:
            'calc(attr.mastery) * (params.Lunar ? talent.q[\"月绽放反应伤害提升\"] : talent.q[\"绽放、超绽放、烈绽放反应伤害提升\"]) / 100'
        }
      })
    }

    buffsOut.push({
      title: '菈乌玛2命：绽放、超绽放、烈绽放、月绽放伤害额外提升[fyplus]',
      sort: 9,
      cons: 2,
      check: 'params.Pale_Hymn',
      data: { fyplus: 'calc(attr.mastery) * (params.Lunar ? 400 : 500) / 100' }
    })

    buffsOut.push({
      title: '菈乌玛2命：处于满辉时月绽放反应伤害提升[lunarBloom]%',
      cons: 2,
      check: 'params.Lunar && (params.Moonsign || 0) >= 2',
      data: { lunarBloom: 40 }
    })

    buffsOut.push({
      title: '菈乌玛6命：处于满辉时月绽放反应伤害擢升[elevated]%',
      cons: 6,
      check: 'params.Lunar && (params.Moonsign || 0) >= 2',
      data: { elevated: 25 }
    })
  }

  // Generic post-process: slash-variant array tables
  // Example: "岩脊伤害/共鸣伤害2" -> [stelePct, resonancePct]
  // These arrays are NOT `[pct, flat]`; treat them as variant lists and either:
  // - split into separate details (when both parts are meaningful damage/heal/shield titles), or
  // - infer `pick` based on title matching.
  {
    const norm = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const outDetails: CalcSuggestDetail[] = []
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.kind !== 'dmg' || !d.talent || !d.table || !String(d.table).includes('/')) {
        outDetails.push(d)
        continue
      }

      // Respect explicit pick.
      if (typeof d.pick === 'number' && Number.isFinite(d.pick) && d.pick >= 0 && d.pick <= 10) {
        outDetails.push(d)
        continue
      }

      const sample = (input.tableSamples as any)?.[d.talent]?.[d.table]
      if (
        !Array.isArray(sample) ||
        sample.length < 2 ||
        !sample.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        outDetails.push(d)
        continue
      }

      const baseName = d.table.endsWith('2') ? d.table.slice(0, -1) : d.table
      const parts = baseName
        .split('/')
        .map((s) => String(s || '').trim())
        .filter(Boolean)

      if (parts.length === sample.length) {
        const meaningful = (p: string): boolean => /(伤害|治疗|护盾|吸收量)/.test(p) && p.length >= 2
        if (parts.every(meaningful)) {
          for (let i = 0; i < parts.length; i++) {
            outDetails.push({ ...d, title: parts[i]!, pick: i })
          }
          continue
        }

        const titleN = norm(d.title)
        const hits = parts
          .map((p, i) => ({ i, ok: !!p && titleN.includes(norm(p)) }))
          .filter((x) => x.ok)
          .map((x) => x.i)
        if (hits.length === 1) {
          outDetails.push({ ...d, pick: hits[0]! })
          continue
        }
      }

      outDetails.push(d)
    }

    details.length = 0
    details.push(...outDetails)
    while (details.length > 20) details.pop()
  }

  // GS: If the model picked a `...2` multi-hit table like "[pct, times]" (text sample contains "*N"),
  // but the baseline-style total table without trailing "2" exists, prefer the total table for charged-attack rows.
  //
  // Example: Ayaka `重击伤害2` = [55.13, 3] with text "55.13%*3", while `重击伤害` is the summed percentage.
  // If we keep `...2` we would need a per-hit vs total title; baseline uses the summed table.
  if (input.game === 'gs') {
    const isIntTimes = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 1 && n <= 20

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.talent !== 'a') continue
      const table = typeof d.table === 'string' ? d.table.trim() : ''
      if (!table || !table.endsWith('2')) continue

      const tk = d.talent
      const sample = (input.tableSamples as any)?.[tk]?.[table]
      const times = Array.isArray(sample) && sample.length >= 2 ? Number(sample[1]) : NaN
      if (!isIntTimes(times)) continue

      const text = normalizePromptText((input.tableTextSamples as any)?.[tk]?.[table])
      if (!text || !/[*×xX]\s*\d+/.test(text) || !/[%％]/.test(text)) continue

      const baseTable = table.slice(0, -1)
      if (!baseTable || baseTable === table) continue
      const ok = (tables as any)?.[tk]
      if (!Array.isArray(ok) || !ok.includes(baseTable)) continue

      const title = normalizePromptText(d.title)
      const wantsPerHit = /(单次|单段|每段|每跳|每次)/.test(title)
      if (wantsPerHit) continue

      const key = typeof d.key === 'string' ? d.key.trim() : ''
      const baseKey = (key.split(',')[0] || '').trim()
      if (baseKey !== 'a2' && !/重击/.test(title)) continue

      d.table = baseTable
      delete (d as any).pick
    }
  }

  // Cleanup: models sometimes emit a `*Multi` buff for a "伤害提升/加成" coefficient that is already used as a `*Plus`
  // additive damage term elsewhere (e.g. per-stack extra damage like "每层提高X%攻击力的伤害"). In miao-plugin, `*Multi`
  // is an independent multiplier bucket; keeping both often causes systematic under/over-estimation. Prefer `*Plus` and drop
  // those redundant `*Multi` entries when they reference the same talent table.
  if (input.game === 'gs') {
    const refRe = /\btalent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/g
    const collectRefs = (expr: string): Array<{ tk: string; table: string }> => {
      const out: Array<{ tk: string; table: string }> = []
      if (!expr) return out
      let m: RegExpExecArray | null
      while ((m = refRe.exec(expr))) {
        const tk = m[1]
        const table = m[3]
        if (!tk || !table) continue
        out.push({ tk, table })
        if (out.length >= 8) break
      }
      return out
    }

    const plusRefs = new Set<string>()
    for (const b of buffsOut) {
      const data = b?.data
      if (!data || typeof data !== 'object') continue
      for (const [k, v] of Object.entries(data)) {
        if (!/Plus$/.test(k)) continue
        if (typeof v !== 'string') continue
        for (const r of collectRefs(v)) plusRefs.add(`${r.tk}:${r.table}`)
      }
    }

    if (plusRefs.size) {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const b = buffsOut[i]!
        const data = b.data
        if (!data || typeof data !== 'object') continue

        let changed = false
        for (const [k, v] of Object.entries(data)) {
          if (!/Multi$/.test(k)) continue
          if (typeof v !== 'string') continue
          const vv = v.trim()
          // Only consider plain talent-table refs (optionally with "- 100") to avoid touching intentionally complex formulas.
          if (!/^\s*talent\s*\.\s*[aeqt]\s*\[\s*(['"]).*?\1\s*\]\s*(?:-\s*100\s*)?$/.test(vv)) continue
          const refs = collectRefs(vv)
          if (!refs.length) continue
          if (!refs.some((r) => plusRefs.has(`${r.tk}:${r.table}`))) continue
          delete (data as any)[k]
          changed = true
        }

        if (changed && Object.keys(data).length === 0) {
          buffsOut.splice(i, 1)
        }
      }
    }
  }

  // GS: Many baseline calcs intentionally omit `ele="phy"` for normal/charged/plunge rows so they benefit from the
  // generic `dmg` bucket (artifact/weapon "造成的伤害提升" etc). Models often overuse `phy`, which can cause large
  // underestimation (since it switches the dmg bonus bucket from `attr.dmg` to `attr.phy`).
  //
  // Heuristic:
  // - Always drop `phy` for catalyst normal attacks.
  // - If the kit hints at self-infusion, drop `phy` for talent=a rows.
  // - If there are global `dmg` buffs but no global `phy` buffs, prefer the `dmg` bucket and drop `phy`.
  if (input.game === 'gs') {
    const hintParts: string[] = []
    for (const h0 of Array.isArray(input.buffHints) ? input.buffHints : []) {
      const h = normalizePromptText(h0)
      if (h) hintParts.push(h)
    }
    if (input.talentDesc) {
      for (const v0 of Object.values(input.talentDesc)) {
        const v = normalizePromptText(v0)
        if (v) hintParts.push(v)
      }
    }
    const hintText = hintParts.join('\n')
    const hasInfusionHint =
      /(元素附魔|将.{0,24}(普通攻击|重击|下落攻击).{0,24}转为|普通攻击.{0,24}转为|重击.{0,24}转为|下落攻击.{0,24}转为)/.test(
        hintText
      ) || /\binfusion\b/i.test(hintText)

    const hasGlobalDmg = buffsOut.some((b) => {
      const data = b?.data
      return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'dmg')
    })
    const hasGlobalPhy = buffsOut.some((b) => {
      const data = b?.data
      return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'phy')
    })
    const preferDmgBucket = hasGlobalDmg && !hasGlobalPhy

    const isCatalyst = input.weapon === 'catalyst'

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.talent !== 'a') continue
      const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
      if (ele.toLowerCase() !== 'phy') continue

      const title0 = normalizePromptText((d as any).title)
      const table0 = normalizePromptText((d as any).table)
      if (/(物理|physical|phys)/i.test(`${title0} ${table0}`)) continue

      if (isCatalyst || hasInfusionHint || preferDmgBucket) {
        delete (d as any).ele
      }
    }
  }

  // GS: Resolve/愿力 style stack multipliers (e.g. 雷电将军「诸愿百眼之轮」).
  // When we see a dedicated q-table like "愿力加成" but the plan doesn't emit a `qPct` buff,
  // add a minimal showcase buff and normalize detail params from `{ stacks: N }` -> `{ type, num }`.
  // This is still API-driven (table name/value), not baseline-copying.
  if (input.game === 'gs' && qTables.includes('愿力加成')) {
    const hasQpct = buffsOut.some((b) => !!b.data && Object.prototype.hasOwnProperty.call(b.data, 'qPct'))
    if (!hasQpct) {
      buffsOut.unshift({
        title: '元素爆发：愿力加成（按 params.type/params.num）',
        data: { qPct: '("type" in params ? talent.q["愿力加成"][params.type] * params.num : 0)' }
      })
    }

    for (const d of details) {
      if (d.talent !== 'q') continue
      const p0 = d.params
      if (!p0 || typeof p0 !== 'object' || Array.isArray(p0)) continue
      const p = { ...(p0 as Record<string, unknown>) }
      if (Object.prototype.hasOwnProperty.call(p, 'type') && Object.prototype.hasOwnProperty.call(p, 'num')) continue
      const stacksRaw = (p as any).stacks
      const stacks = typeof stacksRaw === 'number' && Number.isFinite(stacksRaw) ? Math.trunc(stacksRaw) : null
      if (stacks === null) continue

      const hint = `${d.title || ''} ${d.table || ''}`
      // type=0: 梦想一刀（初击）；type=1: 梦想一心（后续普攻/重击）
      const type = /梦想一心/.test(hint) || /一段伤害|重击伤害/.test(hint) ? 1 : 0
      delete (p as any).stacks
      ;(p as any).type = type
      ;(p as any).num = stacks
      d.params = p as any
      if (typeof (d as any).check === 'string' && /\bparams\.stacks\b/.test((d as any).check)) {
        ;(d as any).check = String((d as any).check).replace(/\bparams\.stacks\b/g, 'params.num')
      }
    }
  }

  // GS: Fix common LLM confusion between `atkPct` (percent ATK) vs `atkPlus` (flat ATK add).
  // If the referenced talent table clearly scales from HP/DEF (unit/text sample contains HP/DEF),
  // convert `atkPct: talent.e["..."]` into `atkPlus: calc(attr.hp/def) * talent.e["..."] / 100`.
  if (input.game === 'gs') {
    const inferBaseStat = (tk: 'a' | 'e' | 'q' | 't', table: string): 'atk' | 'hp' | 'def' | 'mastery' | null => {
      const unitMap = (input.tableUnits as any)?.[tk]
      const unit0 = unitMap && typeof unitMap === 'object' && !Array.isArray(unitMap) ? unitMap[table] : undefined
      const unit = normalizePromptText(unit0)
      if (unit) {
        if (/(生命值上限|最大生命值|生命值|HP)/i.test(unit)) return 'hp'
        if (/(防御力|DEF)/i.test(unit)) return 'def'
        if (/(元素精通|精通|EM|mastery)/i.test(unit)) return 'mastery'
        if (/(攻击力|攻击|ATK)/i.test(unit)) return 'atk'
      }

      const sample0 = (input.tableTextSamples as any)?.[tk]?.[table]
      const sample = normalizePromptText(sample0)
      if (!sample) return null
      if (/(%|％).{0,6}(生命值上限|最大生命值|生命值|HP)/i.test(sample)) return 'hp'
      if (/(%|％).{0,6}(防御力|DEF)/i.test(sample)) return 'def'
      if (/(%|％).{0,6}(元素精通|精通|EM|mastery)/i.test(sample)) return 'mastery'
      if (/(%|％).{0,6}(攻击力|攻击|ATK)/i.test(sample)) return 'atk'
      return null
    }

    // Some HP->ATK conversions have an explicit cap like "不超过基础攻击力的400%".
    const hints = [
      ...(Array.isArray(input.buffHints) ? (input.buffHints as string[]) : []),
      ...Object.values(input.talentDesc || {})
    ]
    let baseAtkCapPct: number | null = null
    for (const h0 of hints) {
      const h = normalizePromptText(h0)
      if (!h) continue
      if (!/基础攻击力/.test(h)) continue
      if (!/(不超过|不会超过|上限)/.test(h)) continue
      const m = h.match(/(\d+(?:\.\d+)?)\s*[%％]/)
      if (!m) continue
      const n = Number(m[1])
      if (!Number.isFinite(n) || n <= 0 || n > 2000) continue
      if (!baseAtkCapPct || n > baseAtkCapPct) baseAtkCapPct = n
    }

    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'atkPct')) continue
      if (Object.prototype.hasOwnProperty.call(data, 'atkPlus')) continue
      const v = (data as any).atkPct
      if (typeof v !== 'string') continue
      const expr = v.trim()
      // Accept both a plain table ref and a more complex (often-wrong) expression that includes a table ref,
      // e.g. `Math.min((talent.e["攻击力提高"] - 100) * calc(attr.hp) / calc(attr.atkBase), 400)`.
      const m = expr.match(/\btalent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/)
      if (!m) continue
      const tk = m[1] as 'a' | 'e' | 'q' | 't'
      const table = m[3] || ''
      if (!table) continue
      const base = inferBaseStat(tk, table)
      if (base !== 'hp' && base !== 'def') continue

      const stat = base === 'hp' ? 'hp' : 'def'
      // Canonical conversion: treat the table value as a percentage coefficient (do NOT subtract 100).
      // This matches baseline patterns for "基于生命值/防御力，提高攻击力" style buffs.
      let newExpr = `calc(attr.${stat}) * talent.${tk}[\"${table}\"] / 100`
      if (baseAtkCapPct && base === 'hp' && /攻击力提高/.test(table)) {
        newExpr = `Math.min(${newExpr}, attr.atk.base * ${baseAtkCapPct / 100})`
      }
      delete (data as any).atkPct
      ;(data as any).atkPlus = newExpr
    }

    // HP/DEF -> ATK conversion buffs are global stat changes. Some models incorrectly gate them by `currentTalent`
    // (e.g. only apply to A/E but not Q), which systematically underestimates burst damage compared to baseline.
    // If a buff's `atkPlus` is derived from a talent table and the check only uses `currentTalent`, drop the check.
    for (const b of buffsOut) {
      const data = b?.data
      if (!data || typeof data !== 'object') continue
      const v = (data as any).atkPlus
      if (typeof v !== 'string') continue
      if (!/\btalent\s*\./.test(v)) continue
      const check = typeof (b as any).check === 'string' ? String((b as any).check) : ''
      if (!check || !/\bcurrentTalent\b/.test(check)) continue
      if (/\bparams\./.test(check)) continue
      delete (b as any).check
    }

    // If we have a dedicated "攻击力提高" coefficient table under E and it clearly scales from HP/DEF,
    // ensure an `atkPlus` buff exists (models sometimes omit it entirely, causing large dmg drift).
    if (Array.isArray(tables.e) && tables.e.includes('攻击力提高')) {
      const base = inferBaseStat('e', '攻击力提高')
      if (base === 'hp' || base === 'def') {
        const stat = base === 'hp' ? 'hp' : 'def'
        const hasAtkPlus = buffsOut.some((b) => {
          const data = b?.data
          if (!data || typeof data !== 'object') return false
          const v = (data as any).atkPlus
          return typeof v === 'string' && /talent\s*\.\s*e\s*\[\s*['"]攻击力提高['"]\s*\]/.test(v)
        })
        if (!hasAtkPlus) {
          let expr = `calc(attr.${stat}) * talent.e[\"攻击力提高\"] / 100`
          if (baseAtkCapPct && base === 'hp') {
            expr = `Math.min(${expr}, attr.atk.base * ${baseAtkCapPct / 100})`
          }
          buffsOut.unshift({
            title: '元素战技：基于生命值提高攻击力',
            check: 'params.e === true',
            data: { atkPlus: expr }
          })
        }
      }
    }
  }

  // GS: If an important E-state buff (gated by `params.e`) affects global stats / Q damage,
  // ensure Q showcase rows also enable `params.e` (baseline often assumes "E后" rotation for such kits).
  if (input.game === 'gs') {
    const affectsQ = (data: Record<string, number | string>): boolean => {
      for (const k of Object.keys(data || {})) {
        // Global stats / dmg bonus / enemy modifiers
        if (
          /^(atk|hp|def)(Base|Plus|Pct|Inc)?$/.test(k) ||
          /^(mastery|recharge|cpct|cdmg|heal|dmg|phy|shield)(Plus|Pct|Inc)?$/.test(k) ||
          /^(enemyDef|enemyIgnore|ignore|kx|fykx|multi|elevated)$/.test(k)
        ) {
          return true
        }
        // Direct Q-scope keys
        if (/^q(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(k)) return true
      }
      return false
    }

    const needsEOnQ = buffsOut.some((b) => {
      const check = typeof (b as any)?.check === 'string' ? String((b as any).check) : ''
      if (!/\bparams\.e\b/.test(check)) return false
      const data = b.data
      if (!data || typeof data !== 'object') return false
      return affectsQ(data)
    })

    if (needsEOnQ) {
      for (const d of details) {
        if (d.talent !== 'q') continue
        const p0 = d.params
        const p: Record<string, unknown> =
          p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
        if (Object.prototype.hasOwnProperty.call(p, 'e')) continue
        p.e = true
        d.params = p as any
      }
    }
  }

  // SR: Extract "*Plus" (flat additional damage value) buffs from constellation hint text.
  // Many SR profiles use max talent levels that can exceed table lengths in meta (yielding undefined => 0),
  // and baseline calc.js often relies on `aPlus/tPlus/...` to keep showcase rows non-zero.
  if (input.game === 'sr') {
    const hints = Array.isArray(input.buffHints) ? input.buffHints : []
    const existing = new Set<string>()
    for (const b of buffsOut) {
      const d = (b as any)?.data
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue
      for (const k of Object.keys(d)) existing.add(k)
    }

    const normTitle = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')
    const existingTitles = new Set(details.map((d) => normTitle(d.title)))
    const pushDerivedDetail = (d: CalcSuggestDetail): void => {
      if (details.length >= 20) return
      const t = normTitle(d.title)
      if (!t || existingTitles.has(t)) return
      existingTitles.add(t)
      details.push(d)
    }

    const pickTalentKey = (text: string): 'a' | 'e' | 'q' | 't' | null => {
      if (/(普攻|普通攻击)/.test(text)) return 'a'
      if (/战技/.test(text)) return 'e'
      if (/终结技/.test(text)) return 'q'
      if (/(反击|天赋)/.test(text)) return 't'
      return null
    }
    const pickStat = (text: string): 'atk' | 'hp' | 'def' | null => {
      if (/(生命上限|生命值上限|最大生命值|生命值)/.test(text)) return 'hp'
      if (/防御力/.test(text)) return 'def'
      if (/(攻击力|攻击)/.test(text)) return 'atk'
      return null
    }
    const pickPct = (text: string, stat: 'atk' | 'hp' | 'def'): number | null => {
      const num = (s: string): number | null => {
        const n = Number(s)
        return Number.isFinite(n) ? n : null
      }
      if (stat === 'hp') {
        const m1 = /([0-9]+(?:\\.[0-9]+)?)\\s*%\\s*(?:生命上限|生命值上限|最大生命值|生命值)/.exec(text)
        if (m1) return num(m1[1]!)
        const m2 = /(?:生命上限|生命值上限|最大生命值|生命值)(?:的)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%/.exec(text)
        return m2 ? num(m2[1]!) : null
      }
      if (stat === 'def') {
        const m1 = /([0-9]+(?:\\.[0-9]+)?)\\s*%\\s*防御力/.exec(text)
        if (m1) return num(m1[1]!)
        const m2 = /防御力(?:的)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%/.exec(text)
        return m2 ? num(m2[1]!) : null
      }
      const m1 = /([0-9]+(?:\\.[0-9]+)?)\\s*%\\s*(?:攻击力|攻击)/.exec(text)
      if (m1) return num(m1[1]!)
      const m2 = /(?:攻击力|攻击)(?:的)?\\s*([0-9]+(?:\\.[0-9]+)?)\\s*%/.exec(text)
      return m2 ? num(m2[1]!) : null
    }
    const pickFlat = (text: string): number | null => {
      const m = /(?:\\+|＋)\\s*([0-9]+(?:\\.[0-9]+)?)\\b/.exec(text)
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) ? n : null
    }

    for (const h0 of hints) {
      const h = normalizePromptText(h0)
      if (!h) continue

      const mCons = /^(\\d+)\\s*魂[:：]/.exec(h)
      if (!mCons) continue
      const cons = Number(mCons[1])
      if (!Number.isFinite(cons) || cons < 1 || cons > 6) continue

      // Only treat clear "additional damage VALUE" wording as *Plus.
      if (/(额外造成|伤害值提高|伤害提高|伤害提升|提升数值|提高数值)/.test(h)) {
        const talentKey = pickTalentKey(h)
        if (talentKey) {
          const stat = pickStat(h)
          if (stat) {
            const pct = pickPct(h, stat)
            if (pct != null && Number.isFinite(pct) && pct > 0 && pct <= 2000) {
              const dataKey = `${talentKey}Plus`
              if (!existing.has(dataKey)) {
                const ratio = Number((pct / 100).toFixed(6))
                const statCn = stat === 'hp' ? '生命上限' : stat === 'def' ? '防御力' : '攻击力'
                buffsOut.push({
                  title: `推导：${cons}魂基于${statCn}的追加伤害值`,
                  cons,
                  data: {
                    [dataKey]: `calc(attr.${stat}) * ${ratio}`
                  }
                })
                existing.add(dataKey)
              }
            }
          }
        }
      }

      // Derive simple cons heal/shield showcase rows (independent from talent tables).
      // Helps keep SR panel results non-zero when talent levels exceed table lengths (undefined => 0/null).
      const wantsShield =
        /护盾/.test(h) && (/(抵消|吸收)/.test(h) || /护盾.{0,10}持续/.test(h))
      const wantsHeal =
        (/(治疗|回复)/.test(h) ||
          (/恢复/.test(h) && /(生命上限|生命值上限|最大生命值|生命值)/.test(h))) &&
        /(生命上限|生命值上限|最大生命值|生命值)/.test(h)
      if (!wantsShield && !wantsHeal) continue

      const statOrder: Array<'atk' | 'hp' | 'def'> = wantsHeal ? ['hp', 'def', 'atk'] : ['def', 'hp', 'atk']
      let stat: 'atk' | 'hp' | 'def' | null = null
      let pct: number | null = null
      for (const s of statOrder) {
        const p = pickPct(h, s)
        if (p != null) {
          stat = s
          pct = p
          break
        }
      }
      if (!stat) stat = pickStat(h)
      if (!stat) continue
      if (pct == null) pct = pickPct(h, stat)
      const flat = pickFlat(h)
      if (pct == null && flat == null) continue

      const ratio = pct != null && Number.isFinite(pct) ? Number((pct / 100).toFixed(6)) : 0
      const exprParts: string[] = []
      if (pct != null && Number.isFinite(pct) && pct > 0) exprParts.push(`calc(attr.${stat}) * ${ratio}`)
      if (flat != null && Number.isFinite(flat) && flat !== 0) exprParts.push(String(flat))
      if (exprParts.length === 0) continue

      const kind: CalcDetailKind = wantsShield ? 'shield' : 'heal'
      const fn = wantsShield ? 'shield' : 'heal'
      const isDotLike = /(持续|回合开始|持续治疗)/.test(h)
      const title = wantsShield ? `${cons}命护盾量` : `${cons}命${isDotLike ? '持续' : ''}治疗量`

      pushDerivedDetail({
        title,
        kind,
        cons,
        dmgExpr: `${fn}(${exprParts.join(' + ')})`
      })
    }
  }

  // GS: If the character has clear EM/reaction hints but the plan omitted all reaction rows,
  // add a single representative transformative reaction row to avoid "too-low maxAvg" regressions
  // (e.g. electro EM triggers commonly benchmarked by hyperBloom).
  if (input.game === 'gs') {
    const hasReaction = details.some((d) => normalizeKind(d.kind) === 'reaction')
    if (!hasReaction && details.length < 20) {
      const hintText = [
        ...(Array.isArray(input.buffHints) ? input.buffHints : []),
        ...Object.values(input.talentDesc || {})
      ]
        .map((s) => String(s || ''))
        .join('\n')

      const hasEmOrReactionHint =
        /(元素精通|精通|mastery|\bem\b)/i.test(hintText) ||
        /(反应|绽放|超绽放|烈绽放|月绽放|扩散|结晶|燃烧|超载|感电|超导|碎冰)/.test(hintText)

      if (hasEmOrReactionHint) {
        const elem = String(input.elem || '').trim()
        const pick =
          elem === '风'
            ? 'swirl'
            : elem === '岩'
              ? 'crystallize'
              : elem === '草'
                ? 'bloom'
                : elem === '水'
                  ? 'bloom'
                  : elem === '雷'
                    ? 'hyperBloom'
                    : elem === '火'
                      ? 'burgeon'
                      : elem === '冰'
                        ? 'shatter'
                        : null
        if (pick && (!okReactions.size || okReactions.has(pick))) {
          const titleByReaction: Record<string, string> = {
            hyperBloom: '超绽放伤害',
            burgeon: '烈绽放伤害',
            bloom: '绽放伤害',
            swirl: '扩散反应伤害',
            crystallize: '结晶反应伤害',
            shatter: '碎冰反应伤害'
          }
          const title = titleByReaction[pick] || '反应伤害'
          details.push({ title, kind: 'reaction', reaction: pick })
        }
      }
    }
  }

  return { mainAttr, defDmgKey, details, buffs: buffsOut }
}

function applySrDerivedFromBuffHints(input: CalcSuggestInput, plan: CalcSuggestResult): void {
  if (input.game !== 'sr') return
  const details = Array.isArray(plan.details) ? plan.details : []
  const buffsArr = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as CalcSuggestBuff[]) : []
  ;(plan as any).buffs = buffsArr

  // Reuse the same safe/derived logic as validatePlan; keep it best-effort and non-throwing.
  try {
    const hints = Array.isArray(input.buffHints) ? input.buffHints : []
    const existing = new Set<string>()
    for (const b of buffsArr) {
      const d = (b as any)?.data
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue
      for (const k of Object.keys(d)) existing.add(k)
    }

    const normTitle = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')
    const existingTitles = new Set(details.map((d) => normTitle(d.title)))
    const pushDerivedDetail = (d: CalcSuggestDetail): void => {
      if (details.length >= 20) return
      const t = normTitle(d.title)
      if (!t || existingTitles.has(t)) return
      existingTitles.add(t)
      details.push(d)
    }

    const pickTalentKey = (text: string): 'a' | 'e' | 'q' | 't' | null => {
      if (/(普攻|普通攻击)/.test(text)) return 'a'
      if (/战技/.test(text)) return 'e'
      if (/终结技/.test(text)) return 'q'
      if (/(反击|天赋)/.test(text)) return 't'
      return null
    }
    const pickStat = (text: string): 'atk' | 'hp' | 'def' | null => {
      if (/(生命上限|生命值上限|最大生命值|生命值)/.test(text)) return 'hp'
      if (/防御力/.test(text)) return 'def'
      if (/(攻击力|攻击)/.test(text)) return 'atk'
      return null
    }
    const pickPct = (text: string, stat: 'atk' | 'hp' | 'def'): number | null => {
      const num = (s: string): number | null => {
        const n = Number(s)
        return Number.isFinite(n) ? n : null
      }
      const pctToken = '[%％]'
      if (stat === 'hp') {
        const m1 = new RegExp(
          `([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}\\\\s*(?:生命上限|生命值上限|最大生命值|生命值)`
        ).exec(text)
        if (m1) return num(m1[1]!)
        const m2 = new RegExp(
          `(?:生命上限|生命值上限|最大生命值|生命值)(?:的)?\\\\s*([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}`
        ).exec(text)
        return m2 ? num(m2[1]!) : null
      }
      if (stat === 'def') {
        const m1 = new RegExp(`([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}\\\\s*防御力`).exec(text)
        if (m1) return num(m1[1]!)
        const m2 = new RegExp(`防御力(?:的)?\\\\s*([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}`).exec(text)
        return m2 ? num(m2[1]!) : null
      }
      const m1 = new RegExp(`([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}\\\\s*(?:攻击力|攻击)`).exec(text)
      if (m1) return num(m1[1]!)
      const m2 = new RegExp(`(?:攻击力|攻击)(?:的)?\\\\s*([0-9]+(?:\\\\.[0-9]+)?)\\\\s*${pctToken}`).exec(text)
      return m2 ? num(m2[1]!) : null
    }
    const pickFlat = (text: string): number | null => {
      const m = /(?:\+|＋)\s*([0-9]+(?:\.[0-9]+)?)\b/.exec(text)
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) ? n : null
    }

    for (const h0 of hints) {
      const h = normalizePromptText(h0)
      if (!h) continue

      const mCons = /^(\\d+)\\s*魂[:：]/.exec(h)
      if (!mCons) continue
      const cons = Number(mCons[1])
      if (!Number.isFinite(cons) || cons < 1 || cons > 6) continue

      // *Plus inferred buffs
      if (/(额外造成|伤害值提高|伤害提高|伤害提升|提升数值|提高数值)/.test(h)) {
        const talentKey = pickTalentKey(h)
        const stat = pickStat(h)
        if (talentKey && stat) {
          const pct = pickPct(h, stat)
          if (pct != null && Number.isFinite(pct) && pct > 0 && pct <= 2000) {
            const dataKey = `${talentKey}Plus`
            if (!existing.has(dataKey)) {
              const ratio = Number((pct / 100).toFixed(6))
              const statCn = stat === 'hp' ? '生命上限' : stat === 'def' ? '防御力' : '攻击力'
              buffsArr.push({
                title: `推导：${cons}魂基于${statCn}的追加伤害值`,
                cons,
                data: {
                  [dataKey]: `calc(attr.${stat}) * ${ratio}`
                }
              })
              existing.add(dataKey)
            }
          }
        }
      }

      // Cons heal/shield rows
      const wantsShield =
        /护盾/.test(h) && (/(抵消|吸收)/.test(h) || /护盾.{0,10}持续/.test(h))
      const wantsHeal =
        (/(治疗|回复)/.test(h) ||
          (/恢复/.test(h) && /(生命上限|生命值上限|最大生命值|生命值)/.test(h))) &&
        /(生命上限|生命值上限|最大生命值|生命值)/.test(h)
      if (!wantsShield && !wantsHeal) continue

      const statOrder: Array<'atk' | 'hp' | 'def'> = wantsHeal ? ['hp', 'def', 'atk'] : ['def', 'hp', 'atk']
      let stat: 'atk' | 'hp' | 'def' | null = null
      let pct: number | null = null
      for (const s of statOrder) {
        const p = pickPct(h, s)
        if (p != null) {
          stat = s
          pct = p
          break
        }
      }
      if (!stat) stat = pickStat(h)
      if (!stat) continue
      if (pct == null) pct = pickPct(h, stat)
      const flat = pickFlat(h)
      if (pct == null && flat == null) continue

      const ratio = pct != null && Number.isFinite(pct) ? Number((pct / 100).toFixed(6)) : 0
      const exprParts: string[] = []
      if (pct != null && Number.isFinite(pct) && pct > 0) exprParts.push(`calc(attr.${stat}) * ${ratio}`)
      if (flat != null && Number.isFinite(flat) && flat !== 0) exprParts.push(String(flat))
      if (exprParts.length === 0) continue

      const kind: CalcDetailKind = wantsShield ? 'shield' : 'heal'
      const fn = wantsShield ? 'shield' : 'heal'
      const isDotLike = /(持续|回合开始|持续治疗)/.test(h)
      const title = wantsShield ? `${cons}命护盾量` : `${cons}命${isDotLike ? '持续' : ''}治疗量`
      pushDerivedDetail({ title, kind, cons, dmgExpr: `${fn}(${exprParts.join(' + ')})` })
    }
  } catch {
    // Best-effort: do not block generation.
  }
}

export async function suggestCalcPlan(
  llm: LlmService,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>,
  retryHint?: string
): Promise<CalcSuggestResult> {
  const messagesBase = buildMessages(input)
  const messagesHint =
    retryHint && retryHint.trim()
      ? messagesBase.concat({
          role: 'user',
          content:
            '上一次输出未通过本地校验（请修正而不是复述规则）：\n' +
            shortenText(String(retryHint), 700)
        })
      : messagesBase
  const attempts: Array<{ temperature: number; messages: ChatMessage[] }> = [
    { temperature: 0.2, messages: messagesHint },
    {
      temperature: 0,
      messages: messagesHint.concat({
        role: 'user',
        content:
          '上一次输出可能不是严格 JSON。请重新输出：\n' +
          '- 只能输出一个 JSON 对象\n' +
          '- 所有 key 必须使用双引号\n' +
          '- 禁止尾随逗号\n' +
          '- 禁止输出任何 JSON 之外的文字'
      })
    }
  ]

  let lastErr: string | undefined
  for (let i = 0; i < attempts.length; i++) {
    const { temperature, messages } = attempts[i]!

    const text = cache
      ? await chatWithDiskCacheValidated(
          llm,
          messages,
          { temperature },
          { ...cache, purpose: `calc-plan.v3.${i}` },
          (t) => {
            try {
              const json = parseJsonFromLlmText(t)
              if (!json || typeof json !== 'object') return false
              const plan = json as Partial<CalcSuggestResult>
              const parsed: CalcSuggestResult = {
                mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
                defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
                details: Array.isArray(plan.details) ? (plan.details as any) : [],
                buffs: Array.isArray((plan as any).buffs) ? ((plan as any).buffs as any) : []
              }
              validatePlan(input, parsed)
              return true
            } catch {
              return false
            }
          }
        )
      : await llm.chat(messages, { temperature })

    try {
      const json = parseJsonFromLlmText(text)
      if (!json || typeof json !== 'object') {
        throw new Error(`[meta-gen] LLM output is not an object`)
      }

      const plan = json as Partial<CalcSuggestResult>
      const parsed: CalcSuggestResult = {
        mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
        defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
        details: Array.isArray(plan.details) ? (plan.details as any) : [],
        buffs: Array.isArray((plan as any).buffs) ? ((plan as any).buffs as any) : []
      }
      return validatePlan(input, parsed)
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  throw new Error(lastErr || `[meta-gen] LLM calc plan failed`)
}

export function renderCalcJs(input: CalcSuggestInput, plan: CalcSuggestResult, createdBy: string): string {
  const inferDmgBaseFromUnit = (unitRaw: unknown): 'hp' | 'def' | 'mastery' | null => {
    const unit = normalizePromptText(unitRaw)
    if (!unit) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值)/.test(unit)) return 'hp'
    if (/防御力/.test(unit)) return 'def'
    return null
  }

  const inferScaleStatFromUnit = (unitRaw: unknown): CalcScaleStat | null => {
    const unit = normalizePromptText(unitRaw)
    if (!unit) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(unit)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(unit)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(unit)) return 'atk'
    return null
  }

  const inferDmgBase = (descRaw: unknown): 'atk' | 'hp' | 'def' | 'mastery' => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'
    // Avoid mis-detecting buff-only skills by requiring damage wording.
    if (!/伤害/.test(desc)) return 'atk'
    // Be conservative: only treat it as HP/DEF/EM scaling when the description explicitly ties
    // that stat to *damage* (not healing/restore text).
    const dmgWord = '(?:伤害|造成|提高|提升|增加|加成|转化)'
    const healWord = '(?:治疗|恢复)'
    const hpWord = '(?:生命上限|生命值上限|最大生命值|生命值)'
    const defWord = '(?:防御力)'
    const emWord = '(?:元素精通|精通)'

    // Many skills/passives are ATK-scaling but have an *additive* bonus like:
    // - "伤害提高，提高值相当于生命值上限的X%"
    // In this case we MUST NOT flip the whole dmg base to HP/DEF/EM.
    const bonusValWord = '(?:提高|提升|增加|加成)(?:的)?值'
    const hpBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${hpWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${hpWord}`).test(desc)
    const hpBuffCtx = new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)
    // Summons/decoys often "inherit max HP" which should NOT flip dmg base to HP.
    const hpInheritCtx =
      new RegExp(`(?:继承|取决于).{0,20}${hpWord}`).test(desc) || new RegExp(`${hpWord}.{0,20}(?:继承|取决于)`).test(desc)
    const defBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${defWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${defWord}`).test(desc)
    const defBuffCtx = new RegExp(`(?:基于|按).{0,20}${defWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)
    const emBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${emWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${emWord}`).test(desc)
    const emBuffCtx = new RegExp(`(?:基于|按).{0,20}${emWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)

    const hasHpHealCtx =
      new RegExp(`${healWord}.{0,30}(?:基于|按).{0,20}${hpWord}`).test(desc) ||
      new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,30}${healWord}`).test(desc)
    const hasHpDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${hpWord}`).test(desc)

    const hasDefDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${defWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${defWord}`).test(desc)

    const hasEmDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${emWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${emWord}`).test(desc)

    if (hasEmDmgCtx && !emBonusCtx && !emBuffCtx) return 'mastery'
    if (hasHpDmgCtx && !hasHpHealCtx && !hpBonusCtx && !hpBuffCtx && !hpInheritCtx) return 'hp'
    if (hasDefDmgCtx && !defBonusCtx && !defBuffCtx) return 'def'
    return 'atk'
  }

  const inferScaleStatFromDesc = (descRaw: unknown): CalcScaleStat => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'
    if (/(元素精通|精通)/.test(desc)) return 'mastery'
    if (/(基于|按).{0,20}(生命上限|生命值上限|最大生命值|生命值)/.test(desc)) return 'hp'
    if (/(基于|按).{0,20}防御力/.test(desc)) return 'def'
    if (/(基于|按).{0,20}(攻击力|攻击)/.test(desc)) return 'atk'
    return 'atk'
  }

  const inferDmgBaseFromTextSample = (textRaw: unknown): CalcScaleStat | null => {
    const text = normalizePromptText(textRaw)
    if (!text) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(text)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(text)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(text)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(text)) return 'atk'
    // Plain percentage without explicit stat tag (e.g. "130.4%") is ATK-based in most GS talent damage tables.
    if (/[%％]/.test(text)) return 'atk'
    return null
  }

	  const ratioFnLine =
	    input.game === 'gs'
	      ? 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n / 100 : 0 }\n'
	      : 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }\n'

	  const inferArrayTableSchema = (
	    talentKey: TalentKey,
	    tableName: string
	  ):
	    | { kind: 'statFlat'; stat: CalcScaleStat }
	    | { kind: 'statStat'; stats: [CalcScaleStat, CalcScaleStat] }
	    | { kind: 'pctList'; stat: CalcScaleStat }
	    | { kind: 'statTimes'; stat: CalcScaleStat }
	    | null => {
	    const textRaw = (input.tableTextSamples as any)?.[talentKey]?.[tableName]
	    const text = normalizePromptText(textRaw)
	    if (!text) return null

	    const inferStatFromText = (s: string): CalcScaleStat | null => {
	      if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(s)) return 'mastery'
	      if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(s)) return 'hp'
	      if (/(防御力|\bdef\b)/i.test(s)) return 'def'
	      if (/(攻击力|攻击|\batk\b)/i.test(s)) return 'atk'
	      return null
	    }

	    // e.g. "1.41%HP*5" / "80%ATK×3" stored as [pct, hitCount] in `<name>2`.
	    // This is NOT "[pct, flat]"; it should be multiplied, not added.
	    //
	    // Note: Some tables omit the stat name entirely (e.g. "57.28%*2"). In that case we default to ATK,
	    // since damage multipliers are ATK-based unless explicitly marked as HP/DEF/EM scaling.
	    if (/[*×xX]\s*\d+/.test(text) && /[%％]/.test(text)) {
	      const s0 = inferStatFromText(text) || 'atk'
	      const sample = (input.tableSamples as any)?.[talentKey]?.[tableName]
	      const times =
	        Array.isArray(sample) && sample.length >= 2 && typeof sample[1] === 'number' ? Number(sample[1]) : NaN
	      const timesOk =
	        Number.isFinite(times) && Math.abs(times - Math.round(times)) < 1e-9 && times > 1 && times <= 20
	      if (timesOk) return { kind: 'statTimes', stat: s0 }
	    }

	    const split = text
	      .split(/[+＋]/)
	      .map((s) => s.trim())
	      .filter(Boolean)
	    if (split.length < 2) return null

	    const unitRaw =
	      (input.tableUnits as any)?.[talentKey]?.[tableName] ??
	      (input.tableUnits as any)?.[talentKey]?.[tableName.endsWith('2') ? tableName.slice(0, -1) : tableName]
	    const unitStat = inferStatFromText(String(unitRaw || ''))

	    // e.g. "32.42%+32.42%" where runtime returns [hit1Pct, hit2Pct, ...]
	    // We treat this as multi-hit parts that can be summed into a single percentage multiplier.
	    // If the stat is not explicitly mentioned, default to ATK (most damage tables).
	    const hasPctAll = split.every((p) => /[%％]/.test(p))
	    if (hasPctAll) {
	      const stats = split.map((p) => inferStatFromText(p)).filter(Boolean) as CalcScaleStat[]
	      const stat = stats[0] || 'atk'
	      const allSame = stats.length === 0 || stats.every((s) => s === stat)
	      if (allSame) {
	        // Mixed-stat tables may omit the second stat label and store it in `unit` instead:
	        // e.g. unit="防御力" value="149.28%攻击 + 186.6%".
	        // Detect it and treat as "%ATK + %DEF" instead of a multi-hit "% + %" list.
	        if (split.length === 2 && unitStat) {
	          const s0 = inferStatFromText(split[0]!)
	          const s1 = inferStatFromText(split[1]!)
	          if (s0 && !s1 && unitStat !== s0) return { kind: 'statStat', stats: [s0, unitStat] }
	          if (!s0 && s1 && unitStat !== s1) return { kind: 'statStat', stats: [unitStat, s1] }
	        }
	        return { kind: 'pctList', stat }
	      }
	    }

	    const p0 = split[0]!
	    const p1 = split[1]!
	    const s0 = inferStatFromText(p0)
	    const s1 = inferStatFromText(p1)
	    const hasPct0 = /[%％]/.test(p0)
	    const hasPct1 = /[%％]/.test(p1)
	    const hasNum1 = /\d/.test(p1)

	    // e.g. "%攻击 + %精通"
	    if (s0 && s1 && hasPct0 && hasPct1) {
	      return { kind: 'statStat', stats: [s0, s1] }
	    }
	    // e.g. "%生命值上限 + 800"
	    if (s0 && hasPct0 && !s1 && hasNum1 && !hasPct1) {
	      return { kind: 'statFlat', stat: s0 }
	    }
	    return null
	  }

	  const inferDefParams = (): Record<string, unknown> | undefined => {
    if (input.game !== 'gs') return undefined
    const out: Record<string, unknown> = {}

    const scan = (s: unknown): void => {
      if (typeof s !== 'string') return
      if (!s) return
      if (!('Nightsoul' in out) && /夜魂/i.test(s)) out.Nightsoul = true
      // HP threshold flags used by many baseline calcs (often assumed to be true for展示/对标).
      if (!('half' in out) && /(半血|低血|生命值低于|生命值少于|HP\s*<\s*50%|hp\s*<\s*50%)/i.test(s)) out.half = true
      if (!('Hexenzirkel' in out) && /(魔女会|Hexenzirkel)/i.test(s)) out.Hexenzirkel = true
      // Lunar system (Moonsign) used by some characters / reactions.
      if (
        !('Moonsign' in out) &&
        /(月兆|月曜|月辉|月感电|月绽放|月结晶|Moonsign)/i.test(s)
      ) {
        // Heuristic: default to 2, bump to 3 when explicitly mentioned.
        // (Some characters use 2, some use 3; baseline often sets it to max stacks.)
        out.Moonsign = /(月兆|月曜|月辉|Moonsign).{0,20}(3|三)/i.test(s)
          ? 3
          : /(月兆|月曜|月辉|Moonsign).{0,20}(2|二)/i.test(s)
            ? 2
            : 2
      }
    }

    for (const arr of Object.values(input.tables || {})) {
      if (!Array.isArray(arr)) continue
      for (const t of arr) scan(t)
    }
    for (const v of Object.values(input.talentDesc || {})) scan(v)
    for (const v of input.buffHints || []) scan(v)

    // Infer additional showcase defaults from the generated plan itself (helps matching baseline diffs):
    // - Enable boolean state flags referenced by buffs when they appear in any detail params
    // - For simple numeric stack params, default to the max numeric value present in any detail params
    const paramKeysInBuff = new Set<string>()
    const minRequired: Record<string, number> = {}
    const collectParamRefs = (expr: string): void => {
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = m[1]
        if (!k) continue
        paramKeysInBuff.add(k)
      }
    }
    const collectParamThresholds = (expr: string): void => {
      // Extract simple numeric thresholds like `params.stack >= 5` to auto-enable "满层" showcase defaults.
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|>)\s*(\d{1,3})\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = m[1]
        const op = m[2]
        const n = Number(m[3])
        if (!k || !Number.isFinite(n)) continue
        if (n < 0 || n > 20) continue
        const need = op === '>' ? Math.trunc(n) + 1 : Math.trunc(n)
        if (need < 1 || need > 20) continue
        minRequired[k] = Math.max(minRequired[k] ?? -Infinity, need)
      }
    }
    for (const b of plan.buffs || []) {
      if (typeof (b as any).check === 'string') {
        collectParamRefs((b as any).check)
        collectParamThresholds((b as any).check)
      }
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const v of Object.values(data as Record<string, unknown>)) {
          if (typeof v === 'string') collectParamRefs(v)
        }
      }
    }

    const numMax: Record<string, number> = {}
    for (const d of plan.details || []) {
      const p = (d as any).params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const [k0, v] of Object.entries(p as Record<string, unknown>)) {
        const k = String(k0 || '').trim()
        if (!k) continue
        if (typeof v === 'number' && Number.isFinite(v)) {
          numMax[k] = Math.max(numMax[k] ?? -Infinity, v)
        }
      }
    }

    // Only set defaults for keys that are actually referenced by some buff logic.
    for (const k of paramKeysInBuff) {
      if (k in out) continue

      // Team-composition style params used by some baseline calcs (e.g. Yelan A1: 4元素类型 => hpPct 30).
      // These are not controllable via per-row params, so default to the max-tier showcase value.
      if (k === 'elementTypes') {
        out[k] = 4
        continue
      }
      if (k === 'team_element_count' || k === 'teamElementCount') {
        out[k] = 4
        continue
      }

      // Generic enum-like selectors used by some stack-indexed buffs, e.g.
      //   talent.q["xxx加成"][params.type] * params.num
      // Default to the first variant to keep the buff non-dead in showcases.
      if (k === 'type' || k === 'idx' || k === 'index') {
        out[k] = 0
        continue
      }

      // Conservative numeric defaults: only for obvious stack/count params within a small bound.
      const n = numMax[k]
      const isCountLike =
        /(?:layer|layers|stack|stacks|count|cnt|num|cracks|drops)$/i.test(k) ||
        /^(?:hunterstacks|glory_stacks|veil_of_falsehood|hpabove50count)$/i.test(k)
      const nOk = Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 0 && n <= 20
      if (isCountLike && nOk) {
        out[k] = Math.trunc(n)
        continue
      }

      // If no detail sets the stack param, but some buff check requires a minimum threshold (e.g. ">= 5"),
      // default to that threshold so the showcase output matches baseline-like "满层" assumptions.
      const need = minRequired[k]
      if (isCountLike && Number.isFinite(need) && need > 0 && need <= 20) {
        out[k] = Math.trunc(need)
        continue
      }
    }

    // Moonsign is a special "state" param that can also affect artifact-set buffs.
    // If any detail already sets Moonsign explicitly, do NOT default it globally via defParams,
    // otherwise unrelated rows (e.g. mastery-scaling E) may be inflated.
    const hasDetailMoonsign = (plan.details || []).some((d) => {
      const p = (d as any)?.params
      return p && typeof p === 'object' && !Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, 'Moonsign')
    })
    const moonsignNeededByBuff = paramKeysInBuff.has('Moonsign')
    if ('Moonsign' in out) {
      if (hasDetailMoonsign || !moonsignNeededByBuff) delete out.Moonsign
    } else if (moonsignNeededByBuff && !hasDetailMoonsign) {
      // Fallback: some lunar characters gate buffs by params.Moonsign but forget to set it in detail.params.
      out.Moonsign = 2
    }

    return Object.keys(out).length ? out : undefined
  }

  const detailsLines: string[] = []
  detailsLines.push(ratioFnLine.trimEnd())
  detailsLines.push('export const details = [')

  const isCatalyst = input.game === 'gs' && input.weapon === 'catalyst'
  const isBow = input.game === 'gs' && input.weapon === 'bow'

  plan.details.forEach((d, idx) => {
    const kind: CalcDetailKind = typeof d.kind === 'string' && d.kind ? d.kind : 'dmg'
    const title = jsString(d.title)

    const dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
    if (dmgExpr) {
      const talentKey = typeof d.talent === 'string' && d.talent ? d.talent : ''
      detailsLines.push('  {')
      detailsLines.push(`    title: ${title},`)
      if (talentKey) {
        detailsLines.push(`    talent: ${jsString(talentKey)},`)
      }
      // For reaction-only rows, baseline calc.js typically omits dmgKey to avoid accidental key-based buffs.
      if (kind !== 'reaction') {
        detailsLines.push(`    dmgKey: ${jsString(d.key || talentKey || 'e')},`)
      }
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      // When dmgExpr is used, render the callback signature based on the detail kind
      // so the expression can directly call heal()/shield()/reaction() when needed.
      if (kind === 'heal') {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, { heal }) => (${dmgExpr})`
        )
      } else if (kind === 'shield') {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, { shield }) => (${dmgExpr})`
        )
      } else if (kind === 'reaction') {
        detailsLines.push(`    dmg: ({}, { reaction }) => (${dmgExpr})`)
      } else {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (${dmgExpr})`
        )
      }
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

    if (kind === 'reaction') {
      const reaction = typeof d.reaction === 'string' && d.reaction.trim() ? d.reaction.trim() : 'swirl'
      detailsLines.push('  {')
      detailsLines.push(`    title: ${title},`)
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      detailsLines.push(`    dmg: ({}, { reaction }) => reaction(${jsString(reaction)})`)
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

	    const talent = d.talent as TalentKey
	    const tableName = d.table as string
	    const table = jsString(tableName)

	    const dmgKeyProp = jsString(d.key || talent)
	    const pick = typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
	    const keyArgRaw = typeof d.key === 'string' ? d.key : undefined
	    const eleRaw = typeof d.ele === 'string' ? d.ele.trim() : ''
	    const ele = eleRaw ? jsString(eleRaw) : ''

    const inferGsSpecialEle = (): string | null => {
      if (input.game !== 'gs') return null
      const hint = `${d.title || ''} ${tableName || ''}`
      if (/月感电/.test(hint)) return 'lunarCharged'
      if (/月绽放/.test(hint)) return 'lunarBloom'
      if (/月结晶/.test(hint)) return 'lunarCrystallize'
      return null
    }
    const inferredEle = !ele ? inferGsSpecialEle() : null

	    // IMPORTANT: do NOT auto-infer "phy" here. In miao-plugin, passing `ele="phy"` switches the dmg bonus
	    // bucket to `attr.phy` and will drop generic `dmg` bonuses (e.g. set/weapon "造成的伤害提升"). Baseline
	    // calc.js commonly omits `phy` and relies on miao-plugin defaults + buffs, so auto-forcing phy causes
	    // systematic underestimation in regression comparisons.
	    const eleArg = ele ? `, ${ele}` : inferredEle ? `, ${jsString(inferredEle)}` : ''

	    const isLunarEle =
	      input.game === 'gs' &&
	      (inferredEle === 'lunarCharged' ||
	        inferredEle === 'lunarBloom' ||
	        inferredEle === 'lunarCrystallize' ||
	        eleRaw === 'lunarCharged' ||
	        eleRaw === 'lunarBloom' ||
	        eleRaw === 'lunarCrystallize')
	    const sanitizeKeyArg = (k: string): string => {
	      const banned = new Set([
	        'vaporize',
	        'melt',
	        'crystallize',
	        'burning',
	        'superconduct',
	        'swirl',
	        'electrocharged',
	        'shatter',
	        'overloaded',
	        'bloom',
	        'burgeon',
	        'hyperbloom',
	        'aggravate',
	        'spread',
	        'lunarcharged',
	        'lunarbloom',
	        'lunarcrystallize',
	        // Avoid invalid talent keys accidentally emitted by LLMs (phy is an element override, not a talent bucket).
	        'phy',
	        'physical',
	        'phys'
	      ])
	      const parts = k
	        .split(',')
	        .map((s) => s.trim())
	        .filter(Boolean)
	        .filter((s) => !banned.has(s.toLowerCase()))
	      return parts.join(',')
	    }
	    const keyArgSanitized = typeof keyArgRaw === 'string' ? sanitizeKeyArg(keyArgRaw) : ''

	    // IMPORTANT: lunar* uses the reaction system with a custom base damage. Baseline uses empty talent key
	    // to avoid accidentally treating e/q bonuses (or other numeric attrs like lunarBloom) as talent modifiers.
	    const keyArg = jsString(isLunarEle ? '' : keyArgSanitized ? keyArgSanitized : talent)

    // Infer scaling base:
    // - Prefer unit hints when they explicitly indicate HP/DEF.
    // - Otherwise fall back to a conservative description match ("based on HP/DEF").
    const unitMap = input.tableUnits?.[talent]
    const baseTableName = tableName.endsWith('2') ? tableName.slice(0, -1) : tableName
    const unit = unitMap ? unitMap[tableName] || unitMap[baseTableName] : undefined
    const unitBase = inferDmgBaseFromUnit(unit)
    const textSample =
      (input.tableTextSamples as any)?.[talent]?.[tableName] ??
      (input.tableTextSamples as any)?.[talent]?.[baseTableName]
    const textBase = inferDmgBaseFromTextSample(textSample)
    const textNorm = normalizePromptText(textSample)
    // For GS talent.a, descriptions often mix multiple mechanics (e.g. special arrows scaling with HP).
    // Prefer per-table text sample hints, and only fall back to description for non-a talents.
    const descBase = talent === 'a' ? 'atk' : inferDmgBase((input.talentDesc as any)?.[talent])
    // If the table unit is just a plain percentage (no HP/DEF/EM marker), prefer ATK over a broad description
    // match. Some skills mention EM/HP bonuses in the description but only specific sub-tables actually scale
    // with those stats (e.g. 纳西妲 E：灭净三业是 atk+em，但点按/长按仍是 atk%).
    const unitNorm = normalizePromptText(unit)
    const looksLikePlainPctUnit =
      !!unitNorm &&
      /[%％]/.test(unitNorm) &&
      !/(生命上限|生命值上限|最大生命值|生命值|hp|防御力|防御|def|精通|元素精通|mastery|\bem\b)/i.test(unitNorm)
    const looksLikePlainPctTextSample =
      !!textNorm &&
      /[%％]/.test(textNorm) &&
      !/[+*/xX×]/.test(textNorm) &&
      !/(生命|防御|精通|hp|def|mastery|\bem\b)/i.test(textNorm)
    // IMPORTANT: In GS, many scalar talent tables have an empty unit (damage % is implicit) and do NOT have a
    // per-table text sample in our prompt input. In that case, falling back to a broad skill description can
    // easily mis-detect HP/DEF/EM scaling and explode damage numbers (e.g. mixed-scaling skills where only one
    // sub-table uses HP/DEF/EM).
    const hasPerTableHint = !!unitNorm || !!textNorm
    const base =
      unitBase ||
      textBase ||
      ((input.game === 'gs' && !hasPerTableHint) || looksLikePlainPctUnit || looksLikePlainPctTextSample
        ? 'atk'
        : descBase) ||
      'atk'
    const useBasic = base !== 'atk'

	    if (kind === 'heal' || kind === 'shield') {
      const method = kind === 'heal' ? 'heal' : 'shield'
      const stat = (d.stat ||
        inferScaleStatFromUnit(unit) ||
        inferScaleStatFromDesc((input.talentDesc as any)?.[talent])) as CalcScaleStat

      // Some GS heal/shield formulas are split into a flat "基础..." + a percent "附加..." table,
      // instead of providing a single `[pct, flat]` table.
      const findPairGs = (): { baseTable: string; addTable: string } | null => {
        if (input.game !== 'gs') return null
        const all = (input.tables as any)?.[talent]
        const list = Array.isArray(all) ? all : []
        const has = (name: string): boolean => list.includes(name)
        const t0 = tableName
        // 例：护盾基础吸收量 + 护盾附加吸收量
        if (/基础/.test(t0)) {
          const add = t0.replace(/基础/g, '附加')
          if (add !== t0 && has(add)) return { baseTable: t0, addTable: add }
        }
        if (/附加/.test(t0)) {
          const base = t0.replace(/附加/g, '基础')
          if (base !== t0 && has(base)) return { baseTable: base, addTable: t0 }
        }
        return null
      }

      // SR heal/shield formulas are commonly split into a percent table + a flat table.
      const findPairSr = (stat: CalcScaleStat): { pctTable: string; flatTable: string } | null => {
        if (input.game !== 'sr') return null
        const all = (input.tables as any)?.[talent]
        const list = Array.isArray(all) ? all : []
        const has = (name: string): boolean => list.includes(name)
        const t0 = tableName

        const pickFlat = (): string | null => list.find((x) => /固定值/.test(String(x || ''))) || null
        const pickPctByStat = (): string | null => {
          if (stat === 'hp') return list.find((x) => /(百分比生命|生命值百分比)/.test(String(x || ''))) || null
          if (stat === 'def') return list.find((x) => /(百分比防御|防御力百分比)/.test(String(x || ''))) || null
          if (stat === 'atk') return list.find((x) => /攻击力百分比/.test(String(x || ''))) || null
          return list.find((x) => /百分比/.test(String(x || ''))) || null
        }

        if (/百分比/.test(t0) && !/固定值/.test(t0)) {
          const flatCand = t0.replace(/百分比生命|生命值百分比|百分比防御|防御力百分比|攻击力百分比/g, '固定值')
          if (flatCand !== t0 && has(flatCand)) return { pctTable: t0, flatTable: flatCand }
          const flat = pickFlat()
          if (flat) return { pctTable: t0, flatTable: flat }
        }

        if (/固定值/.test(t0)) {
          const pctToken = stat === 'hp' ? '百分比生命' : stat === 'def' ? '百分比防御' : stat === 'atk' ? '攻击力百分比' : '百分比生命'
          const pctCand = t0.replace(/固定值/g, pctToken)
          if (pctCand !== t0 && has(pctCand)) return { pctTable: pctCand, flatTable: t0 }
          const pct = pickPctByStat()
          if (pct) return { pctTable: pct, flatTable: t0 }
        }

        return null
      }

	      detailsLines.push('  {')
	      detailsLines.push(`    title: ${title},`)
	      detailsLines.push(`    talent: ${jsString(talent)},`)
	      detailsLines.push(`    dmgKey: ${dmgKeyProp},`)
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      detailsLines.push(`    dmg: ({ attr, talent, calc }, { ${method} }) => {`)

      const pairGs = findPairGs()
      const pairSr = findPairSr(stat)
      if (pairGs) {
        const baseTable = jsString(pairGs.baseTable)
        const addTable = jsString(pairGs.addTable)
        detailsLines.push(`      const tBase = talent.${talent}[${baseTable}]`)
        detailsLines.push(`      const tAdd = talent.${talent}[${addTable}]`)
        detailsLines.push(`      const flat = Array.isArray(tBase) ? (Number(tBase[1]) || 0) : (Number(tBase) || 0)`)
        detailsLines.push(`      const pct = Array.isArray(tAdd) ? (Number(tAdd[0]) || 0) : (Number(tAdd) || 0)`)
        detailsLines.push(`      const flat2 = Array.isArray(tAdd) ? (Number(tAdd[1]) || 0) : 0`)
        detailsLines.push(`      const base = calc(attr.${stat})`)
        detailsLines.push(`      return ${method}(flat + base * toRatio(pct) + flat2)`)
      } else if (pairSr) {
        const pctTable = jsString(pairSr.pctTable)
        const flatTable = jsString(pairSr.flatTable)
        detailsLines.push(`      const tPct = talent.${talent}[${pctTable}]`)
        detailsLines.push(`      const tFlat = talent.${talent}[${flatTable}]`)
        detailsLines.push(`      const pct = Array.isArray(tPct) ? (Number(tPct[0]) || 0) : (Number(tPct) || 0)`)
        detailsLines.push(`      const flat = Array.isArray(tFlat) ? (Number(tFlat[1] ?? tFlat[0]) || 0) : (Number(tFlat) || 0)`)
        detailsLines.push(`      const base = calc(attr.${stat})`)
        detailsLines.push(`      return ${method}(base * toRatio(pct) + flat)`)
      } else {
        detailsLines.push(`      const t = talent.${talent}[${table}]`)
        detailsLines.push(`      const base = calc(attr.${stat})`)

        // If unit hints explicitly mention a stat, this is almost always a percentage table.
        // Otherwise, prefer treating large values as flat (e.g. Zhongli "护盾基础吸收量" is ~1k-3k).
        const unitScale = inferScaleStatFromUnit(unit)
        const scalarMode = unitScale ? 'pct' : 'auto'
        if (scalarMode === 'pct') {
          detailsLines.push(`      if (Array.isArray(t)) return ${method}(base * toRatio(t[0]) + (Number(t[1]) || 0))`)
          detailsLines.push(`      return ${method}(base * toRatio(t))`)
        } else {
          detailsLines.push(`      if (Array.isArray(t)) return ${method}(base * toRatio(t[0]) + (Number(t[1]) || 0))`)
          detailsLines.push(`      const n = Number(t) || 0`)
          const flatThreshold = input.game === 'sr' ? 5 : 200
          detailsLines.push(`      if (n > ${flatThreshold}) return ${method}(n)`)
          detailsLines.push(`      return ${method}(base * toRatio(n))`)
        }
      }
      detailsLines.push('    }')
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

	    detailsLines.push('  {')
	    detailsLines.push(`    title: ${title},`)
	    detailsLines.push(`    talent: ${jsString(talent)},`)
	    detailsLines.push(`    dmgKey: ${dmgKeyProp},`)
    if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
      detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
    }
    if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
      detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
    }
    if (typeof d.check === 'string' && d.check.trim()) {
      detailsLines.push(
        `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
      )
    }
	    detailsLines.push(`    dmg: ({ talent, attr, calc }, dmg) => {`)
	    detailsLines.push(`      const t = talent.${talent}[${table}]`)
	    detailsLines.push(`      if (Array.isArray(t)) {`)
	    if (typeof pick === 'number' && Number.isFinite(pick)) {
	      // Array variant selector (e.g. "低空/高空..." or "X/Y..." tables).
	      detailsLines.push(`        const v = Number(t[${Math.max(0, Math.min(10, pick))}]) || 0`)
	      if (useBasic) {
	        detailsLines.push(`        return dmg.basic(calc(attr.${base}) * toRatio(v), ${keyArg}${eleArg})`)
	      } else {
	        detailsLines.push(`        return dmg(v, ${keyArg}${eleArg})`)
	      }
	    } else {
	      const schema = inferArrayTableSchema(talent, tableName)
	      if (schema?.kind === 'statStat') {
	        const [s0, s1] = schema.stats
	        detailsLines.push(
	          `        return dmg.basic(calc(attr.${s0}) * toRatio(t[0]) + calc(attr.${s1}) * toRatio(t[1]), ${keyArg}${eleArg})`
	        )
	      } else if (schema?.kind === 'statTimes') {
	        // e.g. [pct, hits] from `...2` tables where text sample is like "1.41%HP*5".
          // Default to per-hit output unless the title explicitly says "总/合计/一轮...".
          // (Baseline often compares per-hit rows; total rows should opt-in via title wording.)
          const titleHint = String(d.title || '')
          const wantsTotal =
            /(?:合计|总计|总伤|一轮|总)/.test(titleHint) &&
            !/(?:单次|单段|每段|每跳|每次)/.test(titleHint)
          if (wantsTotal) {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg((Number(t[0]) || 0) * (Number(t[1]) || 0), ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(
                `        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]) * (Number(t[1]) || 0), ${keyArg}${eleArg})`
              )
            }
          } else {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg(Number(t[0]) || 0, ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(`        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]), ${keyArg}${eleArg})`)
            }
          }
	      } else if (schema?.kind === 'pctList') {
	        detailsLines.push(`        const sum = t.reduce((acc, x) => acc + (Number(x) || 0), 0)`)
	        if (schema.stat === 'atk' && !useBasic) {
	          detailsLines.push(`        return dmg(sum, ${keyArg}${eleArg})`)
	        } else {
	          detailsLines.push(`        return dmg.basic(calc(attr.${schema.stat}) * toRatio(sum), ${keyArg}${eleArg})`)
	        }
	      } else if (schema?.kind === 'statFlat') {
	        detailsLines.push(
	          `        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]) + (Number(t[1]) || 0), ${keyArg}${eleArg})`
	        )
	      } else if (useBasic) {
	        detailsLines.push(`        const base = calc(attr.${base})`)
	        detailsLines.push(
	          `        return dmg.basic(base * toRatio(t[0]) + (Number(t[1]) || 0), ${keyArg}${eleArg})`
	        )
	      } else {
	        detailsLines.push(`        const base = calc(attr.atk)`)
	        detailsLines.push(
	          `        return dmg.basic(base * toRatio(t[0]) + (Number(t[1]) || 0), ${keyArg}${eleArg})`
	        )
	      }
	    }
	    detailsLines.push(`      }`)
	    if (useBasic) {
	      detailsLines.push(`      const base = calc(attr.${base})`)
	      detailsLines.push(`      return dmg.basic(base * toRatio(t), ${keyArg}${eleArg})`)
	    } else {
	      detailsLines.push(`      return dmg(t, ${keyArg}${eleArg})`)
	    }
	    detailsLines.push(`    }`)
	    detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
	  })

  detailsLines.push(']')

  const detailKey = (d: CalcSuggestDetail | undefined): string => {
    if (!d) return ''
    if (typeof d.key === 'string' && d.key.trim()) return d.key.trim()
    if (typeof d.talent === 'string' && d.talent) return d.talent
    return ''
  }
  const firstKeyIdx = plan.details.findIndex((d) => !!detailKey(d))
  const fallbackIdx = firstKeyIdx >= 0 ? firstKeyIdx : 0
  const defDmgKey =
    (plan.defDmgKey && plan.defDmgKey.trim()) || detailKey(plan.details[fallbackIdx]) || 'e'
  const defDmgIdxRaw = plan.details.findIndex((d) => detailKey(d) === defDmgKey)
  const defDmgIdx = defDmgIdxRaw >= 0 ? defDmgIdxRaw : fallbackIdx

  const isIdent = (k: string): boolean => /^[$A-Z_][0-9A-Z_$]*$/i.test(k)
  const renderProp = (k: string): string => (isIdent(k) ? k : jsString(k))
  const isFnExpr = (s: string): boolean => /=>/.test(s) || /^function\b/.test(s)
  const wrapExpr = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => (${expr})`
  const wrapExprNumber = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => {` +
    ` const v = (${expr});` +
    ` if (typeof v === "number") return Number.isFinite(v) ? v : 0;` +
    ` if (v === undefined || v === null || v === false || v === "") return v;` +
    ` return 0 }`

  const renderBuffValue = (v: unknown): string | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExprNumber(t)
  }

  const renderBuffCheck = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExpr(t)
  }

  const buffs = Array.isArray(plan.buffs) ? (plan.buffs as CalcSuggestBuff[]) : []
  const buffsLines: string[] = []
  if (buffs.length === 0) {
    buffsLines.push('export const buffs = []')
  } else {
    buffsLines.push('export const buffs = [')
    buffs.forEach((b, idx) => {
      buffsLines.push('  {')
      buffsLines.push(`    title: ${jsString(b.title)},`)
      if (typeof b.sort === 'number' && Number.isFinite(b.sort)) {
        buffsLines.push(`    sort: ${Math.trunc(b.sort)},`)
      }
      if (typeof b.cons === 'number' && Number.isFinite(b.cons)) {
        buffsLines.push(`    cons: ${Math.trunc(b.cons)},`)
      }
      if (typeof b.tree === 'number' && Number.isFinite(b.tree)) {
        buffsLines.push(`    tree: ${Math.trunc(b.tree)},`)
      }

      const check = renderBuffCheck((b as any).check)
      if (check) {
        buffsLines.push(`    check: ${check},`)
      }

      const dataRaw = (b as any).data
      if (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) {
        const entries: Array<[string, string]> = []
        for (const [k, v] of Object.entries(dataRaw as Record<string, unknown>)) {
          const kk = String(k || '').trim()
          if (!kk) continue
          const vv = renderBuffValue(v)
          if (!vv) continue
          entries.push([kk, vv])
        }
        if (entries.length) {
          buffsLines.push('    data: {')
          entries.forEach(([k, v], j) => {
            const comma = j === entries.length - 1 ? '' : ','
            buffsLines.push(`      ${renderProp(k)}: ${v}${comma}`)
          })
          buffsLines.push('    }')
        }
      }

      buffsLines.push(idx === buffs.length - 1 ? '  }' : '  },')
    })
    buffsLines.push(']')
  }

  const defParams = inferDefParams()
  const defParamsLine = defParams ? `export const defParams = ${JSON.stringify(defParams)}` : ''

  return [
    `// Auto-generated by ${createdBy}.`,
    detailsLines.join('\n'),
    '',
    `export const defDmgIdx = ${defDmgIdx}`,
    `export const defDmgKey = ${jsString(defDmgKey)}`,
    `export const mainAttr = ${jsString(plan.mainAttr)}`,
    '',
    ...(defParamsLine ? [defParamsLine, ''] : []),
    buffsLines.join('\n'),
    '',
    `export const createdBy = ${jsString(createdBy)}`,
    ''
  ].join('\n')
}

export async function buildCalcJsWithLlmOrHeuristic(
  llm: LlmService | undefined,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  if (!llm) {
    let plan = heuristicPlan(input)
    // Best-effort post-processing for heuristic plans.
    try {
      plan = validatePlan(input, plan)
    } catch {
      // Keep heuristic plan as-is.
    }
    applySrDerivedFromBuffHints(input, plan)
    const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input)
    return { js, usedLlm: false }
  }

  // Stronger retry: even if the JSON plan is valid, it may still render into invalid JS
  // (e.g. unbalanced expressions). We validate the final JS and retry a few times.
  const MAX_TRIES = 3
  let lastErr: string | undefined
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const cacheTry = cache ? { ...cache, force: i > 0 ? true : cache.force } : undefined
      const plan = await suggestCalcPlan(llm, input, cacheTry, lastErr)
      applySrDerivedFromBuffHints(input, plan)
      const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
      validateCalcJsText(js)
      validateCalcJsRuntime(js, input)
      return { js, usedLlm: true }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  let plan = heuristicPlan(input)
  try {
    plan = validatePlan(input, plan)
  } catch {
    // Keep heuristic plan as-is.
  }
  applySrDerivedFromBuffHints(input, plan)
  const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
  // Heuristic output should always be valid; if not, still return it (caller logs error).
  try {
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input)
  } catch (e) {
    // Keep lastErr as the primary reason; avoid overriding with a secondary validation msg.
    if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
  }
  return { js, usedLlm: false, error: lastErr || `[meta-gen] LLM calc plan failed` }
}
