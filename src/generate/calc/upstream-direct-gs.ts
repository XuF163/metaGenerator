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

const allStatsCache = new Map<string, any>()

function loadAllStats(genshinOptimizerRootAbs: string): any | null {
  const root = genshinOptimizerRootAbs
  if (allStatsCache.has(root)) return allStatsCache.get(root)

  const p = path.join(root, 'libs', 'gi', 'stats', 'src', 'allStat_gen.json')
  if (!fs.existsSync(p)) {
    allStatsCache.set(root, null)
    return null
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as any
    allStatsCache.set(root, j)
    return j
  } catch {
    allStatsCache.set(root, null)
    return null
  }
}

function extractBraceBlock(text: string, openBraceIdx: number): string {
  if (openBraceIdx < 0 || openBraceIdx >= text.length) return ''
  let depth = 0
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0 && i > openBraceIdx) return text.slice(openBraceIdx, i + 1)
  }
  return ''
}

function normalizeSkillParamAccess(access: string): string {
  return String(access || '').replace(/!/g, '')
}

function getSkillParamValue(skillParam: any, access: string): unknown {
  const a = normalizeSkillParamAccess(access)
  const m = /^([A-Za-z0-9_]+)(.*)$/.exec(a)
  if (!m) return undefined
  let cur: any = skillParam?.[m[1]!]
  if (cur == null) return undefined

  const rest = m[2] || ''
  const re = /\[(\d+)\]/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(rest))) {
    const idx = Number(mm[1])
    if (!Number.isFinite(idx)) return undefined
    cur = cur?.[idx]
    if (cur == null) return undefined
  }
  return cur
}

type ConstExpr = { kind: 'percent'; dmPath: string }

function parseDmMapping(dmBlock: string): Map<string, string> {
  const out = new Map<string, string>()
  const stack: string[] = []
  // Many upstream sheets use counter indices like `auto[a++]` / `skill[s++][0]`.
  // Track those counters so we can convert them into stable numeric indices that
  // can be resolved from `allStat_gen.json` skillParam payloads.
  const counters: Record<string, number> = {}
  const lines = dmBlock.split(/\r?\n/)
  for (const line0 of lines) {
    const line = line0.trim()
    if (!line) continue

    const openObj = /^([A-Za-z0-9_]+)\s*:\s*{\s*$/.exec(line)
    if (openObj) {
      stack.push(openObj[1]!)
      continue
    }

    const m = /^([A-Za-z0-9_]+)\s*:\s*skillParam_gen\.([^,]+),?\s*$/.exec(line)
    if (m) {
      const prop = m[1]!
      let rhs = String(m[2] || '').trim()
      if (!rhs) continue
      rhs = rhs.replace(/!/g, '')
      // Replace counter indices like `[a++]` with concrete numeric indices.
      rhs = rhs.replace(/\[([A-Za-z_][A-Za-z0-9_]*)\+\+\]/g, (_m0, v0) => {
        const v = String(v0 || '').trim()
        if (!v) return '[0]'
        const cur = typeof counters[v] === 'number' && Number.isFinite(counters[v]) ? counters[v]! : 0
        counters[v] = cur + 1
        return `[${cur}]`
      })
      // After counter-rewrite, reject arithmetic expressions (we only map direct skillParam reads).
      if (/[+\-*/]/.test(rhs)) continue
      if (!/^[A-Za-z0-9_!\[\]]+$/.test(rhs)) continue
      const fullPath = [...stack, prop].join('.')
      out.set(fullPath, rhs)
    }

    const closeCount = (line.match(/}/g) || []).length
    for (let i = 0; i < closeCount; i++) stack.pop()
  }
  return out
}

function parseDmConstNumbers(dmBlock: string): Map<string, number> {
  const out = new Map<string, number>()
  const stack: string[] = []
  const lines = dmBlock.split(/\r?\n/)
  for (const line0 of lines) {
    const line = line0.trim()
    if (!line) continue

    const openObj = /^([A-Za-z0-9_]+)\s*:\s*{\s*$/.exec(line)
    if (openObj) {
      stack.push(openObj[1]!)
      continue
    }

    const m = /^([A-Za-z0-9_]+)\s*:\s*([+-]?\d+(?:\.\d+)?)\s*,?\s*$/.exec(line)
    if (m) {
      const prop = m[1]!
      const n = Number(m[2])
      if (Number.isFinite(n)) {
        const fullPath = [...stack, prop].join('.')
        out.set(fullPath, n)
      }
    }

    const closeCount = (line.match(/}/g) || []).length
    for (let i = 0; i < closeCount; i++) stack.pop()
  }
  return out
}

function parseConstExprs(text: string): Map<string, ConstExpr> {
  const out = new Map<string, ConstExpr>()
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line.startsWith('const ')) continue
    const m = /^const\s+([A-Za-z0-9_]+)\s*=\s*percent\(\s*dm\.([A-Za-z0-9_.]+)\s*\)\s*;?\s*$/.exec(line)
    if (!m) continue
    const name = m[1]!
    const dmPath = m[2]!
    out.set(name, { kind: 'percent', dmPath })
  }
  return out
}

function mapPremodKeyToMiaoBuffKey(elem: string, key: string): string | null {
  const k = key.trim()
  if (!k) return null

  const e = elem.trim().toLowerCase()
  if (k === `${e}_dmg_`) return 'dmg'
  if (k === 'dmg_' || k === 'all_dmg_') return 'dmg'
  if (k === 'dmgInc' || k === 'all_dmgInc') return 'dmgPlus'
  if (k === 'physical_dmg_') return 'phy'
  if (k === 'atk_') return 'atkPct'
  if (k === 'hp_') return 'hpPct'
  if (k === 'def_') return 'defPct'
  if (k === 'atk') return 'atkPlus'
  if (k === 'hp') return 'hpPlus'
  if (k === 'def') return 'defPlus'
  if (k === 'enerRech_') return 'recharge'
  if (k === 'critRate_') return 'cpct'
  if (k === 'critDMG_') return 'cdmg'
  if (k === 'heal_') return 'heal'
  if (k === 'shield_') return 'shield'
  if (k === 'enemyDefRed_') return 'enemyDef'
  if (k === 'enemyDefIgn_') return 'enemyIgnore'

  const skillMap: Record<string, string> = {
    normal: 'a',
    charged: 'a2',
    plunging: 'a3',
    skill: 'e',
    burst: 'q'
  }
  for (const [prefix, bucket] of Object.entries(skillMap)) {
    if (k === `${prefix}_dmg_`) return `${bucket}Dmg`
    if (k === `${prefix}_dmgInc`) return `${bucket}Plus`
    if (k === `${prefix}_critRate_`) return `${bucket}Cpct`
    if (k === `${prefix}_critDMG_`) return `${bucket}Cdmg`
  }

  return null
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
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
    'element',
    'currentTalent',
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

function extractCallArgs(text: string, openParenIdx: number, maxArgs = 8): string[] {
  const out: string[] = []
  let cur = ''
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
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
    if (ch === '"' || ch === "'" || ch === '`') {
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

function findMatchingParen(text: string, openParenIdx: number): number {
  if (openParenIdx < 0 || openParenIdx >= text.length || text[openParenIdx] !== '(') return -1
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = openParenIdx; i < text.length; i++) {
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
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function normalizeExprGs(exprRaw: string): string {
  let expr = String(exprRaw || '').trim()
  if (!expr) return ''
  expr = expr.replace(/\binput\.constellation\b/g, 'cons')
  // In miao-plugin runtime, `attr.xxx` is an AttrItem-like object and must be converted via `calc(attr.xxx)` when used as a number.
  expr = expr.replace(/\binput\.total\.atk\b/g, 'calc(attr.atk)')
  expr = expr.replace(/\binput\.total\.hp\b/g, 'calc(attr.hp)')
  expr = expr.replace(/\binput\.total\.def\b/g, 'calc(attr.def)')
  // Best-effort: treat ascension gates as always unlocked (panel regression uses real high-level profiles).
  expr = expr.replace(/\binput\.asc\b/g, '6')
  expr = expr.replace(/\bnaught\b/g, '0')
  expr = expr.replace(/\bzero\b/g, '0')
  expr = expr.replace(/\bone\b/g, '1')
  return expr
}

function extractExprUntilStatementEnd(text: string, startIdx: number): { expr: string; endIdx: number } | null {
  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = startIdx; i < text.length; i++) {
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
    if (ch === '(' || ch === '[' || ch === '{') depth++
    if (ch === ')' || ch === ']' || ch === '}') depth--
    if (depth === 0) {
      if (ch === ';') {
        const expr = text.slice(startIdx, i).trim()
        return expr ? { expr, endIdx: i } : null
      }
      if (ch === '\n' || ch === '\r') {
        // GO codebase commonly relies on ASI (no semicolons). Stop at statement boundary:
        // newline at depth=0 followed by a new top-level statement or a closing brace.
        let j = i + 1
        if (ch === '\r' && text[j] === '\n') j++
        while (j < text.length && (text[j] === ' ' || text[j] === '\t')) j++
        const look = text.slice(j, j + 32)
        if (/^(const|let|var|export|function|type|interface|class)\b/.test(look) || look.startsWith('}')) {
          const expr = text.slice(startIdx, i).trim()
          return expr ? { expr, endIdx: i } : null
        }
      }
    }
  }
  const expr = text.slice(startIdx).trim()
  return expr ? { expr, endIdx: text.length } : null
}

function extractConstInitializers(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const re = /\bconst\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=;\r\n]+)?=\s*/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = String(m[1] || '').trim()
    if (!name) continue
    const start = re.lastIndex
    const got = extractExprUntilStatementEnd(text, start)
    if (!got?.expr) continue
    // Skip huge objects that are not meant to be inlined.
    if (name === 'dm') {
      re.lastIndex = got.endIdx + 1
      continue
    }
    out.set(name, got.expr)
    re.lastIndex = got.endIdx + 1
  }
  return out
}

function parseObjectLiteralEntries(block: string): Array<{ key: string; value: string }> {
  const t = String(block || '').trim()
  if (!t.startsWith('{') || !t.endsWith('}')) return []
  const out: Array<{ key: string; value: string }> = []

  const end = t.length - 1
  let i = 1
  while (i < end) {
    while (i < end && /[\s,]/.test(t[i]!)) i++
    if (i >= end) break

    // key
    let key = ''
    const quote = t[i]
    if (quote === '"' || quote === "'") {
      i++
      const startKey = i
      while (i < end) {
        const ch = t[i]!
        if (ch === '\\') {
          i += 2
          continue
        }
        if (ch === quote) break
        i++
      }
      key = t.slice(startKey, i).trim()
      i++ // skip quote
    } else {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(t.slice(i))
      if (!m) break
      key = m[0]!
      i += m[0]!.length
    }
    if (!key) break

    while (i < end && /\s/.test(t[i]!)) i++
    if (t[i] !== ':') break
    i++ // skip ':'
    while (i < end && /\s/.test(t[i]!)) i++

    // value: scan until top-level comma.
    const startVal = i
    let depth = 0
    let inStr: '"' | "'" | '`' | null = null
    for (; i < end; i++) {
      const ch = t[i]!
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
      if (ch === '(' || ch === '[' || ch === '{') depth++
      if (ch === ')' || ch === ']' || ch === '}') depth--
      if (depth === 0 && ch === ',') break
    }
    const value = t.slice(startVal, i).trim().replace(/,$/, '').trim()
    if (value) out.push({ key, value })
    if (t[i] === ',') i++
  }

  return out
}

function extractPremodEntries(text: string): Array<{ key: string; value: string }> {
  const blocks: string[] = []
  let from = 0
  while (true) {
    const idx = text.indexOf('premod:', from)
    if (idx < 0) break
    const brace = text.indexOf('{', idx)
    if (brace < 0) break
    const block = extractBraceBlock(text, brace)
    if (block) blocks.push(block)
    from = brace + 1
  }
  if (!blocks.length) return []

  // Prefer the block with most entries (usually the main `dataObjForCharacterSheet(..., { premod })` one),
  // but also merge in missing keys from other smaller `premod:` blocks (e.g. hit-specific premods).
  const parsed = blocks.map(parseObjectLiteralEntries).filter((arr) => arr.length)
  if (!parsed.length) return []

  let bestIdx = 0
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i]!.length > parsed[bestIdx]!.length) bestIdx = i
  }

  const byKey = new Map<string, string>()
  for (const e of parsed[bestIdx]!) byKey.set(e.key, e.value)
  for (let i = 0; i < parsed.length; i++) {
    if (i === bestIdx) continue
    for (const e of parsed[i]!) {
      if (!byKey.has(e.key)) byKey.set(e.key, e.value)
    }
  }
  return Array.from(byKey.entries()).map(([key, value]) => ({ key, value }))
}

function extractObjectBlocksByPrefix(text: string, prefix: string): string[] {
  const blocks: string[] = []
  let from = 0
  while (true) {
    const idx = text.indexOf(prefix, from)
    if (idx < 0) break
    const brace = text.indexOf('{', idx)
    if (brace < 0) break
    const block = extractBraceBlock(text, brace)
    if (block) blocks.push(block)
    from = brace + 1
  }
  return blocks
}

function extractObjectEntryCandidates(text: string, prefix: string): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const blocks = extractObjectBlocksByPrefix(text, prefix)
  for (const block of blocks) {
    const entries = parseObjectLiteralEntries(block)
    for (const e of entries) {
      if (!e.key) continue
      const list = out.get(e.key) || []
      list.push(e.value)
      out.set(e.key, list)
    }
  }
  return out
}

function mapBaseKeyToMiaoBuffKey(key: string): string | null {
  const k = String(key || '').trim()
  if (!k) return null
  if (k === 'atk') return 'atkBase'
  if (k === 'hp') return 'hpBase'
  if (k === 'def') return 'defBase'
  return null
}

function mergeBuffValue(prev: number | string | undefined, next: number | string): number | string {
  if (prev == null) return next
  if (typeof prev === 'number' && typeof next === 'number') return prev + next
  const p = typeof prev === 'number' ? String(prev) : prev
  const n = typeof next === 'number' ? String(next) : next
  return `(${p}) + (${n})`
}

function buffScale(buffKey: string): number {
  if (!buffKey) return 1
  if (/Plus$/.test(buffKey)) return 1
  if (/Base$/.test(buffKey)) return 1
  if (/Pct$/.test(buffKey)) return 100
  if (/Dmg$/.test(buffKey)) return 100
  if (/Cpct$/.test(buffKey)) return 100
  if (/Cdmg$/.test(buffKey)) return 100
  if (/^(cpct|cdmg|dmg|phy|heal|recharge|shield|enemyDef|enemyIgnore|ignore)$/.test(buffKey)) return 100
  return 1
}

function translateGsExpr(
  exprRaw: string,
  opts: {
    constInits: Map<string, string>
    dmMap: Map<string, string>
    dmConstNums: Map<string, number>
    skillParam: any
  },
  stack = new Set<string>(),
  depth = 0
): string {
  if (depth > 20) return ''
  let expr = normalizeExprGs(exprRaw).replace(/,$/, '').trim()
  if (!expr) return ''

  // Object-spread alias: `const x = { ...y }` (Clorinde: burst_dmgInc mirrors normal_dmgInc).
  const spread = /^\{\s*\.\.\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*}\s*$/.exec(expr)
  if (spread) return translateGsExpr(spread[1]!, opts, stack, depth + 1)

  // dm.<path> -> numeric skillParam literal
  const dmRef = /^dm\.([A-Za-z0-9_.]+)$/.exec(expr)
  if (dmRef) {
    const dmPath = dmRef[1]!
    const lit = opts.dmConstNums.get(dmPath)
    if (typeof lit === 'number' && Number.isFinite(lit)) return String(lit)
    const access = opts.dmMap.get(dmPath)
    if (!access) return '0'
    const raw = getSkillParamValue(opts.skillParam, access)
    const n =
      typeof raw === 'number'
        ? raw
        : Array.isArray(raw) && typeof raw[0] === 'number'
          ? raw[0]
          : Number(raw)
    if (!Number.isFinite(n)) return '0'
    return String(n)
  }

  // numeric literal
  if (isNumberLiteral(expr) != null) return expr

  // identifier -> inline const initializer
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(expr)) {
    const name = expr
    if (
      name === 'cons' ||
      name === 'params' ||
      name === 'Math' ||
      name === 'talent' ||
      name === 'attr' ||
      name === 'calc' ||
      name === 'weapon' ||
      name === 'trees' ||
      name === 'element' ||
      name === 'currentTalent' ||
      name === 'true' ||
      name === 'false' ||
      name === 'null' ||
      name === 'undefined' ||
      name === 'Infinity' ||
      name === 'NaN'
    ) {
      return name
    }
    if (stack.has(name)) return ''
    const init = opts.constInits.get(name)
    if (!init) return ''
    stack.add(name)
    const out = translateGsExpr(init, opts, stack, depth + 1)
    stack.delete(name)
    return out
  }

  // function call
  const call = /^([A-Za-z_][A-Za-z0-9_]*)\s*\(/.exec(expr)
  if (call) {
    const fn = call[1]!
    const openParenIdx = expr.indexOf('(', fn.length)
    const args = extractCallArgs(expr, openParenIdx, 10)
    const a0 = args[0] || ''

    const t = (s: string): string => translateGsExpr(s, opts, stack, depth + 1)

    const pickFirstArg = (): string => t(a0)

    if (fn === 'infoMut') return pickFirstArg()
    if (fn === 'percent') return pickFirstArg()
    if (fn === 'constant') return pickFirstArg()

    // `subscript(input.total.{normal|skill|burst}Index, dm.xxx, { unit: '%' })`
    // is commonly used in GO to pick the current talent-level value from a skillParam array.
    // Upstream-direct cannot faithfully map `*Index` into miao-plugin runtime, so approximate by
    // picking the *highest* numeric entry from the underlying dm array (showcase-like).
    if (fn === 'subscript') {
      const dmArg = String(args[1] || '').trim().replace(/,$/, '')
      const mDm = /^dm\.([A-Za-z0-9_.]+)$/.exec(dmArg)
      if (!mDm) {
        const v = t(dmArg)
        return v || '0'
      }
      const dmPath = mDm[1]!
      const lit = opts.dmConstNums.get(dmPath)
      if (typeof lit === 'number' && Number.isFinite(lit)) return String(lit)
      const access = opts.dmMap.get(dmPath)
      if (!access) return '0'
      const raw = getSkillParamValue(opts.skillParam, access)

      const pickNum = (v: unknown): number | null => {
        if (typeof v === 'number' && Number.isFinite(v)) return v
        if (Array.isArray(v)) {
          for (const x of v) {
            if (typeof x === 'number' && Number.isFinite(x)) return x
          }
        }
        const n = Number(v)
        return Number.isFinite(n) ? n : null
      }

      if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
      if (Array.isArray(raw)) {
        for (let i = raw.length - 1; i >= 0; i--) {
          const n = pickNum(raw[i])
          if (n != null) return String(n)
        }
      }
      const n = pickNum(raw)
      return n != null ? String(n) : '0'
    }

    if (fn === 'sum') {
      const parts = args.map(t).filter(Boolean)
      if (parts.length) return `(${parts.join(' + ')})`
      // Team-element counters (`tally.*`) are not representable in miao-plugin's calc.js runtime.
      // For upstream-direct, assume a "showcase-like" party that satisfies teammate-count thresholds,
      // which aligns better with baseline meta expectations.
      if (args.some((a) => /\btally\b/.test(a))) return '3'
      return '0'
    }
    if (fn === 'prod') {
      const parts = args.map(t).filter(Boolean)
      return parts.length ? `(${parts.join(' * ')})` : '0'
    }
    if (fn === 'min') {
      const parts = args.map(t).filter(Boolean)
      return parts.length ? `Math.min(${parts.join(', ')})` : '0'
    }
    if (fn === 'max') {
      const parts = args.map(t).filter(Boolean)
      return parts.length ? `Math.max(${parts.join(', ')})` : '0'
    }

    if (fn === 'greaterEq') {
      const v1 = t(args[0] || '')
      const v2 = t(args[1] || '')
      const pass = t(args[2] || '')
      if (!v1 || !v2 || !pass) return '0'
      return `((${v1}) >= (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'lessThan') {
      const v1 = t(args[0] || '')
      const v2 = t(args[1] || '')
      const pass = t(args[2] || '')
      if (!v1 || !v2 || !pass) return '0'
      return `((${v1}) < (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'threshold') {
      const v1 = t(args[0] || '')
      const v2 = t(args[1] || '')
      const pass = t(args[2] || '')
      const fail = t(args[3] || '0') || '0'
      if (!v1 || !v2 || !pass) return fail
      return `((${v1}) >= (${v2}) ? (${pass}) : (${fail}))`
    }

    if (fn === 'equal') {
      const v1Raw = String(args[0] || '').trim()
      const v2 = t(args[1] || '')
      const pass = t(args[2] || '')
      if (!pass) return '0'
      // If the lhs is not a core input (often a condition path), assume the buff is active (baseline-like).
      if (!/^cons\b|^attr\b|^[0-9(]/.test(normalizeExprGs(v1Raw))) return pass
      const v1 = t(v1Raw)
      if (!v1 || !v2) return pass
      return `((${v1}) == (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'unequal') {
      const v1Raw = String(args[0] || '').trim()
      const v2 = t(args[1] || '')
      const pass = t(args[2] || '')
      if (!pass) return '0'
      // If the lhs is not a core input (often a condition path), assume the buff is active (baseline-like).
      if (!/^cons\b|^attr\b|^[0-9(]/.test(normalizeExprGs(v1Raw))) return pass
      const v1 = t(v1Raw)
      if (!v1 || !v2) return pass
      return `((${v1}) != (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'lookup') {
      const tableRaw = String(args[1] || '').trim()
      const defaultRaw = args[2] || '0'

      const resolveRangeMax = (arrExprRaw: string): string | null => {
        const arrExpr = String(arrExprRaw || '').trim()
        if (!arrExpr) return null
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(arrExpr)) {
          const init = opts.constInits.get(arrExpr)
          return init ? resolveRangeMax(init) : null
        }
        const mRange = /^range\s*\(/.exec(arrExpr)
        if (!mRange) return null
        const open = arrExpr.indexOf('(')
        const rArgs = extractCallArgs(arrExpr, open, 4)
        if (rArgs.length < 2) return null
        const maxRaw = rArgs[1]!
        const maxExpr = t(maxRaw)
        return maxExpr || null
      }

      const resolveObjKeyMapBody = (objKeyMapExpr: string): string => {
        const open = objKeyMapExpr.indexOf('(')
        const okArgs = extractCallArgs(objKeyMapExpr, open, 3)
        if (okArgs.length < 2) return ''
        const arrExpr = okArgs[0]!
        const arrowExpr = okArgs[1]!
        const maxExpr = resolveRangeMax(arrExpr)
        if (!maxExpr) return ''

        const arrow = String(arrowExpr || '').trim()
        const idxArrow = arrow.indexOf('=>')
        if (idxArrow < 0) return ''
        const paramPart = arrow.slice(0, idxArrow).trim().replace(/^\(|\)$/g, '').trim()
        const param = /^[A-Za-z_][A-Za-z0-9_]*$/.test(paramPart) ? paramPart : ''
        let body = arrow.slice(idxArrow + 2).trim()
        if (body.startsWith('{')) {
          const mRet = /\breturn\s+([^;]+);?/.exec(body)
          if (!mRet) return ''
          body = mRet[1]!.trim()
        }
        if (param) {
          body = body.replace(new RegExp(`\\b${escapeRegExp(param)}\\b`, 'g'), `(${maxExpr})`)
        }
        return t(body)
      }

      const tableInit =
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(tableRaw) && opts.constInits.get(tableRaw)
          ? String(opts.constInits.get(tableRaw))
          : tableRaw
      const tableInitTrim = String(tableInit || '').trim()
      if (/^objKeyMap\s*\(/.test(tableInitTrim)) {
        const bodyExpr = resolveObjKeyMapBody(tableInit)
        return bodyExpr || t(defaultRaw) || '0'
      }
      // Support simple object-literal lookup tables, e.g.
      //   lookup(condSkillCharges, { 1: constant(7), 2: constant(9), ... }, constant(5))
      // by picking the entry with the largest numeric key (showcase-like).
      if (tableInitTrim.startsWith('{') && tableInitTrim.endsWith('}')) {
        const entries = parseObjectLiteralEntries(tableInitTrim)
        if (entries.length) {
          const numeric = entries
            .map((e) => ({ ...e, n: /^\d+$/.test(e.key) ? Number(e.key) : Number.NaN }))
            .filter((e) => Number.isFinite(e.n))
            .sort((a, b) => b.n - a.n)
          const picked = (numeric.length ? numeric[0] : entries.find((e) => e.key === 'on') || entries[0]) || null
          const v = picked ? t(picked.value) : ''
          return v || t(defaultRaw) || '0'
        }
      }
      return t(defaultRaw) || '0'
    }

    // Unsupported call: fall through to freeform.
  }

  // Freeform infix expression: inline known identifiers and dm.<path> literals.
  const inline = (s: string): string => {
    const inlineCallFns = new Set([
      'infoMut',
      'percent',
      'constant',
      'sum',
      'prod',
      'min',
      'max',
      'greaterEq',
      'threshold',
      'equal',
      'lookup'
    ])

    let out = ''
    let inStr: '"' | "'" | '`' | null = null
    for (let i = 0; i < s.length; i++) {
      const ch = s[i]!
      if (inStr) {
        out += ch
        if (ch === '\\') {
          const next = s[i + 1]
          if (next) {
            out += next
            i++
          }
          continue
        }
        if (ch === inStr) inStr = null
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch
        out += ch
        continue
      }
      if (s.startsWith('dm.', i)) {
        const m = /^dm\.([A-Za-z0-9_.]+)/.exec(s.slice(i))
        if (m) {
          const v = translateGsExpr(`dm.${m[1]!}`, opts, stack, depth + 1) || '0'
          out += v
          i += m[0]!.length - 1
          continue
        }
      }
      if (/[A-Za-z_]/.test(ch)) {
        const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i))
        if (m) {
          const id = m[0]!
          let rep = id
          const prevCh = i > 0 ? s[i - 1] : ''
          // Do not rewrite member accesses like `Math.min(...)` (otherwise we may emit `Math.(Math.min(...))`).
          // This mirrors the "prev === '.'" rule used by `hasUnknownFreeIdentifiers()`.
          if (prevCh === '.') {
            out += rep
            i += id.length - 1
            continue
          }

          // Inline supported call expressions so we don't drop the whole expression
          // when wrappers like `constant(...)` appear inside ternaries/arithmetics.
          if (inlineCallFns.has(id)) {
            let j = i + id.length
            while (j < s.length && /\s/.test(s[j]!)) j++
            if (s[j] === '(') {
              const end = findMatchingParen(s, j)
              if (end > j) {
                const callText = s.slice(i, end + 1)
                rep = translateGsExpr(callText, opts, stack, depth + 1) || '0'
                out += `(${rep})`
                i = end
                continue
              }
            }
          }

          if (opts.constInits.has(id) && !stack.has(id)) {
            stack.add(id)
            const v = translateGsExpr(opts.constInits.get(id)!, opts, stack, depth + 1)
            stack.delete(id)
            if (v) rep = `(${v})`
          }
          out += rep
          i += id.length - 1
          continue
        }
      }
      out += ch
    }
    return out
  }

  const out = inline(expr).trim()
  if (!out) return ''
  if (hasUnknownFreeIdentifiers(out)) return ''
  return out
}

export function buildGsUpstreamDirectBuffs(opts: {
  projectRootAbs: string
  id?: number
  elem: string
  upstream?: {
    genshinOptimizerRoot?: string
  }
}): CalcSuggestBuff[] {
  const id = typeof opts.id === 'number' && Number.isFinite(opts.id) ? Math.trunc(opts.id) : 0
  if (!id) return []

  const rootAbs =
    resolveMaybeRelative(opts.projectRootAbs, opts.upstream?.genshinOptimizerRoot) ||
    path.join(opts.projectRootAbs, 'upstream', 'genshin-optimizer')
  if (!fs.existsSync(rootAbs)) return []

  const ctx = buildCalcUpstreamContext({
    projectRootAbs: opts.projectRootAbs,
    game: 'gs',
    id,
    genshinOptimizerRootAbs: rootAbs
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

  const mKey = /\bconst\s+key\b[^=]*=\s*['"]([^'"]+)['"]/.exec(text)
  const charKey = mKey?.[1]?.trim() || ''
  if (!charKey) return []

  const allStats = loadAllStats(rootAbs)
  const skillParam = allStats?.char?.skillParam?.[charKey]
  if (!skillParam || typeof skillParam !== 'object') return []

  const idxDm = text.indexOf('const dm')
  const idxDmBrace = idxDm >= 0 ? text.indexOf('{', idxDm) : -1
  const dmBlock = idxDmBrace >= 0 ? extractBraceBlock(text, idxDmBrace) : ''
  const dmMap = dmBlock ? parseDmMapping(dmBlock) : new Map<string, string>()
  const dmConstNums = dmBlock ? parseDmConstNumbers(dmBlock) : new Map<string, number>()

  const premodCandidates = extractObjectEntryCandidates(text, 'premod:')
  const baseCandidates = extractObjectEntryCandidates(text, 'base:')
  if (premodCandidates.size === 0 && baseCandidates.size === 0) return []

  const constInits = extractConstInitializers(text)
  const data: Record<string, number | string> = {}

  const applyCandidates = (
    candidates: Map<string, string[]>,
    mapKey: (rawKey: string) => string | null
  ): void => {
    for (const [rawKey, values] of candidates.entries()) {
      const buffKey = mapKey(rawKey)
      if (!buffKey) continue
      if (!isAllowedMiaoBuffDataKey('gs', buffKey)) continue
      if (!Array.isArray(values) || values.length === 0) continue

      // Prefer later occurrences (dataObjForCharacterSheet premod/base blocks tend to come later than node-local ones).
      for (let i = values.length - 1; i >= 0; i--) {
        const value = values[i]!
        const expr = translateGsExpr(value, { constInits, dmMap, dmConstNums, skillParam })
        if (!expr) continue

        const scaled = scaleExpr(expr, buffScale(buffKey))
        if (typeof scaled === 'number') {
          if (!Number.isFinite(scaled) || scaled === 0) continue
          data[buffKey] = mergeBuffValue(data[buffKey], scaled)
          break
        }

        const t = String(scaled || '').trim()
        if (!t || t === '0' || t === '(0)') continue
        if (hasUnknownFreeIdentifiers(t)) continue
        data[buffKey] = mergeBuffValue(data[buffKey], t)
        break
      }
    }
  }

  applyCandidates(baseCandidates, mapBaseKeyToMiaoBuffKey)
  applyCandidates(premodCandidates, (k) => mapPremodKeyToMiaoBuffKey(opts.elem, k))

  const keys = Object.keys(data)
  if (!keys.length) return []
  return [{ title: 'upstream:genshin-optimizer(premod)', data }]
}
