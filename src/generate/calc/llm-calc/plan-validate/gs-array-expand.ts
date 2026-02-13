import type { CalcSuggestDetail, CalcSuggestInput, TalentKey } from '../types.js'
import { inferArrayTableSchema } from '../table-schema.js'
import { normalizePromptText } from '../utils.js'
import { normalizeKind } from './normalize.js'

function isNumericArraySample(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 2 &&
    v.length <= 10 &&
    v.every((x) => typeof x === 'number' && Number.isFinite(x))
  )
}

function paramsSig(pRaw: unknown): string {
  const p = pRaw && typeof pRaw === 'object' && !Array.isArray(pRaw) ? (pRaw as Record<string, unknown>) : null
  if (!p) return ''
  const keys = Object.keys(p).map((k) => String(k || '').trim()).filter(Boolean).sort()
  if (!keys.length) return ''
  const parts: string[] = []
  for (const k of keys) {
    const v = p[k]
    if (typeof v === 'number' && Number.isFinite(v)) parts.push(`${k}=${v}`)
    else if (typeof v === 'boolean') parts.push(`${k}=${v ? 1 : 0}`)
    else if (typeof v === 'string' && v.trim()) parts.push(`${k}=${v.trim()}`)
    else if (v == null) parts.push(`${k}=null`)
  }
  return parts.join(',')
}

function segLabel(i: number): string {
  const cn = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'][i] || String(i + 1)
  return `${cn}段`
}

/**
 * GS: expand simple numeric-array damage tables into multiple detail rows with `pick`.
 *
 * Motivation:
 * - Some Hakush/official tables are arrays like `[v0, v1, v2]` where each slot is a different hit/variant.
 * - Without `pick`, renderer falls back to the first component and can miss baseline segment rows.
 *
 * Safety (conservative):
 * - Only expands when:
 *   - kind=dmg
 *   - no existing `pick` and no custom `dmgExpr`
 *   - `input.tableSamples` confirms the table is a numeric array
 *   - renderer cannot infer a structured schema (`statFlat/statTimes/pctList/...`)
 *   - array length is small (<=3)
 * - Deduplicates repeated rows that share the same `(talent, table, key, ele, paramsSig)`.
 */
export function expandGsArrayVariantDetails(input: CalcSuggestInput, details: CalcSuggestDetail[]): void {
  if (input.game !== 'gs') return
  if (!Array.isArray(details) || details.length === 0) return

  type Group = { idxs: number[]; tk: TalentKey; table: string; len: number }
  const groups = new Map<string, Group>()

  for (let i = 0; i < details.length; i++) {
    const d: any = details[i]
    if (!d || typeof d !== 'object') continue
    if (normalizeKind(d.kind) !== 'dmg') continue
    if (typeof d.dmgExpr === 'string' && d.dmgExpr.trim()) continue
    if (typeof d.pick === 'number' && Number.isFinite(d.pick)) continue

    const tk = typeof d.talent === 'string' ? String(d.talent).trim() : ''
    const table = typeof d.table === 'string' ? String(d.table).trim() : ''
    if (!tk || !table) continue

    const sample = (input.tableSamples as any)?.[tk]?.[table]
    if (!isNumericArraySample(sample)) continue
    if (sample.length > 3) continue

    // Let renderer handle known structured arrays.
    if (inferArrayTableSchema(input, tk, table)) continue

    const key = typeof d.key === 'string' ? String(d.key).trim() : ''
    const ele = typeof d.ele === 'string' ? String(d.ele).trim() : ''
    const sig = paramsSig(d.params)
    const gKey = `${tk}\u0000${table}\u0000${key}\u0000${ele}\u0000${sig}`

    const g = groups.get(gKey)
    if (g) g.idxs.push(i)
    else groups.set(gKey, { idxs: [i], tk, table, len: sample.length })
  }

  if (groups.size === 0) return

  const expandAt = new Map<number, CalcSuggestDetail[]>()
  const skipIdx = new Set<number>()

  for (const g of groups.values()) {
    if (g.idxs.length === 0) continue
    const baseIdx = g.idxs[0]!
    const base: any = details[baseIdx]
    if (!base || typeof base !== 'object') continue

    const baseTitle = normalizePromptText(base.title) || String(base.title || '').trim() || String(base.table || '').trim()
    const clones: CalcSuggestDetail[] = []
    for (let j = 0; j < g.len; j++) {
      const label = segLabel(j)
      clones.push({ ...(base as CalcSuggestDetail), title: `${baseTitle}(${label})`, pick: j })
    }

    expandAt.set(baseIdx, clones)
    for (let k = 1; k < g.idxs.length; k++) skipIdx.add(g.idxs[k]!)
  }

  const out: CalcSuggestDetail[] = []
  for (let i = 0; i < details.length; i++) {
    if (skipIdx.has(i)) continue
    const expanded = expandAt.get(i)
    if (expanded) out.push(...expanded)
    else out.push(details[i]!)
  }

  // Keep plan stable (renderer and downstream matching assume a small, curated list).
  while (out.length > 20) out.pop()

  details.length = 0
  details.push(...out)
}

