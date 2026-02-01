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

function validateCalcJsRuntime(js: string): void {
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

  const dmgFn: any = function () {
    return { dmg: 0, avg: 0 }
  }
  dmgFn.basic = function () {
    return { dmg: 0, avg: 0 }
  }
  dmgFn.dynamic = function () {
    return { dmg: 0, avg: 0 }
  }
  dmgFn.reaction = function () {
    return { dmg: 0, avg: 0 }
  }
  dmgFn.swirl = function () {
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

  const details = Array.isArray(mod?.details) ? mod.details : []
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (typeof (d as any).dmg !== 'function') continue
    try {
      if (typeof (d as any).check === 'function') {
        ;(d as any).check(ctx)
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid detail.check(): ${msg}`)
    }
    try {
      const ret = (d as any).dmg(ctx, dmgFn)
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
        ;(b as any).check(ctx)
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
    descLines.push(`- ${k}: ${shortenText(t, 600)}`)
  }

  const buffHintLines: string[] = []
  const buffHints = Array.isArray(input.buffHints) ? input.buffHints : []
  for (const h of buffHints) {
    const t = normalizePromptText(h)
    if (!t) continue
    buffHintLines.push(`- ${shortenText(t, 260)}`)
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
    '  - cons: 1..6；用于限制该 detail 只在对应命座生效时展示/计算。',
    '  - 如果某些伤害在特定状态下才成立（例如 夜魂、月兆、Q期间、满层/满战意），请用不同的 detail 行来表达：',
    '    - 通过 key 使用标签（例如 "e,nightsoul" / "q,nightsoul"）来触发对应的增益域；必要时配合 params 设置默认状态。',
    '- GS key 建议：普攻=a，重击=a2，下落=a3；元素战技=e；元素爆发=q；可在后面追加标签（逗号分隔）。',
    '- GS 提示：若你在 talent.e 里看到像普攻一样的表名（例如「一段伤害/五段伤害/重击伤害」），通常表示“E状态下普攻倍率被替换”。此时请用 talent=e 的表作为 table，但 key 仍然用 a/a2（以便吃到普攻/重击相关增益）。',
    '- GS 提示：若 a 表存在明显的“特殊重击/蓄力形态”表名（例如包含「重击·」/「持续伤害」/「蓄力」），请让“重击伤害/重击”条目优先代表该特殊形态，而不是普通「重击伤害」。',
    '- SR key 建议：普攻=a；战技=e；终结技=q；天赋=t（追击等）；可在后面追加逗号标签。',
	    '- details 可选字段：dmgExpr 用于表达复杂公式（当需要多属性混合、多段合计、或多表/条件分支时）。',
	    '  - dmgExpr: JS 表达式（不要写 function/箭头函数），必须返回 dmg(...) 的结果对象；可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent, dmg, toRatio。',
	    '  - GS: 如果 talent.<a/e/q>["表名2"] 在运行时返回数组（如 [atkPct, masteryPct] 或 [pct, flat]），请在 dmgExpr 中用 [0]/[1] 取值，不要直接把数组传给 dmg(...)。',
	    '  - 提示：如果“表值样本”里出现了某个表名，说明该表在运行时返回数组/对象；不在样本里的表通常是 number。',
	    '  - 对于出现在“表值样本”里的表名（尤其是以 2 结尾的），你必须优先选它作为 table（因为不带 2 的同名表通常是把多项系数相加得到的展示值，会导致伤害严重偏差）。',
	    '  - 如需多项/分支/多段合计计算，配合 dmgExpr。',
	    '  - 多属性混合模板（ATK+精通）：dmg.basic(calc(attr.atk) * toRatio(talent.e["表名2"][0]) + calc(attr.mastery) * toRatio(talent.e["表名2"][1]), "e")',
	    '  - 注意：dmg(...) / dmg.basic(...) 只允许 2~3 个参数：(倍率或基础数值, key, ele?)；第三参只能是 ele 字符串或省略；禁止传入对象/额外参数。',
	    '  - 即使使用 dmgExpr，也请填写 talent/table/key 作为主表与归类 key（用于 UI 与默认排序）。',
	    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal）。',
	    '- buffs 用于对标基线的增益/减益（天赋/行迹/命座/秘技等），输出一个数组（可为空）。',
	    '- buffs[i].data 的值：数字=常量；字符串=JS 表达式（不是函数，不要写箭头函数/function/return），可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent。',
	    '- buffs[i].data 的数值单位：通常是“百分比数值”（例如 +20% 请输出 20，不要输出 0.2）；不要在 buff.data 里使用 toRatio()。',
	    '- 如果需要“基于属性追加伤害值”，使用 aPlus/a2Plus/a3Plus/ePlus/qPlus 等 *Plus key；不要误用 aDmg/eDmg/qDmg/dmg。',
	    '- 如果描述是“造成原本170%的伤害/提高到160%”这类乘区倍率，使用 aMulti/a2Multi/qMulti 等 *Multi key（数值仍用百分比数值，例如 170）。',
	    '- 若是“月曜反应伤害提升”，使用 lunarBloom/lunarCharged/lunarCrystallize 作为 buff.data key（数值为百分比数值）。',
    '- buffs[i].data 的 key 请尽量使用基线常见命名（避免自造）：',
    `  - GS 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,mastery,recharge,heal,shield,dmg,phy,aDmg,a2Dmg,a3Dmg,eDmg,qDmg,aPlus,a2Plus,a3Plus,ePlus,qPlus,aMulti,a2Multi,a3Multi,qMulti,lunarBloom,lunarCharged,lunarCrystallize,kx,enemyDef,fypct,fyplus,fybase,fyinc,swirl,crystallize,bloom,hyperBloom,burgeon,burning,overloaded,electroCharged,superConduct,shatter`,
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
    const kind = normalizeKind(d.kind)
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
	    if (ele) out.ele = ele
    const stat = normalizeStat(d.stat)
    if (stat) out.stat = stat

    const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

    const check = typeof d.check === 'string' ? d.check.trim() : ''
    if (check) {
      if (!isSafeExpr(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check is not a safe expression`)
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
  }

  if (details.length === 0) throw new Error(`[meta-gen] invalid LLM plan: no valid details`)

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
      // Prefer aggregate table for multi-hit when the base table text sample contains `*N`.
      if (d.table && d.talent && d.table.endsWith('2')) {
        const baseName = d.table.slice(0, -1)
        const allowed = tables[d.talent] || []
        const sampleText = (textSamples as any)?.[d.talent]?.[baseName]
        if (allowed.includes(baseName) && typeof sampleText === 'string' && /\*\s*\d+/.test(sampleText)) {
          d.table = baseName
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
      const want = eNaCandidates.filter(
        (c) => !details.some((d) => d.talent === 'e' && typeof d.table === 'string' && d.table === c.table)
      )
      if (want.length) {
        for (let i = want.length - 1; i >= 0; i--) {
          const c = want[i]!
          details.unshift({ title: c.title, kind: 'dmg', talent: 'e', table: c.table, key: c.key })
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
    const check =
      checkRaw && isSafeExpr(checkRaw) && !hasIllegalTalentRef(checkRaw) && !hasIllegalCalcCall(checkRaw)
        ? checkRaw
        : undefined

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
        if (n >= 50) break
        if (key in out) continue
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[key] = v
          n++
	        } else if (typeof v === 'string') {
	          const vv = v.trim()
	          if (!vv) continue
	          if (!isSafeExpr(vv)) continue
	          if (hasIllegalTalentRef(vv)) continue
	          if (hasIllegalCalcCall(vv)) continue
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
	    | null => {
	    const textRaw = (input.tableTextSamples as any)?.[talentKey]?.[tableName]
	    const text = normalizePromptText(textRaw)
	    if (!text) return null

	    const split = text
	      .split(/[+＋]/)
	      .map((s) => s.trim())
	      .filter(Boolean)
	    if (split.length < 2) return null

	    const inferStatFromText = (s: string): CalcScaleStat | null => {
	      if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(s)) return 'mastery'
	      if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(s)) return 'hp'
	      if (/(防御力|\bdef\b)/i.test(s)) return 'def'
	      if (/(攻击力|攻击|\batk\b)/i.test(s)) return 'atk'
	      return null
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
      detailsLines.push(`    dmgKey: ${jsString(d.key || talentKey || 'e')},`)
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
      detailsLines.push(
        `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (${dmgExpr})`
      )
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
          : input.game === 'gs' && talent === 'a'
            ? isCatalyst
              ? ''
              : isBow
                ? (() => {
                    const hint = `${d.title || ''} ${tableName || ''}`
                    // Elemental/charged special arrows (avoid forcing phy).
                    if (/(满蓄力|二段蓄力|三段蓄力|蓄力完成|破局|霜华|花筥)/.test(hint)) return ''
                    // Aimed shot without full charge is physical.
                    if (/瞄准射击/.test(hint) && !/满蓄力/.test(hint)) return `, "phy"`
                    // Default bow multi-hit and plunge are physical.
                    if (/(一段|二段|三段|四段|五段|六段|下落|坠地|低空|高空)/.test(hint)) return `, "phy"`
                    // Fallback: keep it physical (safer than defaulting to character element).
                    return `, "phy"`
                  })()
	                : `, "phy"`
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
    validateCalcJsRuntime(js)
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
      validateCalcJsRuntime(js)
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
    validateCalcJsRuntime(js)
  } catch (e) {
    // Keep lastErr as the primary reason; avoid overriding with a secondary validation msg.
    if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
  }
  return { js, usedLlm: false, error: lastErr || `[meta-gen] LLM calc plan failed` }
}
