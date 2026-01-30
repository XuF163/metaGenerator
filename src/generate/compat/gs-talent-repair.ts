/**
 * Repair/normalize GS talent tables and talentData in already-generated output.
 *
 * Why:
 * - `meta-gen gen` is incremental and may skip rewriting existing `data.json`.
 * - Some structure details are easy to normalize locally without re-fetching upstream.
 *
 * What:
 * - When a table has `isSame=true`, baseline meta stores a single value in `values`.
 * - Older outputs may have repeated identical values; we compact them.
 * - `talentData` in baseline meta mirrors the numeric content of `talent.*.tables`.
 *   We rebuild `talentData` from already-generated tables to ensure rounding and
 *   operator handling matches baseline (especially for multi-hit normal attacks).
 *
 * This does NOT change numeric meaning; it only normalizes representation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { walkFiles } from '../../fs/walk.js'
import { writeJsonFile } from '../../fs/json.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function compactSameTableValues(block: unknown): boolean {
  if (!isRecord(block)) return false
  const tables = block.tables
  if (!Array.isArray(tables)) return false

  let changed = false
  for (const t of tables) {
    if (!isRecord(t)) continue

    if (t.isSame !== true) continue
    const values = t.values
    if (!Array.isArray(values) || values.length <= 1) continue

    const first = values[0]
    if (values.every((v) => v === first)) {
      ;(t as any).values = [first]
      changed = true
    }
  }
  return changed
}

function compactTalentTables(data: unknown): boolean {
  if (!isRecord(data)) return false
  const talent = data.talent
  if (!isRecord(talent)) return false

  let changed = false
  for (const v of Object.values(talent)) {
    if (compactSameTableValues(v)) changed = true
  }
  return changed
}

type TalentTable = { name: string; values: string[] }

function normalizeItalicDescLines(desc: unknown): { changed: boolean; next?: string[] } {
  if (!Array.isArray(desc) || !(desc as Array<unknown>).every((x) => typeof x === 'string')) return { changed: false }

  let italicOpen = false
  let changed = false
  const next: string[] = []

  for (const rawLine of desc as string[]) {
    let line = rawLine
    const startedItalic = line.includes('<i>')
    const endedItalic = line.includes('</i>')

    if (!startedItalic && endedItalic) {
      line = `<i>${line}`
    } else if (italicOpen && !startedItalic) {
      line = `<i>${line}`
    }

    if ((italicOpen || startedItalic) && !line.includes('</i>')) {
      line = `${line}</i>`
    }

    next.push(line)
    if (line !== rawLine) changed = true

    if (endedItalic) italicOpen = false
    else if (startedItalic) italicOpen = true
  }

  return changed ? { changed: true, next } : { changed: false }
}

function repairItalicDescArrays(data: unknown): boolean {
  if (!isRecord(data)) return false
  let changed = false

  const talent = data.talent
  if (isRecord(talent)) {
    for (const blk of Object.values(talent)) {
      if (!isRecord(blk)) continue
      const res = normalizeItalicDescLines(blk.desc)
      if (res.changed && res.next) {
        ;(blk as any).desc = res.next
        changed = true
      }
    }
  }

  const cons = data.cons
  if (isRecord(cons)) {
    for (const blk of Object.values(cons)) {
      if (!isRecord(blk)) continue
      const res = normalizeItalicDescLines(blk.desc)
      if (res.changed && res.next) {
        ;(blk as any).desc = res.next
        changed = true
      }
    }
  }

  return changed
}

function normalizeDescPunctuation(data: unknown): boolean {
  if (!isRecord(data)) return false
  let changed = false

  const fix = (desc: unknown): { changed: boolean; next?: string[] } => {
    if (!Array.isArray(desc) || !(desc as Array<unknown>).every((x) => typeof x === 'string')) return { changed: false }
    const next = (desc as string[]).map((line) => line.replace(/\s+：/g, '：'))
    const didChange = JSON.stringify(next) !== JSON.stringify(desc)
    return didChange ? { changed: true, next } : { changed: false }
  }

  const apply = (blk: unknown): void => {
    if (!isRecord(blk)) return
    const res = fix(blk.desc)
    if (res.changed && res.next) {
      ;(blk as any).desc = res.next
      changed = true
    }
  }

  const talent = data.talent
  if (isRecord(talent)) {
    for (const blk of Object.values(talent)) apply(blk)
  }
  const cons = data.cons
  if (isRecord(cons)) {
    for (const blk of Object.values(cons)) apply(blk)
  }

  return changed
}

function normalizeTalentTableValues(data: unknown): boolean {
  if (!isRecord(data)) return false
  const talent = data.talent
  if (!isRecord(talent)) return false

  let changed = false

  for (const blk of Object.values(talent)) {
    if (!isRecord(blk)) continue
    const tables = blk.tables
    if (!Array.isArray(tables)) continue

    for (const t of tables) {
      if (!isRecord(t)) continue
      const name = typeof t.name === 'string' ? (t.name as string) : ''
      const unit = typeof t.unit === 'string' ? (t.unit as string) : ''
      const valuesRaw = t.values
      if (!Array.isArray(valuesRaw) || !(valuesRaw as Array<unknown>).every((x) => typeof x === 'string')) continue
      const values = valuesRaw as string[]

      // Baseline-compat: "元素能量恢复" prefers unit-in-value formatting (unit="").
      if (name === '元素能量恢复' && unit === '点') {
        const nextValues = values.map((v) => {
          const m = v.match(/^(.*?)(-?\d+(?:\.\d+)?)(.*)$/)
          if (!m) return `${v}点`
          const prefix = m[1] ?? ''
          const numStr = m[2] ?? ''
          const suffix = m[3] ?? ''
          const num = Number(numStr)
          if (!Number.isFinite(num)) return `${v}点`
          const rendered = Math.abs(num - Math.round(num)) < 1e-9 ? num.toFixed(2) : numStr
          return `${prefix}${rendered}${suffix}点`
        })
        ;(t as any).unit = ''
        ;(t as any).values = nextValues
        changed = true
        continue
      }

      // Baseline-compat: compact slash lists for time/count stacks.
      const nextValues = values.map((v) => {
        if (!v.includes('/')) return v
        if (/(?:秒|次|层)$/.test(v)) return v.replace(/\s*\/\s*/g, '/')
        return v
      })
      if (JSON.stringify(nextValues) !== JSON.stringify(values)) {
        ;(t as any).values = nextValues
        changed = true
      }
    }
  }

  return changed
}

function parseNumbersFromTableValue(text: string): number[] {
  const nums = text.match(/-?\d+(?:\.\d+)?/g)
  if (!nums) return []
  return nums.map((s) => Number(s)).filter((n) => Number.isFinite(n))
}

function isSlashListValue(text: string): boolean {
  // Baseline uses spaced slashes (" / ") for multi-part percent lists.
  // Also treat 2+ slashes as list (even when compact, e.g. "0%/104%/110%生命之契").
  if (text.includes(' / ')) return true
  const slashCount = (text.match(/\//g) || []).length
  return slashCount >= 2
}

type ExprTok =
  | { kind: 'num'; value: number }
  | { kind: 'op'; op: '+' | '-' | '*' | '/' }
  | { kind: 'lparen' }
  | { kind: 'rparen' }

function tableValueToExpr(text: string): string {
  // Convert values like "(67.2%攻击 + 134.4%精通)*2" into "(67.2 + 134.4)*2".
  // Keep only operators/parentheses/numbers; replace everything else with spaces.
  const allowed = new Set(['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '+', '-', '*', '/', '(', ')', ' '])
  let out = ''
  for (const ch of text.replaceAll('%', '')) {
    out += allowed.has(ch) ? ch : ' '
  }
  return out.replace(/\s+/g, ' ').trim()
}

function tokenizeExpr(expr: string): ExprTok[] {
  const toks: ExprTok[] = []
  let i = 0
  const s = expr
  while (i < s.length) {
    const c = s[i]!
    if (c === ' ') {
      i++
      continue
    }
    if (c === '(') {
      toks.push({ kind: 'lparen' })
      i++
      continue
    }
    if (c === ')') {
      toks.push({ kind: 'rparen' })
      i++
      continue
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      toks.push({ kind: 'op', op: c })
      i++
      continue
    }
    if ((c >= '0' && c <= '9') || c === '.') {
      let j = i + 1
      while (j < s.length) {
        const cj = s[j]!
        if ((cj >= '0' && cj <= '9') || cj === '.') j++
        else break
      }
      const num = Number(s.slice(i, j))
      if (Number.isFinite(num)) toks.push({ kind: 'num', value: num })
      i = j
      continue
    }
    // Unknown char: skip.
    i++
  }
  return toks
}

function evalExpr(expr: string): number | null {
  const toks = tokenizeExpr(expr)
  if (toks.length === 0) return null

  let idx = 0
  const peek = (): ExprTok | undefined => toks[idx]
  const next = (): ExprTok | undefined => toks[idx++]

  const parseFactor = (): number | null => {
    const t = peek()
    if (!t) return null

    if (t.kind === 'op' && (t.op === '+' || t.op === '-')) {
      next()
      const v = parseFactor()
      if (v == null) return null
      return t.op === '-' ? -v : v
    }

    if (t.kind === 'num') {
      next()
      return t.value
    }

    if (t.kind === 'lparen') {
      next()
      const v = parseExpr()
      const r = peek()
      if (!r || r.kind !== 'rparen') return null
      next()
      return v
    }

    return null
  }

  const parseTerm = (): number | null => {
    let v = parseFactor()
    if (v == null) return null
    while (true) {
      const t = peek()
      if (!t || t.kind !== 'op' || (t.op !== '*' && t.op !== '/')) break
      next()
      const rhs = parseFactor()
      if (rhs == null) return null
      v = t.op === '*' ? v * rhs : v / rhs
    }
    return v
  }

  const parseExpr = (): number | null => {
    let v = parseTerm()
    if (v == null) return null
    while (true) {
      const t = peek()
      if (!t || t.kind !== 'op' || (t.op !== '+' && t.op !== '-')) break
      next()
      const rhs = parseTerm()
      if (rhs == null) return null
      v = t.op === '+' ? v + rhs : v - rhs
    }
    return v
  }

  const v = parseExpr()
  if (v == null || !Number.isFinite(v)) return null
  return v
}

function tryEvalTableValue(text: string): number | null {
  const expr = tableValueToExpr(text)
  if (!expr) return null
  return evalExpr(expr)
}

function rebuildTalentDataFromTables(data: unknown): boolean {
  if (!isRecord(data)) return false
  const talent = data.talent
  const talentData = data.talentData
  if (!isRecord(talent) || !isRecord(talentData)) return false

  let changed = false

  for (const skillKey of ['a', 'e', 'q'] as const) {
    const tBlock = talent[skillKey]
    const tdBlock = talentData[skillKey]
    if (!isRecord(tBlock) || !isRecord(tdBlock)) continue

    const tablesArr = Array.isArray(tBlock.tables) ? (tBlock.tables as Array<unknown>) : []
    const tables: TalentTable[] = tablesArr
      .map((t) => (isRecord(t) && typeof t.name === 'string' && Array.isArray(t.values) ? (t as any) : null))
      .filter(Boolean) as TalentTable[]

    const tableByName = new Map<string, TalentTable>()
    for (const t of tables) {
      tableByName.set(t.name, t)
    }

    for (const [key, oldVal] of Object.entries(tdBlock)) {
      const direct = tableByName.get(key)
      const baseName = key.endsWith('2') ? key.slice(0, -1) : null
      const base = baseName ? tableByName.get(baseName) : undefined
      const table = direct ?? base
      if (!table) continue

      const values = Array.isArray(table.values) && table.values.length ? table.values : []
      if (!values.length) continue

      const len = Array.isArray(oldVal) ? oldVal.length : 0
      if (len <= 0) continue

      const pickValue = (i: number): string => values[Math.min(i, values.length - 1)]!

      const isPlus = values.some((v) => v.includes('+'))
      const isMul = values.some((v) => v.includes('*'))
      const isSlashList = values.some(isSlashListValue)
      const wantsParts = !direct && Boolean(baseName) && key.endsWith('2') && (isPlus || isMul)

      let next: unknown

      if (isSlashList) {
        const sample = parseNumbersFromTableValue(pickValue(0))
        if (sample.length <= 1) {
          const out: number[] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push(nums[0] ?? 0)
          }
          next = out
        } else {
          const out: number[][] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push(nums)
          }
          next = out
        }
      } else if (isPlus) {
        if (wantsParts) {
          const out: number[][] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push(nums)
          }
          next = out
        } else {
          const out: number[] = []
          for (let i = 0; i < len; i++) {
            const v = tryEvalTableValue(pickValue(i))
            if (v != null) out.push(v)
            else {
              const nums = parseNumbersFromTableValue(pickValue(i))
              out.push(nums.reduce((a, b) => a + b, 0))
            }
          }
          next = out
        }
      } else if (isMul) {
        if (wantsParts) {
          const out: number[][] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push([nums[0] ?? 0, nums[nums.length - 1] ?? 0])
          }
          next = out
        } else {
          const out: number[] = []
          for (let i = 0; i < len; i++) {
            const v = tryEvalTableValue(pickValue(i))
            if (v != null) out.push(v)
            else {
              const nums = parseNumbersFromTableValue(pickValue(i))
              out.push(nums.length >= 2 ? (nums[0] ?? 0) * (nums[nums.length - 1] ?? 0) : (nums[0] ?? 0))
            }
          }
          next = out
        }
      } else {
        const sample = parseNumbersFromTableValue(pickValue(0))
        if (sample.length > 1) {
          const out: number[][] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push(nums)
          }
          next = out
        } else {
          const out: number[] = []
          for (let i = 0; i < len; i++) {
            const nums = parseNumbersFromTableValue(pickValue(i))
            out.push(nums[0] ?? 0)
          }
          next = out
        }
      }

      if (JSON.stringify(oldVal) !== JSON.stringify(next)) {
        ;(tdBlock as Record<string, unknown>)[key] = next
        changed = true
      }
    }
  }

  return changed
}

export async function repairGsTalentTables(metaGsRootAbs: string, log?: Pick<Console, 'info' | 'warn'>): Promise<void> {
  const charRoot = path.join(metaGsRootAbs, 'character')
  if (!fs.existsSync(charRoot)) return

  let scanned = 0
  let updated = 0

  for await (const filePath of walkFiles(charRoot, { ignoreNames: new Set(['.ace-tool']) })) {
    if (path.basename(filePath) !== 'data.json') continue
    // Skip top-level character/data.json index.
    if (path.dirname(filePath) === charRoot) continue

    scanned++
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    } catch {
      continue
    }

    const changedDesc = repairItalicDescArrays(raw)
    const changedPunct = normalizeDescPunctuation(raw)
    const changedTables = compactTalentTables(raw)
    const changedTableValues = normalizeTalentTableValues(raw)
    const changedData = rebuildTalentDataFromTables(raw)
    if (!changedDesc && !changedPunct && !changedTables && !changedTableValues && !changedData) continue

    writeJsonFile(filePath, raw)
    updated++
    if (updated === 1 || updated % 50 === 0) {
      log?.info?.(`[meta-gen] (gs) talent table repaired: ${updated}/${scanned}`)
    }
  }

  if (updated > 0) {
    log?.info?.(`[meta-gen] (gs) talent table repair done: updated=${updated} scanned=${scanned}`)
  }
}

