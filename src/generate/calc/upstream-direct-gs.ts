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
  if (k === 'eleMas') return 'mastery'
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
    // Common upstream variants: `plunging_impact_dmgInc`, `skill_hit_dmg_`, ...
    // Treat these as the corresponding talent bucket to better align with baseline-style calc.js.
    if (k.startsWith(`${prefix}_`)) {
      if (k.endsWith('_dmg_')) return `${bucket}Dmg`
      if (k.endsWith('_dmgInc')) return `${bucket}Plus`
      if (k.endsWith('_critRate_')) return `${bucket}Cpct`
      if (k.endsWith('_critDMG_')) return `${bucket}Cdmg`
    }
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
  const isStart = (ch: string | undefined): boolean => !!ch && /[A-Za-z_]/.test(ch)
  const isChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch)
  let inStr: '"' | "'" | '`' | null = null
  for (let i = 0; i < expr.length; i++) {
    const ch = expr[i]!
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
    if (!isStart(ch)) continue

    let j = i + 1
    while (j < expr.length && isChar(expr[j])) j++
    const id = expr.slice(i, j)

    const prev = i > 0 ? expr[i - 1] : ''
    const prev2 = i > 1 ? expr[i - 2] : ''
    // Ignore member accesses like `Math.min`, but NOT spread operator like `...input`.
    if (!(prev === '.' && prev2 !== '.')) {
      if (!allowed.has(id)) return true
    }

    i = j - 1
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

type CondVarInfo = { condKey: string; section?: string; nameKey?: string }

function extractCondVarDecls(text: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const m of text.matchAll(
    /\bconst\s*\[\s*[A-Za-z_][A-Za-z0-9_]*\s*,\s*([A-Za-z_][A-Za-z0-9_]*)\s*]\s*=\s*cond\s*\(\s*key\s*,\s*['"]([^'"]+)['"]/g
  )) {
    const varName = String(m[1] || '').trim()
    const condKey = String(m[2] || '').trim()
    if (varName && condKey) out.set(varName, condKey)
  }
  return out
}

function extractCondTemInfo(
  text: string,
  condVarToKey: Map<string, string>
): Map<string, Pick<CondVarInfo, 'section' | 'nameKey'>> {
  const out = new Map<string, Pick<CondVarInfo, 'section' | 'nameKey'>>()
  const re = /\bct\.condTem\s*\(\s*['"]([^'"]+)['"]\s*,/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const section = String(m[1] || '').trim()
    if (!section) continue

    const brace = text.indexOf('{', re.lastIndex)
    if (brace < 0) continue
    const block = extractBraceBlock(text, brace)
    if (!block) continue

    const mValue = /\bvalue\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\b/.exec(block)
    const varName = String(mValue?.[1] || '').trim()
    if (!varName || !condVarToKey.has(varName)) {
      re.lastIndex = brace + block.length
      continue
    }

    const mNameKey = /\bname\s*:\s*st\s*\(\s*['"]([^'"]+)['"]/.exec(block)
    const nameKey = String(mNameKey?.[1] || '').trim() || undefined

    out.set(varName, { section, nameKey })
    re.lastIndex = brace + block.length
  }
  return out
}

function sanitizeParamKey(raw: string): string {
  let t = String(raw || '').trim()
  if (!t) return ''
  t = t.replace(/[^A-Za-z0-9_]/g, '_')
  t = t.replace(/_+/g, '_').replace(/^_+|_+$/g, '')
  if (!t) return ''
  if (!/^[A-Za-z_]/.test(t)) t = `p_${t}`
  return t
}

function parseStringLiteral(text: string): string | null {
  const s = String(text || '').trim()
  const m = /^(['"])(.*)\1$/.exec(s)
  return m ? m[2]! : null
}

function renderParamAccess(keyRaw: string): string {
  const key = String(keyRaw || '').trim()
  if (!key) return 'params'
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) ? `params.${key}` : `params[${JSON.stringify(key)}]`
}

function inferCondStateParamKey(info: CondVarInfo, stateKey: string, varNameRaw: string): string {
  const varName = String(varNameRaw || '').trim()
  const state = String(stateKey || '').trim()

  // Baseline convention: HP<=50% toggles commonly use `halfHp`.
  if (info.condKey === 'SanguineRouge') return 'halfHp'
  if (info.nameKey === 'lessEqPercentHP' && state === 'on') return 'halfHp'

  if (state === 'on') {
    if (info.section === 'skill') return 'e'
    if (info.section === 'burst') return 'q'
    const k = sanitizeParamKey(info.condKey) || sanitizeParamKey(varName)
    return k || 'cond'
  }

  const condKey = sanitizeParamKey(info.condKey) || sanitizeParamKey(varName)
  const st = sanitizeParamKey(state)
  if (condKey && st && condKey === st) return condKey
  if (condKey && st) return `${condKey}_${st}`
  return condKey || st || 'cond'
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

function stripJsComments(text: string): string {
  const s = String(text || '')
  if (!s) return ''
  let out = ''
  let inStr: '"' | "'" | '`' | null = null
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!
    const next = s[i + 1]

    if (inStr) {
      out += ch
      if (ch === '\\') {
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

    // Line comment: `// ...`
    if (ch === '/' && next === '/') {
      i += 2
      while (i < s.length && s[i] !== '\n' && s[i] !== '\r') i++
      out += ' '
      i -= 1
      continue
    }

    // Block comment: `/* ... */`
    if (ch === '/' && next === '*') {
      i += 2
      while (i < s.length - 1 && !(s[i] === '*' && s[i + 1] === '/')) i++
      i += 1
      out += ' '
      continue
    }

    out += ch
  }
  return out
}

function normalizeExprGs(exprRaw: string): string {
  let expr = String(exprRaw || '').trim()
  if (!expr) return ''
  expr = expr.replace(/\binput\.constellation\b/g, 'cons')
  // Base stats are available as `attr.xxx.base` in miao-plugin runtime.
  expr = expr.replace(/\binput\.base\.atk\b/g, 'attr.atk.base')
  expr = expr.replace(/\binput\.base\.hp\b/g, 'attr.hp.base')
  expr = expr.replace(/\binput\.base\.def\b/g, 'attr.def.base')
  // In miao-plugin runtime, `attr.xxx` is an AttrItem-like object and must be converted via `calc(attr.xxx)` when used as a number.
  expr = expr.replace(/\binput\.total\.atk\b/g, 'calc(attr.atk)')
  expr = expr.replace(/\binput\.total\.hp\b/g, 'calc(attr.hp)')
  expr = expr.replace(/\binput\.total\.def\b/g, 'calc(attr.def)')
  expr = expr.replace(/\binput\.total\.eleMas\b/g, 'calc(attr.mastery)')
  // Upstream `*_` total stats are typically ratios (e.g. enerRech_=1.8 for 180%).
  // miao-plugin stores them as percent points (e.g. recharge=180), so convert to ratios when used in formulas.
  expr = expr.replace(/\binput\.total\.enerRech_\b/g, '(calc(attr.recharge) / 100)')
  expr = expr.replace(/\binput\.total\.critRate_\b/g, '(calc(attr.cpct) / 100)')
  expr = expr.replace(/\binput\.total\.critDMG_\b/g, '(calc(attr.cdmg) / 100)')
  expr = expr.replace(/\binput\.total\.heal_\b/g, '(calc(attr.heal) / 100)')
  // Best-effort: miao-plugin does not distinguish premod vs total; map both to total panel stats.
  expr = expr.replace(/\binput\.premod\.atk\b/g, 'calc(attr.atk)')
  expr = expr.replace(/\binput\.premod\.hp\b/g, 'calc(attr.hp)')
  expr = expr.replace(/\binput\.premod\.def\b/g, 'calc(attr.def)')
  expr = expr.replace(/\binput\.premod\.eleMas\b/g, 'calc(attr.mastery)')
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
  const skipUntilComma = (): void => {
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
      else if (ch === ')' || ch === ']' || ch === '}') {
        if (depth > 0) depth--
      }
      if (depth === 0 && ch === ',') break
    }
  }
  while (i < end) {
    while (i < end && /[\s,]/.test(t[i]!)) i++
    if (i >= end) break

    // spread entries: `...foo` / `...Object.fromEntries(...)`
    if (t.startsWith('...', i)) {
      i += 3
      skipUntilComma()
      if (t[i] === ',') i++
      continue
    }

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
      if (!m) {
        // Skip unsupported fragments like `[x]: y` instead of aborting the whole parse.
        skipUntilComma()
        if (t[i] === ',') i++
        continue
      }
      key = m[0]!
      i += m[0]!.length
    }
    if (!key) {
      skipUntilComma()
      if (t[i] === ',') i++
      continue
    }

    while (i < end && /\s/.test(t[i]!)) i++
    if (t[i] !== ':') {
      // shorthand entry: `{ foo, bar }` means `{ foo: foo, bar: bar }`
      out.push({ key, value: key })
      while (i < end && /\s/.test(t[i]!)) i++
      if (t[i] === ',') i++
      continue
    }
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

function extractDataObjOptionsBlock(text: string): string {
  const got = extractDataObjOptionsBlockWithRange(text)
  return got?.block || ''
}

function extractDataObjOptionsBlockWithRange(
  text: string
): { block: string; startIdx: number; endIdx: number } | null {
  const idx = text.indexOf('dataObjForCharacterSheet(')
  if (idx < 0) return null
  const brace = text.indexOf('{', idx)
  if (brace < 0) return null
  const block = extractBraceBlock(text, brace)
  if (!block) return null
  return { block, startIdx: brace, endIdx: brace + block.length }
}

function extractTopLevelObjectPropBlock(objText: string, propNameRaw: string): string {
  const propName = String(propNameRaw || '').trim()
  if (!propName) return ''
  const isIdentChar = (ch: string | undefined): boolean => !!ch && /[A-Za-z0-9_]/.test(ch)

  let depth = 0
  let inStr: '"' | "'" | '`' | null = null
  for (let i = 0; i < objText.length; i++) {
    const ch = objText[i]!
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
    if (ch === '{') {
      depth++
      continue
    }
    if (ch === '}') {
      depth--
      continue
    }
    if (depth !== 1) continue

    if (
      objText.startsWith(propName, i) &&
      !isIdentChar(objText[i - 1]) &&
      !isIdentChar(objText[i + propName.length])
    ) {
      let j = i + propName.length
      while (j < objText.length && /\s/.test(objText[j]!)) j++
      if (objText[j] !== ':') continue
      j++
      while (j < objText.length && /\s/.test(objText[j]!)) j++
      if (objText[j] !== '{') continue
      return extractBraceBlock(objText, j)
    }
  }
  return ''
}

function pushObjectEntries(out: Map<string, string[]>, block: string): void {
  if (!block) return
  const entries = parseObjectLiteralEntries(block)
  for (const e of entries) {
    if (!e.key) continue
    const list = out.get(e.key) || []
    list.push(e.value)
    out.set(e.key, list)
  }
}

function extractObjectEntryCandidates(
  text: string,
  prefix: string,
  opts?: { includeTeamBuffs?: boolean; includeNodeLocal?: boolean }
): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const includeTeamBuffs = Boolean(opts?.includeTeamBuffs)
  const includeNodeLocal = Boolean(opts?.includeNodeLocal)

  // Prefer parsing the `dataObjForCharacterSheet(..., { ... })` options object to avoid accidentally
  // pulling in unrelated blocks (and to make teamBuff inclusion explicit/configurable).
  const optionsBlockInfo = extractDataObjOptionsBlockWithRange(text)
  const optionsBlock = optionsBlockInfo?.block || ''
  if (optionsBlock) {
    if (prefix === 'premod:') {
      pushObjectEntries(out, extractTopLevelObjectPropBlock(optionsBlock, 'premod'))
      if (includeTeamBuffs) {
        const teamBuffBlock = extractTopLevelObjectPropBlock(optionsBlock, 'teamBuff')
        pushObjectEntries(out, extractTopLevelObjectPropBlock(teamBuffBlock, 'premod'))
        // Some upstream sheets place team-wide flat buffs under `teamBuff.total` (e.g. Bennett atk).
        pushObjectEntries(out, extractTopLevelObjectPropBlock(teamBuffBlock, 'total'))
      }
    } else if (prefix === 'base:') {
      pushObjectEntries(out, extractTopLevelObjectPropBlock(optionsBlock, 'base'))
    } else if (prefix === 'total:') {
      pushObjectEntries(out, extractTopLevelObjectPropBlock(optionsBlock, 'total'))
      if (includeTeamBuffs) {
        const teamBuffBlock = extractTopLevelObjectPropBlock(optionsBlock, 'teamBuff')
        pushObjectEntries(out, extractTopLevelObjectPropBlock(teamBuffBlock, 'total'))
      }
    }
  }

  // IMPORTANT:
  // - For upstream-direct, do NOT treat node-local `{ premod: { ... } }` blocks (e.g. inside `dmgNode(...)`)
  //   as global buffs. Those premods are scoped to a specific formula row; merging them globally causes severe
  //   over-buffing drift (e.g. Mualani's wave stacks applied to every normal hit).
  // - Keep this behind a flag for potential future use in upstream-follow (LLM) as *hints*, not as globals.
  if (includeNodeLocal) {
    // Scan node-local blocks by prefix (e.g. dmgNode(..., { premod: { ... } })), but skip occurrences
    // inside the already-parsed `dataObjForCharacterSheet` options object to avoid unintentionally including
    // teamBuff when `includeTeamBuffs=false`.
    const skipStart = typeof optionsBlockInfo?.startIdx === 'number' ? optionsBlockInfo.startIdx : -1
    const skipEnd = typeof optionsBlockInfo?.endIdx === 'number' ? optionsBlockInfo.endIdx : -1

    let from = 0
    while (true) {
      const idx = text.indexOf(prefix, from)
      if (idx < 0) break
      const brace = text.indexOf('{', idx)
      if (brace < 0) break

      if (skipStart >= 0 && skipEnd > skipStart && idx >= skipStart && idx < skipEnd) {
        from = brace + 1
        continue
      }

      const block = extractBraceBlock(text, brace)
      if (block) pushObjectEntries(out, block)
      from = brace + 1
    }
  }
  return out
}

function extractTeamBuffEntryCandidates(text: string, prop: 'premod' | 'total'): Map<string, string[]> {
  const out = new Map<string, string[]>()
  const optionsBlock = extractDataObjOptionsBlock(text)
  if (!optionsBlock) return out
  const teamBuffBlock = extractTopLevelObjectPropBlock(optionsBlock, 'teamBuff')
  if (!teamBuffBlock) return out
  pushObjectEntries(out, extractTopLevelObjectPropBlock(teamBuffBlock, prop))
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

function mapTotalKeyToMiaoBuffKey(key: string): string | null {
  const k = String(key || '').trim()
  if (!k) return null
  if (k === 'atk') return 'atkPlus'
  if (k === 'hp') return 'hpPlus'
  if (k === 'def') return 'defPlus'
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
    condVarInfo?: Map<string, CondVarInfo>
  },
  stack = new Set<string>(),
  depth = 0
): string {
  if (depth > 20) return ''
  let expr = normalizeExprGs(stripJsComments(exprRaw)).replace(/,$/, '').trim()
  if (!expr) return ''

  // `tally.*` represents teammate-count / team-aggregate values in genshin-optimizer.
  // miao-plugin runtime has no such concept; approximate with "showcase-like" assumptions:
  // - teammate counts: assume thresholds are satisfied (use 3)
  // - max stat across team: approximate with self panel stat
  const tally = /^tally\.([A-Za-z0-9_]+)$/.exec(expr)
  if (tally) {
    const k = String(tally[1] || '').trim()
    const lower = k.toLowerCase()
    if (/max.*(elemas|em|mastery)/.test(lower)) return 'calc(attr.mastery)'
    if (/max.*hp/.test(lower)) return 'calc(attr.hp)'
    if (/max.*atk/.test(lower)) return 'calc(attr.atk)'
    if (/max.*def/.test(lower)) return 'calc(attr.def)'
    return '3'
  }

  // Object-spread alias: `const x = { ...y }` (Clorinde: burst_dmgInc mirrors normal_dmgInc).
  // Also used in upstream to mark "pivot" nodes (e.g. `infoMut({ ...input.premod.hp }, { pivot: true })`).
  const spread = /^\{\s*\.\.\.\s*([^}]+?)\s*}\s*$/.exec(expr)
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

  // constObj.propA.propB -> inline from const initializer object literal when possible.
  // (Common in upstream options blocks: `skill_dmgInc: dmgFormulas.constellation2.skill_dmgInc`.)
  const member = /^([A-Za-z_][A-Za-z0-9_]*)(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/.exec(expr)
  if (member) {
    const parts = expr.split('.').map((s) => s.trim()).filter(Boolean)
    const base = parts.shift() || ''
    if (base && opts.constInits.has(base) && !stack.has(base)) {
      const extractObjBlock = (raw: string): string | null => {
        const s = String(raw || '').trim()
        if (!s) return null
        const idx = s.indexOf('{')
        if (idx < 0) return null
        const block = extractBraceBlock(s, idx)
        return block && block.trim().startsWith('{') ? block : null
      }

      stack.add(base)
      let cur = String(opts.constInits.get(base) || '')
      for (const seg of parts) {
        if (!seg) {
          cur = ''
          break
        }
        // Allow indirection: `{ foo: bar }` where `bar` is another const object.
        const idOnly = /^[A-Za-z_][A-Za-z0-9_]*$/.test(cur.trim()) ? cur.trim() : ''
        if (idOnly && opts.constInits.has(idOnly) && !stack.has(idOnly)) {
          stack.add(idOnly)
          cur = String(opts.constInits.get(idOnly) || '')
          stack.delete(idOnly)
        }

        const obj = extractObjBlock(cur)
        if (!obj) {
          cur = ''
          break
        }
        const entries = parseObjectLiteralEntries(obj)
        const hit = entries.find((e) => e.key === seg) || null
        if (!hit?.value) {
          cur = ''
          break
        }
        cur = hit.value
      }
      stack.delete(base)
      const resolved = String(cur || '').trim()
      if (resolved) return translateGsExpr(resolved, opts, stack, depth + 1)
    }
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
      const pickDmPath = (raw: string): string | null => {
        const s = String(raw || '').trim()
        if (!s) return null
        const direct = /^dm\.([A-Za-z0-9_.]+)$/.exec(s)
        if (direct) return direct[1]!
        const inner = /\bdm\.([A-Za-z0-9_.]+)\b/.exec(s)
        return inner ? inner[1]! : null
      }

      const dmArg0 = String(args[1] || '').trim().replace(/,$/, '')
      const dmArg =
        /^[A-Za-z_][A-Za-z0-9_]*$/.test(dmArg0) && opts.constInits.has(dmArg0)
          ? String(opts.constInits.get(dmArg0) || '')
          : dmArg0
      const dmPath = pickDmPath(dmArg)
      if (!dmPath) {
        const v = t(dmArg0)
        if (!v) return '0'
        // Reject array literals/spreads; `subscript()` must resolve to a scalar.
        if (/\.\.\./.test(v) || /^\s*\[/.test(v) || /^\s*\(\s*\[/.test(v)) return '0'
        return v
      }
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
      const parts = args
        .map(t)
        .filter(Boolean)
        // Drop unresolved spread fragments like `...0` that are invalid in scalar expressions.
        .filter((x) => !/\.\.\./.test(x))
      if (parts.length) return `(${parts.map((p) => `(${p})`).join(' + ')})`
      // Team-element counters (`tally.*`) are not representable in miao-plugin's calc.js runtime.
      // For upstream-direct, assume a "showcase-like" party that satisfies teammate-count thresholds,
      // which aligns better with baseline meta expectations.
      if (args.some((a) => /\btally\b/.test(a))) return '3'
      return '0'
    }
    if (fn === 'prod') {
      const parts = args
        .map(t)
        .filter(Boolean)
        .filter((x) => !/\.\.\./.test(x))
      return parts.length ? `(${parts.map((p) => `(${p})`).join(' * ')})` : '0'
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
      const v2Raw = String(args[1] || '').trim()
      const pass = t(args[2] || '')
      if (!pass) return '0'

      const cond = (raw: string): { varName: string; info: CondVarInfo } | null => {
        const varName = String(raw || '').trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return null
        const info = opts.condVarInfo?.get(varName)
        return info ? { varName, info } : null
      }

      const c1 = cond(v1Raw)
      const c2 = cond(v2Raw)
      const s1 = parseStringLiteral(v1Raw)
      const s2 = parseStringLiteral(v2Raw)
      if ((c1 && s2) || (c2 && s1)) {
        const picked = c1 && s2 ? { c: c1, state: s2 } : { c: c2!, state: s1! }
        const key = inferCondStateParamKey(picked.c.info, picked.state, picked.c.varName)
        const access = renderParamAccess(key)
        return `((${access}) ? (${pass}) : 0)`
      }

      const v1 = t(v1Raw)
      const v2 = t(v2Raw)
      if (!v1 || !v2) return '0'
      return `((${v1}) == (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'unequal') {
      const v1Raw = String(args[0] || '').trim()
      const v2Raw = String(args[1] || '').trim()
      const pass = t(args[2] || '')
      if (!pass) return '0'

      const cond = (raw: string): { varName: string; info: CondVarInfo } | null => {
        const varName = String(raw || '').trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return null
        const info = opts.condVarInfo?.get(varName)
        return info ? { varName, info } : null
      }

      const c1 = cond(v1Raw)
      const c2 = cond(v2Raw)
      const s1 = parseStringLiteral(v1Raw)
      const s2 = parseStringLiteral(v2Raw)
      if ((c1 && s2) || (c2 && s1)) {
        const picked = c1 && s2 ? { c: c1, state: s2 } : { c: c2!, state: s1! }
        const key = inferCondStateParamKey(picked.c.info, picked.state, picked.c.varName)
        const access = renderParamAccess(key)
        return `(!(${access}) ? (${pass}) : 0)`
      }

      const v1 = t(v1Raw)
      const v2 = t(v2Raw)
      if (!v1 || !v2) return '0'
      return `((${v1}) != (${v2}) ? (${pass}) : 0)`
    }

    if (fn === 'compareEq') {
      const v1Raw = String(args[0] || '').trim()
      const v2Raw = String(args[1] || '').trim()
      const eq = t(args[2] || '')
      const neq = t(args[3] || '') || '0'
      if (!eq && !neq) return '0'

      const cond = (raw: string): { varName: string; info: CondVarInfo } | null => {
        const varName = String(raw || '').trim()
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(varName)) return null
        const info = opts.condVarInfo?.get(varName)
        return info ? { varName, info } : null
      }

      const c1 = cond(v1Raw)
      const c2 = cond(v2Raw)
      const s1 = parseStringLiteral(v1Raw)
      const s2 = parseStringLiteral(v2Raw)
      if ((c1 && s2) || (c2 && s1)) {
        const picked = c1 && s2 ? { c: c1, state: s2 } : { c: c2!, state: s1! }
        const key = inferCondStateParamKey(picked.c.info, picked.state, picked.c.varName)
        const access = renderParamAccess(key)
        return `((${access}) ? (${eq || '0'}) : (${neq || '0'}))`
      }

      const v1 = t(v1Raw)
      const v2 = t(v2Raw)
      if (!v1 || !v2) return neq || '0'
      return `((${v1}) == (${v2}) ? (${eq || '0'}) : (${neq || '0'}))`
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
          const prev2Ch = i > 1 ? s[i - 2] : ''
          if (prevCh === '.' && prev2Ch !== '.') {
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
    includeTeamBuffs?: boolean
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

  const includeTeamBuffs = Boolean(opts.upstream?.includeTeamBuffs)
  const premodCandidates = extractObjectEntryCandidates(text, 'premod:', { includeTeamBuffs: false })
  const baseCandidates = extractObjectEntryCandidates(text, 'base:', { includeTeamBuffs: false })
  const totalCandidates = extractObjectEntryCandidates(text, 'total:', { includeTeamBuffs: false })
  const teamPremodCandidates = extractTeamBuffEntryCandidates(text, 'premod')
  const teamTotalCandidates = extractTeamBuffEntryCandidates(text, 'total')
  const nodeLocalPremodCandidates = extractObjectEntryCandidates(text, 'premod:', { includeTeamBuffs: false, includeNodeLocal: true })
  if (
    premodCandidates.size === 0 &&
    baseCandidates.size === 0 &&
    totalCandidates.size === 0 &&
    teamPremodCandidates.size === 0 &&
    teamTotalCandidates.size === 0 &&
    nodeLocalPremodCandidates.size === 0
  ) {
    return []
  }

  const constInits = extractConstInitializers(text)
  const condVarToKey = extractCondVarDecls(text)
  const condTemInfo = condVarToKey.size
    ? extractCondTemInfo(text, condVarToKey)
    : new Map<string, Pick<CondVarInfo, 'section' | 'nameKey'>>()
  const condVarInfo = new Map<string, CondVarInfo>()
  for (const [varName, condKey] of condVarToKey.entries()) condVarInfo.set(varName, { condKey })
  for (const [varName, meta] of condTemInfo.entries()) {
    const existing = condVarInfo.get(varName)
    if (!existing) continue
    if (meta.section) existing.section = meta.section
    if (meta.nameKey) existing.nameKey = meta.nameKey
  }
  const dataPremod: Record<string, number | string> = {}
  const dataTotal: Record<string, number | string> = {}

  const applyCandidates = (
    candidates: Map<string, string[]>,
    mapKey: (rawKey: string) => string | null,
    dataOut: Record<string, number | string>
  ): void => {
    for (const [rawKey, values] of candidates.entries()) {
      const buffKey = mapKey(rawKey)
      if (!buffKey) continue
      if (!isAllowedMiaoBuffDataKey('gs', buffKey)) continue
      if (!Array.isArray(values) || values.length === 0) continue

      // Prefer later occurrences (dataObjForCharacterSheet premod/base blocks tend to come later than node-local ones).
      for (let i = values.length - 1; i >= 0; i--) {
        const value = values[i]!
        const expr = translateGsExpr(value, { constInits, dmMap, dmConstNums, skillParam, condVarInfo })
        if (!expr) continue

        const scaled = scaleExpr(expr, buffScale(buffKey))
        if (typeof scaled === 'number') {
          if (!Number.isFinite(scaled) || scaled === 0) continue
          dataOut[buffKey] = mergeBuffValue(dataOut[buffKey], scaled)
          break
        }

        const t = String(scaled || '').trim()
        if (!t || t === '0' || t === '(0)') continue
        // Spread/rest fragments are not representable in miao-plugin runtime; keep upstream-direct deterministic.
        if (/\.\.\./.test(t)) continue
        if (hasUnknownFreeIdentifiers(t)) continue
        dataOut[buffKey] = mergeBuffValue(dataOut[buffKey], t)
        break
      }
    }
  }

  applyCandidates(baseCandidates, mapBaseKeyToMiaoBuffKey, dataPremod)
  applyCandidates(premodCandidates, (k) => mapPremodKeyToMiaoBuffKey(opts.elem, k), dataPremod)
  if (includeTeamBuffs) {
    applyCandidates(teamPremodCandidates, (k) => mapPremodKeyToMiaoBuffKey(opts.elem, k), dataPremod)
    applyCandidates(teamTotalCandidates, mapTotalKeyToMiaoBuffKey, dataTotal)
  } else {
    // Keep a conservative subset: teamBuff entries that map to ability-scoped buckets (a/a2/a3/e/q).
    const isAbilityScoped = (buffKey: string): boolean => /^(a|a2|a3|e|q|nightsoul)/.test(buffKey)
    const applyTeamAbilityOnly = (
      candidates: Map<string, string[]>,
      mapKey: (rawKey: string) => string | null,
      dataOut: Record<string, number | string>
    ): void => {
      const filtered = new Map<string, string[]>()
      for (const [rawKey, values] of candidates.entries()) {
        const buffKey = mapKey(rawKey)
        if (!buffKey) continue
        if (!isAbilityScoped(buffKey)) continue
        filtered.set(rawKey, values)
      }
      applyCandidates(filtered, mapKey, dataOut)
    }
    applyTeamAbilityOnly(teamPremodCandidates, (k) => mapPremodKeyToMiaoBuffKey(opts.elem, k), dataPremod)
  }

  // Best-effort: lift a conservative subset of node-local premods into global buffs to match baseline expectations.
  // Keep this narrow to avoid over-buffing (node-local premods can be hit-scoped).
  try {
    for (const [rawKey0, values] of nodeLocalPremodCandidates.entries()) {
      const rawKey = String(rawKey0 || '').trim()
      if (!rawKey) continue
      if (!/^(skill|burst)_/i.test(rawKey)) continue
      if (!Array.isArray(values) || values.length === 0) continue

      const buffKey = mapPremodKeyToMiaoBuffKey(opts.elem, rawKey)
      if (!buffKey) continue
      if (!isAllowedMiaoBuffDataKey('gs', buffKey)) continue
      // Fallback-only: do not override global premod.
      if (Object.prototype.hasOwnProperty.call(dataPremod, buffKey)) continue

      const uniq = new Map<string, number | string>()
      for (const vRaw of values) {
        const expr = translateGsExpr(vRaw, { constInits, dmMap, dmConstNums, skillParam, condVarInfo })
        if (!expr) continue

        const scaled = scaleExpr(expr, buffScale(buffKey))
        if (typeof scaled === 'number') {
          if (!Number.isFinite(scaled) || scaled === 0) continue
          uniq.set(`n:${scaled}`, scaled)
          continue
        }

        const t = String(scaled || '').trim()
        if (!t || t === '0' || t === '(0)') continue
        if (/\.\.\./.test(t)) continue
        if (hasUnknownFreeIdentifiers(t)) continue
        uniq.set(`s:${t}`, t)
      }

      if (uniq.size !== 1) continue
      dataPremod[buffKey] = Array.from(uniq.values())[0]!
    }
  } catch {
    // best-effort
  }

  applyCandidates(totalCandidates, mapTotalKeyToMiaoBuffKey, dataTotal)

  const buffs: CalcSuggestBuff[] = []
  if (Object.keys(dataPremod).length) buffs.push({ title: 'upstream:genshin-optimizer(premod)', data: dataPremod })
  if (Object.keys(dataTotal).length) buffs.push({ title: 'upstream:genshin-optimizer(total)', data: dataTotal })
  return buffs
}
