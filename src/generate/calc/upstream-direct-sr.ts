import fs from 'node:fs'
import path from 'node:path'

import type { CalcSuggestBuff } from './llm-calc/types.js'
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
    out = out.replace(new RegExp(`\\b${escapeRegExp(k)}\\b`, 'g'), `(${v})`)
  }
  return out
}

function buildConstExprMap(text: string): Record<string, string> {
  const thresholds = extractAbilityThresholdsByFnName(text)
  const entries = extractConstEntries(text)
  const resolved: Record<string, string> = {}
  const pending: ConstEntry[] = []

  for (const e of entries) {
    const n = isNumberLiteral(e.expr)
    if (n != null) {
      resolved[e.name] = String(n)
      continue
    }

    const m = e.expr.match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*e\s*,\s*([+-]?\d+(?:\.\d+)?)\s*,\s*([+-]?\d+(?:\.\d+)?)\s*\)$/
    )
    if (m) {
      const fn = String(m[1] || '').trim()
      const t = thresholds[fn]
      if (t) {
        resolved[e.name] = `(cons >= ${t} ? ${m[3]} : ${m[2]})`
        continue
      }
    }

    pending.push({ name: e.name, expr: normalizeExpr(e.expr) })
  }

  for (let pass = 0; pass < 4; pass++) {
    let progressed = false
    for (let i = pending.length - 1; i >= 0; i--) {
      const p = pending[i]!
      const expr = inlineConsts(p.expr, resolved)
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

function mapStatVarToBuffKey(varName: string): { key: string; scale: number } | null {
  const v = varName.trim().toUpperCase()
  if (!v) return null

  if (/_SCALING$/.test(v)) return null
  if (/_TOUGHNESS/.test(v)) return null

  if (v === 'ATK_P') return { key: 'atkPct', scale: 100 }
  if (v === 'HP_P') return { key: 'hpPct', scale: 100 }
  if (v === 'DEF_P') return { key: 'defPct', scale: 100 }
  if (v === 'SPD_P') return { key: 'speedPct', scale: 100 }
  if (v === 'CR') return { key: 'cpct', scale: 100 }
  if (v === 'CD') return { key: 'cdmg', scale: 100 }
  if (v === 'ERR') return { key: 'recharge', scale: 100 }
  if (v === 'DEF_PEN') return { key: 'enemyIgnore', scale: 100 }
  if (v === 'ELEMENTAL_DMG' || v === 'DMG_P') return { key: 'dmg', scale: 100 }
  if (v === 'VULNERABILITY' || v === 'ENEMY_DMG' || v === 'ENEMY_DMG_P') return { key: 'enemydmg', scale: 100 }
  if (v === 'EHR') return { key: 'effPct', scale: 100 }
  if (v === 'ERS' || v === 'EFF_RES') return { key: 'effDef', scale: 100 }
  if (v === 'BREAK_EFF') return { key: 'stance', scale: 100 }
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

function extractBuffsFromBlock(blockText: string, constMap: Record<string, string>): CalcSuggestBuff[] {
  const buffs: CalcSuggestBuff[] = []
  const push = (title: string, dataKey: string, value: number | string): void => {
    if (!isAllowedMiaoBuffDataKey('sr', dataKey)) return
    buffs.push({ title, data: { [dataKey]: value } })
  }

  const statRe = /\bx\.([A-Z][A-Z0-9_]+)\.(buff|buffSingle|buffTeam)\s*\(/g
  let m: RegExpExecArray | null
  while ((m = statRe.exec(blockText))) {
    const varName = String(m[1] || '').trim()
    const method = String(m[2] || '').trim()
    if (!varName) continue
    if (method !== 'buff') continue

    const mapped = mapStatVarToBuffKey(varName)
    if (!mapped) continue

    const open = blockText.indexOf('(', m.index)
    if (open < 0) continue
    const args = extractCallArgs(blockText.slice(m.index), blockText.slice(m.index).indexOf('('))
    const raw0 = args[0] || ''
    if (!raw0) continue
    if (/\bx\./.test(raw0) || /\baction\b/.test(raw0) || /\bcontext\b/.test(raw0)) continue

    const expr = normalizeExpr(raw0)
    if (!expr) continue
    const inlined = inlineConsts(expr, constMap)
    if (!inlined || hasUnknownFreeIdentifiers(inlined)) continue
    const scaled = scaleExpr(inlined, mapped.scale)
    push(`upstream:${varName}`, mapped.key, scaled)
  }

  const abilityRe = /\bbuffAbilityDmg\s*\(\s*x\s*,\s*([A-Z][A-Z0-9_]+)\s*,/g
  while ((m = abilityRe.exec(blockText))) {
    const typeConst = String(m[1] || '').trim()
    const key = mapAbilityDmgTypeToBuffKey(typeConst)
    if (!key) continue

    const open = blockText.indexOf('(', m.index)
    if (open < 0) continue
    const args = extractCallArgs(blockText, open)
    const rawVal = args[2] || ''
    if (!rawVal) continue
    if (/\bx\./.test(rawVal) || /\baction\b/.test(rawVal) || /\bcontext\b/.test(rawVal)) continue

    const expr = normalizeExpr(rawVal)
    if (!expr) continue
    const inlined = inlineConsts(expr, constMap)
    if (!inlined || hasUnknownFreeIdentifiers(inlined)) continue
    const scaled = scaleExpr(inlined, 100)
    push(`upstream:buffAbilityDmg(${typeConst})`, key, scaled)
  }

  return buffs
}

export function buildSrUpstreamDirectBuffs(opts: {
  projectRootAbs: string
  id?: number
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

  const blocks: string[] = []
  const pre = extractArrowFnBodyBlock(text, 'precomputeEffects')
  if (pre) blocks.push(pre)

  if (opts.upstream?.includeTeamBuffs) {
    const mutual = extractArrowFnBodyBlock(text, 'precomputeMutualEffects')
    if (mutual) blocks.push(mutual)
    const team = extractArrowFnBodyBlock(text, 'precomputeTeammateEffects')
    if (team) blocks.push(team)
  }

  const buffs: CalcSuggestBuff[] = []
  for (const b of blocks) buffs.push(...extractBuffsFromBlock(b, constMap))
  return buffs
}
