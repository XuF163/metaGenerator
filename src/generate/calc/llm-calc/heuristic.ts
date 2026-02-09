import type {
  CalcScaleStat,
  CalcSuggestDetail,
  CalcSuggestInput,
  CalcSuggestResult,
  TalentKey
} from './types.js'
import { normalizePromptText, normalizeTableList, uniq } from './utils.js'

export function pickDamageTable(tables: string[]): string | undefined {
  const list = normalizeTableList(tables)
  // Prefer explicit damage tables; avoid cooldown/energy/toughness-only tables.
  // Many SR kits include buff tables like "伤害提高/抗性穿透提高/基础概率提高" which MUST NOT be treated as damage multipliers.
  const isBuffLike = (t: string): boolean =>
    /(提高|提升|增加|降低|减少|加成|增伤|穿透|抗性穿透|无视|概率|几率|命中|抵抗|击破效率|削韧|冷却|能量|回合|持续时间)/.test(t)
  const dmg = list.find((t) => /伤害/.test(t) && !isBuffLike(t))
  if (dmg) return dmg
  // If no obvious damage table exists, skip (prevents generating nonsense like "战技伤害" -> "生命上限提高").
  return undefined
}

export function heuristicPlan(input: CalcSuggestInput): CalcSuggestResult {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const details: CalcSuggestDetail[] = []

  if (input.game === 'gs') {
    const e = pickDamageTable(eTables)
    const q = pickDamageTable(qTables)
    const a = pickDamageTable(aTables)
    if (e) details.push({ title: 'E伤害', talent: 'e', table: e, key: 'e' })
    if (q) details.push({ title: 'Q伤害', talent: 'q', table: q, key: 'q' })
    if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a', ele: 'phy' })
    return {
      mainAttr: 'atk,cpct,cdmg',
      defDmgKey: e ? 'e' : q ? 'q' : 'a',
      details,
      buffs: []
    }
  }

  // sr
  const desc = input.talentDesc || {}
  const descText = (k: TalentKey): string => normalizePromptText((desc as any)[k])

  const inferSrStat = (list: string[], fallback: CalcScaleStat): CalcScaleStat => {
    const joined = list.join('|')
    if (/(生命上限|生命值上限|最大生命值|生命值)/.test(joined)) return 'hp'
    if (/防御力/.test(joined)) return 'def'
    if (/(攻击力|攻击)/.test(joined)) return 'atk'
    return fallback
  }

  const pickSrHealOrShield = (
    talent: TalentKey,
    list: string[],
    kind: 'heal' | 'shield',
    title: string
  ): void => {
    const preferPct =
      kind === 'heal'
        ? list.find((t) => /(百分比生命|生命值百分比|百分比)/.test(t)) || ''
        : list.find((t) => /(百分比防御|防御力百分比|百分比生命|生命值百分比|百分比)/.test(t)) || ''
    const fallback = list.find((t) => /固定值/.test(t)) || preferPct
    const table = (preferPct || fallback || '').trim()
    if (!table) return
    const stat = inferSrStat(list, kind === 'heal' ? 'hp' : 'def')
    details.push({ title, kind, talent, table, key: talent, stat })
  }

  // A
  const a = pickDamageTable(aTables)
  if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a' })

  // E
  const eDesc = descText('e')
  const isHealLike = (text: string): boolean =>
    /(治疗|回复)/.test(text) || (/恢复/.test(text) && /(生命上限|生命值上限|最大生命值|生命值)/.test(text))
  const eHasHeal = isHealLike(eDesc) || eTables.some((t) => /(治疗|回复)/.test(t))
  const eHasShield = /护盾/.test(eDesc) || eTables.some((t) => /护盾/.test(t))
  if (eHasShield) {
    pickSrHealOrShield('e', eTables, 'shield', '战技护盾量')
  } else if (eHasHeal) {
    pickSrHealOrShield('e', eTables, 'heal', '战技治疗量')
  } else {
    const e = pickDamageTable(eTables)
    if (e) details.push({ title: '战技伤害', talent: 'e', table: e, key: 'e' })
  }

  // Q
  const qDesc = descText('q')
  const qHasHeal = isHealLike(qDesc) || qTables.some((t) => /(治疗|回复)/.test(t))
  const qHasShield = /护盾/.test(qDesc) || qTables.some((t) => /护盾/.test(t))
  if (qHasShield) {
    pickSrHealOrShield('q', qTables, 'shield', '终结技护盾量')
  } else if (qHasHeal) {
    pickSrHealOrShield('q', qTables, 'heal', '终结技治疗量')
  } else {
    const q = pickDamageTable(qTables)
    if (q) details.push({ title: '终结技伤害', talent: 'q', table: q, key: 'q' })
  }
  // Extra Q damage tables (e.g. 冻结回合开始伤害 -> 冻结附加伤害)
  const qMain = details.find((d) => d.talent === 'q' && d.kind !== 'heal' && d.kind !== 'shield')?.table || ''
  for (const tn of qTables) {
    if (!/伤害/.test(tn)) continue
    if (tn === qMain) continue
    if (details.length >= 12) break
    const title = tn.replace(/回合开始伤害/g, '附加伤害')
    details.push({ title, talent: 'q', table: tn, key: 'q' })
  }

  // T
  const t = pickDamageTable(tTables)
  if (t) {
    const title = /反击/.test(t) ? '反击伤害' : '天赋伤害'
    details.push({ title, talent: 't', table: t, key: 't' })
  }

  const mainAttrParts = ['atk', 'cpct', 'cdmg']
  if (details.some((d) => d.kind === 'heal') || /(生命上限|生命值上限|最大生命值|生命值)/.test(`${eDesc} ${qDesc}`))
    mainAttrParts.push('hp')
  if (details.some((d) => d.kind === 'shield') || /防御力/.test(`${eDesc} ${qDesc}`)) mainAttrParts.push('def')
  const mainAttr = uniq(mainAttrParts).join(',')

  const hasE = details.some((d) => d.talent === 'e')
  const hasQ = details.some((d) => d.talent === 'q')
  const hasA = details.some((d) => d.talent === 'a')
  return {
    mainAttr,
    defDmgKey: hasE ? 'e' : hasQ ? 'q' : hasA ? 'a' : 'e',
    details,
    buffs: []
  }
}
