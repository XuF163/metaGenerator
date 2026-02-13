import fs from 'node:fs'
import path from 'node:path'

import type { CalcSuggestBuff, CalcSuggestInput } from './llm-calc/types.js'
import { isAllowedMiaoBuffDataKey } from './llm-calc/utils.js'
import { buildCalcUpstreamContext } from './upstream-follow/context.js'

function resolveMaybeRelative(projectRootAbs: string, p: string | undefined): string | undefined {
  const t = typeof p === 'string' ? p.trim() : ''
  if (!t) return undefined
  return path.isAbsolute(t) ? t : path.resolve(projectRootAbs, t)
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function extractArrowFnBodyBlock(text: string, propName: string): string {
  const idx = text.indexOf(`${propName}:`)
  if (idx < 0) return ''
  const idxArrow = text.indexOf('=>', idx)
  if (idxArrow < 0) return ''
  const idxBrace = text.indexOf('{', idxArrow)
  if (idxBrace < 0) return ''
  let depth = 0
  for (let i = idxBrace; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0 && i > idxBrace) return text.slice(idxBrace + 1, i)
  }
  return ''
}

function isNumberLiteral(expr: string): number | null {
  const t = expr.trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function scaleExpr(expr: string, scale: number): number | string {
  const n = isNumberLiteral(expr)
  if (n != null) {
    const v = n * scale
    if (!Number.isFinite(v)) return 0
    const rounded = Math.abs(v - Math.round(v)) < 1e-9 ? Math.round(v) : Number(v.toFixed(6))
    return rounded
  }
  if (scale === 1) return expr.trim()
  return `((${expr.trim()}) * ${scale})`
}

function normalizeExpr(exprRaw: string): string {
  let expr = String(exprRaw || '').trim()
  if (!expr) return ''
  expr = expr.replace(/\b([rmt])\./g, 'params.')
  expr = expr.replace(/\be\b/g, 'cons')
  // Common upstream computed-stat reads (x.c.a[Key.HP]) -> miao attr access.
  // This allows us to inline/emit trace buffs like "CR scales with HP" as pure expressions.
  expr = expr.replace(/\bx\.c\.a\s*\[\s*Key\.HP\s*]/g, 'calc(attr.hp)')
  expr = expr.replace(/\bx\.c\.a\s*\[\s*Key\.ATK\s*]/g, 'calc(attr.atk)')
  expr = expr.replace(/\bx\.c\.a\s*\[\s*Key\.DEF\s*]/g, 'calc(attr.def)')
  expr = expr.replace(/\bx\.c\.a\s*\[\s*Key\.SPD\s*]/g, 'calc(attr.speed)')
  // Upstream sometimes reads the already-computed stat array as `x.a[Key.*]` instead of `x.c.a[Key.*]`.
  // Translate the common ones we can model in miao-plugin's calc.js environment.
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.HP\s*]/g, 'calc(attr.hp)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.ATK\s*]/g, 'calc(attr.atk)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.DEF\s*]/g, 'calc(attr.def)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.SPD\s*]/g, 'calc(attr.speed)')
  // SR rate stats: upstream uses ratios (0.75), while miao-plugin attr uses percent points (75).
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.EHR\s*]/g, '(attr.effPct / 100)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.(?:EFF_RES|ERS)\s*]/g, '(attr.effDef / 100)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.CR\s*]/g, '(attr.cpct / 100)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.CD\s*]/g, '(attr.cdmg / 100)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.ERR\s*]/g, '(attr.recharge / 100)')
  expr = expr.replace(/\bx\.a\s*\[\s*Key\.(?:BE|BREAK_EFF)\s*]/g, '(attr.stance / 100)')
  // Align common upstream param ids to baseline-like conventions (improves matching and state gating).
  expr = expr.replace(/\bparams\.talentEnhancedState\b/g, 'params.strength')
  // Baseline meta commonly gates ultimate-field effects with `params.q`.
  expr = expr.replace(/\bparams\.ultFieldActive\b/g, 'params.q')
  // Baseline meta commonly gates skill-state buffs with `params.eBuff` (unset => off).
  expr = expr.replace(/\bparams\.skillOvertoneBuff\b/g, 'params.eBuff')
  return expr
}

function parseAbilityGroup(group: string): Set<string> {
  const parts = group.split('_').filter(Boolean)
  const out = new Set<string>()
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i] || ''
    const n = parts[i + 1] || ''
    if (p === 'MEMO' && n === 'TALENT') {
      out.add('MEMO_TALENT')
      i++
      continue
    }
    if (p === 'MEMO' && n === 'SKILL') {
      out.add('MEMO_SKILL')
      i++
      continue
    }
    out.add(p)
  }
  return out
}

function extractAbilityThresholdsByFnName(text: string): Record<string, number> {
  const m = text.match(/\bconst\s*\{\s*[^}]+\s*}\s*=\s*AbilityEidolon\.([A-Z0-9_]+)/)
  const key = m?.[1] || ''
  if (!key) return {}

  const m2 = key.match(/^(.*)_3_(.*)_5$/)
  if (!m2) return {}
  const g3 = parseAbilityGroup(m2[1] || '')
  const g5 = parseAbilityGroup(m2[2] || '')

  const pick = (ability: string): number | undefined => (g3.has(ability) ? 3 : g5.has(ability) ? 5 : undefined)

  const out: Record<string, number> = {}
  const basic = pick('BASIC')
  const skill = pick('SKILL')
  const ult = pick('ULT')
  const talent = pick('TALENT')
  const memoTalent = pick('MEMO_TALENT')
  const memoSkill = pick('MEMO_SKILL')

  if (basic) out.basic = basic
  if (skill) out.skill = skill
  if (ult) out.ult = ult
  if (talent) out.talent = talent
  if (memoTalent) out.memoTalent = memoTalent
  if (memoSkill) out.memoSkill = memoSkill
  return out
}

function hasUnknownFreeIdentifiers(expr: string): boolean {
  const allowed = new Set([
    'cons',
    'params',
    'Math',
    'talent',
    'attr',
    'calc',
    'weapon',
    'trees',
    'true',
    'false',
    'null',
    'undefined',
    'Infinity',
    'NaN'
  ])
  const re = /\b[A-Za-z_][A-Za-z0-9_]*\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(expr))) {
    const id = m[0] || ''
    if (!id) continue
    const prev = expr[m.index - 1]
    if (prev === '.') continue
    if (allowed.has(id)) continue
    return true
  }
  return false
}

type ConstEntry = { name: string; expr: string }

function extractConstEntries(text: string): ConstEntry[] {
  const out: ConstEntry[] = []
  const re = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([^;\r\n]+)\s*;?/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = String(m[1] || '').trim()
    const expr = String(m[2] || '').trim()
    if (!name || !expr) continue
    out.push({ name, expr })
  }
  return out
}

function inlineConsts(expr: string, constMap: Record<string, string>): string {
  let out = expr
  for (const [k, v] of Object.entries(constMap)) {
    if (!k || !v) continue
    if (!out.includes(k)) continue
    // Do not inline when used as a member-access property name (e.g. `params.foo`),
    // otherwise we'd emit invalid syntax like `params.(...)`.
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9_.])${escapeRegExp(k)}\\b`, 'g'), (_m0, pre) => `${pre}(${v})`)
  }
  return out
}

function buildConstExprMap(text: string): Record<string, string> {
  const thresholds = extractAbilityThresholdsByFnName(text)
  const entries = extractConstEntries(text)
  const resolved: Record<string, string> = {}
  const pending: ConstEntry[] = []

  const rewriteAbilityCalls = (exprRaw: string): string => {
    let expr = String(exprRaw || '')
    if (!expr) return ''
    // Replace `<abilityFn>(e|cons, a, b)` with `(cons >= threshold ? b : a)` when the threshold is known.
    expr = expr.replace(
      /\b([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(?:e|cons)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)/g,
      (m0, fn0, a0, b0) => {
        const fn = String(fn0 || '').trim()
        const t = thresholds[fn]
        if (!t) return m0
        return `(cons >= ${t} ? ${String(b0)} : ${String(a0)})`
      }
    )
    return expr
  }

  for (const e of entries) {
    const n = isNumberLiteral(e.expr)
    if (n != null) {
      resolved[e.name] = String(n)
      continue
    }

    pending.push({ name: e.name, expr: rewriteAbilityCalls(normalizeExpr(e.expr)) })
  }

  for (let pass = 0; pass < 4; pass++) {
    let progressed = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!
      const expr = rewriteAbilityCalls(inlineConsts(p.expr, resolved))
      if (!expr) continue
      if (hasUnknownFreeIdentifiers(expr)) continue
      resolved[p.name] = expr
      pending.splice(i, 1)
      progressed = true
    }
    if (!progressed) break
  }

  return resolved
}

function extractBraceBlock(text: string, openBraceIdx: number): string {
  if (openBraceIdx < 0 || openBraceIdx >= text.length) return ''
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0 && i > openBraceIdx) return text.slice(openBraceIdx, i + 1)
  }
  return ''
}

function splitTopLevelComma(blockText: string): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = 0; i < blockText.length; i++) {
    const ch = blockText[i]!
    if (inStr) {
      cur += ch
      if (ch === '\\') {
        const next = blockText[i + 1]
        if (next) {
          cur += next
          i++
        }
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (depth === 0 && ch === ',') {
      const t = cur.trim()
      if (t) out.push(t)
      cur = ''
      continue
    }
    cur += ch
  }
  const tail = cur.trim()
  if (tail) out.push(tail)
  return out
}

function mapSrParamKey(kRaw: string): string {
  const k = String(kRaw || '').trim()
  if (!k) return ''
  if (k === 'talentEnhancedState') return 'strength'
  return k
}

function applySrDefaultsExprOverrides(defaults: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = { ...defaults }

  const set = (k: string, v: string): void => {
    const key = String(k || '').trim()
    const val = String(v || '').trim()
    if (!key || !val) return
    out[key] = val
  }

  for (const k0 of Object.keys(out)) {
    const k = String(k0 || '').trim()
    if (!k) continue
    const lower = k.toLowerCase()
    const v = String(out[k] || '').trim()
    if (!v) continue

    // Upstream defaults are curated for optimizer UI, but baseline meta treats some knobs as *stateful toggles*
    // (unset => off) to avoid inflating damage outside the intended state rows.
    //
    // - "enhanced/state/mode/stance" flags: default to false (state is enabled per-row via params).
    // - generic stack counters: default to 0, except talent-like stacks (often showcased at max in baseline).
    if (v === 'true') {
      // Keep this conservative: many upstream knobs end with "...State" but are effectively "kit baseline"
      // assumptions in CNB-style showcase calcs (e.g. `vendettaState`). Only force-disable the obviously
      // transient/enhanced toggles by default.
      const isStateLike = /(enhanced|mode|stance|active|field)/.test(lower)
      if (isStateLike) {
        set(k, 'false')
        continue
      }
    }

    const looksLikeStack = /stacks?/.test(lower) || /\bstack\b/.test(lower)
    const isEidolonLike = /^[eq]\d/.test(lower)
    const isEnemyLike = /(enemy|target|weakness)/.test(lower)
    const isTalentLike = /talent/.test(lower)
    if (looksLikeStack && !isEidolonLike && !isEnemyLike && !isTalentLike) {
      // Keep cons-dependent max defaults (common in showcase-style rows, e.g. memoSpdStacksMax = e>=4?7:6).
      // Otherwise, treat stack counters as stateful knobs (unset => 0) to avoid inflating baseline comparisons.
      const n = isNumberLiteral(v)
      const isConsDependent = /\bcons\b/.test(v)
      if (n != null || !isConsDependent) {
        set(k, '0')
        continue
      }
    }

    // Tribbie-like "alliesMaxHp" knobs: baseline typically uses a single-character showcase approximation.
    // Defaulting to own HP reduces drift vs baseline while keeping the param overrideable per row.
    // NOTE: Do NOT match generic "MaxHp" substrings (e.g. `e4MaxHpIncreaseStacks`), otherwise we'd default a
    // numeric stack counter to `calc(attr.hp)` and massively inflate damage via `hpPct` buffs.
    if (/(allies|ally|team)/.test(lower) && /(maxhp|max_hp)/.test(lower)) {
      set(k, 'calc(attr.hp)')
      continue
    }
  }

  return out
}

function extractDefaultsExprMap(text: string, constMap: Record<string, string>): Record<string, string> {
  const idx = text.indexOf('const defaults')
  if (idx < 0) return {}
  const idxBrace = text.indexOf('{', idx)
  if (idxBrace < 0) return {}
  const block = extractBraceBlock(text, idxBrace)
  if (!block) return {}
  const inner = block.slice(1, -1)

  const out: Record<string, string> = {}
  for (const ent of splitTopLevelComma(inner)) {
    const idxColon = ent.indexOf(':')
    if (idxColon <= 0) continue
    const key = mapSrParamKey(ent.slice(0, idxColon).trim())
    if (!key) continue
    let rhs = ent.slice(idxColon + 1).trim()
    if (!rhs) continue
    // Strip trailing comments.
    rhs = rhs.replace(/\/\/.*$/, '').trim()
    if (!rhs) continue

    if (rhs === 'true' || rhs === 'false') {
      out[key] = rhs
      continue
    }
    const n = isNumberLiteral(rhs)
    if (n != null) {
      out[key] = String(n)
      continue
    }

    let expr = normalizeExpr(rhs)
    expr = inlineConsts(expr, constMap)
    expr = expr.trim()
    if (!expr) continue
    if (hasUnknownFreeIdentifiers(expr)) continue
    out[key] = expr
  }
  return applySrDefaultsExprOverrides(out)
}

function applyDefaultsToParamsExpr(expr: string, defaults: Record<string, string>): string {
  let out = String(expr || '').trim()
  if (!out) return ''
  for (const [k, defExpr0] of Object.entries(defaults)) {
    const key = String(k || '').trim()
    if (!key) continue
    // Never default `strength`: it should be explicitly set on the relevant detail rows.
    if (key === 'strength') continue
    const defExpr = String(defExpr0 || '').trim()
    if (!defExpr) continue
    out = out.replace(
      new RegExp(`\\bparams\\.${escapeRegExp(key)}\\b(?!\\s*\\?\\?)`, 'g'),
      `(params.${key} ?? (${defExpr}))`
    )
  }
  return out
}

function extractCallArgs(text: string, openParenIdx: number, maxArgs = 6): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inStr: '"' | "'" | null = null
  for (let i = openParenIdx + 1; i < text.length; i++) {
    const ch = text[i]!
    if (inStr) {
      cur += ch
      if (ch === '\\') {
        const next = text[i + 1]
        if (next) {
          cur += next
          i++
        }
        continue
      }
      if (ch === inStr) inStr = null
      continue
    }
    if (ch === '"' || ch === "'") {
      inStr = ch
      cur += ch
      continue
    }
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (depth < 0) break
    if (depth === 0 && ch === ',') {
      out.push(cur.trim())
      cur = ''
      if (out.length >= maxArgs) return out
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur.trim())
  return out
}

type StatVarMap = { key: string; scale: number; baseStat?: 'atk' | 'hp' | 'def'; kind?: 'scaling' }

function mapStatVarToBuffKey(varName: string): StatVarMap | null {
  const v = varName.trim().toUpperCase()
  if (!v) return null

  // Upstream uses `*_SCALING` vars to model both:
  // - base talent multipliers (already represented by our local talent tables)
  // - extra scaling components from eidolons/traces/conditionals (NOT represented in tables)
  //
  // We map the latter into miao-plugin's `<key>Plus` buckets so that:
  //   baseDamage = baseStat * talentTable
  //   plusDamage = baseStat * extraScaling
  // which matches baseline modeling and keeps results comparable.
  const mScaling = /^(BASIC|SKILL|ULT|FUA|DOT|BREAK)_(ATK|HP|DEF)_SCALING$/.exec(v)
  if (mScaling) {
    const ability = mScaling[1]!
    const stat = mScaling[2]!
    const baseStat = stat === 'HP' ? 'hp' : stat === 'DEF' ? 'def' : 'atk'
    const prefix =
      ability === 'BASIC'
        ? 'a'
        : ability === 'SKILL'
          ? 'e'
          : ability === 'ULT'
            ? 'q'
            : ability === 'FUA'
              ? 't'
              : ability === 'DOT'
                ? 'dot'
                : 'break'
    return { key: `${prefix}Plus`, scale: 1, baseStat, kind: 'scaling' }
  }
  if (/_TOUGHNESS/.test(v)) return null

  if (v === 'ATK_P') return { key: 'atkPct', scale: 100 }
  if (v === 'ATK') return { key: 'atkPlus', scale: 1 }
  if (v === 'HP_P') return { key: 'hpPct', scale: 100 }
  if (v === 'HP') return { key: 'hpPlus', scale: 1 }
  if (v === 'DEF_P') return { key: 'defPct', scale: 100 }
  if (v === 'DEF') return { key: 'defPlus', scale: 1 }
  if (v === 'SPD_P') return { key: 'speedPct', scale: 100 }
  if (v === 'SPD') return { key: 'speedPlus', scale: 1 }
  if (v === 'CR') return { key: 'cpct', scale: 100 }
  if (v === 'CD') return { key: 'cdmg', scale: 100 }
  if (v === 'ERR') return { key: 'recharge', scale: 100 }
  if (v === 'DEF_PEN') return { key: 'ignore', scale: 100 }
  if (v === 'RES_PEN') return { key: 'kx', scale: 100 }
  // Element-specific RES PEN (ICE_RES_PEN/WIND_RES_PEN/...) maps to miao-plugin's generic kx bucket.
  if (/_RES_PEN$/.test(v) && v !== 'EFFECT_RES_PEN') return { key: 'kx', scale: 100 }
  if (v === 'ELEMENTAL_DMG' || v === 'DMG_P') return { key: 'dmg', scale: 100 }
  if (v === 'VULNERABILITY' || v === 'ENEMY_DMG' || v === 'ENEMY_DMG_P') return { key: 'enemydmg', scale: 100 }
  if (v === 'EHR') return { key: 'effPct', scale: 100 }
  if (v === 'ERS' || v === 'EFF_RES') return { key: 'effDef', scale: 100 }
  if (v === 'BREAK_EFF' || v === 'BE') return { key: 'stance', scale: 100 }
  // Some kits use a dedicated "true dmg" multiplier bucket (additive to the final multiplier).
  // Baseline commonly models this as `multi` (percent points), not as `dmg%`.
  if (v === 'TRUE_DMG_MODIFIER') return { key: 'multi', scale: 100 }
  return null
}

function mapAbilityDmgTypeToBuffKey(typeConst: string): string | null {
  const t = typeConst.trim().toUpperCase()
  if (!t) return null
  if (t === 'BASIC_DMG_TYPE') return 'aDmg'
  if (t === 'SKILL_DMG_TYPE') return 'eDmg'
  if (t === 'ULT_DMG_TYPE') return 'qDmg'
  if (t === 'FUA_DMG_TYPE') return 'tDmg'
  if (t === 'DOT_DMG_TYPE') return 'dotDmg'
  if (t === 'BREAK_DMG_TYPE') return 'breakDmg'
  return null
}

function abilityPrefixFromTypeConst(typeConst: string): string | null {
  const key = mapAbilityDmgTypeToBuffKey(typeConst)
  if (!key) return null
  return key.endsWith('Dmg') ? key.slice(0, -3) : null
}

function extractAbilityTypeConsts(typeExpr: string): string[] {
  const out: string[] = []
  const re = /\b[A-Z][A-Z0-9_]*_DMG_TYPE\b/g
  let m: RegExpExecArray | null
  while ((m = re.exec(String(typeExpr || '')))) {
    const k = String(m[0] || '').trim()
    if (k) out.push(k)
  }
  return Array.from(new Set(out))
}

function extractBuffsFromBlock(
  blockText: string,
  constMap: Record<string, string>,
  defaultsExpr: Record<string, string>,
  opts?: { includeTeamBuffs?: boolean }
): CalcSuggestBuff[] {
  const buffs: CalcSuggestBuff[] = []
  const push = (title: string, dataKey: string, value: number | string, extra?: Pick<CalcSuggestBuff, 'tree'>): void => {
    if (!isAllowedMiaoBuffDataKey('sr', dataKey)) return
    const b: CalcSuggestBuff = { title, data: { [dataKey]: value } }
    if (extra?.tree) b.tree = extra.tree
    buffs.push(b)
  }

  const statRe = /\bx\.([A-Z][A-Z0-9_]+)\.(buff|buffSingle|buffTeam)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = statRe.exec(blockText))) {
    const varName = String(m[1] || '').trim()
    const method = String(m[2] || '').trim()
    if (!varName) continue
    if (method === 'buffTeam' && !opts?.includeTeamBuffs) {
      // Many upstream "team" effects are actually enemy debuffs (RES_PEN/vulnerability) that affect the caster too.
      // Keep these even when we otherwise skip teammate-only buffs.
      const v = varName.toUpperCase()
      const keepDebuffLikeTeam =
        (/_RES_PEN$/.test(v) && v !== 'EFFECT_RES_PEN') || v === 'RES_PEN' || v === 'VULNERABILITY' || v.startsWith('ENEMY_DMG')
      if (!keepDebuffLikeTeam) continue
    }

    const mapped = mapStatVarToBuffKey(varName)
    if (!mapped) continue

    const open = blockText.indexOf('(', m.index)
    if (open < 0) continue
    const args = extractCallArgs(blockText, open)
    const raw0 = args[0] || ''
    const rawSource = args[1] || ''
    if (!raw0) continue
    // We can translate a subset of `x.*` reads into attr/calc (see normalizeExpr()), so do not early-drop on `x.`.
    if (/\baction\b/.test(raw0) || /\bcontext\b/.test(raw0)) continue
    const srcUpper = String(rawSource || '').trim().toUpperCase()
    // Baseline parity: upstream `SOURCE_TRACE` effects often map to SR major traces (tree buffs),
    // but miao-plugin forks in the wild may not apply `buff.tree` consistently.
    // Mark them as `tree`-gated so they won't be applied unconditionally and blow up showcase rows.
    const tree = /\bSOURCE_TRACE\b/.test(srcUpper) ? 1 : undefined

    // `_SCALING` stats: only keep extra components (eidolons/traces/etc), not base talent multipliers.
    if (mapped.kind === 'scaling') {
      // NOTE: upstream sometimes tags core kit scaling as SOURCE_MEMO (memosprite base scaling).
      // Our meta already models base scalings via Hakush talent tables, so including SOURCE_MEMO would double-count.
      const isExtra = /\bSOURCE_(?:E\d+|TRACE)\b/.test(srcUpper)
      if (!isExtra) continue
    }

    let expr = normalizeExpr(raw0)
    if (!expr) continue

    // Capture common gating pattern: `<cond> && x.VAR.buff*(...)`
    let gateExpr = ''
    try {
      const lineStart = blockText.lastIndexOf('\n', m.index) + 1
      const lineEnd0 = blockText.indexOf('\n', m.index)
      const lineEnd = lineEnd0 >= 0 ? lineEnd0 : blockText.length
      const line = blockText.slice(lineStart, lineEnd)
      const mm = line.match(new RegExp(`(.+?)&&\\s*x\\.${escapeRegExp(varName)}\\.(?:buff|buffSingle|buffTeam)\\s*\\(`))
      if (mm) gateExpr = normalizeExpr(String(mm[1] || '').trim())
    } catch {
      // ignore
    }

    expr = inlineConsts(expr, constMap)
    if (!expr) continue
    expr = applyDefaultsToParamsExpr(expr, defaultsExpr)

    if (gateExpr) {
      gateExpr = applyDefaultsToParamsExpr(inlineConsts(gateExpr, constMap), defaultsExpr)
      if (gateExpr && !hasUnknownFreeIdentifiers(gateExpr)) {
        expr = `(${gateExpr}) ? (${expr}) : 0`
      }
    }

    if (!expr || hasUnknownFreeIdentifiers(expr)) continue
    let scaled: number | string = scaleExpr(expr, mapped.scale)
    if (mapped.kind === 'scaling' && mapped.baseStat) {
      const s = typeof scaled === 'number' ? String(scaled) : String(scaled || '').trim()
      if (!s) continue
      if (hasUnknownFreeIdentifiers(s)) continue
      scaled = `calc(attr.${mapped.baseStat}) * (${s})`
    }

    let dataKey = mapped.key
    // Upstream collapses DEF shred and DEF ignore into `DEF_PEN`. Baseline meta distinguishes:
    // - `enemyDef`: debuff "降低防御力"
    // - `ignore`: penetration "无视防御"
    // Use the param naming convention to disambiguate common "decrease debuff" toggles.
    if (varName.toUpperCase() === 'DEF_PEN' && dataKey === 'ignore') {
      const hint = `${raw0} ${gateExpr}`.toLowerCase()
      // `DEF_PEN` in upstream is a unified "defense penetration" bucket and is often used for true "ignore DEF" buffs.
      // Only map it to baseline-style "enemyDef" when we have strong signals that it is a DEF *reduction* debuff.
      // (Many kits name their ignore-DEF toggles as "defShred", so do NOT treat "defshred" as debuff by default.)
      if (/(defdecrease|defreduc(?:tion|e)|defdown|debuff)/.test(hint)) dataKey = 'enemyDef'
    }

    push(`upstream:${varName}[${dataKey}]`, dataKey, scaled, tree ? { tree } : undefined)
  }

  const scanAbilityBuff = (
    fnName: 'buffAbilityDmg' | 'buffAbilityCd' | 'buffAbilityVulnerability',
    mapKey: (typeConst: string) => string | null
  ): void => {
    const re = new RegExp(`\\b${fnName}\\s*\\(\\s*x\\s*,`, 'g')
    let mm: RegExpExecArray | null
    while ((mm = re.exec(blockText))) {
      const open = blockText.indexOf('(', mm.index)
      if (open < 0) continue
      const args = extractCallArgs(blockText, open, 8)
      const rawTypeExpr = args[1] || ''
      const rawVal = args[2] || ''
      if (!rawVal) continue
      if (/\baction\b/.test(rawVal) || /\bcontext\b/.test(rawVal)) continue

      const typeConsts = extractAbilityTypeConsts(rawTypeExpr)
      if (!typeConsts.length) continue

      const keys = typeConsts
        .map((t) => mapKey(t))
        .filter((k): k is string => typeof k === 'string' && !!k && isAllowedMiaoBuffDataKey('sr', k))
      if (!keys.length) continue

      const expr0 = normalizeExpr(rawVal)
      if (!expr0) continue
      let inlined = inlineConsts(expr0, constMap)
      if (!inlined) continue

      // Capture common gating pattern: `<cond> && <fnName>(...)`
      let gateExpr = ''
      try {
        const lineStart = blockText.lastIndexOf('\n', mm.index) + 1
        const lineEnd0 = blockText.indexOf('\n', mm.index)
        const lineEnd = lineEnd0 >= 0 ? lineEnd0 : blockText.length
        const line = blockText.slice(lineStart, lineEnd)
        const mx = line.match(new RegExp(`(.+?)&&\\s*${fnName}\\s*\\(`))
        if (mx) gateExpr = normalizeExpr(String(mx[1] || '').trim())
      } catch {
        // ignore
      }
      if (gateExpr) {
        gateExpr = applyDefaultsToParamsExpr(inlineConsts(gateExpr, constMap), defaultsExpr)
        if (gateExpr && !hasUnknownFreeIdentifiers(gateExpr)) {
          inlined = `(${gateExpr}) ? (${inlined}) : 0`
        }
      }

      inlined = applyDefaultsToParamsExpr(inlined, defaultsExpr)
      if (!inlined || hasUnknownFreeIdentifiers(inlined)) continue
      const scaled = scaleExpr(inlined, 100)

      const typeList = typeConsts.join('|')
      for (const k of keys) {
        push(`upstream:${fnName}(${typeList})[${k}]`, k, scaled)
      }
    }
  }

  scanAbilityBuff('buffAbilityDmg', (t) => mapAbilityDmgTypeToBuffKey(t))
  scanAbilityBuff('buffAbilityCd', (t) => {
    const p = abilityPrefixFromTypeConst(t)
    return p ? `${p}Cdmg` : null
  })
  scanAbilityBuff('buffAbilityVulnerability', (t) => {
    const p = abilityPrefixFromTypeConst(t)
    return p ? `${p}Enemydmg` : null
  })

  return buffs
}

type DynConvMap = { key: string; scale: number; baseStat: 'atk' | 'hp' | 'def' | 'speed' }

function mapSrStatToBuffKey(statNameRaw: string): DynConvMap | null {
  const s = String(statNameRaw || '').trim().toUpperCase()
  if (!s) return null
  // dynamicStatConversion(HP->HP): upstream semantics is an *additive* buff equal to `convertibleValue * factor`.
  // This matches miao-plugin's `<stat>Plus` buckets (flat additions), not `<stat>Pct` (percent of base only).
  if (s === 'ATK') return { key: 'atkPlus', scale: 1, baseStat: 'atk' }
  if (s === 'HP') return { key: 'hpPlus', scale: 1, baseStat: 'hp' }
  if (s === 'DEF') return { key: 'defPlus', scale: 1, baseStat: 'def' }
  if (s === 'SPD') return { key: 'speedPlus', scale: 1, baseStat: 'speed' }
  return null
}

function extractArrowFactorExpr(arrowRaw: string): string {
  const s = String(arrowRaw || '').trim()
  if (!s) return ''
  const idx = s.indexOf('=>')
  if (idx < 0) return ''
  let body = s.slice(idx + 2).trim()
  if (!body) return ''

  if (body.startsWith('{')) {
    const m = body.match(/return\s+([^;\r\n]+)\s*;?/)
    body = String(m?.[1] || '').trim()
  }
  if (!body) return ''

  // Extract factor from `convertibleValue * factor` or `factor * convertibleValue`.
  const m1 = /^\s*convertibleValue\s*\*\s*(.+?)\s*$/.exec(body)
  if (m1) return String(m1[1] || '').trim()
  const m2 = /^\s*(.+?)\s*\*\s*convertibleValue\s*$/.exec(body)
  if (m2) return String(m2[1] || '').trim()
  return ''
}

function guessGateExprForDynamicConversion(text: string, callIdx: number): string {
  try {
    const start = Math.max(0, callIdx - 2400)
    const win = text.slice(start, callIdx)
    const idxCond = win.lastIndexOf('condition:')
    if (idxCond < 0) return ''
    const tail = win.slice(idxCond)
    const m = tail.match(/return\s+([^;\r\n]+)\s*;?/)
    if (!m) return ''
    return normalizeExpr(String(m[1] || '').trim())
  } catch {
    return ''
  }
}

function extractDynamicStatConversions(text: string, constMap: Record<string, string>, defaultsExpr: Record<string, string>): CalcSuggestBuff[] {
  const out: CalcSuggestBuff[] = []
  const re = /\bdynamicStatConversion\s*\(\s*Stats\.([A-Z_]+)\s*,\s*Stats\.([A-Z_]+)\s*,/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const fromStat = String(m[1] || '').trim()
    const toStat = String(m[2] || '').trim()
    if (!fromStat || !toStat) continue
    if (fromStat.toUpperCase() !== toStat.toUpperCase()) continue

    const mapped = mapSrStatToBuffKey(fromStat)
    if (!mapped) continue

    const open = text.indexOf('(', m.index)
    if (open < 0) continue
    const args = extractCallArgs(text, open, 12)
    if (!args.length) continue
    const arrowArg = args[args.length - 1] || ''
    let factorExpr = extractArrowFactorExpr(arrowArg)
    if (!factorExpr) continue

    // Optional gating from the closest `condition:` in the same dynamic conditional object.
    let gateExpr = guessGateExprForDynamicConversion(text, m.index)

    factorExpr = normalizeExpr(factorExpr)
    factorExpr = inlineConsts(factorExpr, constMap)
    factorExpr = applyDefaultsToParamsExpr(factorExpr, defaultsExpr)

    if (!factorExpr || hasUnknownFreeIdentifiers(factorExpr)) continue

    if (gateExpr) {
      gateExpr = applyDefaultsToParamsExpr(inlineConsts(gateExpr, constMap), defaultsExpr)
      if (gateExpr && !hasUnknownFreeIdentifiers(gateExpr)) {
        factorExpr = `(${gateExpr}) ? (${factorExpr}) : 0`
      }
    }

    let scaled: number | string = scaleExpr(factorExpr, mapped.scale)
    const s = typeof scaled === 'number' ? String(scaled) : String(scaled || '').trim()
    if (!s) continue
    if (hasUnknownFreeIdentifiers(s)) continue

    const expr = `calc(attr.${mapped.baseStat}) * (${s})`
    if (hasUnknownFreeIdentifiers(expr)) continue
    if (!isAllowedMiaoBuffDataKey('sr', mapped.key)) continue
    out.push({
      title: `upstream:dynamicStatConversion(${fromStat}->${toStat})[${mapped.key}]`,
      data: { [mapped.key]: expr }
    })
  }

  return out
}

function extractMemoBaseSpdScaling(text: string): number | null {
  try {
    const m = text.match(/\bx\.MEMO_BASE_SPD_SCALING\.buff\(\s*([0-9]+(?:\.[0-9]+)?)\s*,/i)
    if (!m) return null
    const n = Number(m[1])
    return Number.isFinite(n) && n >= 0 && n <= 5 ? n : null
  } catch {
    return null
  }
}

function extractMemoSpdFlatExpr(text: string, constMap: Record<string, string>, defaultsExpr: Record<string, string>): string {
  try {
    // Pattern: x.m.SPD.buff(r.memoSpdStacks * memoTalentSpd, SOURCE_MEMO)
    const m = text.match(/\bx\.m\.SPD\.buff\(\s*r\.([A-Za-z0-9_]+)\s*\*\s*([A-Za-z0-9_]+)\s*,/i)
    if (!m) return ''
    const stacksKey = String(m[1] || '').trim()
    const perStackVar = String(m[2] || '').trim()
    if (!stacksKey || !perStackVar) return ''

    let perStackExpr = normalizeExpr(perStackVar)
    perStackExpr = inlineConsts(perStackExpr, constMap)
    if (!perStackExpr || hasUnknownFreeIdentifiers(perStackExpr)) return ''

    const stacksExpr = applyDefaultsToParamsExpr(`params.${stacksKey}`, defaultsExpr)
    const out = `(${stacksExpr}) * (${perStackExpr})`
    return hasUnknownFreeIdentifiers(out) ? '' : out
  } catch {
    return ''
  }
}

function pickSrTalentTable(input: CalcSuggestInput | undefined, talentKey: string, re: RegExp): string {
  const list = input?.tables && (input.tables as any)[talentKey]
  const arr = Array.isArray(list) ? list : []
  for (const s of arr) {
    const t = String(s || '').trim()
    if (!t) continue
    if (re.test(t)) return t
  }
  return ''
}

function extractDynamicConditionalAtkPlusFromSpd(
  text: string,
  constMap: Record<string, string>,
  defaultsExpr: Record<string, string>,
  input?: CalcSuggestInput
): CalcSuggestBuff[] {
  const out: CalcSuggestBuff[] = []
  // Pattern from hsr-optimizer dynamicConditionals:
  //   const buffValue = 7.20 * x.a[Key.SPD] + 3.60 * x.m.a[Key.SPD]
  //   x.ATK.buffDynamic(...)
  const re = /\bconst\s+buffValue\s*=\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*x\.a\[Key\.SPD\]\s*\+\s*([0-9]+(?:\.[0-9]+)?)\s*\*\s*x\.m\.a\[Key\.SPD\]/g
  let m: RegExpExecArray | null
  const memoBaseSpd = extractMemoBaseSpdScaling(text) ?? 0
  const memoFlatExpr = extractMemoSpdFlatExpr(text, constMap, defaultsExpr)
  const stacksKey = (() => {
    try {
      const mm = text.match(/\bx\.m\.SPD\.buff\(\s*r\.([A-Za-z0-9_]+)\s*\*/i)
      return String(mm?.[1] || '').trim()
    } catch {
      return ''
    }
  })()

  // Best-effort: map upstream constants to runtime talent tables to keep outputs talent-level dependent.
  // This is critical for matching baseline when user skills are not maxed.
  const qSpdBoostTable = pickSrTalentTable(input, 'q', /速度.*提高|速度提高|速度提升/)
  const mtSpdPerStackTable = pickSrTalentTable(input, 'mt', /速度.*提高|速度提高|速度提升/)

  while ((m = re.exec(text))) {
    const a = Number(m[1])
    const b = Number(m[2])
    if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0) continue

    // Ensure this is actually used to buff ATK dynamically in the nearby window.
    const tail = text.slice(m.index, Math.min(text.length, m.index + 1400))
    if (!/\bx\.ATK\.buffDynamic\s*\(/.test(tail)) continue

    // Best-effort gate: find the closest `if (!r.xxx) return` above this line.
    const head = text.slice(Math.max(0, m.index - 1400), m.index)
    const gates = Array.from(head.matchAll(/\bif\s*\(\s*!\s*r\.([A-Za-z0-9_]+)\s*\)\s*\{\s*return\s*\}/g))
    const gateKey = String(gates.length ? gates[gates.length - 1]?.[1] : '').trim()

    const speedBaseExpr = `calc(attr.speed)`

    // Use the same stack counter as upstream (usually memoSpdStacks).
    const stacksExpr = stacksKey ? applyDefaultsToParamsExpr(`params.${stacksKey}`, defaultsExpr) : ''

    // Main SPD: baseline models this as baseSpeed * (1 + ultSpdBoost * stacks) under the state gate.
    // When we can map ultSpdBoost to `talent.q[...]`, use it instead of hardcoded upstream constants.
    const speedExpr =
      qSpdBoostTable && stacksExpr
        ? `(${speedBaseExpr}) * (1 + (talent.q[${JSON.stringify(qSpdBoostTable)}] || 0) * (${stacksExpr}))`
        : speedBaseExpr

    // Memo SPD: baseline models this as baseSpeed * memoBaseSpd + memoSpdPerStack * stacks.
    const memoBaseExpr = memoBaseSpd ? `(${speedBaseExpr}) * ${memoBaseSpd}` : '0'
    const memoFlatExpr2 =
      mtSpdPerStackTable && stacksExpr
        ? `(talent.mt[${JSON.stringify(mtSpdPerStackTable)}] || 0) * (${stacksExpr})`
        : memoFlatExpr
    const memoExpr = memoFlatExpr2 ? `${memoBaseExpr} + (${memoFlatExpr2})` : memoBaseExpr

    const buffExpr0 = `${a} * (${speedExpr}) + ${b} * (${memoExpr})`

    let buffExpr = normalizeExpr(buffExpr0)
    buffExpr = inlineConsts(buffExpr, constMap)
    buffExpr = applyDefaultsToParamsExpr(buffExpr, defaultsExpr)
    if (!buffExpr || hasUnknownFreeIdentifiers(buffExpr)) continue

    if (gateKey) {
      const gateExpr = applyDefaultsToParamsExpr(`params.${gateKey}`, defaultsExpr)
      if (gateExpr && !hasUnknownFreeIdentifiers(gateExpr)) {
        buffExpr = `(${gateExpr}) ? (${buffExpr}) : 0`
      }
    }

    if (!isAllowedMiaoBuffDataKey('sr', 'atkPlus')) continue
    out.push({
      title: `upstream:dynamicConditional(SPD->ATK)[atkPlus]`,
      // This conversion is tagged as SOURCE_TRACE in upstream (a major trace-like mechanic).
      // Gate it to avoid unconditional over-buffing when profile trace mapping is incomplete.
      tree: 1,
      data: { atkPlus: buffExpr }
    })
  }

  return out
}

export function buildSrUpstreamDirectBuffs(opts: {
  projectRootAbs: string
  id?: number
  input?: CalcSuggestInput
  upstream?: {
    hsrOptimizerRoot?: string
    includeTeamBuffs?: boolean
  }
}): CalcSuggestBuff[] {
  const id = typeof opts.id === 'number' && Number.isFinite(opts.id) ? Math.trunc(opts.id) : 0
  if (!id) return []

  const rootAbs =
    resolveMaybeRelative(opts.projectRootAbs, opts.upstream?.hsrOptimizerRoot) ||
    path.join(opts.projectRootAbs, 'upstream', 'hsr-optimizer')
  if (!fs.existsSync(rootAbs)) return []

  const ctx = buildCalcUpstreamContext({
    projectRootAbs: opts.projectRootAbs,
    game: 'sr',
    id,
    hsrOptimizerRootAbs: rootAbs,
    includeTeamBuffs: opts.upstream?.includeTeamBuffs
  })
  if (!ctx?.file) return []

  const fileAbs = path.join(rootAbs, ...ctx.file.split('/'))
  if (!fs.existsSync(fileAbs)) return []

  let text = ''
  try {
    text = fs.readFileSync(fileAbs, 'utf8')
  } catch {
    return []
  }

  const constMap = buildConstExprMap(text)
  const defaultsExpr = extractDefaultsExprMap(text, constMap)

  const blocks: string[] = []
  const pre = extractArrowFnBodyBlock(text, 'precomputeEffects')
  if (pre) blocks.push(pre)
  const basicEff = extractArrowFnBodyBlock(text, 'calculateBasicEffects')
  if (basicEff) blocks.push(basicEff)
  // Many character traces are applied in finalizeCalculations (e.g. EHR->dmg conversions).
  const fin = extractArrowFnBodyBlock(text, 'finalizeCalculations')
  if (fin) blocks.push(fin)

  // "Mutual" effects are often team-wide buffs that also affect the caster (e.g. shared CR/CD from skill state).
  // These are important for baseline-compat damage outputs, but are typically free of teammate-stat dependencies.
  const mutual = extractArrowFnBodyBlock(text, 'precomputeMutualEffects')

  if (opts.upstream?.includeTeamBuffs) {
    const team = extractArrowFnBodyBlock(text, 'precomputeTeammateEffects')
    if (team) blocks.push(team)
  }

  const buffs: CalcSuggestBuff[] = []
  for (const b of blocks) {
    buffs.push(
      ...extractBuffsFromBlock(b, constMap, defaultsExpr, { includeTeamBuffs: !!opts.upstream?.includeTeamBuffs })
    )
  }
  if (mutual) {
    buffs.push(...extractBuffsFromBlock(mutual, constMap, defaultsExpr, { includeTeamBuffs: true }))
  }
  buffs.push(...extractDynamicStatConversions(text, constMap, defaultsExpr))
  const dyn = extractDynamicConditionalAtkPlusFromSpd(text, constMap, defaultsExpr, opts.input)
  buffs.push(...dyn)

  // If we successfully mapped SPD->ATK conversion to runtime talent tables, drop the raw SPD_P speedPct buff
  // to avoid double-counting and to keep memo base-speed math aligned with baseline conventions.
  const usedTalentSpdTables = dyn.some((b) => {
    if (!b || typeof b !== 'object') return false
    const expr = (b as any)?.data?.atkPlus
    return typeof expr === 'string' && /\btalent\.q\b/.test(expr)
  })
  if (usedTalentSpdTables) {
    for (let i = buffs.length - 1; i >= 0; i--) {
      const b: any = buffs[i]
      if (!b || typeof b !== 'object') continue
      const title = typeof b.title === 'string' ? b.title : ''
      const hasSpeedPct = b.data && typeof b.data === 'object' && Object.prototype.hasOwnProperty.call(b.data, 'speedPct')
      if (hasSpeedPct && /\bSPD_P\b/.test(title)) buffs.splice(i, 1)
    }
  }
  return buffs
}
