import type { CalcScaleStat, CalcSuggestDetail, CalcSuggestInput, TalentKeyGs } from '../types.js'
import { jsString, normalizePromptText, normalizeTableList } from '../utils.js'
import { inferArrayTableSchema } from '../table-schema.js'
import { normalizeKind } from './normalize.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function escapeRegExp(s: string): string {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function inferBaseStat(input: CalcSuggestInput, tk: TalentKeyGs, table: string): CalcScaleStat {
  const unitMap = (input.tableUnits as any)?.[tk]
  const unit0 = unitMap && typeof unitMap === 'object' && !Array.isArray(unitMap) ? unitMap[table] : undefined
  const unit = normalizePromptText(unit0)
  if (unit) {
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(unit)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(unit)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(unit)) return 'atk'
  }

  const baseName = table.endsWith('2') ? table.slice(0, -1) : table
  const sample0 = (input.tableTextSamples as any)?.[tk]?.[table] ?? (input.tableTextSamples as any)?.[tk]?.[baseName]
  const sample = normalizePromptText(sample0)
  if (sample) {
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(sample)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(sample)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(sample)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(sample)) return 'atk'
    if (/[%％]/.test(sample)) return 'atk'
  }

  return 'atk'
}

function makeDmgCallExpr(
  input: CalcSuggestInput,
  d: Pick<CalcSuggestDetail, 'talent' | 'table' | 'key' | 'ele' | 'pick'> & { talent: TalentKeyGs; table: string; key: string }
): string | null {
  const tk = d.talent
  const tableName = String(d.table || '').trim()
  if (!tableName) return null
  const key = String(d.key || tk).trim() || tk
  const ele = typeof d.ele === 'string' && d.ele.trim() ? d.ele.trim() : ''
  const keyArg = jsString(key)
  const eleArg = ele ? `, ${jsString(ele)}` : ''

  const acc = `talent.${tk}[${jsString(tableName)}]`
  const base = inferBaseStat(input, tk, tableName)
  const useBasic = base !== 'atk'

  const pick =
    typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.max(0, Math.min(10, Math.trunc((d as any).pick))) : null

  if (pick !== null) {
    const vExpr = `Number(Array.isArray(${acc}) ? ${acc}[${pick}] : ${acc}) || 0`
    if (useBasic) return `dmg.basic(calc(attr.${base}) * toRatio(${vExpr}), ${keyArg}${eleArg})`
    return `dmg(${vExpr}, ${keyArg}${eleArg})`
  }

  const schema = inferArrayTableSchema(input, tk, tableName)

  if (schema?.kind === 'statStat') {
    const [s0, s1] = schema.stats
    const scalar = useBasic
      ? `dmg.basic(calc(attr.${base}) * toRatio(${acc}), ${keyArg}${eleArg})`
      : `dmg(${acc}, ${keyArg}${eleArg})`
    return `Array.isArray(${acc}) ? dmg.basic(calc(attr.${s0}) * toRatio(${acc}[0]) + calc(attr.${s1}) * toRatio(${acc}[1]), ${keyArg}${eleArg}) : (${scalar})`
  }
  if (schema?.kind === 'statFlat') {
    const scalar = useBasic
      ? `dmg.basic(calc(attr.${base}) * toRatio(${acc}), ${keyArg}${eleArg})`
      : `dmg(${acc}, ${keyArg}${eleArg})`
    return `Array.isArray(${acc}) ? dmg.basic(calc(attr.${schema.stat}) * toRatio(${acc}[0]) + (Number(${acc}[1]) || 0), ${keyArg}${eleArg}) : (${scalar})`
  }
  if (schema?.kind === 'statTimes') {
    const t0 = `Number(Array.isArray(${acc}) ? ${acc}[0] : ${acc}) || 0`
    if (schema.stat === 'atk' && !useBasic) return `dmg(${t0}, ${keyArg}${eleArg})`
    return `dmg.basic(calc(attr.${schema.stat}) * toRatio(${t0}), ${keyArg}${eleArg})`
  }
  if (schema?.kind === 'pctList') {
    // Avoid synthesizing totals for pct-list arrays here: summing them would require a loop in dmgExpr.
    return null
  }

  // Fallback: treat unknown arrays as variant lists and use the first component.
  const v0 = `Number(Array.isArray(${acc}) ? ${acc}[0] : ${acc}) || 0`
  if (useBasic) return `dmg.basic(calc(attr.${base}) * toRatio(${v0}), ${keyArg}${eleArg})`
  return `dmg(${v0}, ${keyArg}${eleArg})`
}

function isDamageLikeTableName(nameRaw: unknown): boolean {
  const name = normalizePromptText(nameRaw)
  if (!name) return false
  if (!/伤害/.test(name)) return false
  // Exclude obvious non-damage coefficient tables.
  if (/(加成|提升|提高|增加|降低|减少|上限|概率|几率|持续时间|冷却时间|能量|消耗|回复|治疗|护盾|吸收量)/.test(name)) return false
  return true
}

function inferTimesFromDesc(descRaw: unknown, tokenRaw: string): number | null {
  const desc = normalizePromptText(descRaw).replace(/\s+/g, '')
  const token = String(tokenRaw || '').trim()
  if (!desc || !token || token.length < 2) return null

  const esc = escapeRegExp(token)
  const re1 = new RegExp(`(\\d{1,3})\\s*(?:次|段|枚)\\s*${esc}`)
  const m1 = desc.match(re1)
  if (m1) {
    const n = Math.trunc(Number(m1[1]))
    return Number.isFinite(n) && n >= 1 && n <= 60 ? n : null
  }

  const re2 = new RegExp(`${esc}[^\\d]{0,16}?(\\d{1,3})\\s*(?:次|段|枚)`)
  const m2 = desc.match(re2)
  if (m2) {
    const n = Math.trunc(Number(m2[1]))
    return Number.isFinite(n) && n >= 1 && n <= 60 ? n : null
  }

  return null
}

function inferMaxCountFromDesc(descRaw: unknown): number | null {
  const desc = normalizePromptText(descRaw).replace(/\s+/g, '')
  if (!desc) return null

  const picks: RegExp[] = [
    /拥有\s*(\d{1,2})\s*次可使用次数/,
    /可使用次数\s*[:：]\s*(\d{1,2})/,
    /最多(?:可以)?(?:同时)?存在\s*(\d{1,2})\s*[个枚层次]/,
    /至多(?:可以)?(?:同时)?存在\s*(\d{1,2})\s*[个枚层次]/,
    /最多(?:可以)?(?:同时)?拥有\s*(\d{1,2})\s*[个枚层次]/,
    /至多(?:可以)?(?:同时)?拥有\s*(\d{1,2})\s*[个枚层次]/
  ]

  for (const re of picks) {
    const m = desc.match(re)
    if (!m) continue
    const n = Math.trunc(Number(m[1]))
    if (Number.isFinite(n) && n >= 2 && n <= 10) return n
  }

  return null
}

export function applyGsDerivedTotals(opts: {
  input: CalcSuggestInput
  tables: Record<string, string[]>
  details: CalcSuggestDetail[]
  gsBuffIdsOut: Set<string>
}): void {
  const { input, tables, details, gsBuffIdsOut } = opts
  if (input.game !== 'gs') return
  if (details.length === 0) return

  const normKey = (s: unknown): string =>
    normalizePromptText(s)
      .replace(/\s+/g, '')
      .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')
  const hasTitle = (title: string): boolean => details.some((d) => normKey(d?.title) === normKey(title))

  const findReplaceableIdx = (): number => {
    for (let i = details.length - 1; i >= 0; i--) {
      const d: any = details[i]
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      const tk = String(d.talent || '')
      if (tk !== 'a') continue
      const key = typeof d.key === 'string' ? String(d.key).trim() : ''
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      const s = `${title} ${table}`
      if (/(单次|每段|每跳|每次|总伤|总计|合计|一轮)/.test(s)) continue
      // Prefer dropping segmented NA rows first.
      if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
      if (/(一段|二段|三段|四段|五段|六段|七段|八段|九段|十段|段伤害)/.test(s)) return i
    }
    // Fallback: any plain NA dmg row (excluding charged/plunge/aimed).
    for (let i = details.length - 1; i >= 0; i--) {
      const d: any = details[i]
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      const tk = String(d.talent || '')
      if (tk !== 'a') continue
      const key = typeof d.key === 'string' ? String(d.key).trim() : ''
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      const s = `${title} ${table}`
      if (/(单次|每段|每跳|每次|总伤|总计|合计|一轮)/.test(s)) continue
      if (key === 'a2' || /(重击|下落|坠地|瞄准)/.test(s)) continue
      return i
    }
    // Final fallback: allow replacing charged/plunge/aimed rows when the plan is capped.
    for (let i = details.length - 1; i >= 0; i--) {
      const d: any = details[i]
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      const tk = String(d.talent || '')
      if (tk !== 'a') continue
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      const s = `${title} ${table}`
      if (/(单次|每段|每跳|每次|总伤|总计|合计|一轮)/.test(s)) continue
      if (/(重击|下落|坠地|瞄准)/.test(s)) return i
    }
    return -1
  }

  const pushPrefer = (d: CalcSuggestDetail): void => {
    if (details.length < 20) {
      details.push(d)
      return
    }
    const idx = findReplaceableIdx()
    if (idx >= 0) details.splice(idx, 1, d)
  }

  const elemRaw = String(input.elem || '').trim()
  const elemLower = elemRaw.toLowerCase()
  const isElem = (...keys: string[]): boolean => keys.includes(elemRaw) || keys.includes(elemLower)
  const catalyzeId = isElem('草', 'dendro') ? 'spread' : isElem('雷', 'electro') ? 'aggravate' : null

  const isQBucket = (d: any): boolean => {
    const k0 = typeof d?.key === 'string' ? String(d.key).trim() : ''
    const head = (k0 || 'q').split(',')[0]?.trim().toLowerCase() || 'q'
    return head === 'q'
  }

  const qDetails = details.filter(
    (d) => normalizeKind(d.kind) === 'dmg' && d.talent === 'q' && typeof d.table === 'string' && isQBucket(d as any)
  ) as any[]
  if (qDetails.length === 0) return

  const qTablesAll = normalizeTableList((tables as any).q || [])
  const countTables = qTablesAll.filter((t) => /(攻击次数|命中次数|攻击段数)/.test(t))
  const pickMaxCountTable = (): { table: string; hits: number } | null => {
    let best: { table: string; hits: number } | null = null
    for (const t of countTables) {
      const v = (input.tableSamples as any)?.q?.[t]
      const n = typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : NaN
      if (!Number.isFinite(n) || n < 2 || n > 60) continue
      if (!best || n > best.hits) best = { table: t, hits: n }
    }
    return best
  }

  const pickBestSingleHit = (ele?: string): any | null => {
    const list = qDetails.filter((d: any) => {
      if (!d || typeof d !== 'object') return false
      if (!isDamageLikeTableName(d.table)) return false
      const e = typeof d.ele === 'string' ? d.ele.trim() : ''
      if (ele === undefined) return !e
      return e === ele
    })
    if (!list.length) return null
    const score = (d: any): number => {
      const title = normalizePromptText(d.title)
      const table = normalizePromptText(d.table)
      let s = 0
      if (/单次/.test(table) || /单次/.test(title)) s += 6
      if (String(d.table || '').trim().endsWith('2')) s += 3
      if (/最后一击/.test(table) || /最后一击/.test(title)) s += 2
      if (/连斩/.test(table) || /连斩/.test(title)) s += 2
      return s
    }
    list.sort((a: any, b: any) => score(b) - score(a))
    return list[0] || null
  }

  const descQ = (input.talentDesc as any)?.q
  const descE = (input.talentDesc as any)?.e

  const addTotalByCountTable = (): void => {
    const bestCount = pickMaxCountTable()
    if (!bestCount) return

    const base = pickBestSingleHit()
    if (!base) return
    if (!base.table) return

    const key = typeof base.key === 'string' && base.key.trim() ? base.key.trim() : 'q'
    const hits = bestCount.hits
    const titleBase = `Q总伤-${hits}段`
    if (!hasTitle(titleBase)) {
      const call = makeDmgCallExpr(input, { talent: 'q', table: base.table, key })
      if (call) {
        pushPrefer({
          title: titleBase,
          kind: 'dmg',
          talent: 'q',
          table: base.table,
          key,
          params: { q: true },
          dmgExpr: `({ dmg: (${call}).dmg * ${hits}, avg: (${call}).avg * ${hits} })`
        } as any)
      }
    }

    if (catalyzeId) {
      const titleCat = catalyzeId === 'spread' ? `Q激化总伤-${hits}段` : `Q总伤-${hits}段·超激化`
      if (!hasTitle(titleCat)) {
        const callBase = makeDmgCallExpr(input, { talent: 'q', table: base.table, key })
        const callCat = makeDmgCallExpr(input, { talent: 'q', table: base.table, key, ele: catalyzeId })
        if (callBase && callCat) {
          const catHits = Math.max(1, Math.min(hits, Math.ceil(hits / 3)))
          const normalHits = Math.max(0, hits - catHits)
          gsBuffIdsOut.add(catalyzeId)
          pushPrefer({
            title: titleCat,
            kind: 'dmg',
            talent: 'q',
            table: base.table,
            key,
            params: { q: true },
            dmgExpr: `({ dmg: (${callBase}).dmg * ${normalHits} + (${callCat}).dmg * ${catHits}, avg: (${callBase}).avg * ${normalHits} + (${callCat}).avg * ${catHits} })`
          } as any)
        }
      }
    }
  }

  const addTotalsFromDescCounts = (): void => {
    const candidates = qDetails
      .filter((d: any) => isDamageLikeTableName(d.table))
      .map((d: any) => String(d.table || '').trim())
      .filter(Boolean)
    const uniqTables = Array.from(new Set(candidates))
    if (uniqTables.length === 0) return

    const timesByTable = new Map<string, number>()
    const descQNorm = normalizePromptText(descQ).replace(/\s+/g, '')
    const maxCount = inferMaxCountFromDesc(descE) ?? inferMaxCountFromDesc(descQ)
    const inferImplicitRepeat = (token: string): number | null => {
      if (!maxCount || maxCount < 2) return null
      if (!descQNorm || !token || token.length < 2) return null
      if (!descQNorm.includes(token)) return null
      const esc = escapeRegExp(token)
      // e.g. "每...摧毁一...就能...<token>"
      const re1 = new RegExp(`每[^\\n]{0,28}?(?:摧毁|消耗|存在|生成|引爆|解放|转化|触发)[^\\n]{0,28}?(?:一|1)[^\\n]{0,28}?${esc}`)
      if (re1.test(descQNorm)) return maxCount
      // e.g. "<token>...每...摧毁/消耗/存在一..."
      const re2 = new RegExp(`${esc}[^\\n]{0,36}?(?:每|每当|每次)[^\\n]{0,36}?(?:摧毁|消耗|存在|触发)[^\\n]{0,36}?(?:一|1)`)
      if (re2.test(descQNorm)) return maxCount
      return null
    }

    for (const table of uniqTables) {
      const token = table.replace(/2$/, '').replace(/伤害/g, '').replace(/\s+/g, '').trim()
      const times0 = inferTimesFromDesc(descQ, token)
      const times = times0 && times0 >= 2 ? times0 : inferImplicitRepeat(token)
      if (times && times >= 2) timesByTable.set(table, times)
    }
    if (timesByTable.size === 0) return

    // Keep conservative: avoid exploding detail complexity.
    const picked = Array.from(timesByTable.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 4)

    const buildKeyForTable = (table: string): string => {
      const d = qDetails.find((x: any) => String(x?.table || '').trim() === table && (!x.ele || String(x.ele).trim() === ''))
      const k = d && typeof d.key === 'string' && d.key.trim() ? d.key.trim() : 'q'
      return k
    }

    const baseTerms: Array<{ table: string; call: string; times: number }> = []
    const catTerms: Array<{ base: string; cat: string; times: number }> = []

    const pushTerm = (table: string, times: number): void => {
      const key = buildKeyForTable(table)
      const call = makeDmgCallExpr(input, { talent: 'q', table, key })
      if (!call) return
      baseTerms.push({ table, call, times })
      if (catalyzeId) {
        const callCat = makeDmgCallExpr(input, { talent: 'q', table, key, ele: catalyzeId })
        if (callCat) catTerms.push({ base: call, cat: callCat, times })
      }
    }

    for (const [table, times] of picked) pushTerm(table, times)

    // Also include a single "base" hit once when the kit has a clear cast-damage table,
    // e.g. "技能伤害/释放伤害" + "额外X伤害 * N". This is common in baseline totals.
    const otherTables = uniqTables.filter((t) => !timesByTable.has(t))
    const basePick =
      otherTables.find((t) => /(技能伤害|释放伤害|点按伤害|长按伤害)/.test(t)) ||
      (otherTables.length === 1 ? otherTables[0] : null)
    if (basePick) pushTerm(basePick, 1)

    if (baseTerms.length === 0) return

    const sumExpr = (terms: Array<{ call: string; times: number }>, prop: 'dmg' | 'avg'): string =>
      terms.map((t) => `(${t.call}).${prop} * ${t.times}`).join(' + ')

    const totalHits = baseTerms.reduce((acc, t) => acc + (Number.isFinite(t.times) ? t.times : 0), 0)
    const numToCn = (n: number): string => {
      const map: Record<number, string> = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' }
      return map[n] || String(n)
    }
    const hitTitle = totalHits >= 2 && totalHits <= 10 ? `${numToCn(totalHits)}段Q总伤害` : ''

    const titleBase = `Q总伤害`
    if (!hasTitle(titleBase)) {
      pushPrefer({
        title: titleBase,
        kind: 'dmg',
        talent: 'q',
        table: baseTerms[0]!.table,
        key: 'q',
        params: { q: true },
        dmgExpr: `({ dmg: ${sumExpr(baseTerms, 'dmg')}, avg: ${sumExpr(baseTerms, 'avg')} })`
      } as any)
    }
    if (hitTitle && !hasTitle(hitTitle)) {
      pushPrefer({
        title: hitTitle,
        kind: 'dmg',
        talent: 'q',
        table: baseTerms[0]!.table,
        key: 'q',
        params: { q: true },
        dmgExpr: `({ dmg: ${sumExpr(baseTerms, 'dmg')}, avg: ${sumExpr(baseTerms, 'avg')} })`
      } as any)
    }

    if (catalyzeId && catTerms.length === baseTerms.length) {
      // Baseline-style: "激化总伤害" usually assumes each hit triggers catalyze (no partial hit splitting here).
      const catSum = (prop: 'dmg' | 'avg'): string => catTerms.map((t) => `(${t.cat}).${prop} * ${t.times}`).join(' + ')
      const titleCat = catalyzeId === 'spread' ? `Q激化总伤害` : `Q总伤害·超激化`
      if (!hasTitle(titleCat)) {
        gsBuffIdsOut.add(catalyzeId)
        pushPrefer({
          title: titleCat,
          kind: 'dmg',
          talent: 'q',
          table: baseTerms[0]!.table,
          key: 'q',
          params: { q: true },
          dmgExpr: `({ dmg: ${catSum('dmg')}, avg: ${catSum('avg')} })`
        } as any)
      }

      const hitCatTitle = totalHits >= 2 && totalHits <= 10 ? `${numToCn(totalHits)}段Q总激化伤害` : ''
      if (hitCatTitle && !hasTitle(hitCatTitle)) {
        gsBuffIdsOut.add(catalyzeId)
        pushPrefer({
          title: hitCatTitle,
          kind: 'dmg',
          talent: 'q',
          table: baseTerms[0]!.table,
          key: 'q',
          params: { q: true },
          dmgExpr: `({ dmg: ${catSum('dmg')}, avg: ${catSum('avg')} })`
        } as any)
      }
    }
  }

  // Prefer count-table driven totals (more deterministic and update-proof).
  if (countTables.length) addTotalByCountTable()
  // Fallback: parse hit counts from the official talent description.
  addTotalsFromDescCounts()
}
