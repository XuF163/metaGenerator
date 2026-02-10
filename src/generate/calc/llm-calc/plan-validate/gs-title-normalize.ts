import type { CalcSuggestDetail } from '../types.js'

/**
 * GS: normalize some common titles towards baseline conventions to improve
 * panel-regression matching while keeping generation generic.
 */
export function normalizeGsDetailTitlesTowardsBaseline(details: CalcSuggestDetail[]): void {
  if (!Array.isArray(details) || details.length === 0) return

  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (typeof d.title !== 'string') continue
    let t = d.title.trim()
    if (!t) continue

    // Baseline commonly uses "首段/二段/三段..." for normal attack hit segments.
    // Only rewrite the "普攻一段" form when it's either the root title or under a "…状态·" prefix,
    // so we don't accidentally change contexts like "Q后普攻一段" (baseline tends to keep "一段" there).
    t = t.replace(/(^|状态·)普攻一段(?=[(（\\s]|伤害|$)/g, '$1普攻首段')

    d.title = t
  }
}

