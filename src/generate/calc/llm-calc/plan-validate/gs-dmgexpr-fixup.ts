import type { TalentKeyGs } from '../types.js'
import { normalizePromptText } from '../utils.js'

function stripOuterParens(expr: string): string {
  let s = expr.trim()
  for (let pass = 0; pass < 5; pass++) {
    if (!(s.startsWith('(') && s.endsWith(')'))) break
    let depth = 0
    let quote: '"' | "'" | '`' | null = null
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
      if (ch === '"' || ch === "'" || ch === '`') {
        quote = ch
        continue
      }
      if (ch === '(') depth++
      else if (ch === ')') {
        depth--
        if (depth === 0) {
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

function splitTopLevel(expr: string, delim: string): string[] {
  const parts: string[] = []
  let buf = ''
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let quote: '"' | "'" | '`' | null = null
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

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      buf += ch
      continue
    }

    if (ch === '(') depthParen++
    else if (ch === ')') depthParen = Math.max(0, depthParen - 1)
    else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1)
    else if (ch === '{') depthBrace++
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1)

    if (ch === delim && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      parts.push(buf.trim())
      buf = ''
      continue
    }
    buf += ch
  }
  if (buf.trim()) parts.push(buf.trim())
  return parts
}

function parseTopLevelCall(exprRaw: string, fnName: string): string[] | null {
  const s = exprRaw.trim()
  const re = new RegExp(`^${fnName}\\s*\\(`)
  if (!re.test(s)) return null
  const openIdx = s.indexOf('(')
  if (openIdx < 0) return null

  const args: string[] = []
  let argStart = openIdx + 1
  let depthParen = 0
  let depthBracket = 0
  let depthBrace = 0
  let quote: '"' | "'" | '`' | null = null
  let escaped = false

  for (let i = openIdx + 1; i < s.length; i++) {
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

    if (ch === '"' || ch === "'" || ch === '`') {
      quote = ch
      continue
    }

    if (ch === '(') depthParen++
    else if (ch === ')') {
      if (depthParen > 0) {
        depthParen--
        continue
      }
      // close call
      args.push(s.slice(argStart, i).trim())
      const rest = s.slice(i + 1).trim()
      if (rest) return null
      return args
    } else if (ch === '[') depthBracket++
    else if (ch === ']') depthBracket = Math.max(0, depthBracket - 1)
    else if (ch === '{') depthBrace++
    else if (ch === '}') depthBrace = Math.max(0, depthBrace - 1)

    if (ch === ',' && depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
      args.push(s.slice(argStart, i).trim())
      argStart = i + 1
      continue
    }
  }

  return null
}

function parseTalentTableAccess(expr: string): { tk: TalentKeyGs; table: string } | null {
  const s = stripOuterParens(expr)
  const m = /^\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*$/.exec(s)
  if (!m) return null
  return { tk: m[1] as TalentKeyGs, table: m[3]! }
}

function parseCoeffIncFactor(expr: string): { tk: TalentKeyGs; table: string; mul: number } | null {
  const s = stripOuterParens(expr)

  // Pattern 1 (preferred): `1 + toRatio(talent.e["伤害提升"]) * N`
  let m =
    /^\s*1\s*\+\s*toRatio\s*\(\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\)\s*(?:\*\s*([0-9]+(?:\.[0-9]+)?))?\s*$/.exec(
      s
    )
  if (m) {
    const mul = m[4] ? Number(m[4]) : 1
    if (!Number.isFinite(mul)) return null
    return { tk: m[1] as TalentKeyGs, table: m[3]!, mul }
  }

  // Pattern 2: `1 + talent.e["伤害提升"] * N / 100` (common hallucination; equivalent to toRatio())
  m =
    /^\s*1\s*\+\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*(?:\*\s*([0-9]+(?:\.[0-9]+)?))?\s*\/\s*100(?:\.0+)?\s*$/.exec(
      s
    )
  if (m) {
    const mul = m[4] ? Number(m[4]) : 1
    if (!Number.isFinite(mul)) return null
    return { tk: m[1] as TalentKeyGs, table: m[3]!, mul }
  }

  // Pattern 3: `1 + talent.e["伤害提升"] / 100 * N`
  m =
    /^\s*1\s*\+\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\/\s*100(?:\.0+)?\s*(?:\*\s*([0-9]+(?:\.[0-9]+)?))?\s*$/.exec(
      s
    )
  if (m) {
    const mul = m[4] ? Number(m[4]) : 1
    if (!Number.isFinite(mul)) return null
    return { tk: m[1] as TalentKeyGs, table: m[3]!, mul }
  }

  // Pattern 4: `1 + (talent.e["伤害提升"] * N) / 100`
  m =
    /^\s*1\s*\+\s*\(\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\*\s*([0-9]+(?:\.[0-9]+)?)\s*\)\s*\/\s*100(?:\.0+)?\s*$/.exec(
      s
    )
  if (m) {
    const mul = m[4] ? Number(m[4]) : 1
    if (!Number.isFinite(mul)) return null
    return { tk: m[1] as TalentKeyGs, table: m[3]!, mul }
  }

  // Pattern 5: `1 + (talent.e["伤害提升"] / 100) * N`
  m =
    /^\s*1\s*\+\s*\(\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\/\s*100(?:\.0+)?\s*\)\s*(?:\*\s*([0-9]+(?:\.[0-9]+)?))?\s*$/.exec(
      s
    )
  if (m) {
    const mul = m[4] ? Number(m[4]) : 1
    if (!Number.isFinite(mul)) return null
    return { tk: m[1] as TalentKeyGs, table: m[3]!, mul }
  }

  return null
}

function parseCoeffIncTerm(expr: string): { tk: TalentKeyGs; table: string; mulExpr: string } | null {
  const s0 = stripOuterParens(expr)
  const parts = splitTopLevel(s0, '*').map(stripOuterParens).filter(Boolean)
  if (parts.length === 0 || parts.length > 2) return null

  const parseIntMul = (s: string): number | null => {
    const n = Number(s)
    if (!Number.isFinite(n)) return null
    const r = Math.round(n)
    if (Math.abs(n - r) > 1e-9) return null
    return r
  }

  const parseMulExpr = (s: string): string | null => {
    const n = parseIntMul(s)
    if (n != null) {
      if (n < 1 || n > 60) return null
      return String(n)
    }
    const t = s.trim()
    if (/^params\s*\.\s*[A-Za-z_]\w*$/.test(t)) return t
    return null
  }

  let mulExpr = '1'
  let baseExpr = parts[0]!
  if (parts.length === 2) {
    const m0 = parseMulExpr(parts[0]!)
    const m1 = parseMulExpr(parts[1]!)
    if (m0 != null && m1 == null) {
      mulExpr = m0
      baseExpr = parts[1]!
    } else if (m1 != null && m0 == null) {
      mulExpr = m1
      baseExpr = parts[0]!
    } else {
      return null
    }
  }

  const base = stripOuterParens(baseExpr)

  // `toRatio(talent.e["..."])` (common hallucination; for coefficient tables we want the raw percent points).
  let m =
    /^\s*toRatio\s*\(\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\)\s*$/.exec(base)
  if (m) return { tk: m[1] as TalentKeyGs, table: m[3]!, mulExpr }

  // `talent.e["..."] / 100` (equivalent to toRatio()).
  m =
    /^\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*\/\s*100(?:\.0+)?\s*$/.exec(base)
  if (m) return { tk: m[1] as TalentKeyGs, table: m[3]!, mulExpr }

  // Plain `talent.e["..."]`.
  const acc0 =
    /^\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*(?:\|\|\s*0\s*)?$/.exec(base)
  if (acc0) return { tk: acc0[1] as TalentKeyGs, table: acc0[3]!, mulExpr }
  const acc = parseTalentTableAccess(base)
  if (acc) return { tk: acc.tk, table: acc.table, mulExpr }

  return null
}

function parseCoeffIncSumFactor(expr: string): Array<{ tk: TalentKeyGs; table: string; mulExpr: string }> | null {
  const s = stripOuterParens(expr)
  const terms = splitTopLevel(s, '+').map(stripOuterParens).filter(Boolean)
  if (terms.length < 2) return null
  const head = terms[0]!.replace(/\s+/g, '')
  if (!/^1(?:\.0+)?$/.test(head)) return null

  const incs: Array<{ tk: TalentKeyGs; table: string; mulExpr: string }> = []
  for (const t of terms.slice(1)) {
    const inc = parseCoeffIncTerm(t)
    if (!inc) return null
    incs.push(inc)
  }
  if (incs.length === 0) return null
  return incs
}

/**
 * Fix common LLM mistake for GS skill-specific "extra multipliers" tables:
 *
 * Some Hakush talent tables encode stacking bonuses as extra *multipliers* in the same unit as the base damage
 * (e.g. "技能伤害" + "变格伤害提升"*4), but LLM often treats them as "% damage bonus" and writes:
 *   base * (1 + toRatio(inc) * N)
 *
 * This rewrite converts a narrow, safe subset of such expressions into additive coefficient form:
 *   dmg(base + inc*N + ..., key[, ele])
 */
export function rewriteGsAdditiveCoeffDmgExpr(
  exprRaw: string,
  tables: Record<string, string[]>
): string | null {
  const args = parseTopLevelCall(exprRaw, 'dmg')
  if (!args || args.length < 2 || args.length > 3) return null

  const coeffRaw = args[0] || ''
  const keyArg = String(args[1] || '').trim()
  const eleArg = args[2] !== undefined ? String(args[2] || '').trim() : ''
  if (!keyArg) return null

  const factors = splitTopLevel(coeffRaw, '*').map(stripOuterParens).filter(Boolean)
  if (factors.length < 2) return null

  const base = parseTalentTableAccess(factors[0]!)
  if (!base) return null

  const allowed = new Set<string>(tables[base.tk] || [])
  if (allowed.size && !allowed.has(base.table)) return null

  const incs: Array<{ table: string; mulExpr: string }> = []
  for (const f of factors.slice(1)) {
    const inc = parseCoeffIncFactor(f)
    if (!inc) {
      // Handle a common severe hallucination variant:
      // `dmg(talent.e["技能伤害"] * (1 + talent.e["伤害提升"] * N + talent.e["额外提升"]), "e")`
      //
      // For coefficient-style tables (same unit as base pct), we want:
      // `dmg(base + inc*N + extra, key)`
      if (factors.length !== 2 || incs.length) return null
      const list = parseCoeffIncSumFactor(f)
      if (!list) return null
      for (const x of list) {
        if (x.tk !== base.tk) return null
        if (allowed.size && !allowed.has(x.table)) return null

        const name = normalizePromptText(x.table)
        if (!/(伤害提升|伤害提高|伤害增加|伤害加成|加成|增伤)/.test(name)) return null
        if (/(治疗|护盾|上限|概率|持续时间|冷却时间|消耗|能量|回复)/.test(name)) return null

        incs.push({ table: x.table, mulExpr: x.mulExpr })
      }
      continue
    }
    if (inc.tk !== base.tk) return null
    if (allowed.size && !allowed.has(inc.table)) return null

    const name = normalizePromptText(inc.table)
    if (!/(伤害提升|伤害提高|伤害增加|伤害加成|加成|增伤)/.test(name)) return null
    if (/(治疗|护盾|上限|概率|持续时间|冷却时间|消耗|能量|回复)/.test(name)) return null

    const mul = Math.round(inc.mul)
    if (!Number.isFinite(mul) || Math.abs(mul - inc.mul) > 1e-9) return null
    if (mul < 1 || mul > 60) return null
    incs.push({ table: inc.table, mulExpr: String(mul) })
  }
  if (incs.length === 0) return null

  const terms = [`talent.${base.tk}[${JSON.stringify(base.table)}]`]
  for (const inc of incs) {
    const t = `talent.${base.tk}[${JSON.stringify(inc.table)}]`
    const mul = String(inc.mulExpr || '').trim()
    terms.push(!mul || mul === '1' ? t : `${t} * ${mul}`)
  }

  const coeffExpr = terms.join(' + ')
  const argsOut = eleArg ? `${coeffExpr}, ${keyArg}, ${eleArg}` : `${coeffExpr}, ${keyArg}`
  return `dmg(${argsOut})`
}
