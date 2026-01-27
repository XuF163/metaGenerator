/**
 * Shared helpers for Hakush-based generators.
 */

/**
 * Round to N decimals, keeping a JS number (not a string).
 */
export function roundTo(value: number, decimals: number): number {
  const pow = 10 ** decimals
  return Math.round(value * pow) / pow
}

/**
 * Remove keys whose values are not finite numbers, and round the remaining values.
 */
export function cleanNumberRecord(
  record: Record<string, number | undefined | null>,
  decimals: number
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[k] = roundTo(v, decimals)
  }
  return out
}

/**
 * Sort object keys as numeric when possible, otherwise lexicographic.
 */
export function sortRecordByKey<T>(record: Record<string, T>): Record<string, T> {
  const entries = Object.entries(record)
  entries.sort((a, b) => {
    const an = Number(a[0])
    const bn = Number(b[0])
    if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn
    return a[0].localeCompare(b[0], 'zh-Hans-CN')
  })
  return Object.fromEntries(entries) as Record<string, T>
}

