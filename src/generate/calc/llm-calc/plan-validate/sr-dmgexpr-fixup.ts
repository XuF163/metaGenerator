import type { CalcSuggestDetail } from '../types.js'
import { normalizePromptText } from '../utils.js'

/**
 * SR: fix common LLM misread for "倍率提高" tables.
 *
 * In many SR kits, tables like "伤害倍率提高" are *additive deltas* to a base talent multiplier:
 *   slowed-ult: dmg(技能伤害 + 伤害倍率提高, "q")
 *
 * Weak models frequently treat it as a percent increase:
 *   dmg(技能伤害 * (1 + 伤害倍率提高), "q")
 *
 * This causes large deviations (often 2x~5x) because base multipliers are already > 1.
 *
 * We conservatively rewrite the specific pattern:
 *   dmg(talent.X["base"] * (1 + toRatio(talent.Y["...倍率提高..."])), ...)
 * to:
 *   dmg(talent.X["base"] + talent.Y["...倍率提高..."], ...)
 */
export function rewriteSrDeltaMultiplierIncreaseExprs(details: CalcSuggestDetail[]): void {
  if (!Array.isArray(details) || details.length === 0) return

  const deltaTableRe = /(伤害)?倍率(提高|提升|增加)/

  for (const d of details) {
    const expr0 = typeof (d as any)?.dmgExpr === 'string' ? String((d as any).dmgExpr).trim() : ''
    if (!expr0) continue
    // Cheap prefilter.
    if (!/\bdmg\s*\(/.test(expr0) || !/\*\s*\(\s*1\s*\+/.test(expr0) || !/\btalent\s*\./.test(expr0)) continue

    let changed = false
    let out = expr0

    // Pattern A: LLM multiplies calcRet.dmg/avg by (1+delta) instead of adding the delta multiplier.
    out = out.replace(
      /(?:\(\s*)?\{\s*dmg:\s*dmg\(\s*talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*,\s*([^)]+?)\)\s*\.\s*dmg\s*\*\s*\(\s*1\s*\+\s*(?:toRatio\s*\(\s*)?talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\6\s*\]\s*(?:\)\s*)?\s*\)\s*,\s*avg:\s*dmg\(\s*talent\s*\.\s*\1\s*\[\s*\2\3\2\s*\]\s*,\s*\4\)\s*\.\s*avg\s*\*\s*\(\s*1\s*\+\s*(?:toRatio\s*\(\s*)?talent\s*\.\s*\5\s*\[\s*\6\7\6\s*\]\s*(?:\)\s*)?\s*\)\s*\}\s*(?:\))?/g,
      (full, baseTk, q1, baseTable, args, deltaTk, q2, deltaTable) => {
        const tn = normalizePromptText(deltaTable)
        if (!tn || !deltaTableRe.test(tn)) return full
        changed = true
        return `dmg(talent.${baseTk}[${q1}${baseTable}${q1}] + talent.${deltaTk}[${q2}${deltaTable}${q2}], ${args})`
      }
    )

    // Pattern B: LLM multiplies the multiplier table itself: dmg(base * (1+delta), key)
    out = out.replace(
      /\bdmg\s*\(\s*(?:\(\s*)?talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*(?:\s*\)\s*)?\s*\*\s*\(\s*1\s*\+\s*(?:toRatio\s*\(\s*)?talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\5\s*\]\s*(?:\)\s*)?\s*\)\s*,/g,
      (full, baseTk, q1, baseTable, deltaTk, q2, deltaTable) => {
        const tn = normalizePromptText(deltaTable)
        if (!tn || !deltaTableRe.test(tn)) return full
        changed = true
        return `dmg(talent.${baseTk}[${q1}${baseTable}${q1}] + talent.${deltaTk}[${q2}${deltaTable}${q2}],`
      }
    )

    // Pattern C: SR talent multipliers are already ratios (e.g. 0.8 means 80%).
    // Some models mistakenly convert them as percentages and multiply by 100, causing 100x errors.
    out = out.replace(
      /\(\s*talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*\|\|\s*0\s*\)\s*\*\s*100\b/g,
      (_full, tk, q, table) => {
        changed = true
        return `(talent.${tk}[${q}${table}${q}] || 0)`
      }
    )
    out = out.replace(
      /\(\s*toRatio\s*\(\s*talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*\)\s*\|\|\s*0\s*\)\s*\*\s*100\b/g,
      (_full, tk, q, table) => {
        changed = true
        return `(toRatio(talent.${tk}[${q}${table}${q}]) || 0)`
      }
    )
    out = out.replace(
      /\btoRatio\s*\(\s*talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*\)\s*\*\s*100\b/g,
      (_full, tk, q, table) => {
        changed = true
        return `toRatio(talent.${tk}[${q}${table}${q}])`
      }
    )
    out = out.replace(
      /\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*\*\s*100\b/g,
      (_full, tk, q, table) => {
        changed = true
        return `talent.${tk}[${q}${table}${q}]`
      }
    )
    if (changed) (d as any).dmgExpr = out
  }
}
