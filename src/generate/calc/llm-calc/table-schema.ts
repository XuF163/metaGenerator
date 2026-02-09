import type { CalcScaleStat, CalcSuggestInput, TalentKey } from './types.js'
import { normalizePromptText } from './utils.js'

export type ArrayTableSchema =
  | { kind: 'statFlat'; stat: CalcScaleStat }
  | { kind: 'statStat'; stats: [CalcScaleStat, CalcScaleStat] }
  | { kind: 'pctList'; stat: CalcScaleStat }
  | { kind: 'statTimes'; stat: CalcScaleStat }
  | null

export function inferArrayTableSchema(input: CalcSuggestInput, talentKey: TalentKey, tableName: string): ArrayTableSchema {
  const textRaw = (input.tableTextSamples as any)?.[talentKey]?.[tableName]
  const text = normalizePromptText(textRaw)
  if (!text) return null

  const inferStatFromText = (s: string): CalcScaleStat | null => {
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(s)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(s)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(s)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(s)) return 'atk'
    return null
  }

  // e.g. "1.41%HP*5" / "80%ATK×3" stored as [pct, hitCount] in `<name>2`.
  // This is NOT "[pct, flat]"; it should be multiplied, not added.
  //
  // Note: Some tables omit the stat name entirely (e.g. "57.28%*2"). In that case we default to ATK,
  // since damage multipliers are ATK-based unless explicitly marked as HP/DEF/EM scaling.
  if (/[*×xX]\s*\d+/.test(text) && /[%％]/.test(text)) {
    const s0 = inferStatFromText(text) || 'atk'
    const sample = (input.tableSamples as any)?.[talentKey]?.[tableName]
    const times = Array.isArray(sample) && sample.length >= 2 && typeof sample[1] === 'number' ? Number(sample[1]) : NaN
    const timesOk = Number.isFinite(times) && Math.abs(times - Math.round(times)) < 1e-9 && times > 1 && times <= 20
    if (timesOk) return { kind: 'statTimes', stat: s0 }
  }

  const split = text
    .split(/[+＋]/)
    .map((s) => s.trim())
    .filter(Boolean)
  if (split.length < 2) return null

  const unitRaw =
    (input.tableUnits as any)?.[talentKey]?.[tableName] ??
    (input.tableUnits as any)?.[talentKey]?.[tableName.endsWith('2') ? tableName.slice(0, -1) : tableName]
  const unitStat = inferStatFromText(String(unitRaw || ''))

  // e.g. "32.42%+32.42%" where runtime returns [hit1Pct, hit2Pct, ...]
  // We treat this as multi-hit parts that can be summed into a single percentage multiplier.
  // If the stat is not explicitly mentioned, default to ATK (most damage tables).
  const hasPctAll = split.every((p) => /[%％]/.test(p))
  if (hasPctAll) {
    const stats = split.map((p) => inferStatFromText(p)).filter(Boolean) as CalcScaleStat[]
    const stat = stats[0] || 'atk'
    const allSame = stats.length === 0 || stats.every((s) => s === stat)
    if (allSame) {
      // Mixed-stat tables may omit the second stat label and store it in `unit` instead:
      // e.g. unit="防御力" value="149.28%攻击 + 186.6%".
      // Detect it and treat as "%ATK + %DEF" instead of a multi-hit "% + %" list.
      if (split.length === 2 && unitStat) {
        const s0 = inferStatFromText(split[0]!)
        const s1 = inferStatFromText(split[1]!)
        if (s0 && !s1 && unitStat !== s0) return { kind: 'statStat', stats: [s0, unitStat] }
        if (!s0 && s1 && unitStat !== s1) return { kind: 'statStat', stats: [unitStat, s1] }
      }
      return { kind: 'pctList', stat }
    }
  }

  const p0 = split[0]!
  const p1 = split[1]!
  const s0 = inferStatFromText(p0)
  const s1 = inferStatFromText(p1)
  const hasPct0 = /[%％]/.test(p0)
  const hasPct1 = /[%％]/.test(p1)
  const hasNum1 = /\d/.test(p1)

  // e.g. "%攻击 + %精通"
  if (s0 && s1 && hasPct0 && hasPct1) {
    return { kind: 'statStat', stats: [s0, s1] }
  }
  // e.g. "%生命值上限 + 800"
  if (s0 && hasPct0 && !s1 && hasNum1 && !hasPct1) {
    return { kind: 'statFlat', stat: s0 }
  }
  return null
}

