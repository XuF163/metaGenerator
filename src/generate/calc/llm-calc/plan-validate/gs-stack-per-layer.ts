import type { CalcSuggestDetail, CalcSuggestInput, TalentKeyGs } from '../types.js'
import { jsString, normalizePromptText, normalizeTableList } from '../utils.js'
import { normalizeKind } from './normalize.js'

/**
 * GS: rewrite common "base + per-layer" damage rows into a single dmgExpr.
 *
 * Why:
 * - Official talent tables sometimes split stacking mechanics into:
 *   - "<X>基础伤害"
 *   - "每层...伤害"
 * - Models often emit a "(满层)" row with params.stacks but forget to add the per-layer term,
 *   causing large underestimation vs baseline (and vs actual game mechanics).
 *
 * Scope (conservative):
 * - Only applies when:
 *   - kind=dmg
 *   - no existing dmgExpr
 *   - table name contains "基础伤害"
 *   - the same talent block contains at least one "每层...伤害" table
 *   - detail.params contains a stack-like numeric field (key includes "stack"/"layer"/"层"/"叠")
 */
export function rewriteGsBasePlusPerLayerDetails(opts: {
  input: CalcSuggestInput
  tables: Record<string, string[]>
  details: CalcSuggestDetail[]
}): void {
  const { input, tables, details } = opts
  if (input.game !== 'gs') return
  if (!Array.isArray(details) || details.length === 0) return

  const perLayerByTalent: Partial<Record<TalentKeyGs, string[]>> = {}
  for (const tk of ['a', 'e', 'q'] as TalentKeyGs[]) {
    const list = normalizeTableList((tables as any)?.[tk] || [])
    perLayerByTalent[tk] = list.filter((t) => {
      const tn = normalizePromptText(t)
      return /(每层|每叠)/.test(tn) && /伤害/.test(tn)
    })
  }

  const pickStackKey = (params: Record<string, unknown>): string | null => {
    const keys = Object.keys(params || {})
    const rank = (k: string): number => {
      const kn = String(k || '').trim()
      if (!kn) return 999
      if (/^stacks?$/i.test(kn)) return 0
      if (/^layers?$/i.test(kn)) return 1
      if (/stack/i.test(kn)) return 2
      if (/layer/i.test(kn)) return 3
      if (/[层叠]/.test(kn)) return 4
      return 999
    }
    keys.sort((a, b) => rank(a) - rank(b))
    for (const k of keys) {
      const kn = String(k || '').trim()
      if (!kn) continue
      if (/stack/i.test(kn) || /layer/i.test(kn) || /[层叠]/.test(kn)) return kn
    }
    return null
  }

  for (const d of details as any[]) {
    if (!d || typeof d !== 'object') continue
    if (normalizeKind(d.kind) !== 'dmg') continue
    if (typeof d.dmgExpr === 'string' && d.dmgExpr.trim()) continue

    const tkRaw = typeof d.talent === 'string' ? String(d.talent).trim() : ''
    if (tkRaw !== 'a' && tkRaw !== 'e' && tkRaw !== 'q') continue
    const tk = tkRaw as TalentKeyGs

    const table = typeof d.table === 'string' ? String(d.table).trim() : ''
    if (!table) continue
    if (!/基础伤害/.test(normalizePromptText(table))) continue

    const params0 = d.params
    if (!params0 || typeof params0 !== 'object' || Array.isArray(params0)) continue
    const stackKey = pickStackKey(params0 as Record<string, unknown>)
    if (!stackKey) continue

    const perTables = perLayerByTalent[tk] || []
    if (perTables.length === 0) continue
    // Conservative: pick the first per-layer table (usually only one exists in the same block).
    const perTable = perTables[0]!

    const key = typeof d.key === 'string' && d.key.trim() ? String(d.key).trim() : tk
    const ele = typeof d.ele === 'string' && d.ele.trim() ? String(d.ele).trim() : ''
    const eleArg = ele ? `, ${jsString(ele)}` : ''

    const baseAcc = `talent.${tk}[${jsString(table)}]`
    const perAcc = `talent.${tk}[${jsString(perTable)}]`
    const stacks = `Number(params[${jsString(stackKey)}]) || 0`
    d.dmgExpr = `dmg((Number(${baseAcc})||0) + (Number(${perAcc})||0) * (${stacks}), ${jsString(key)}${eleArg})`
  }
}
