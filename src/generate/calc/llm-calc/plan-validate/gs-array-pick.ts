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

function norm(sRaw: unknown): string {
  return String(sRaw || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')
}

function inferPickFromTitle(opts: {
  title: string
  len: number
  groupSize: number
  hasZeroVariant: boolean
  hasHighVariant: boolean
}): number | null {
  const { title, len, groupSize, hasZeroVariant, hasHighVariant } = opts
  if (len < 2) return null

  const t0 = normalizePromptText(title)
  if (!t0) return null
  const t = norm(t0)

  // Highly specific 2-variant pairs.
  if (/点按/.test(t)) return 0
  if (/长按/.test(t)) return Math.min(1, len - 1)
  if (/低空/.test(t)) return 0
  if (/高空/.test(t)) return Math.min(1, len - 1)

  // Explicit hit/segment indices (1-based): "首段/一段/二段/3段...".
  const segCn = t.match(/(首|一|二|三|四|五|六|七|八|九|十)段/)
  if (segCn) {
    const map: Record<string, number> = {
      首: 0,
      一: 0,
      二: 1,
      三: 2,
      四: 3,
      五: 4,
      六: 5,
      七: 6,
      八: 7,
      九: 8,
      十: 9
    }
    const idx = map[segCn[1]!]
    if (typeof idx === 'number') return Math.max(0, Math.min(len - 1, idx))
  }
  const segNum = t.match(/(\d{1,2})段/)
  if (segNum) {
    const n = Math.trunc(Number(segNum[1]))
    if (Number.isFinite(n) && n >= 1 && n <= 20) return Math.max(0, Math.min(len - 1, n - 1))
  }

  // Explicit numeric layers (0-based). Common in tables like [0层,1层,2层...].
  const layerM = t.match(/(\d{1,2})层/)
  if (layerM) {
    const n = Math.trunc(Number(layerM[1]))
    if (Number.isFinite(n) && n >= 0 && n < len) return n
  }

  // Explicit bond-of-life / percent thresholds.
  if (/(0%|=0%|=0(?!\d)|第0层|零层)/.test(t)) return 0
  // "<100%" is a low-like threshold; handle it before matching plain "100%".
  if (/(<100%|<=100%|≤100%)/.test(t)) {
    if (len === 2) return 0
    return 1
  }
  if (/(>=100%|≥100%)/.test(t)) return len - 1
  if (/(^|[^<])(?:=)?100%/.test(t)) return len - 1

  // Explicit percent state (e.g. "25%/50%/...") -> map by proportion.
  const pctM = t.match(/(\d{1,3}(?:\.\d+)?)%/)
  if (pctM) {
    const pct = Number(pctM[1])
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      const idx = Math.round((pct / 100) * (len - 1))
      return Math.max(0, Math.min(len - 1, idx))
    }
  }

  const isLowLike =
    /(生命之契<100%|生命之契≤100%|低生命之契)/.test(t) || /低空/.test(t)
  const isHighLike =
    /(生命之契>=100%|生命之契≥100%|高生命之契)/.test(t) || /高空/.test(t) || /(满层|满辉|最高|最大)/.test(t)

  if (isHighLike) {
    // If the group shows a 0%/低/高 style triple, "高" is often NOT the max slot of a longer array.
    // Use index 2 conservatively unless the title is explicitly max-like.
    const explicitMax = /(满层|满辉|最高|最大)/.test(t)
    if (!explicitMax && hasZeroVariant && hasHighVariant && groupSize === 3 && len > 3) return Math.min(2, len - 1)
    return len - 1
  }
  if (isLowLike) {
    if (len === 2) return 0
    // Common 3-variant arrays: [0%, <100%, >=100%]. Low-like variants usually map to index 1.
    // (When only 2 variants are shown, index 0 is typically the unused "0%" slot.)
    return 1
  }

  return null
}

/**
 * GS: infer missing `detail.pick` for array tables that are *variant lists* but do not expose "/" in the table name.
 *
 * Motivation:
 * - Many Hakush tables are arrays like talent.e["驰猎伤害2"] = [v0, v1, v2] where each slot is a different state variant.
 * - LLM plans often emit multiple showcase rows ("低/高/0%/100%") but forget to fill `pick`, so renderer defaults to [0].
 * - That yields systematic underestimation and breaks baseline comparisons.
 *
 * Safety:
 * - Only applies when `input.tableSamples` confirms the table is a numeric array.
 * - Skips tables whose schema we can already infer (`statFlat/statStat/pctList/statTimes`), letting renderer handle them.
 * - Uses conservative, title-based heuristics (点按/长按/低空/高空/0%/100%/生命之契).
 */
export function applyGsArrayVariantPicksFromTitles(input: CalcSuggestInput, details: CalcSuggestDetail[]): void {
  if (input.game !== 'gs') return
  if (!Array.isArray(details) || details.length === 0) return

  type Group = { tk: TalentKey; table: string; len: number; idxs: number[] }
  const groups = new Map<string, Group>()

  for (let i = 0; i < details.length; i++) {
    const d: any = details[i]
    if (!d || typeof d !== 'object') continue
    const kind = normalizeKind(d.kind)
    if (kind !== 'dmg' && kind !== 'heal' && kind !== 'shield') continue
    const tk = typeof d.talent === 'string' ? (d.talent as TalentKey) : ''
    const table = typeof d.table === 'string' ? d.table.trim() : ''
    if (!tk || !table) continue
    if (typeof d.pick === 'number' && Number.isFinite(d.pick)) continue

    const sample = (input.tableSamples as any)?.[tk]?.[table]
    if (!isNumericArraySample(sample)) continue

    // Let the renderer handle known structured arrays.
    if (inferArrayTableSchema(input, tk, table)) continue

    const key = `${tk}\u0000${table}`
    const g = groups.get(key)
    if (g) g.idxs.push(i)
    else groups.set(key, { tk, table, len: sample.length, idxs: [i] })
  }

  for (const g of groups.values()) {
    if (g.idxs.length === 0) continue

    const titles = g.idxs.map((idx) => normalizePromptText((details[idx] as any)?.title))
    const hasZeroVariant = titles.some((t) => /(0%|=0%|=0(?!\d)|第0层|零层)/.test(norm(t)))
    const hasHighVariant = titles.some((t) =>
      /(?:^|[^<])(?:=)?100%|>=100%|≥100%|高生命之契|高空|长按|满层|满辉|最高|最大/.test(norm(t))
    )

    for (const idx of g.idxs) {
      const d: any = details[idx]
      if (!d || typeof d !== 'object') continue
      if (typeof d.pick === 'number' && Number.isFinite(d.pick)) continue

      const pick = inferPickFromTitle({
        title: String(d.title || ''),
        len: g.len,
        groupSize: g.idxs.length,
        hasZeroVariant,
        hasHighVariant
      })
      if (typeof pick === 'number' && Number.isFinite(pick) && pick >= 0 && pick < g.len) {
        d.pick = pick
      }
    }
  }
}
