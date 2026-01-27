/**
 * GI (GS) talent table helpers.
 *
 * Hakush GI character detail provides:
 * - `Skills[].Desc` (rich text with <color> tags and \\n)
 * - `Skills[].Promote[]` containing:
 *   - Desc: comma-separated "Label|{paramN:Fmt}[+...]" templates
 *   - Param: a numeric array for each talent level
 *
 * miao-plugin expects (in meta-gs/character/<name>/data.json):
 * - `talent.<key>.desc`: string[] (with <h3> headings)
 * - `talent.<key>.tables`: formatted string tables (for wiki display)
 * - `talentData.<key>`: numeric tables used by damage calc runtime
 *
 * This module builds those structures deterministically for *new* characters.
 */

type SkillKey = 'a' | 'e' | 'q'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeGiRichText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Hakush GI strings often include literal "\\n" sequences.
  return raw
    .replaceAll('{LINK#', '') // keep visible text and drop markers
    .replaceAll('{/LINK}', '')
    .replaceAll('\\n', '\n')
    .replaceAll('\r\n', '\n')
    .trim()
}

/**
 * Convert Hakush GI skill description to miao-plugin "desc array".
 *
 * - Convert golden <color> headings to <h3>
 * - Strip other <color> tags
 * - Split by newline, drop empty lines
 */
export function giSkillDescToLines(rawDesc: unknown): string[] {
  let text = normalizeGiRichText(rawDesc)
  if (!text) return []

  // Headings are usually color=#FFD780FF in GI texts.
  text = text.replace(/<color=#FFD780FF>(.*?)<\/color>/g, (_m, t: string) => `<h3>${t}</h3>`)

  // Drop other color tags but keep inner text.
  text = text.replace(/<color=[^>]+>/g, '').replace(/<\/color>/g, '')

  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
}

function formatGiParam(value: number, format: string): string {
  // Keep behavior aligned with existing meta outputs:
  // - Percent formats multiply by 100 and keep up to 2 decimals (trim trailing zeros)
  // - F1 keeps 1 decimal (trim trailing zeros)
  // - I keeps integer-ish
  const num = Number(value)
  if (!Number.isFinite(num)) return ''

  const fmt = String(format || '')
  const isPercent = fmt.includes('P')
  if (isPercent) {
    const v = parseFloat((num * 100).toFixed(2))
    return `${v}%`
  }

  if (fmt === 'F1') {
    return String(parseFloat(num.toFixed(1)))
  }

  if (fmt === 'I') {
    return String(Math.round(num))
  }

  // Fallback: keep a reasonable precision.
  return String(parseFloat(num.toFixed(3)))
}

function renderGiTemplate(template: string, params: number[]): string {
  let out = template
  out = out.replace(/\{param(\d+):([^}]+)\}/g, (_m, idxStr: string, fmt: string) => {
    const idx = Number(idxStr) - 1
    const v = params?.[idx]
    if (typeof v !== 'number' || !Number.isFinite(v)) return ''
    return formatGiParam(v, fmt)
  })

  // Normalize separators to match baseline style.
  out = out.replace(/\s*\+\s*/g, ' + ')
  out = out.replace(/\s*\/\s*/g, ' / ')
  return out.trim()
}

function parsePromoteDescTemplate(desc: unknown): Array<{ name: string; template: string }> {
  if (typeof desc !== 'string') return []
  const parts = desc
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const out: Array<{ name: string; template: string }> = []
  for (const p of parts) {
    const idx = p.indexOf('|')
    if (idx === -1) continue
    const name = p.slice(0, idx).trim()
    const template = p.slice(idx + 1).trim()
    if (!name || !template) continue
    out.push({ name, template })
  }
  return out
}

function promoteLevels(promotes: Array<unknown>): Array<{ level: number; params: number[]; templateDesc: string }> {
  const rows: Array<{ level: number; params: number[]; templateDesc: string }> = []
  for (const p of promotes) {
    if (!isRecord(p)) continue
    const level = toNum(p.Level)
    const desc =
      typeof p.Desc === 'string'
        ? p.Desc
        : Array.isArray(p.Desc)
          ? (p.Desc as Array<unknown>).filter((x) => typeof x === 'string' && x.trim()).join(',')
          : ''
    const params = Array.isArray(p.Param)
      ? (p.Param as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n))
      : []
    if (!level || !desc || params.length === 0) continue
    rows.push({ level, params: params as number[], templateDesc: desc })
  }
  rows.sort((a, b) => a.level - b.level)
  return rows
}

function normalizePromoteList(promoteRaw: unknown): Array<unknown> {
  if (Array.isArray(promoteRaw)) return promoteRaw
  if (isRecord(promoteRaw)) {
    // Hakush sometimes uses an object keyed by 0..N instead of an array.
    return Object.keys(promoteRaw)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
      .map((n) => promoteRaw[String(n)] as unknown)
  }
  return []
}

export interface GiTalentBlock {
  id: number
  name: string
  desc: string[]
  tables: Array<{ name: string; unit: string; isSame: boolean; values: string[] }>
}

export type GiTalentDataBlock = Record<string, number[] | number[][]>

export function buildGiTablesFromPromote(promotes: Array<unknown>): Array<{ name: string; unit: string; isSame: boolean; values: string[] }> {
  const rows = promoteLevels(promotes)
  if (rows.length === 0) return []

  const templates = parsePromoteDescTemplate(rows[0]!.templateDesc)
  if (templates.length === 0) return []

  const tables: Array<{ name: string; unit: string; isSame: boolean; values: string[] }> = []
  for (const t of templates) {
    const values: string[] = []
    for (const row of rows) {
      values.push(renderGiTemplate(t.template, row.params))
    }
    const isSame = values.length > 1 && values.every((v) => v === values[0])
    // Baseline meta uses a compact representation: when values are identical across levels,
    // keep a single item in `values` and mark `isSame=true`.
    tables.push({ name: t.name, unit: '', isSame, values: isSame ? [values[0]!] : values })
  }
  return tables
}

function extractParamRefs(template: string): Array<{ index: number; fmt: string }> {
  const refs: Array<{ index: number; fmt: string }> = []
  const re = /\{param(\d+):([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const idx = Number(m[1]) - 1
    const fmt = m[2] ?? ''
    if (Number.isFinite(idx) && idx >= 0) refs.push({ index: idx, fmt })
  }
  return refs
}

function numericParam(value: number, fmt: string): number {
  const isPercent = String(fmt || '').includes('P')
  const v = isPercent ? value * 100 : value
  // Keep a stable precision for calc (avoid long floats).
  return parseFloat(v.toFixed(5))
}

export function buildGiTalentDataFromPromote(promotes: Array<unknown>): GiTalentDataBlock {
  const rows = promoteLevels(promotes)
  if (rows.length === 0) return {}

  const templates = parsePromoteDescTemplate(rows[0]!.templateDesc)
  if (templates.length === 0) return {}

  const out: GiTalentDataBlock = {}

  for (const t of templates) {
    const refs = extractParamRefs(t.template)
    if (refs.length === 0) continue

    const wantsSlash = t.template.includes('/')
    const wantsPlus = t.template.includes('+')
    const mulMatch = t.template.match(/\*(\d+)\s*$/)
    const mul = mulMatch ? Number(mulMatch[1]) : null

    if (wantsSlash && refs.length >= 2) {
      const vals: number[][] = []
      for (const row of rows) {
        const arr = refs.map((r) => numericParam(row.params[r.index] ?? 0, r.fmt))
        vals.push(arr)
      }
      out[t.name] = vals
      out[`${t.name}2`] = vals
      continue
    }

    if (wantsPlus && refs.length >= 2) {
      const sumVals: number[] = []
      const partsVals: number[][] = []
      for (const row of rows) {
        const arr = refs.map((r) => numericParam(row.params[r.index] ?? 0, r.fmt))
        partsVals.push(arr)
        sumVals.push(parseFloat(arr.reduce((a, b) => a + b, 0).toFixed(5)))
      }
      out[t.name] = sumVals
      out[`${t.name}2`] = partsVals
      continue
    }

    if (mul != null && refs.length >= 1) {
      const main: number[] = []
      const parts: number[][] = []
      for (const row of rows) {
        const base = numericParam(row.params[refs[0]!.index] ?? 0, refs[0]!.fmt)
        main.push(parseFloat((base * mul).toFixed(5)))
        parts.push([base, mul])
      }
      out[t.name] = main
      out[`${t.name}2`] = parts
      continue
    }

    if (refs.length === 1) {
      const main: number[] = []
      for (const row of rows) {
        main.push(numericParam(row.params[refs[0]!.index] ?? 0, refs[0]!.fmt))
      }
      out[t.name] = main
      continue
    }

    // Multiple params but no operator: keep arrays for maximum fidelity.
    const vals: number[][] = []
    for (const row of rows) {
      vals.push(refs.map((r) => numericParam(row.params[r.index] ?? 0, r.fmt)))
    }
    out[t.name] = vals
    out[`${t.name}2`] = vals
  }

  return out
}

export interface BuildGiTalentResult {
  talent: Record<SkillKey, GiTalentBlock>
  talentData: Record<SkillKey, GiTalentDataBlock>
  talentId: Record<string, SkillKey>
}

/**
 * Build a/e/q talent blocks from Hakush `Skills` array.
 *
 * @param skillsRaw Hakush `Skills` array
 * @param qIdx Index of Q skill in the array (some characters have an extra sprint skill)
 */
export function buildGiTalent(skillsRaw: Array<unknown>, qIdx: number): BuildGiTalentResult | null {
  if (!Array.isArray(skillsRaw) || skillsRaw.length < 3) return null
  const skills = skillsRaw.map((s) => (isRecord(s) ? (s as Record<string, unknown>) : null))

  const pick = (idx: number): Record<string, unknown> | null => (idx >= 0 && idx < skills.length ? skills[idx] : null) as any
  const a = pick(0)
  const e = pick(1)
  const q = pick(qIdx)
  if (!a || !e || !q) return null

  const skillBlock = (s: Record<string, unknown>): GiTalentBlock | null => {
    const id = toNum(s.Id)
    const name = typeof s.Name === 'string' ? s.Name : ''
    if (!id || !name) return null
    const desc = giSkillDescToLines(s.Desc)
    const promotes = normalizePromoteList(s.Promote)
    const tables = buildGiTablesFromPromote(promotes)
    return { id, name, desc, tables }
  }

  const aBlock = skillBlock(a)
  const eBlock = skillBlock(e)
  const qBlock = skillBlock(q)
  if (!aBlock || !eBlock || !qBlock) return null

  const dataBlock = (s: Record<string, unknown>): GiTalentDataBlock => {
    const promotes = normalizePromoteList(s.Promote)
    return buildGiTalentDataFromPromote(promotes)
  }

  const talentData: Record<SkillKey, GiTalentDataBlock> = {
    a: dataBlock(a),
    e: dataBlock(e),
    q: dataBlock(q)
  }

  const talentId: Record<string, SkillKey> = {
    [String(aBlock.id)]: 'a',
    [String(eBlock.id)]: 'e',
    [String(qBlock.id)]: 'q'
  }

  return {
    talent: { a: aBlock, e: eBlock, q: qBlock },
    talentData,
    talentId
  }
}
