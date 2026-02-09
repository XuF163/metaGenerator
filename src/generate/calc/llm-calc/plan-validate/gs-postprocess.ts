import type { CalcDetailKind, CalcScaleStat, CalcSuggestDetail, CalcSuggestInput, TalentKeyGs } from '../types.js'
import { normalizePromptText, normalizeTableList } from '../utils.js'
import { normalizeKind } from './normalize.js'
import { applyGsDerivedTotals } from './gs-totals.js'

export function applyGsPostprocess(opts: {
  input: CalcSuggestInput
  tables: Record<string, string[]>
  details: CalcSuggestDetail[]
  okReactions: Set<string>
  gsBuffIdsOut: Set<string>
}): void {
  const { input, tables, details, okReactions, gsBuffIdsOut } = opts

  // Auto-add missing heal/shield showcase rows when the LLM plan is too sparse.
  // Derived purely from official talent table names + unit texts (no baseline code reuse).
  const gsHasKindForTalent = (kind: CalcDetailKind, talent: TalentKeyGs): boolean =>
    details.some((d) => normalizeKind(d.kind) === kind && d.talent === talent)

  const gsHasDetail = (q: Partial<CalcSuggestDetail>): boolean =>
    details.some((d) => {
      if (q.kind && normalizeKind(d.kind) !== q.kind) return false
      if (q.talent && d.talent !== q.talent) return false
      if (q.table && d.table !== q.table) return false
      if (q.key && d.key !== q.key) return false
      if (q.ele && d.ele !== q.ele) return false
      return true
    })

  const gsUnitOf = (talent: TalentKeyGs, table: string): string => {
    const u =
      (input.tableUnits as any)?.[talent]?.[table] ??
      (input.tableUnits as any)?.[talent]?.[table.endsWith('2') ? table.slice(0, -1) : table] ??
      ''
    return normalizePromptText(u)
  }

  const gsInferStatFromUnit = (unitRaw: unknown, fallback: CalcScaleStat): CalcScaleStat => {
    const unit = normalizePromptText(unitRaw)
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命值上限|最大生命值|生命值|\bhp\b)/i.test(unit)) return 'hp'
    if (/(防御力|防御|\bdef\b)/i.test(unit)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(unit)) return 'atk'
    return fallback
  }

  const gsCleanHealShieldTitle = (table: string): string => {
    let t = String(table || '').trim()
    t = t.replace(/2$/, '')
    t = t.replace(/治疗量/g, '治疗').replace(/回复量/g, '回复')
    // Prefer baseline-like wording for shields.
    t = t.replace(/护盾吸收量/g, '护盾量').replace(/吸收量/g, '护盾量')
    return t
  }

  const gsPushDetail = (d: CalcSuggestDetail): void => {
    if (details.length >= 20) return
    if (!d.talent || !d.table) return
    const kind = normalizeKind(d.kind)
    if (!['dmg', 'heal', 'shield', 'reaction'].includes(kind)) return
    // De-dup by (kind,talent,table,ele). Avoid treating different `key` values as distinct rows.
    if (gsHasDetail({ kind, talent: d.talent as any, table: d.table, ele: d.ele })) return
    details.push(d)
  }

  const gsPickPrefer2 = (arr: string[]): string | undefined => {
    const list = normalizeTableList(arr)
    return list.find((t) => t.endsWith('2')) || list[0]
  }

  const addGsHealOrShield = (talent: TalentKeyGs, kind: 'heal' | 'shield'): void => {
    if (gsHasKindForTalent(kind, talent)) return
    const list = normalizeTableList((tables as any)[talent] || [])
    const re = kind === 'heal' ? /(治疗|回复)/ : /(护盾|吸收量|盾)/
    const candidates = list.filter((t) => re.test(t))
    if (!candidates.length) return

    // Prefer the structured "2" table which usually yields [pct, flat].
    const table = gsPickPrefer2(candidates)
    if (!table) return

    const stat = gsInferStatFromUnit(gsUnitOf(talent, table), kind === 'heal' ? 'hp' : 'def')
    const prefix = talent === 'a' ? 'A' : talent === 'e' ? 'E' : 'Q'
    const title = `${prefix}${gsCleanHealShieldTitle(table)}`
    gsPushDetail({ title, kind, talent, table, stat, key: talent })
  }

  addGsHealOrShield('e', 'heal')
  addGsHealOrShield('q', 'heal')
  addGsHealOrShield('e', 'shield')
  addGsHealOrShield('q', 'shield')

  // Enrich overly-generic GS plans: include a few more high-signal dmg tables and common reaction variants.
  // This keeps output closer to baseline "detail level" even when LLM under-produces.
  const gsElemRaw = String(input.elem || '').trim()
  const gsElemLower = gsElemRaw.toLowerCase()
  const gsIsElem = (...keys: string[]): boolean => keys.includes(gsElemRaw) || keys.includes(gsElemLower)

  // 1) Core A variants: charged attack is frequently shown in baseline profiles.
  const aTables = normalizeTableList((tables as any).a || [])
  const chargedTable =
    aTables.find((t) => t === '重击伤害') ||
    aTables.find((t) => t === '重击伤害2') ||
    aTables.find((t) => /重击/.test(t) && /伤害/.test(t))
  if (chargedTable && details.length < 20) {
    // Prefer key=a2 so buffs gated by currentTalent can distinguish it.
    if (!gsHasDetail({ kind: 'dmg', talent: 'a', table: chargedTable, key: 'a2' })) {
      gsPushDetail({ title: '重击伤害', kind: 'dmg', talent: 'a', table: chargedTable, key: 'a2' })
    }
  }

  // 2) Add a small number of extra E/Q damage tables when available.
  const gsIsDamageTableName = (t: string): boolean => {
    if (!t) return false
    if (!/伤害/.test(t)) return false
    if (/(冷却|持续时间|消耗|能量|回复|恢复|治疗|护盾|吸收量)/.test(t)) return false
    return true
  }
  const gsScoreDamageTableName = (t: string): number => {
    let s = 0
    if (/总/.test(t)) s += 60
    if (/(爆裂|爆发)/.test(t)) s += 55
    if (/召唤/.test(t)) s += 45
    if (/(协同|共鸣|连携|联动|追击|反击)/.test(t)) s += 40
    if (/持续/.test(t)) s += 35
    if (/每跳/.test(t)) s += 30
    if (/释放/.test(t)) s += 25
    if (/(单次|单段)/.test(t)) s += 18
    if (/(一段|二段|三段|四段|五段|六段|七段|八段|九段|十段)/.test(t)) s += 10
    if (t.length >= 6) s += 5
    return s
  }
  const gsAddExtraDmgTables = (talent: TalentKeyGs, maxAdd: number): void => {
    if (details.length >= 20) return
    const list = normalizeTableList((tables as any)[talent] || [])
    const candidates = list.filter(gsIsDamageTableName)
    candidates.sort((a, b) => gsScoreDamageTableName(b) - gsScoreDamageTableName(a))
    let added = 0
    for (const table of candidates) {
      if (details.length >= 20) break
      if (added >= maxAdd) break
      if (gsHasDetail({ kind: 'dmg', talent, table })) continue
      const prefix = talent === 'e' ? 'E' : talent === 'q' ? 'Q' : ''
      const title = prefix ? `${prefix}${table}` : table
      gsPushDetail({ title, kind: 'dmg', talent, table, key: talent })
      added++
    }
  }
  gsAddExtraDmgTables('e', 2)
  gsAddExtraDmgTables('q', 2)

  // 3) Elemental reaction variants (amp / catalyze) for key hits.
  const gsEleVariant:
    | { id: 'vaporize' | 'melt' | 'aggravate' | 'spread'; suffix: string; maxE: number; maxQ: number }
    | null =
    gsIsElem('火', 'pyro') || gsIsElem('水', 'hydro')
      ? { id: 'vaporize', suffix: '蒸发', maxE: 2, maxQ: 1 }
      : gsIsElem('冰', 'cryo')
        ? { id: 'melt', suffix: '融化', maxE: 2, maxQ: 1 }
        : gsIsElem('雷', 'electro')
          ? { id: 'aggravate', suffix: '超激化', maxE: 2, maxQ: 2 }
          : gsIsElem('草', 'dendro')
            ? { id: 'spread', suffix: '激化', maxE: 2, maxQ: 2 }
            : null

  const gsMakeEleTitle = (titleRaw: string, suffix: string): string => {
    const title = String(titleRaw || '').trim()
    if (!title) return title
    if (title.includes(suffix)) return title
    if (/伤害$/.test(title)) return title.replace(/伤害$/, suffix)
    return `${title}${suffix}`
  }

  const gsIsEleVariantBase = (d: CalcSuggestDetail): boolean => {
    if (!d || typeof d !== 'object') return false
    if (normalizeKind(d.kind) !== 'dmg') return false
    if (!d.talent || !d.table) return false
    if (typeof d.dmgExpr === 'string' && d.dmgExpr.trim()) return false
    const ele = typeof d.ele === 'string' ? d.ele.trim() : ''
    // Physical rows don't participate in reactions.
    if (ele === 'phy') return false
    // Only derive when base row has no ele.
    if (ele) return false
    return true
  }

  const gsTryAddEleVariant = (base: CalcSuggestDetail, variant: NonNullable<typeof gsEleVariant>): void => {
    if (!base.talent || !base.table) return
    const out: CalcSuggestDetail = {
      ...base,
      title: gsMakeEleTitle(base.title, variant.suffix),
      kind: 'dmg',
      ele: variant.id
    }
    if (gsHasDetail({ kind: 'dmg', talent: out.talent as any, table: out.table, ele: out.ele })) return
    if (details.length < 20) {
      gsPushDetail(out)
      gsBuffIdsOut.add(variant.id)
      return
    }

    // Keep reaction showcases even when the plan is already at the detail cap:
    // replace a low-signal NA segment row (baseline rarely keeps all NA segments).
    const findReplaceableIdx = (): number => {
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]
        if (!d || typeof d !== 'object') continue
        if (normalizeKind((d as any).kind) !== 'dmg') continue
        if ((d as any).talent !== 'a') continue
        const title = String((d as any).title || '')
        const table = String((d as any).table || '')
        const key = String((d as any).key || '')
        const s = `${title} ${table}`
        // Keep charged/plunge/aimed rows.
        if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
        // Prefer dropping segmented NA rows (一段/二段/...).
        if (/(一段|二段|三段|四段|五段|六段|七段|八段|九段|十段|段伤害)/.test(s)) {
          return i
        }
      }
      // Fallback: any plain NA dmg row.
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]
        if (!d || typeof d !== 'object') continue
        if (normalizeKind((d as any).kind) !== 'dmg') continue
        if ((d as any).talent !== 'a') continue
        const title = String((d as any).title || '')
        const table = String((d as any).table || '')
        const key = String((d as any).key || '')
        const s = `${title} ${table}`
        if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
        return i
      }
      return -1
    }

    const idx = findReplaceableIdx()
    if (idx >= 0) {
      details.splice(idx, 1, out)
      gsBuffIdsOut.add(variant.id)
    }
  }

  if (gsEleVariant) {
    const bases = details.filter(gsIsEleVariantBase)

    // Prefer charged attack for amp showcases (蒸发/融化).
    if (gsEleVariant.id === 'vaporize' || gsEleVariant.id === 'melt') {
      const a2 = bases.find((d) => d.talent === 'a' && (d.key === 'a2' || /重击/.test(d.title)))
      if (a2) gsTryAddEleVariant(a2, gsEleVariant)
    }

    let eAdded = 0
    for (const d of bases) {
      if (d.talent !== 'e') continue
      if (eAdded >= gsEleVariant.maxE) break
      gsTryAddEleVariant(d, gsEleVariant)
      eAdded++
    }

    let qAdded = 0
    for (const d of bases) {
      if (d.talent !== 'q') continue
      if (qAdded >= gsEleVariant.maxQ) break
      gsTryAddEleVariant(d, gsEleVariant)
      qAdded++
    }
  }

  // 4) Baseline-style multi-hit total rows (e.g. Q激化总伤-10段 / Q总伤害·超激化).
  // Derived from official table names + descriptions (no baseline code reuse).
  applyGsDerivedTotals({ input, tables, details, gsBuffIdsOut })

  const hasReaction = details.some((d) => normalizeKind(d.kind) === 'reaction')
  if (!hasReaction && details.length < 20) {
    const hintText = [
      ...(Array.isArray((input as any).buffHints) ? ((input as any).buffHints as unknown[]) : []),
      ...Object.values((input as any).talentDesc || {})
    ]
      .map((s) => String(s || ''))
      .join('\n')

    const hasEmOrReactionHint =
      /(元素精通|精通|mastery|\bem\b)/i.test(hintText) ||
      /(反应|绽放|超绽放|烈绽放|月绽放|扩散|结晶|燃烧|超载|感电|超导|碎冰)/.test(hintText)

    if (hasEmOrReactionHint) {
      const elemRaw = String(input.elem || '').trim()
      const elemLower = elemRaw.toLowerCase()
      const isElem = (...keys: string[]): boolean => keys.includes(elemRaw) || keys.includes(elemLower)
      const pick =
        isElem('风', 'anemo')
          ? 'swirl'
          : isElem('岩', 'geo')
            ? 'crystallize'
            : isElem('草', 'dendro')
              ? 'bloom'
              : isElem('水', 'hydro')
                ? 'bloom'
                : isElem('雷', 'electro')
                  ? 'hyperBloom'
                  : isElem('火', 'pyro')
                    ? 'burgeon'
                    : isElem('冰', 'cryo')
                      ? 'shatter'
                      : null
      if (pick && (!okReactions.size || okReactions.has(pick))) {
        const titleByReaction: Record<string, string> = {
          hyperBloom: '超绽放伤害',
          burgeon: '烈绽放伤害',
          bloom: '绽放伤害',
          swirl: '扩散反应伤害',
          crystallize: '结晶反应伤害',
          shatter: '碎冰反应伤害'
        }
        const title = titleByReaction[pick] || '反应伤害'
        details.push({ title, kind: 'reaction', reaction: pick })
      }
    }
  }
}
