import type { CalcDetailKind, CalcScaleStat, CalcSuggestDetail, CalcSuggestInput, TalentKeyGs } from '../types.js'
import { normalizePromptText, normalizeTableList } from '../utils.js'
import { inferArrayTableSchema } from '../table-schema.js'
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

  const gsTryInferStatFromUnit = (unitRaw: unknown): CalcScaleStat | null => {
    const unit = normalizePromptText(unitRaw)
    if (!unit) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命值上限|最大生命值|生命值|\bhp\b)/i.test(unit)) return 'hp'
    if (/(防御力|防御|\bdef\b)/i.test(unit)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(unit)) return 'atk'
    return null
  }

  const gsCleanHealShieldTitle = (table: string): string => {
    let t = String(table || '').trim()
    t = t.replace(/2$/, '')
    t = t.replace(/治疗量/g, '治疗').replace(/回复量/g, '回复')
    // Prefer baseline-like wording for shields.
    t = t.replace(/护盾吸收量/g, '护盾量').replace(/吸收量/g, '护盾量')
    return t
  }

  // When the plan hits the 20-row cap, prefer dropping segmented NA rows (baseline rarely keeps all of them)
  // so we can keep more baseline-like E/Q/heal/shield showcases.
  const gsFindReplaceableNaIdx = (): number => {
    const hasStateParams = (d: any): boolean => {
      const p = d?.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) return false
      // Protect stateful showcase rows (e.g. 开Q/开E/半血...) from being overwritten by later aliases.
      return (
        Object.prototype.hasOwnProperty.call(p, 'e') ||
        Object.prototype.hasOwnProperty.call(p, 'q') ||
        Object.prototype.hasOwnProperty.call(p, 'halfHp')
      )
    }
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i] as any
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      if (d.talent !== 'a') continue
      if (hasStateParams(d)) continue
      const title = String(d.title || '')
      const table = String(d.table || '')
      const key = String(d.key || '')
      const s = `${title} ${table}`
      // Keep charged/plunge/aimed rows.
      if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
      // Prefer dropping segmented NA rows (首段/一段/二段/...).
      if (/(首段|一段|二段|三段|四段|五段|六段|七段|八段|九段|十段|段伤害)/.test(s)) return i
    }
    // Fallback: any plain NA dmg row.
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i] as any
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      if (d.talent !== 'a') continue
      if (hasStateParams(d)) continue
      const title = String(d.title || '')
      const table = String(d.table || '')
      const key = String(d.key || '')
      const s = `${title} ${table}`
      if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
      return i
    }
    // Final fallback: charged/plunge/aimed rows are often low-signal in baseline detail sets.
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i] as any
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      if (d.talent !== 'a') continue
      if (hasStateParams(d)) continue
      const title = String(d.title || '')
      const table = String(d.table || '')
      const key = String(d.key || '')
      const s = `${title} ${table}`
      if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) return i
    }
    return -1
  }

  const gsPushDetail = (d: CalcSuggestDetail): void => {
    if (!d.talent || !d.table) return
    const kind = normalizeKind(d.kind)
    if (!['dmg', 'heal', 'shield', 'reaction'].includes(kind)) return
    // De-dup by (kind,talent,table,ele). Avoid treating different `key` values as distinct rows.
    if (gsHasDetail({ kind, talent: d.talent as any, table: d.table, ele: d.ele })) return
    if (details.length < 20) {
      details.push(d)
      return
    }
    const idx = gsFindReplaceableNaIdx()
    if (idx >= 0) details.splice(idx, 1, d)
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

    const prefix = talent === 'a' ? 'A' : talent === 'e' ? 'E' : 'Q'
    const title = `${prefix}${gsCleanHealShieldTitle(table)}`
    const unitStat = gsTryInferStatFromUnit(gsUnitOf(talent, table))
    const d: CalcSuggestDetail = { title, kind, talent, table, key: talent }
    if (unitStat) d.stat = unitStat
    gsPushDetail(d)
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
  const gsWeapon = String(input.weapon || '').trim().toLowerCase()
  const gsIsBow = gsWeapon === 'bow'

  const gsScoreA2Table = (tRaw: string): number => {
    const t = normalizePromptText(tRaw)
    if (!t) return -1
    if (!/伤害/.test(t)) return -1
    if (/(冷却时间|持续时间|体力消耗|元素能量|能量恢复|积攒|治疗|护盾|吸收量|上限|能量值)/.test(t)) return -1
    if (/(下坠|坠地|低空|高空)/.test(t)) return -1

    let s = 0
    if (/重击/.test(t)) s += 90
    if (/(瞄准|蓄力)/.test(t)) s += 85
    if (/满/.test(t) && /(瞄准|蓄力)/.test(t)) s += 20
    if (gsIsBow && /(箭|矢)/.test(t)) s += 25

    if (/(次级|追加|额外|附加|协同|追击|连携|后续)/.test(t)) s -= 20
    // Avoid treating plain NA segments as charged/aimed shots.
    if (/(首段|一段|二段|三段|四段|五段|六段|七段|八段|九段|十段|段伤害)/.test(t)) s -= 60
    if (/2$/.test(t)) s -= 1
    return s
  }

  const chargedTable =
    aTables.find((t) => t === '重击伤害') ||
    aTables.find((t) => t === '重击伤害2') ||
    aTables.find((t) => /重击/.test(t) && /伤害/.test(t)) ||
    aTables
      .map((t) => ({ t, s: gsScoreA2Table(t) }))
      .filter((x) => x.s >= 20)
      .sort((a, b) => b.s - a.s || a.t.length - b.t.length)[0]?.t ||
    ''

  if (chargedTable) {
    const title = chargedTable.endsWith('2') ? chargedTable.slice(0, -1) : chargedTable
    gsPushDetail({ title, kind: 'dmg', talent: 'a', table: chargedTable, key: 'a2' })

    // Charged attacks commonly have a distinct "finisher" hit table (e.g. "重击终结伤害").
    // Include it as an extra core A2 showcase when available.
    const chargedFinisherTable =
      aTables.find((t) => t === '重击终结伤害') ||
      aTables.find((t) => t === '重击终结伤害2') ||
      aTables.find((t) => /重击/.test(t) && /(终结|尾刀|最后)/.test(t) && /伤害/.test(t)) ||
      aTables.find((t) => /(终结|尾刀|最后)/.test(t) && /伤害/.test(t)) ||
      ''
    if (chargedFinisherTable && chargedFinisherTable !== chargedTable) {
      const finTitle = chargedFinisherTable.endsWith('2') ? chargedFinisherTable.slice(0, -1) : chargedFinisherTable
      gsPushDetail({ title: finTitle, kind: 'dmg', talent: 'a', table: chargedFinisherTable, key: 'a2' })
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
    const scoreExtra = (table: string): number => {
      let s = gsScoreDamageTableName(table)
      // Prefer per-hit / multi-hit schema tables (e.g. "24%*8" -> `[pct, hits]`), since baseline
      // often uses them for "单段" showcases and builds totals from them.
      const schema = inferArrayTableSchema(input, talent, table)
      if (schema?.kind === 'statTimes') s += 80
      if (String(table || '').trim().endsWith('2')) s += 10
      return s
    }
    candidates.sort((a, b) => scoreExtra(b) - scoreExtra(a))
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

  const gsHasTalentKind = (kind: CalcDetailKind, talent: TalentKeyGs): boolean =>
    details.some((d) => normalizeKind(d.kind) === kind && d.talent === talent)

  // Push an "alias" row that may intentionally duplicate (kind,talent,table,ele) to improve
  // baseline matching (panel-regression compares by titles first). De-dup only by normalized title.
  const gsPushAliasByTitle = (d: CalcSuggestDetail): void => {
    if (!d || typeof d !== 'object') return
    if (!d.talent || !d.table) return
    const kind = normalizeKind(d.kind)
    if (!['dmg', 'heal', 'shield', 'reaction'].includes(kind)) return

    const title = normalizePromptText(d.title)
    if (!title) return
    const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
    const hasSameTitle = details.some((x: any) => {
      if (!x || typeof x !== 'object') return false
      if (normalizeKind(x.kind) !== kind) return false
      if (x.talent !== d.talent) return false
      const t = normalizePromptText(String(x.title || ''))
      if (!t || t !== title) return false
      const xe = typeof x.ele === 'string' ? String(x.ele).trim() : ''
      return xe === ele
    })
    if (hasSameTitle) return

    if (details.length < 20) {
      details.push(d)
      return
    }
    const idx = gsFindReplaceableNaIdx()
    if (idx >= 0) details.splice(idx, 1, d)
  }

  // Ensure at least one E/Q damage row exists; otherwise reaction/totals derivation becomes ineffective and
  // regressions drift (baseline often showcases E/Q, not every NA segment).
  const gsEnsureCoreDmg = (talent: 'e' | 'q'): void => {
    if (gsHasTalentKind('dmg', talent)) return
    const list = normalizeTableList((tables as any)[talent] || [])
    const candidates = list.filter(gsIsDamageTableName)
    candidates.sort((a, b) => gsScoreDamageTableName(b) - gsScoreDamageTableName(a))
    const table = candidates[0]
    if (!table) return
    if (gsHasDetail({ kind: 'dmg', talent, table })) return

    const prefix = talent === 'e' ? 'E' : 'Q'
    const out: CalcSuggestDetail = { title: `${prefix}${table}`, kind: 'dmg', talent, table, key: talent }
    if (talent === 'q') (out as any).params = { q: true }

    if (details.length < 20) {
      gsPushDetail(out)
      return
    }
    const idx = gsFindReplaceableNaIdx()
    if (idx >= 0) details.splice(idx, 1, out)
  }

  gsEnsureCoreDmg('e')
  gsEnsureCoreDmg('q')

  // Ensure baseline-like generic core titles also exist (in addition to table-specific titles),
  // e.g. baseline may use "E伤害"/"Q伤害" even when the underlying table name is specific.
  const gsEnsureCoreTitleAlias = (talent: 'e' | 'q'): void => {
    const marker = talent === 'e' ? 'E' : 'Q'
    const aliasTitle = `${marker}技能伤害`

    // Pick the strongest damage-like table (same heuristic as core dmg selection).
    const list = normalizeTableList((tables as any)[talent] || [])
    const candidates = list.filter(gsIsDamageTableName)
    candidates.sort((a, b) => gsScoreDamageTableName(b) - gsScoreDamageTableName(a))
    const table = candidates[0]
    if (!table) return

    // Prefer cloning an existing base row for the chosen table (preserve key/params).
    const base = details.find((d: any) => {
      if (!d || typeof d !== 'object') return false
      if (normalizeKind(d.kind) !== 'dmg') return false
      if (d.talent !== talent) return false
      if (String(d.table || '').trim() !== table) return false
      const ele = typeof d.ele === 'string' ? d.ele.trim() : ''
      return !ele
    }) as any

    const out: CalcSuggestDetail = base
      ? { ...(base as CalcSuggestDetail), title: aliasTitle }
      : ({ title: aliasTitle, kind: 'dmg', talent, table, key: talent } as any)

    if (talent === 'q') {
      const p0 = (out as any).params
      const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as any) } : {}
      if (!Object.prototype.hasOwnProperty.call(p, 'q')) p.q = true
      ;(out as any).params = p
    }

    gsPushAliasByTitle(out)
  }

  gsEnsureCoreTitleAlias('e')
  gsEnsureCoreTitleAlias('q')

  // 2b) GS state conventions (baseline-friendly):
  // - Keep `params.q===true` for Q rows (burst-state showcase), but do NOT auto-enable `params.e` for all E rows,
  //   since upstream/baseline may use `params.e` for kit-specific toggles (e.g. manual detonation, special modes).
  try {
    for (const d of details as any[]) {
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      const p0 = d.params
      const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as any) } : {}
      if (d.talent === 'q') {
        if (!Object.prototype.hasOwnProperty.call(p, 'q')) p.q = true
        d.params = p
      }
    }
  } catch {
    // best-effort
  }

  // 3) Elemental reaction variants (amp / catalyze) for key hits.
  const gsEleVariant:
    | { id: 'vaporize' | 'melt' | 'aggravate' | 'spread'; suffix: string; maxA: number; maxE: number; maxQ: number }
    | null =
    gsIsElem('火', 'pyro') || gsIsElem('水', 'hydro')
      ? { id: 'vaporize', suffix: '蒸发', maxA: 1, maxE: 2, maxQ: 1 }
      : gsIsElem('冰', 'cryo')
        ? { id: 'melt', suffix: '融化', maxA: 1, maxE: 2, maxQ: 1 }
        : gsIsElem('雷', 'electro')
          ? { id: 'aggravate', suffix: '超激化', maxA: 1, maxE: 2, maxQ: 2 }
          : gsIsElem('草', 'dendro')
            ? { id: 'spread', suffix: '激化', maxA: 1, maxE: 2, maxQ: 2 }
            : null

  const gsMakeEleTitle = (titleRaw: string, suffix: string): string => {
    const title = String(titleRaw || '').trim()
    if (!title) return title
    if (title.includes(suffix)) return title
    if (/伤害$/.test(title)) {
      // Baseline catalyze titles often keep the trailing "伤害": "激化伤害"/"超激化伤害".
      const needsDamage = /激化/.test(suffix)
      return title.replace(/伤害$/, needsDamage ? `${suffix}伤害` : suffix)
    }
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
    const idx = gsFindReplaceableNaIdx()
    if (idx >= 0) {
      details.splice(idx, 1, out)
      gsBuffIdsOut.add(variant.id)
    }
  }

  if (gsEleVariant) {
    const bases = details.filter(gsIsEleVariantBase)
    const scoreBase = (d: CalcSuggestDetail): number => {
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      const s = `${title} ${table}`
      let sc = 0
      // Prefer higher-stage rows when multiple stages exist (e.g. "肆阶/叄阶/贰阶/壹阶").
      if (/肆阶|四阶/.test(s)) sc += 60
      if (/叄阶|三阶/.test(s)) sc += 45
      if (/贰阶|二阶/.test(s)) sc += 30
      if (/壹阶|一阶/.test(s)) sc += 15
      if (/满层|最大|完全|完整/.test(s)) sc += 18
      if (/总伤|总计|合计|一轮/.test(s)) sc += 14
      if (/单次|单段/.test(s)) sc += 10
      // Prefer explicit table titles (more likely baseline-compatible).
      if (title.length >= 6) sc += 4
      if (table.length >= 6) sc += 4
      return sc
    }

    // Prefer charged attack for amp showcases (蒸发/融化).
    if (gsEleVariant.id === 'vaporize' || gsEleVariant.id === 'melt') {
      const a2 = bases.find((d) => d.talent === 'a' && (d.key === 'a2' || /重击/.test(d.title)))
      if (a2) gsTryAddEleVariant(a2, gsEleVariant)
    }

    const scoreA = (d: CalcSuggestDetail): number => {
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      const s = `${title} ${table}`
      let sc = scoreBase(d)
      if (d.key === 'a2' || /(重击|瞄准|蓄力)/.test(s)) sc += 60
      return sc
    }
    const aBases = bases
      .filter((d) => d.talent === 'a')
      .sort((a, b) => scoreA(b) - scoreA(a))
    for (const d of aBases.slice(0, gsEleVariant.maxA)) gsTryAddEleVariant(d, gsEleVariant)

    const eBases = bases
      .filter((d) => d.talent === 'e')
      .sort((a, b) => scoreBase(b) - scoreBase(a))
    for (const d of eBases.slice(0, gsEleVariant.maxE)) gsTryAddEleVariant(d, gsEleVariant)

    const qBases = bases
      .filter((d) => d.talent === 'q')
      .sort((a, b) => scoreBase(b) - scoreBase(a))
    for (const d of qBases.slice(0, gsEleVariant.maxQ)) gsTryAddEleVariant(d, gsEleVariant)
  }

  // 3b) Baseline-style state showcase aliases for NA/charged rows.
  // When kit descriptions indicate E/Q states affect normal/charged attacks, add a small number of
  // explicit param-enabled rows (e.g. "开Q重击", "重击蒸发(半血开E)") so upstream-derived buffs can apply.
  try {
    const descEState = normalizePromptText((input.talentDesc as any)?.e)
    const descQState = normalizePromptText((input.talentDesc as any)?.q)
    const descT = normalizePromptText((input.talentDesc as any)?.t)

    const hasParamKey = (k: string): boolean =>
      details.some((d: any) => {
        const p = d?.params
        return p && typeof p === 'object' && !Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, k)
      })

    const hasHalfHp = hasParamKey('halfHp') || /低于\s*50%|生命值.{0,8}50%/.test(`${descEState} ${descQState} ${descT}`)

    const affectsA = (descRaw: string): boolean => {
      const desc = normalizePromptText(descRaw)
      if (!desc) return false
      const hasAttackWords = /(普通攻击|重击|下落攻击|攻击伤害)/.test(desc)
      if (!hasAttackWords) return false
      const hasConvertWords = /(转为|转化为|转换为|附魔|替换为|变为|进入.{0,16}状态)/.test(desc)
      if (hasConvertWords) return true
      // Also treat explicit "攻击力提高/提升" state texts as affecting attack showcases.
      if (/(攻击力).{0,12}(提高|提升|增加)/.test(desc) && /(持续|状态|期间)/.test(desc)) return true
      return false
    }

    const eAffectsA = affectsA(descEState)
    const qAffectsA = affectsA(descQState)

    const cloneWithParams = (
      base: CalcSuggestDetail,
      title: string,
      extra: Record<string, number | boolean | string>
    ): CalcSuggestDetail => {
      const p0 = (base as any).params
      const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as any) } : {}
      for (const [k, v] of Object.entries(extra)) (p as any)[k] = v
      return { ...(base as any), title, params: p }
    }

    // Stronger alias insertion for state rows:
    // - Prefer keeping the 20-row cap
    // - If we can't replace a NA segment row, replace an obvious duplicate row (same kind+talent+table+ele)
    //   so critical state showcases (开Q/开E/半血...) don't get dropped for kits without NA segments.
    const pushAliasStrong = (d: CalcSuggestDetail): void => {
      if (!d || typeof d !== 'object') return
      if (!d.talent || !d.table) return
      const kind = normalizeKind(d.kind)
      if (!['dmg', 'heal', 'shield', 'reaction'].includes(kind)) return
      const title = normalizePromptText(d.title)
      if (!title) return
      const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''

      const hasSameTitle = details.some((x: any) => {
        if (!x || typeof x !== 'object') return false
        if (normalizeKind(x.kind) !== kind) return false
        if (x.talent !== d.talent) return false
        const t = normalizePromptText(String(x.title || ''))
        if (!t || t !== title) return false
        const xe = typeof x.ele === 'string' ? String(x.ele).trim() : ''
        return xe === ele
      })
      if (hasSameTitle) return

      if (details.length < 20) {
        details.push(d)
        return
      }

      const idxNa = gsFindReplaceableNaIdx()
      if (idxNa >= 0) {
        details.splice(idxNa, 1, d)
        return
      }

      const sigOf = (x: any): string => {
        const k = normalizeKind(x?.kind)
        const tk = String(x?.talent || '').trim()
        const tb = normalizePromptText(x?.table)
        const e0 = typeof x?.ele === 'string' ? String(x.ele).trim() : ''
        return `${k}|${tk}|${tb}|${e0}`
      }

      const groups = new Map<string, number[]>()
      for (let i = 0; i < details.length; i++) {
        const cur: any = details[i]
        if (!cur || typeof cur !== 'object') continue
        const sig = sigOf(cur)
        if (!sig) continue
        const list = groups.get(sig) || []
        list.push(i)
        groups.set(sig, list)
      }

      let bestIdx = -1
      let bestScore = Number.POSITIVE_INFINITY
      for (const idxs of groups.values()) {
        if (idxs.length <= 1) continue
        for (const i of idxs) {
          const cur: any = details[i]
          if (!cur || typeof cur !== 'object') continue
          const t = normalizePromptText(cur.title).replace(/\s+/g, '')
          const hasParams = cur.params && typeof cur.params === 'object' && !Array.isArray(cur.params) && Object.keys(cur.params).length > 0
          const k = normalizeKind(cur.kind)
          const score = t.length + (hasParams ? 100 : 0) + (k === 'shield' ? 1000 : 0) + (k === 'reaction' ? 200 : 0)
          if (score < bestScore) {
            bestScore = score
            bestIdx = i
          }
        }
      }
      if (bestIdx >= 0) {
        details.splice(bestIdx, 1, d)
      }
    }

    const pickCharged = (opts?: { ele?: string; tableRe?: RegExp }): CalcSuggestDetail | null => {
      const ele = typeof opts?.ele === 'string' ? opts.ele.trim() : ''
      const re = opts?.tableRe
      const cands = details.filter((d) => {
        if (!d || typeof d !== 'object') return false
        if (normalizeKind(d.kind) !== 'dmg') return false
        if (d.talent !== 'a') return false
        const key = typeof (d as any).key === 'string' ? String((d as any).key).trim() : ''
        const s = `${normalizePromptText(d.title)} ${normalizePromptText(d.table)}`
        const isCharged = key === 'a2' || /(重击|瞄准|蓄力)/.test(s)
        if (!isCharged) return false
        const e0 = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
        if (ele && e0 !== ele) return false
        if (!ele && e0) return false
        if (re) {
          if (!re.test(s)) return false
        }
        return true
      })
      return cands[0] || null
    }

    // Q-state charged attack aliases (Noelle-like kits): "开Q重击" + "开Q尾刀".
    if (qAffectsA) {
      const loop = pickCharged({ tableRe: /循环|每段/ })
      const fin = pickCharged({ tableRe: /终结|尾刀|最后/ })
      if (loop) pushAliasStrong(cloneWithParams(loop, '开Q重击', { q: true }))
      if (fin) pushAliasStrong(cloneWithParams(fin, '开Q尾刀', { q: true }))
    }

    // Q-state stat/dmg buffs can affect other talents (e.g. Itto burst ATK bonus affecting E skill).
    // Add a minimal, explicit showcase row for E damage under Q state so `params.q`-gated upstream buffs are not dead.
    const qAffectsOther = (descRaw: string): boolean => {
      const desc = normalizePromptText(descRaw)
      if (!desc) return false
      // Common patterns: "...进入XX状态...提高攻击力/造成的伤害提高..."
      if (/(攻击力).{0,12}(提高|提升|增加)/.test(desc) && /(状态|期间|持续|特性)/.test(desc)) return true
      if (/(伤害).{0,12}(提高|提升|增加)/.test(desc) && /(状态|期间|持续|特性)/.test(desc)) return true
      return false
    }
    if (qAffectsOther(descQState)) {
      const eBase = details.find((d) => {
        if (!d || typeof d !== 'object') return false
        if (normalizeKind(d.kind) !== 'dmg') return false
        if (d.talent !== 'e') return false
        const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
        if (ele) return false
        const table = normalizePromptText(d.table)
        if (!table || !/伤害/.test(table)) return false
        if (/(治疗|护盾|吸收量|持续时间|冷却)/.test(table)) return false
        return true
      })
      if (eBase) {
        const title = `开Q后${normalizePromptText(eBase.title)}`
        pushAliasStrong(cloneWithParams(eBase, title, { q: true }))
      }
    }

    // E-state charged attack + amp variants (Hu Tao-like kits): add "(半血开E)" rows when supported.
    if (eAffectsA) {
      const stateLabel = hasHalfHp ? '半血开E' : '开E'
      const stateParams: Record<string, number | boolean | string> = { e: true, ...(hasHalfHp ? { halfHp: true } : {}) }
      const chargedBase: CalcSuggestDetail | null = (() => {
        const hit = pickCharged()
        if (hit) return hit
        // Fallback: synthesize from the selected charged table (core A2 row might not exist yet at this stage).
        if (!chargedTable) return null
        const title = chargedTable.endsWith('2') ? chargedTable.slice(0, -1) : chargedTable
        return { title, kind: 'dmg', talent: 'a', table: chargedTable, key: 'a2' }
      })()
      if (chargedBase) {
        pushAliasStrong(cloneWithParams(chargedBase, `${chargedBase.title}(${stateLabel})`, stateParams))
      }

      // Charged amp showcase: vaporize/melt variants should also carry the same state params.
      // If the base amp row was not derived due to the 20-row cap, synthesize it directly from the charged base row.
      const ensureChargedAmp = (id: 'vaporize' | 'melt'): void => {
        const existing = pickCharged({ ele: id })
        if (existing) {
          pushAliasStrong(cloneWithParams(existing, `${existing.title}(${stateLabel})`, stateParams))
          return
        }
        if (!chargedBase) return
        if (!gsEleVariant || gsEleVariant.id !== id) return
        const ampTitle = gsMakeEleTitle(chargedBase.title, gsEleVariant.suffix)
        const ampRow: CalcSuggestDetail = { ...(chargedBase as any), title: ampTitle, kind: 'dmg', ele: id }
        pushAliasStrong(cloneWithParams(ampRow, `${ampTitle}(${stateLabel})`, stateParams))
        gsBuffIdsOut.add(id)
      }
      ensureChargedAmp('vaporize')
      ensureChargedAmp('melt')

      // Skill periodic damage showcases: "E后<表名>" is a common baseline naming convention.
      const eBase = details.find((d) => {
        if (!d || typeof d !== 'object') return false
        if (normalizeKind(d.kind) !== 'dmg') return false
        if (d.talent !== 'e') return false
        const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
        if (ele) return false
        const table = normalizePromptText(d.table)
        if (!table || !/伤害/.test(table)) return false
        if (/(治疗|护盾|吸收量|持续时间|冷却)/.test(table)) return false
        return true
      })
      if (eBase) {
        const tableBase = normalizePromptText(eBase.table)?.replace(/2$/, '') || ''
        const title = tableBase ? `E后${tableBase}` : `E后${normalizePromptText(eBase.title)}`
        // Do NOT implicitly enable halfHp here (title does not encode it). Keep it as "E后..." only.
        gsPushAliasByTitle(cloneWithParams(eBase, title, { e: true }))
      }
    }
  } catch {
    // best-effort
  }

  // 4) Baseline-style multi-hit total rows (e.g. Q激化总伤-10段 / Q总伤害·超激化).
  // Derived from official table names + descriptions (no baseline code reuse).
  applyGsDerivedTotals({ input, tables, details, gsBuffIdsOut })

  // 4.1) Title aliases towards baseline: "激化" wording + common per-tick / single-hit / release labels.
  // Keep it conservative and evidence-driven (avoid hardcoding per-character logic).
  const descE = normalizePromptText((input.talentDesc as any)?.e)
  const descQ = normalizePromptText((input.talentDesc as any)?.q)
  const isTickLikeDesc = (desc: string): boolean =>
    /(每隔?\s*\d+(?:\.\d+)?\s*(?:秒|s)|每\s*\d+(?:\.\d+)?\s*(?:秒|s))/i.test(desc) && /(造成|恢复|回复|治疗)/.test(desc)

  // Prefer adding "激化" aliases for catalyze variants when the model used "超激化/蔓激化" (baseline frequently uses "激化").
  for (const d0 of [...details]) {
    const d: any = d0 as any
    if (!d || typeof d !== 'object') continue
    const title = typeof d.title === 'string' ? d.title : ''
    if (!title) continue
    if (!/(超激化|蔓激化)/.test(title)) continue
    const aliasTitle = title.replace(/超激化/g, '激化').replace(/蔓激化/g, '激化')
    if (aliasTitle !== title) gsPushAliasByTitle({ ...(d as CalcSuggestDetail), title: aliasTitle } as any)
  }

  const pickBest = (list: CalcSuggestDetail[], score: (d: CalcSuggestDetail) => number): CalcSuggestDetail | null => {
    if (!list.length) return null
    const sorted = list.slice().sort((a, b) => score(b) - score(a))
    return sorted[0] || null
  }

  // "每跳治疗/每跳伤害" aliases for periodic kits (very common in baseline titles).
  if (isTickLikeDesc(descE)) {
    const eHeal = details.filter((d) => normalizeKind(d.kind) === 'heal' && d.talent === 'e')
    const best = pickBest(eHeal, (d) => (normalizePromptText(d.title).length >= 4 ? 1 : 0))
    if (best) gsPushAliasByTitle({ ...(best as any), title: 'E每跳治疗' } as any)

    const eDmg = details.filter((d) => normalizeKind(d.kind) === 'dmg' && d.talent === 'e' && !String((d as any).ele || '').trim())
    const bestDmg = pickBest(eDmg, (d) => (/每跳|持续/.test(`${d.title} ${d.table}`) ? 3 : 0) + (String(d.table || '').includes('伤害') ? 1 : 0))
    if (bestDmg) gsPushAliasByTitle({ ...(bestDmg as any), title: 'E每跳伤害' } as any)
  }
  if (isTickLikeDesc(descQ)) {
    const qHeal = details.filter((d) => normalizeKind(d.kind) === 'heal' && d.talent === 'q')
    const best = pickBest(qHeal, (d) => (normalizePromptText(d.title).length >= 4 ? 1 : 0))
    if (best) gsPushAliasByTitle({ ...(best as any), title: 'Q每跳治疗' } as any)

    const qDmg = details.filter((d) => normalizeKind(d.kind) === 'dmg' && d.talent === 'q' && !String((d as any).ele || '').trim())
    const bestDmg = pickBest(qDmg, (d) => (/每跳|持续/.test(`${d.title} ${d.table}`) ? 3 : 0) + (String(d.table || '').includes('伤害') ? 1 : 0))
    if (bestDmg) gsPushAliasByTitle({ ...(bestDmg as any), title: 'Q每跳伤害' } as any)
  }

  // "Q单段伤害/Q释放伤害" are frequent baseline labels; derive them from the most "single-hit" Q row.
  const qSingles = details.filter(
    (d) =>
      normalizeKind(d.kind) === 'dmg' &&
      d.talent === 'q' &&
      !String((d as any).ele || '').trim() &&
      !/(总伤|总计|合计|每跳|持续)/.test(`${d.title} ${d.table}`)
  )
  const bestQSingle = pickBest(qSingles, (d) => {
    const s = `${normalizePromptText(d.title)} ${normalizePromptText(d.table)}`
    let sc = 0
    if (/单次|单段/.test(s)) sc += 6
    if (/释放/.test(s)) sc += 4
    if (/技能伤害/.test(s)) sc += 2
    const table = String(d.table || '').trim()
    const schema = table ? inferArrayTableSchema(input, 'q', table) : null
    if (schema?.kind === 'statTimes') sc += 20
    if (table.endsWith('2')) sc += 8
    return sc
  })
  if (bestQSingle) {
    gsPushAliasByTitle({ ...(bestQSingle as any), title: 'Q单段伤害' } as any)
    gsPushAliasByTitle({ ...(bestQSingle as any), title: 'Q释放伤害' } as any)

    // If this is a `[pct, hits]` multi-hit table (e.g. "126.88%*5"), add a baseline-like "完整" total row
    // that multiplies by hit count via renderer's statTimes logic.
    const table = typeof (bestQSingle as any).table === 'string' ? String((bestQSingle as any).table).trim() : ''
    const schema = table ? inferArrayTableSchema(input, 'q', table) : null
    const sample = table ? (input.tableSamples as any)?.q?.[table] : null
    const hits =
      Array.isArray(sample) && sample.length >= 2 && typeof sample[1] === 'number' ? Math.trunc(Number(sample[1])) : NaN
    if (schema?.kind === 'statTimes' && Number.isFinite(hits) && hits >= 2) {
      gsPushAliasByTitle({ ...(bestQSingle as any), title: 'Q完整伤害' } as any)
    }
  }

  // Symmetric: "E释放伤害" helps matching for kits where baseline uses cast-damage wording.
  const eSingles = details.filter(
    (d) =>
      normalizeKind(d.kind) === 'dmg' &&
      d.talent === 'e' &&
      !String((d as any).ele || '').trim() &&
      !/(总伤|总计|合计|每跳|持续)/.test(`${d.title} ${d.table}`)
  )
  const bestESingle = pickBest(eSingles, (d) => {
    const s = `${normalizePromptText(d.title)} ${normalizePromptText(d.table)}`
    let sc = 0
    if (/释放|点按|长按/.test(s)) sc += 6
    if (/技能伤害/.test(s)) sc += 3
    return sc
  })
  if (bestESingle) gsPushAliasByTitle({ ...(bestESingle as any), title: 'E释放伤害' } as any)

  // Add baseline-compatible title aliases from official table names (skill-specific names are common in baseline).
  // Keep it compact: prefer inserting by replacing low-signal NA segment rows when at the detail cap.
  const baseTableName = (tRaw: unknown): string => {
    const t0 = normalizePromptText(String(tRaw || ''))
    if (!t0) return ''
    return t0.endsWith('2') ? t0.slice(0, -1) : t0
  }
  const isGenericTableTitle = (t: string): boolean => {
    if (!t) return true
    if (/^(?:一|二|三|四|五|六|七|八|九|十)段伤害$/.test(t)) return true
    if (/^(?:重击伤害|下落攻击伤害|下坠期间伤害|坠地冲击伤害)$/.test(t)) return true
    return false
  }
  const deriveTableTitleAliases = (tRaw: unknown): string[] => {
    const t = baseTableName(tRaw)
    if (!t) return []
    if (isGenericTableTitle(t)) return []

    const out: string[] = [t]
    // Baseline commonly drops "量" suffixes in titles while keeping the same underlying table.
    if (/(治疗|回复)量$/.test(t)) out.push(t.replace(/量$/, ''))
    // Shield tables frequently map to a single baseline title.
    if (/护盾吸收量$/.test(t)) out.push(t.replace(/护盾吸收量$/, '护盾最大吸收量'))
    return out
  }
  const scoreAliasTitle = (tRaw: string): number => {
    const t = normalizePromptText(tRaw)
    if (!t) return -1
    let s = 0
    if (t.length >= 10) s += 12
    else if (t.length >= 6) s += 6
    if (/护盾最大吸收量/.test(t)) s += 40
    if (/(每跳|持续)/.test(t)) s += 18
    if (/(总伤|总计|合计|一轮)/.test(t)) s += 14
    if (/(爆发|爆裂|召唤|协同|追击|联动|反击)/.test(t)) s += 10
    if (/(激化|蒸发|融化)/.test(t)) s += 8
    return s
  }

  const aliasCands: CalcSuggestDetail[] = []
  for (const d0 of details) {
    const d: any = d0 as any
    if (!d || typeof d !== 'object') continue
    const kind = normalizeKind(d.kind)
    if (!['dmg', 'heal', 'shield'].includes(kind)) continue
    if (!d.talent || !d.table) continue
    for (const t of deriveTableTitleAliases(d.table)) {
      if (!t) continue
      if (normalizePromptText(d.title) === normalizePromptText(t)) continue
      aliasCands.push({ ...(d as CalcSuggestDetail), title: t })
    }
  }
  aliasCands.sort((a, b) => scoreAliasTitle(String(b.title || '')) - scoreAliasTitle(String(a.title || '')))
  const aliasKeepMax = 10
  for (const d of aliasCands.slice(0, aliasKeepMax)) gsPushAliasByTitle(d)

  // "开Q..." is a common baseline synonym for "Q状态·...". Add a conservative alias for better matching.
  for (const d0 of [...details]) {
    const d: any = d0 as any
    if (!d || typeof d !== 'object') continue
    if (!d.talent || !d.table) continue
    const title0 = normalizePromptText(d.title)
    if (!title0) continue
    if (!/^Q状态/.test(title0)) continue

    const kind = normalizeKind(d.kind)
    let rest = title0.replace(/^Q状态[·.]?/, '').trim()
    if (!rest) continue
    let title = `开Q${rest}`
    if (kind === 'dmg' && !/(伤害|治疗|护盾|吸收量)/.test(title)) title = `${title}伤害`
    gsPushAliasByTitle({ ...(d as CalcSuggestDetail), title } as any)
  }

  // Prune over-generated transformative reaction rows from LLM plans.
  // These rows can dominate `maxAvg` (e.g. hyperBloom) and introduce large regression drift,
  // especially on healer/support kits where baseline typically does not showcase them.
  const hintLines = [
    ...(Array.isArray((input as any).buffHints) ? ((input as any).buffHints as unknown[]) : []),
    ...Object.values((input as any).talentDesc || {})
  ]
    .map((s) => normalizePromptText(String(s || '')))
    .filter(Boolean)
  const hintTextAll = hintLines.join('\n')

  // Prune over-generated lunar showcase rows from LLM plans.
  // Lunar (Moonsign) reactions are represented as kind=dmg with ele=lunar* (NOT kind=reaction).
  // Many non-lunar kits mention electro-charged/bloom keywords in descriptions; the model can hallucinate
  // lunar rows (e.g. "月感电反应伤害") that then dominate `maxAvg` and break regressions.
  const isLunarEle = (eleRaw: unknown): boolean => {
    const e = typeof eleRaw === 'string' ? eleRaw.trim() : ''
    return e === 'lunarCharged' || e === 'lunarBloom' || e === 'lunarCrystallize'
  }
  const hasLunarTables = (() => {
    for (const listRaw of Object.values(tables || {})) {
      const list = Array.isArray(listRaw) ? (listRaw as unknown[]) : []
      for (const t0 of list) {
        const t = normalizePromptText(String(t0 || ''))
        if (!t) continue
        if (/(月感电|月绽放|月结晶)/.test(t)) return true
      }
    }
    return false
  })()
  const hasLunarHint = /(月感电|月绽放|月结晶|月曜|月兆|Moonsign|Lunar)/i.test(hintTextAll)
  const allowLunarShowcase = hasLunarTables || hasLunarHint

  const lunarIdxs: number[] = []
  for (let i = 0; i < details.length; i++) {
    const d: any = details[i]
    if (!d || typeof d !== 'object') continue
    if (normalizeKind(d.kind) !== 'dmg') continue
    if (!isLunarEle(d.ele)) continue
    lunarIdxs.push(i)
  }
  if (lunarIdxs.length) {
    if (!allowLunarShowcase) {
      for (let i = details.length - 1; i >= 0; i--) {
        const d: any = details[i]
        if (!d || typeof d !== 'object') continue
        if (normalizeKind(d.kind) !== 'dmg') continue
        if (isLunarEle(d.ele)) details.splice(i, 1)
      }
    } else {
      // Keep a small, table-backed subset. Prefer explicit lunar table names.
      const isLunarNamed = (sRaw: unknown): boolean => /(月感电|月绽放|月结晶)/.test(normalizePromptText(String(sRaw || '')))
      const keepMax = 3
      const tableNamedIdxs = lunarIdxs.filter((idx) => {
        const d: any = details[idx]
        const table = typeof d?.table === 'string' ? d.table : ''
        return isLunarNamed(table)
      })

      if (tableNamedIdxs.length === 0) {
        for (let i = details.length - 1; i >= 0; i--) {
          const d: any = details[i]
          if (!d || typeof d !== 'object') continue
          if (normalizeKind(d.kind) !== 'dmg') continue
          if (isLunarEle(d.ele)) details.splice(i, 1)
        }
      } else {
        const scored = tableNamedIdxs
          .map((idx) => {
            const d: any = details[idx]
            const table = typeof d?.table === 'string' ? d.table : ''
            const title = typeof d?.title === 'string' ? d.title : ''
            const hasTable = typeof d?.talent === 'string' && typeof d?.table === 'string' && !!d.table
            const strong = isLunarNamed(table)
            const score = (strong ? 10 : 0) + (hasTable ? 2 : 0) + (isLunarNamed(title) ? 1 : 0)
            return { idx, score }
          })
          .sort((a, b) => b.score - a.score || a.idx - b.idx)
        const keep = new Set(scored.slice(0, keepMax).map((x) => x.idx))

        for (let i = details.length - 1; i >= 0; i--) {
          const d: any = details[i]
          if (!d || typeof d !== 'object') continue
          if (normalizeKind(d.kind) !== 'dmg') continue
          if (!isLunarEle(d.ele)) continue
          if (!keep.has(i)) details.splice(i, 1)
        }
      }
    }
  }

  const elemRaw = String(input.elem || '').trim()
  const elemLower = elemRaw.toLowerCase()
  const isElem = (...keys: string[]): boolean => keys.includes(elemRaw) || keys.includes(elemLower)
  const isAnemoOrGeo = isElem('风', 'anemo') || isElem('岩', 'geo')

  const hasEmHint = /(元素精通|精通|mastery|\bem\b)/i.test(hintTextAll)
  const hasOffensiveReactionHint = (() => {
    const hasReactionWord = /(绽放|超绽放|烈绽放|月绽放|扩散|结晶|燃烧|超载|感电|超导|碎冰)/
    const offensive = /(造成|触发|提升|提高|增加|加成|额外|反应伤害)/
    for (const line of hintLines) {
      if (!line) continue
      if (!hasReactionWord.test(line)) continue
      // Lunar reactions should be modeled as kind=dmg (ele=lunar*), not kind=reaction.
      if (/(月感电|月绽放|月结晶)/.test(line)) continue
      // Skip purely defensive wording like "免疫感电反应的伤害" / "不受...影响".
      if (/(免疫|不受)/.test(line)) continue
      // Skip "受到...反应伤害降低/减少/减免" style defensive hints.
      if (/受到/.test(line) && /(降低|减少|减免)/.test(line)) continue
      if (offensive.test(line)) return true
    }
    return false
  })()

  // Only keep/inject a single transformative reaction showcase row when:
  // - the kit explicitly benefits from reaction damage, OR
  // - it is anemo/geo with clear EM hints (swirl/crystallize).
  const allowReactionShowcase = hasOffensiveReactionHint || (hasEmHint && isAnemoOrGeo)
  const hasAnyReaction = details.some((d) => normalizeKind(d.kind) === 'reaction')
  if (hasAnyReaction) {
    if (!allowReactionShowcase) {
      for (let i = details.length - 1; i >= 0; i--) {
        if (normalizeKind((details[i] as any)?.kind) === 'reaction') details.splice(i, 1)
      }
    } else {
      // Keep at most one reaction row.
      let kept = false
      for (let i = details.length - 1; i >= 0; i--) {
        if (normalizeKind((details[i] as any)?.kind) !== 'reaction') continue
        if (!kept) {
          kept = true
          continue
        }
        details.splice(i, 1)
      }
    }
  }

  const hasReaction = details.some((d) => normalizeKind(d.kind) === 'reaction')
  if (!hasReaction && details.length < 20) {
    if (allowReactionShowcase) {
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
