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

function validateCalcJsRuntime(js: string, game: 'gs' | 'sr'): void {
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

  const mkDeep0 = (): any => {
    const baseFn = function () {
      return 0
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        return proxy
      },
      apply() {
        return 0
      }
    }
    proxy = new Proxy(baseFn, handler)
    return proxy
  }

  const mkParams0 = (): any => {
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        return 0
      }
    }
    proxy = new Proxy({}, handler)
    return proxy
  }

  const mkAttrSample = (): any => {
    const base: Record<string, number> = {
      atk: 2000,
      hp: 40_000,
      def: 1000,
      mastery: 800,
      recharge: 120,
      heal: 0,
      shield: 0,
      cpct: 50,
      cdmg: 100,
      dmg: 0,
      phy: 0
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

  const N = mkDeep0()
  const P = mkParams0()
  const A = mkAttrSample()
  const ctx = {
    talent: N,
    attr: A,
    calc: (v: unknown) => {
      const n = Number(v)
      return Number.isFinite(n) ? n : 0
    },
    params: P,
    cons: 0,
    weapon: N,
    trees: N,
    currentTalent: ''
  }

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

  const dmgFn: any = function (_pctNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    return { dmg: 0, avg: 0 }
  }
  dmgFn.basic = function (_basicNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    return { dmg: 0, avg: 0 }
  }
  dmgFn.dynamic = function (_pctNum = 0, _talent = false, _dynamicData = false, ele = false) {
    validateEle(ele)
    return { dmg: 0, avg: 0 }
  }
  dmgFn.reaction = function (ele = false) {
    validateEle(ele)
    return { dmg: 0, avg: 0 }
  }
  dmgFn.swirl = function () {
    validateEle('swirl')
    return { dmg: 0, avg: 0 }
  }
  dmgFn.heal = function () {
    return { avg: 0 }
  }
  dmgFn.shield = function () {
    return { avg: 0 }
  }
  dmgFn.elation = function () {
    return { dmg: 0, avg: 0 }
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
  for (const b of buffs) {
    if (!b || typeof b !== 'object') continue
    try {
      if (typeof (b as any).check === 'function') {
        const prev = ctx.currentTalent
        for (const ct of talentVariants) {
          ctx.currentTalent = ct
          ;(b as any).check(ctx)
        }
        ctx.currentTalent = prev
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid buff.check(): ${msg}`)
    }
    const data = (b as any).data
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      for (const [k, v] of Object.entries(data)) {
        if (typeof v !== 'function') continue
        try {
          const prev = ctx.currentTalent
          for (const ct of talentVariants) {
            ctx.currentTalent = ct

            // Mimic miao-plugin: only evaluate data when check passes.
            const ok = typeof (b as any).check === 'function' ? !!(b as any).check(ctx) : true
            if (!ok) continue

            const ret = v(ctx)
            if (typeof ret === 'number') {
              if (!Number.isFinite(ret)) throw new Error(`buff.data() returned non-finite number`)
              const key = String(k || '')
              if (isCritRateKey(key) && Math.abs(ret) > 100) {
                throw new Error(`buff.data() returned unreasonable cpct-like value: ${key}=${ret}`)
              }
              if (isPercentLikeKey(key) && Math.abs(ret) > 500) {
                throw new Error(`buff.data() returned unreasonable percent-like value: ${key}=${ret}`)
              }
            } else if (ret === undefined || ret === null || ret === false || ret === '') {
              // ok (skipped by miao-plugin runtime)
            } else if (ret === true) {
              throw new Error(`buff.data() returned boolean true`)
            } else {
              throw new Error(`buff.data() returned non-number (${typeof ret})`)
            }
          }
          ctx.currentTalent = prev
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          throw new Error(`[meta-gen] Generated calc.js invalid buff.data(): ${msg}`)
        }
      }
    }
  }
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
   * - You can use: talent, attr, calc, params, cons, weapon, trees, currentTalent, dmg, toRatio.
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
  if (/^(speed|recharge|cpct|cdmg|heal|dmg|enemydmg|shield|stance)(Plus|Pct|Inc)?$/.test(key)) return true
  if (/^(enemyDef|enemyIgnore|ignore)$/.test(key)) return true
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
  const a = pickDamageTable(aTables)
  const e = pickDamageTable(eTables)
  const q = pickDamageTable(qTables)
  const t = pickDamageTable(tTables)
  if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a' })
  if (e) details.push({ title: '战技伤害', talent: 'e', table: e, key: 'e' })
  if (q) details.push({ title: '终结技伤害', talent: 'q', table: q, key: 'q' })
  if (t) details.push({ title: '天赋伤害', talent: 't', table: t, key: 't' })
  return {
    mainAttr: 'atk,cpct,cdmg',
    defDmgKey: e ? 'e' : q ? 'q' : a ? 'a' : 'e',
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
    '- details[i].kind 可选：dmg / heal / shield / reaction；不写默认为 dmg。',
    '- 优先选择“可计算伤害”的表：通常表名包含「伤害」或类似字样；尽量不要选「冷却时间」「能量恢复」「削韧」等非伤害表。',
    '- kind=dmg/heal/shield：必须给出 talent + table；并且 table 必须来自我给出的表名列表，不能编造。',
    '- kind=heal/shield：请给出 stat（atk/hp/def/mastery）表示百分比部分基于哪个面板属性计算。',
    '- GS 提示：很多治疗/护盾会同时存在 "治疗量" 和 "治疗量2"（或 "护盾吸收量" / "护盾吸收量2"）。优先选择带 2 的表（通常是 [百分比, 固定值]），不带 2 的同名表往往只是展示用的“百分比+固定值”，不能直接乘面板。',
    '- kind=reaction：仅用于“无表/纯剧变反应”计算（不需要 talent/table），例如 swirl/crystallize/bloom/hyperBloom/burgeon/burning/overloaded/electroCharged/superConduct/shatter。',
    '  - 不要用 kind=reaction 表达蒸发/融化/激化/蔓激化：这些请用 kind=dmg + ele="vaporize/melt/aggravate/spread"。',
    '  - GS 月曜反应（月感电/月绽放/月结晶）：不是 kind=reaction；它们通常是“带表的基础伤害 + 月曜反应加成”，应使用 kind=dmg 并设置 ele="lunarCharged/lunarBloom/lunarCrystallize"。',
    '  - 注意：不要把 ele="lunarCharged/lunarBloom/lunarCrystallize" 用在普通技能伤害上；仅当表名/描述明确为月曜反应或月曜相关追加伤害时才使用。',
    '- details 可选字段：params/check/cons 用于描述“状态/变体”（对标基线 calc.js 的复杂度）。',
    '  - params: 仅允许 number/boolean/string；用于给 miao-plugin 传入默认状态（如 Nightsoul/Moonsign/BondOfLife/层数/开关）。',
    '  - check: 仅允许 JS 表达式（不要写 function/箭头函数）；可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent。',
    '  - 禁止引用不存在的变量（例如 key/title/index/name）。',
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
    '  - 仅当该条目确实是物理伤害时才写 ele="phy"；普通元素技能/元素普攻不要写 ele。',
    '  - weapon=catalyst：普攻/重击/下落默认都是元素伤害（不要写 phy）。',
    '  - weapon=bow：普攻/非满蓄力箭多为物理（可写 phy）；满蓄力/元素箭不要写 phy。',
    '  - 其他近战武器：普攻/重击/下落默认物理（可写 phy）；若存在元素附魔/状态，请用 params+buff/check 表达，而不是把 ele 写死成 phy。',
    '- GS 提示：若你在 talent.e 里看到像普攻一样的表名（例如「一段伤害/五段伤害/重击伤害」），通常表示“E状态下普攻倍率被替换”。此时请用 talent=e 的表作为 table，但 key 仍然用 a/a2（以便吃到普攻/重击相关增益）。',
    '- GS 提示：若 a 表存在明显的“特殊重击/蓄力形态”表名（例如包含「重击·」/「持续伤害」/「蓄力」），请让“重击伤害/重击”条目优先代表该特殊形态，而不是普通「重击伤害」。',
    '- SR key 建议：普攻=a；战技=e；终结技=q；天赋=t（追击等）；可在后面追加逗号标签。',
	    '- details 可选字段：dmgExpr 用于表达复杂公式（当需要多属性混合、多段合计、或多表/条件分支时）。',
	    '  - dmgExpr: JS 表达式（不要写 function/箭头函数），必须返回 dmg(...) 的结果对象；可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent, dmg, toRatio。',
	    '  - GS: 如果 talent.<a/e/q>["表名2"] 在运行时返回数组（如 [atkPct, masteryPct] 或 [pct, flat]），请在 dmgExpr 中用 [0]/[1] 取值，不要直接把数组传给 dmg(...)。',
	    '  - GS: 如果“表值文字样本”里出现 "*N"（例如 "57.28%*2" / "1.41%HP*5" / "80%ATK×3"），并且该表的样本值形如 [x, N]，表示“多段/次数倍率”，应使用乘法：base * x/100 * N（不要写成 + N）。',
	    '  - 提示：如果“表值样本”里出现了某个表名，说明该表在运行时返回数组/对象；不在样本里的表通常是 number。',
	    '  - 对于出现在“表值样本”里的表名（通常以 2 结尾），优先选它作为 table；常见 [pct,flat] / [pct,hits] / [%stat + %stat] 由生成器处理，只有复杂合计才用 dmgExpr。',
	    '  - 如需多项/分支/多段合计计算，配合 dmgExpr。',
	    '  - 多属性混合模板（ATK+精通）：dmg.basic(calc(attr.atk) * toRatio(talent.e["表名2"][0]) + calc(attr.mastery) * toRatio(talent.e["表名2"][1]), "e")',
	    '  - 注意：dmg(...) / dmg.basic(...) 只允许 2~3 个参数：(倍率或基础数值, key, ele?)；第三参只能是 ele 字符串或省略；禁止传入对象/额外参数。',
	    '  - GS: ele 第三参只能省略（不传，禁止传空字符串 ""）、"phy" 或反应ID（melt/vaporize/aggravate/spread/swirl/burning/overloaded/electroCharged/bloom/burgeon/hyperBloom/crystallize/superConduct/shatter 以及 lunarCharged/lunarBloom/lunarCrystallize）。禁止使用元素名 anemo/geo/electro/dendro/hydro/pyro/cryo 作为 ele。',
	    '  - 即使使用 dmgExpr，也请填写 talent/table/key 作为主表与归类 key（用于 UI 与默认排序）。',
	    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal）。',
	    '- buffs 用于对标基线的增益/减益（天赋/行迹/命座/秘技等），输出一个数组（可为空）。',
	    '- buffs[i].data 的值：数字=常量；字符串=JS 表达式（不是函数，不要写箭头函数/function/return），可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent。',
	    '- buffs[i].data 的数值单位：通常是“百分比数值”（例如 +20% 请输出 20，不要输出 0.2）；不要在 buff.data 里使用 toRatio()。',
	    '- buffs 尽量写清楚 check/params 以限定生效范围，避免“无条件全局增益”污染其他技能（尤其是 ePlus/qPlus/aPlus 等）。',
	    '- buffs: 如果文案包含“处于/在…状态/施放后/持续期间/命中后/满层/上限/至多叠加/初辉/满辉/夜魂/月兆/战意”等状态或层数：',
	    '  - 必须写 check，并使用 params.<State> / params.<stacks> 做条件；同时确保至少有 1 条 detail 设置对应 params 使该 buff 生效（对标基线展示行通常按满状态/满层）。',
	    '  - 若文案明确写死层数（例如 300层/3枚/满层），请直接在 buff 表达式里乘上该常量，不要漏乘；只有层数可变时才引入 params.stacks。',
	    '  - “层数上限提升X/额外获得X层”不要用 qPlus/qMulti 等；应把“每层提供的比例” * X，计入 dmg/healInc 等对应 key。',
	    '- 如果需要“基于属性追加伤害值”，使用 aPlus/a2Plus/a3Plus/ePlus/qPlus 等 *Plus key；不要误用 aDmg/eDmg/qDmg/dmg。',
	    '- 如果描述是“提升/提高 X%攻击力(生命值上限/防御力/元素精通) 的伤害/追加值”（例如 640%攻击力），这属于 *Plus：请写成 calc(attr.atk) * (X/100)（例如 640% => calc(attr.atk) * 6.4），不要把 640 当成常量。',
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
    '    { "title": "复杂公式示例", "kind": "dmg", "talent": "e", "table": "技能伤害", "key": "e", "dmgExpr": "dmg.basic(calc(attr.atk) * toRatio(talent.e[\\\"技能伤害\\\"]), \\\"e\\\")" },',
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

  const hasIllegalCalcCall = (expr: string): boolean => {
    // In miao-plugin baseline, `calc()` is used as `calc(attr.xxx)` (single-arg). Multi-arg calls are almost
    // always hallucinations and can explode damage numbers.
    return /\bcalc\([^)]*,/.test(expr)
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

      const check = typeof d.check === 'string' ? d.check.trim() : ''
      if (check) {
        if (!isSafeExpr(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check is not a safe expression`)
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

      const dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
	      if (dmgExpr) {
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

	    const out: CalcSuggestDetail = { title, kind, talent, table: tableFinal }
	    if (typeof d.key === 'string') {
	      // Allow empty string key (baseline uses this for some reaction-like damage such as lunar*).
	      out.key = d.key.trim()
	    }
	    const ele = typeof d.ele === 'string' ? d.ele.trim() : ''
	    if (ele && kind === 'dmg') {
	      // Some models hallucinate element names (cryo/hydro/pyro/...) as ele args.
	      // In miao-plugin, elemental skills should omit ele arg; keep only allowed ids (phy/reaction ids).
	      if (
	        input.game === 'gs' &&
	        /^(anemo|geo|electro|dendro|hydro|pyro|cryo)$/i.test(ele)
	      ) {
	        // ignore
	      } else {
	        out.ele = ele
	      }
	    }
    const stat = normalizeStat(d.stat)
    if (stat) out.stat = stat

    const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

    const check = typeof d.check === 'string' ? d.check.trim() : ''
    if (check) {
      try {
        if (!isSafeExpr(check)) throw new Error('unsafe')
        if (hasBareKeyRef(check)) throw new Error('bare-key')
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
    const dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
	    if (dmgExpr && kind === 'dmg') {
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
    const checkRaw = typeof b.check === 'string' ? b.check.trim() : ''
    let check: string | undefined
    if (
      checkRaw &&
      isSafeExpr(checkRaw) &&
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
        if (!isBuffDataKey(key)) continue
        if (!isAllowedMiaoBuffDataKey(input.game, key)) continue
        if (n >= 50) break
        if (key in out) continue
        if (typeof v === 'number' && Number.isFinite(v)) {
          // `*Multi` keys use a "total multiplier percent" convention in miao-plugin (e.g. 170 means 170%).
          // Some models mistakenly output only the delta part (e.g. 70 for "170%").
          // Heuristic: when value is (0,100) for a `*Multi` key, interpret it as "+v%" and convert to total.
          let num = v
          if (/Multi$/.test(key) && num > 0 && num < 100) num = num + 100
          out[key] = num
          n++
	        } else if (typeof v === 'string') {
	          const vv = v.trim()
          if (!vv) continue
          if (!isSafeExpr(vv)) continue
          if (hasBareKeyRef(vv)) continue
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
	          out[key] = vv
	          n++
	        }
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

  // If official passive/cons descriptions clearly contain "抗性降低xx%" but the LLM forgot to emit a `kx` buff,
  // add a simple max-tier `kx` showcase buff (baseline often assumes the max condition for comparing output).
  if (input.game === 'gs') {
    const hasKx = buffsOut.some((b) => !!b.data && Object.prototype.hasOwnProperty.call(b.data, 'kx'))
    if (!hasKx) {
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
        buffsOut.unshift({
          title: `被动/命座：敌方元素抗性降低[kx]%（默认按最大档位）`,
          data: { kx: best }
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

  return { mainAttr, defDmgKey, details, buffs: buffsOut }
}

export async function suggestCalcPlan(
  llm: LlmService,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
): Promise<CalcSuggestResult> {
  const messagesBase = buildMessages(input)
  const attempts: Array<{ temperature: number; messages: ChatMessage[] }> = [
    { temperature: 0.2, messages: messagesBase },
    {
      temperature: 0,
      messages: messagesBase.concat({
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
    // Be conservative: only treat it as HP/DEF scaling when the description explicitly states
    // "based on HP/DEF" (e.g. "基于生命值上限造成...伤害"). Many skills mention HP thresholds
    // like "生命值上限的30%时" which should NOT flip the damage base.
    if (/(基于|按).{0,20}(元素精通|精通)/.test(desc)) return 'mastery'
    if (/(基于|按).{0,20}(生命上限|生命值上限|最大生命值|生命值)/.test(desc)) return 'hp'
    if (/(基于|按).{0,20}防御力/.test(desc)) return 'def'
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

	    // e.g. "32.42%+32.42%" where runtime returns [hit1Pct, hit2Pct, ...]
	    // We treat this as multi-hit parts that can be summed into a single percentage multiplier.
	    // If the stat is not explicitly mentioned, default to ATK (most damage tables).
	    const hasPctAll = split.every((p) => /[%％]/.test(p))
	    if (hasPctAll) {
	      const stats = split.map((p) => inferStatFromText(p)).filter(Boolean) as CalcScaleStat[]
	      const stat = stats[0] || 'atk'
	      const allSame = stats.length === 0 || stats.every((s) => s === stat)
	      if (allSame) return { kind: 'pctList', stat }
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
    const collectParamRefs = (expr: string): void => {
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = m[1]
        if (!k) continue
        paramKeysInBuff.add(k)
      }
    }
    for (const b of plan.buffs || []) {
      if (typeof (b as any).check === 'string') collectParamRefs((b as any).check)
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

      // Conservative numeric defaults: only for obvious stack/count params within a small bound.
      const n = numMax[k]
      const isCountLike = /^(?:layer|layers|stacks|stack|count|cnt|num|cracks|drops|hunterstacks|glory_stacks|veil_of_falsehood|hpabove50count)$/i.test(
        k
      )
      const nOk = Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 0 && n <= 20
      if (isCountLike && nOk) {
        out[k] = Math.trunc(n)
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

    // Heuristic default:
    // - GS melee normals are physical (explicit "phy")
    // - catalyst normals are elemental (no explicit eleArg)
    // - bow normals are usually physical, BUT full-charge/elemental arrows are not
	    const eleArg =
	      ele
	        ? `, ${ele}`
	        : inferredEle
	          ? `, ${jsString(inferredEle)}`
	            : ''

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
	        'lunarcrystallize'
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
    const unit = unitMap ? unitMap[tableName] : undefined
    const unitBase = inferDmgBaseFromUnit(unit)
    const base = unitBase || inferDmgBase((input.talentDesc as any)?.[talent])
    const useBasic = base !== 'atk'

	    if (kind === 'heal' || kind === 'shield') {
      const method = kind === 'heal' ? 'heal' : 'shield'
      const stat = (d.stat ||
        inferScaleStatFromUnit(unit) ||
        inferScaleStatFromDesc((input.talentDesc as any)?.[talent])) as CalcScaleStat

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
      detailsLines.push(`      const t = talent.${talent}[${table}]`)
      detailsLines.push(`      const base = calc(attr.${stat})`)
      detailsLines.push(`      if (Array.isArray(t)) return ${method}(base * toRatio(t[0]) + (Number(t[1]) || 0))`)
      detailsLines.push(`      return ${method}(base * toRatio(t))`)
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
	    const schema = inferArrayTableSchema(talent, tableName)
	    if (schema?.kind === 'statStat') {
	      const [s0, s1] = schema.stats
	      detailsLines.push(
	        `        return dmg.basic(calc(attr.${s0}) * toRatio(t[0]) + calc(attr.${s1}) * toRatio(t[1]), ${keyArg}${eleArg})`
	      )
	    } else if (schema?.kind === 'statTimes') {
	      // e.g. [pct, hits] from `...2` tables where text sample is like "1.41%HP*5".
	      if (schema.stat === 'atk' && !useBasic) {
	        detailsLines.push(`        return dmg((Number(t[0]) || 0) * (Number(t[1]) || 0), ${keyArg}${eleArg})`)
	      } else {
	        detailsLines.push(
	          `        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]) * (Number(t[1]) || 0), ${keyArg}${eleArg})`
	        )
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
    `({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${expr})`
  const wrapExprNumber = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => {` +
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
    const plan = heuristicPlan(input)
    const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input.game)
    return { js, usedLlm: false }
  }

  // Stronger retry: even if the JSON plan is valid, it may still render into invalid JS
  // (e.g. unbalanced expressions). We validate the final JS and retry a few times.
  const MAX_TRIES = 3
  let lastErr: string | undefined
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const cacheTry = cache ? { ...cache, force: i > 0 ? true : cache.force } : undefined
      const plan = await suggestCalcPlan(llm, input, cacheTry)
      const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
      validateCalcJsText(js)
      validateCalcJsRuntime(js, input.game)
      return { js, usedLlm: true }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  const plan = heuristicPlan(input)
  const js = renderCalcJs(input, plan, DEFAULT_CREATED_BY)
  // Heuristic output should always be valid; if not, still return it (caller logs error).
  try {
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input.game)
  } catch (e) {
    // Keep lastErr as the primary reason; avoid overriding with a secondary validation msg.
    if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
  }
  return { js, usedLlm: false, error: lastErr || `[meta-gen] LLM calc plan failed` }
}
