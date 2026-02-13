import type { CalcSuggestDetail, CalcSuggestInput, TalentKey } from '../types.js'
import { jsString, normalizePromptText } from '../utils.js'
import { normalizeKind } from './normalize.js'

const srIsBuffOnlyTableName = (tableNameRaw: unknown): boolean => {
  const tn = normalizePromptText(tableNameRaw)
  if (!tn) return false
  // Whitelist: real output tables (damage / break / special hits).
  if (/(技能伤害|每段伤害|附加伤害|追加攻击伤害|追击伤害|反击伤害|持续伤害|dot|击破伤害|超击破|秘技伤害)/i.test(tn)) {
    return false
  }
  // Anything that reads like "increase/decrease/penetration/chance" is a buff/debuff table, not a dmg multiplier table.
  if (/(提高|提升|增加|降低|减少|加成|增伤|穿透|抗性穿透|无视|概率|几率|命中|抵抗|击破效率|削韧)/.test(tn)) return true
  return false
}

export function applySrPostprocess(opts: {
  input: CalcSuggestInput
  tables: Record<string, string[]>
  details: CalcSuggestDetail[]
}): void {
  const { input, tables, details } = opts

  const norm = (s: unknown): string => normalizePromptText(s)
  const normTitleKey = (s: unknown): string => norm(String(s || '')).replace(/\s+/g, '')
  const hasTitle = (title: string): boolean => details.some((d) => normTitleKey((d as any)?.title) === normTitleKey(title))

  const baseOf = (t: string): string =>
    String(t || '')
      .replace(/\(主目标\)/g, '')
      .replace(/\(相邻目标\)/g, '')
      .replace(/\(完整[^)]*\)/g, '')
      .trim()

  const isDmg = (d: CalcSuggestDetail): boolean => normalizeKind((d as any)?.kind) === 'dmg'
  const isAdjTitle = (t: string): boolean => /相邻目标/.test(norm(t))
  const isMainTitle = (t: string): boolean => /(主目标|主目標)/.test(norm(t))
  const isFullTitle = (t: string): boolean => /完整/.test(norm(t))

  const makeRatioExpr = (tk: string, table: string): string => {
    const acc = `talent.${tk}[${jsString(table)}]`
    return `toRatio(Array.isArray(${acc}) ? ${acc}[0] : ${acc})`
  }

  const inferScaleStat = (talentKey: string, table: string): string => {
    const tk = String(talentKey || '').trim()
    const t = String(table || '').trim()
    if (!tk || !t) return 'atk'

    const unit = norm((input.tableUnits as any)?.[tk]?.[t])
    if (unit) {
      if (/生命上限|生命值|最大生命值/.test(unit)) return 'hp'
      if (/防御力/.test(unit)) return 'def'
      if (/元素精通/.test(unit)) return 'mastery'
      if (/攻击力/.test(unit)) return 'atk'
    }

    const desc = norm((input.talentDesc as any)?.[tk])
    if (!desc) return 'atk'
    if (/(生命上限|生命值|最大生命值)/.test(desc) && !/攻击力/.test(desc)) return 'hp'
    if (/防御力/.test(desc)) return 'def'
    if (/元素精通/.test(desc)) return 'mastery'
    return 'atk'
  }

  const makeDmgCallExpr = (d: CalcSuggestDetail): string | null => {
    const tk = typeof d.talent === 'string' ? String(d.talent).trim() : ''
    const table = typeof d.table === 'string' ? String(d.table).trim() : ''
    if (!tk || !table) return null
    const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : tk
    const ele = typeof d.ele === 'string' && d.ele.trim() ? `, ${jsString(d.ele.trim())}` : ''
    const stat0 = typeof (d as any).stat === 'string' ? String((d as any).stat).trim() : ''
    const stat = stat0 && stat0 !== 'atk' ? stat0 : inferScaleStat(tk, table)
    if (!stat || stat === 'atk') return `dmg(talent.${tk}[${jsString(table)}], ${jsString(key)}${ele})`
    if (stat === 'hp' || stat === 'def' || stat === 'mastery') {
      return `dmg.basic(calc(attr.${stat}) * (${makeRatioExpr(tk, table)}), ${jsString(key)}${ele})`
    }
    return `dmg(talent.${tk}[${jsString(table)}], ${jsString(key)}${ele})`
  }

  // 0) Ensure Memory/Remembrance ("忆灵") rows exist when tables are present.
  // Many models skip me/mt buckets entirely, which causes extreme underestimation vs baseline.
  try {
    const pushPrefer = (d: CalcSuggestDetail): void => {
      const title = String((d as any)?.title || '').trim()
      if (!title) return
      // Allow same table name across different talent keys (common in SR: multiple blocks have "技能伤害").
      // Only treat as duplicate when the talent+table pair already exists.
      const tk = String((d as any)?.talent || '').trim()
      const table = String((d as any)?.table || '').trim()
      if (tk && table) {
        const exists = details.some((cur) => {
          if (!cur || typeof cur !== 'object') return false
          if (normalizeKind((cur as any).kind) !== 'dmg') return false
          return String((cur as any)?.talent || '').trim() === tk && String((cur as any)?.table || '').trim() === table
        })
        if (exists) return
      }
      if (details.length < 20) {
        details.push(d)
        return
      }
      // Replace a low-signal normal attack row (baseline rarely keeps all NA segments).
      for (let i = details.length - 1; i >= 0; i--) {
        const cur: any = details[i]
        if (!cur || typeof cur !== 'object') continue
        if (normalizeKind(cur.kind) !== 'dmg') continue
        const tkCur = String(cur.talent || '').trim()
        if (tkCur === 'a' || tkCur === 'a2' || tkCur === 'a3') {
          details.splice(i, 1, d)
          return
        }
      }
      // Fallback: replace the last row.
      details.splice(details.length - 1, 1, d)
    }

    const addRow = (talentKey: string, table: string): void => {
      const tk = String(talentKey || '').trim()
      const t = String(table || '').trim()
      if (!tk || !t) return
      if (srIsBuffOnlyTableName(t)) return
      if (!/伤害/.test(norm(t))) return
      const key = tk.replace(/\d+$/, '') as any
      pushPrefer({ title: t, kind: 'dmg', talent: tk as any, table: t, key } as any)
    }

    const memTalentKeys = Object.keys(tables).filter((k) => /^m[et]\d*$/.test(String(k || '').trim()))
    for (const tk of memTalentKeys) {
      const list = Array.isArray((tables as any)[tk]) ? ((tables as any)[tk] as string[]) : []
      if (!list.length) continue

      // Prefer main+adjacent pairs so the later "blast-style" pass can derive a "(完整)" total.
      const byBase = new Map<string, { main?: string; adj?: string; plain?: string }>()
      for (const t0 of list) {
        const t = String(t0 || '').trim()
        if (!t || srIsBuffOnlyTableName(t)) continue
        if (!/伤害/.test(norm(t))) continue
        const base = baseOf(t)
        if (!base) continue
        const ent = byBase.get(base) || {}
        if (isMainTitle(t)) ent.main = t
        else if (isAdjTitle(t)) ent.adj = t
        else if (!isFullTitle(t)) ent.plain = t
        byBase.set(base, ent)
      }

      // Add pairs first.
      for (const ent of byBase.values()) {
        if (ent.main && ent.adj) {
          addRow(tk, ent.main)
          addRow(tk, ent.adj)
        }
      }
      // Then add one plain row if we still have room.
      for (const ent of byBase.values()) {
        if (details.length >= 20) break
        if (ent.plain) addRow(tk, ent.plain)
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 0b) Normalize Memory/Remembrance ("忆灵") showcase titles and derive a "(完整)" total row when possible.
  // This is driven by official table names (no baseline code reuse).
  try {
    const isMemKey = (tkRaw: unknown): boolean => /^m[et]\d*$/.test(String(tkRaw || '').trim())
    const titleOf = (d: CalcSuggestDetail): string => String((d as any)?.title || '').trim()
    const tableOf = (d: CalcSuggestDetail): string => String((d as any)?.table || '').trim()
    const tkOf = (d: CalcSuggestDetail): string => String((d as any)?.talent || '').trim()

    const upsert = (d: CalcSuggestDetail): void => {
      const t = String((d as any)?.title || '').trim()
      if (!t) return
      const idx = details.findIndex((cur) => normTitleKey(titleOf(cur)) === normTitleKey(t))
      if (idx >= 0) {
        details.splice(idx, 1, d)
        return
      }
      if (details.length < 20) {
        details.push(d)
        return
      }
      // Replace a low-signal normal attack row if possible.
      for (let i = details.length - 1; i >= 0; i--) {
        const cur: any = details[i]
        if (!cur || typeof cur !== 'object') continue
        if (normalizeKind(cur.kind) !== 'dmg') continue
        const tk = String(cur.talent || '').trim()
        if (tk === 'a' || tk === 'a2' || tk === 'a3') {
          details.splice(i, 1, d)
          return
        }
      }
      details.splice(details.length - 1, 1, d)
    }

    const descByTalent = (input.talentDesc || {}) as Record<string, unknown>
    const descOf = (tkRaw: unknown): string => {
      const tk = String(tkRaw || '').trim()
      return tk ? norm((descByTalent as any)[tk]) : ''
    }

    const parseHitCount = (descRaw: unknown): number | null => {
      const desc = norm(descRaw)
      if (!desc) return null
      // Most common wording: "造成4次伤害"
      const m =
        desc.match(/造成\s*(\d{1,2})\s*次(?:伤害|攻击)/) ||
        desc.match(/(\d{1,2})\s*次(?:伤害|攻击)/)
      if (!m) return null
      const n = Math.trunc(Number(m[1]))
      return Number.isFinite(n) && n >= 2 && n <= 60 ? n : null
    }

    const parseSpriteName = (descQ: string): string | null => {
      const s = norm(descQ)
      if (!s || !/召唤忆灵/.test(s)) return null
      const m =
        /召唤忆灵[^“「『"《》]{0,20}(?:“([^”]{1,12})”|「([^」]{1,12})」|『([^』]{1,12})』|"([^"]{1,12})"|《([^》]{1,12})》)/.exec(
          s
        )
      const name = String(m?.[1] || m?.[2] || m?.[3] || m?.[4] || m?.[5] || '').trim()
      return name || null
    }

    const spriteName = parseSpriteName(descOf('q')) || '忆灵'
    const me2DescAll = descOf('me2')
    const isMemStackKit = /忆质/.test(me2DescAll) && /每持有\s*1\s*点/.test(me2DescAll)

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (!isDmg(d)) continue
      const tk = tkOf(d)
      if (!isMemKey(tk)) continue
      const tbl = norm(tableOf(d))
      if (!tbl) continue

      // Enhanced memory-skill rows (me2): align titles to a stable baseline-like format.
      if (tk.startsWith('me2')) {
        if (isMemStackKit) {
          if (/^技能伤害$/.test(tbl) || /^目标伤害$/.test(tbl)) (d as any).title = `${spriteName}自爆伤害(单次主目标)`
          else if (/^技能伤害\(2\)$/.test(tbl) || /相邻目标/.test(tbl)) (d as any).title = `${spriteName}自爆伤害(单次相邻目标)`
        } else {
          if (/^所有目标伤害$/.test(tbl)) (d as any).title = '强化忆灵技伤害(首次释放)'
          else if (/二次释放伤害/.test(tbl)) (d as any).title = '强化忆灵技伤害(二次释放)'
          else if (/三次释放伤害/.test(tbl)) (d as any).title = '强化忆灵技伤害(三次释放)'
        }
      }

      // Memory-talent rows (mt*): "随机伤害" is typically a single bounce instance.
      if (tk.startsWith('mt') && /^随机伤害$/.test(tbl)) (d as any).title = '忆灵天赋伤害(单次弹射)'

      // Memory-skill rows (me): normalize "随机/最后" showcase titles.
      if (tk === 'me') {
        if (/^随机伤害$/.test(tbl)) (d as any).title = '忆灵技伤害(随机单体)'
        const meDesc = descOf('me')
        const looksLikeLastAoe = /最后/.test(meDesc) && /(全体|群体|敌方全体)/.test(meDesc)
        if (/^最后伤害$/.test(tbl) || (looksLikeLastAoe && /^每次伤害$/.test(tbl))) (d as any).title = '忆灵技伤害(最后)'
        if (/^技能伤害$/.test(tbl)) (d as any).title = '忆灵技伤害'
        if (/^附加伤害$/.test(tbl)) (d as any).title = '忆灵技附加伤害'
      }
    }

    const pickByTitle = (t: string): CalcSuggestDetail | null =>
      details.find((d) => isDmg(d) && normTitleKey(titleOf(d)) === normTitleKey(t)) || null

    // Derive "忆灵技伤害(完整)" for common "随机N次 + 最后" patterns (e.g. 记忆开拓者).
    try {
      const random = pickByTitle('忆灵技伤害(随机单体)')
      const last = pickByTitle('忆灵技伤害(最后)')
      const n = random && last ? parseHitCount(descOf((random as any).talent || 'me')) : null
      if (random && last && n) {
        const callRand = makeDmgCallExpr(random)
        const callLast = makeDmgCallExpr(last)
        if (callRand && callLast) {
          const full: CalcSuggestDetail = {
            title: '忆灵技伤害(完整)',
            kind: 'dmg',
            talent: (random as any)?.talent,
            table: (random as any)?.table,
            key: (random as any)?.key,
            ele: (random as any)?.ele,
            stat: (random as any)?.stat,
            params: (random as any)?.params,
            check: (random as any)?.check,
            dmgExpr: `({ dmg: (${callRand}).dmg * ${n} + (${callLast}).dmg, avg: (${callRand}).avg * ${n} + (${callLast}).avg })`
          } as any
          upsert(full)
        }
      }
    } catch {
      // ignore
    }

    // Derive "强化忆灵技伤害(完整)" for multi-release memory skills; include bounce totals when available.
    try {
      const first = pickByTitle('强化忆灵技伤害(首次释放)')
      const second = pickByTitle('强化忆灵技伤害(二次释放)')
      const third = pickByTitle('强化忆灵技伤害(三次释放)')
      // Some kits expose bounce damage under multiple mt* blocks (mt1/mt2) but the baseline typically
      // uses the "later" / final mt2 block as the canonical bounce table. Prefer it when duplicates exist.
      const bounce = (() => {
        const list = details.filter(
          (d) => isDmg(d) && normTitleKey(titleOf(d)) === normTitleKey('忆灵天赋伤害(单次弹射)')
        )
        if (list.length <= 1) return list[0] || null
        const score = (d: CalcSuggestDetail): number => {
          const tk = tkOf(d)
          if (tk === 'mt2') return 0
          if (tk === 'mt') return 1
          if (/^mt\d+$/.test(tk)) return 2
          return 3
        }
        return list.slice().sort((a, b) => score(a) - score(b))[0] || null
      })()
      const parts = [first, second, third].filter(Boolean) as CalcSuggestDetail[]

      const me2Desc = descOf('me2')
      const wantsRepeat = /可重复|重复发动|重复释放/.test(me2Desc)
      const thirdHitsExpr = wantsRepeat ? `(cons > 1 ? 4 : 2)` : '1'

      const baseBounce = bounce ? parseHitCount(descOf((bounce as any).talent)) : null
      const extraBounceByCons = new Map<number, number>()
      for (const h0 of Array.isArray(input.buffHints) ? input.buffHints : []) {
        const h = norm(h0)
        if (!h || !/弹射次数/.test(h) || !/额外增加/.test(h)) continue
        const mc = /(^|[^\d])([1-6])\s*(?:魂|命|星魂)/.exec(h)
        const mv = /额外增加\s*(\d{1,2})\s*次/.exec(h)
        if (!mc || !mv) continue
        const c = Number(mc[2])
        const v = Math.trunc(Number(mv[1]))
        if (!Number.isFinite(c) || c < 1 || c > 6) continue
        if (!Number.isFinite(v) || v < 1 || v > 60) continue
        extraBounceByCons.set(c, v)
      }
      const bounceHitsExpr = (() => {
        if (!baseBounce || baseBounce < 2) return null
        const extras = Array.from(extraBounceByCons.entries()).sort((a, b) => a[0] - b[0])
        if (!extras.length) return String(baseBounce)
        const parts = [String(baseBounce)]
        for (const [c, v] of extras) parts.push(`(cons >= ${c} ? ${v} : 0)`)
        return parts.join(' + ')
      })()

      // Detect per-cast stacking damage bonus hints for multi-release Memory skills, e.g.:
      // "每次施放/释放...造成的伤害提高X%，该效果最多叠加N层".
      // When found, prefer using miao-plugin's dynamicData ({ dynamicDmg }) in showcase rows to reduce drift.
      const inferRepeatDynamicStacks = (): { stepPct: number; maxStacks: number } | null => {
        const hintLines = Array.isArray(input.buffHints) ? (input.buffHints as unknown[]) : []
        for (const h0 of hintLines) {
          const h = norm(h0)
          if (!h) continue
          // 每次 + 释放/施放/发动 + 伤害 + 提高/提升/增加 + 最多/最高 + 叠加N层
          if (!/\u6bcf\u6b21/.test(h)) continue
          if (!/\u6bcf\u6b21/.test(h)) continue
          if (!/(\u91ca\u653e|\u65bd\u653e|\u53d1\u52a8)/.test(h)) continue
          if (!/\u4f24\u5bb3/.test(h)) continue
          if (!/(\u63d0\u9ad8|\u63d0\u5347|\u589e\u52a0|\u52a0\u6210)/.test(h)) continue
          if (!/(\u6700\u591a|\u6700\u9ad8)/.test(h)) continue
          if (!/\u53e0\u52a0/.test(h)) continue

          const mStep = h.match(
            /\u4f24\u5bb3.{0,16}(?:\u63d0\u9ad8|\u63d0\u5347|\u589e\u52a0|\u52a0\u6210).{0,16}?(\d{1,4}(?:\.\d+)?)\s*%/
          )
          const mMax = h.match(/(?:\u6700\u591a|\u6700\u9ad8).{0,16}\u53e0\u52a0.{0,16}?(\d{1,3})\s*\u5c42/)
          const step0 = mStep ? Number(mStep[1]) : NaN
          const max0 = mMax ? Math.trunc(Number(mMax[1])) : NaN
          const stepPct = Number.isFinite(step0) && step0 > 0 && step0 <= 200 ? step0 : NaN
          const maxStacks = Number.isFinite(max0) && max0 >= 2 && max0 <= 12 ? max0 : NaN
          if (!Number.isFinite(stepPct) || !Number.isFinite(maxStacks)) continue
          return { stepPct, maxStacks }
        }
        return null
      }

      // Guardrail: only apply this to the known "二次/三次释放伤害" staging pattern.
      const hasReleaseStages = (() => {
        const me2Tables = Array.isArray((tables as any).me2) ? ((tables as any).me2 as string[]) : []
        const has2 = me2Tables.some((t) => /\u4e8c\u6b21\u91ca\u653e\u4f24\u5bb3/.test(norm(t)))
        const has3 = me2Tables.some((t) => /\u4e09\u6b21\u91ca\u653e\u4f24\u5bb3/.test(norm(t)))
        return has2 && has3
      })()

      const makeDmgCallExprWithDynamic = (d: CalcSuggestDetail, dynamicDmgExpr: string): string | null => {
        const tk = typeof d.talent === 'string' ? String(d.talent).trim() : ''
        const table = typeof d.table === 'string' ? String(d.table).trim() : ''
        if (!tk || !table) return null
        const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : tk
        const eleArg = typeof d.ele === 'string' && d.ele.trim() ? jsString(d.ele.trim()) : 'false'
        const stat0 = typeof (d as any).stat === 'string' ? String((d as any).stat).trim() : ''
        const stat = stat0 && stat0 !== 'atk' ? stat0 : inferScaleStat(tk, table)
        if (!stat || stat === 'atk') return null
        return `dmg.basic(calc(attr.${stat}) * (${makeRatioExpr(tk, table)}), ${jsString(key)}, ${eleArg}, { dynamicDmg: ${dynamicDmgExpr} })`
      }

      const repeatDyn = wantsRepeat && hasReleaseStages ? inferRepeatDynamicStacks() : null
      if (repeatDyn) {
        const step = repeatDyn.stepPct
        const maxStacks = repeatDyn.maxStacks
        const patch = (d: CalcSuggestDetail | null, stacks: number): void => {
          if (!d) return
          const s = Math.max(0, Math.min(maxStacks, Math.trunc(stacks)))
          const expr = makeDmgCallExprWithDynamic(d, `${step} * ${s}`)
          if (expr) (d as any).dmgExpr = expr
        }
        patch(first, 1)
        patch(second, 2)
        patch(third, 3)
      }

      if (parts.length >= 2) {
        const callFirst = first ? makeDmgCallExpr(first) : null
        const callSecond = second ? makeDmgCallExpr(second) : null
        const callThird = third ? makeDmgCallExpr(third) : null
        const callBounce = bounce ? makeDmgCallExpr(bounce) : null

        let didDynamic = false
        if (repeatDyn && wantsRepeat && first && second && third) {
          const step = repeatDyn.stepPct
          const cap = repeatDyn.maxStacks

          const call1 = makeDmgCallExprWithDynamic(first, 'dyn(1)')
          const call2 = makeDmgCallExprWithDynamic(second, 'dyn(2)')
          const call3 = makeDmgCallExprWithDynamic(third, 'dyn(3)')
          const call3x = makeDmgCallExprWithDynamic(third, 'dyn(3 + i)')
          const callB = bounce ? makeDmgCallExprWithDynamic(bounce, 'dyn(cost + 2)') : null

          if (call1 && call2 && call3 && call3x) {
            const full: CalcSuggestDetail = {
              title: '强化忆灵技伤害(完整)',
              kind: 'dmg',
              talent: (first as any)?.talent ?? (second as any)?.talent ?? (third as any)?.talent,
              table: (first as any)?.table ?? (second as any)?.table ?? (third as any)?.table,
              key: (first as any)?.key ?? (second as any)?.key ?? (third as any)?.key,
              ele: (first as any)?.ele ?? (second as any)?.ele ?? (third as any)?.ele,
              stat: (first as any)?.stat ?? (second as any)?.stat ?? (third as any)?.stat,
              params: (first as any)?.params ?? (second as any)?.params ?? (third as any)?.params,
              check: (first as any)?.check ?? (second as any)?.check ?? (third as any)?.check,
              dmgExpr: `(() => {
  const step = ${step}
  const cap = ${cap}
  const dyn = (n) => step * (n > cap ? cap : n)
  const cost = (cons > 1 ? 4 : 2)
  const d1 = (${call1})
  const d2 = (${call2})
  const d3 = (${call3})
  for (let i = 1; i < cost; i++) {
    const x = (${call3x})
    d3.dmg += x.dmg
    d3.avg += x.avg
  }
  let dmgSum = d1.dmg + d2.dmg + d3.dmg
  let avgSum = d1.avg + d2.avg + d3.avg
${callB && bounceHitsExpr ? `  const b = (${callB})
  const hits = (${bounceHitsExpr})
  dmgSum += b.dmg * hits
  avgSum += b.avg * hits` : ''}
  return { dmg: dmgSum, avg: avgSum }
})()`
            } as any
            upsert(full)
            didDynamic = true
          }
        }

        const dmgParts: string[] = []
        const avgParts: string[] = []
        if (callFirst) {
          dmgParts.push(`(${callFirst}).dmg`)
          avgParts.push(`(${callFirst}).avg`)
        }
        if (callSecond) {
          dmgParts.push(`(${callSecond}).dmg`)
          avgParts.push(`(${callSecond}).avg`)
        }
        if (callThird) {
          dmgParts.push(`(${callThird}).dmg * ${thirdHitsExpr}`)
          avgParts.push(`(${callThird}).avg * ${thirdHitsExpr}`)
        }
        if (callBounce && bounceHitsExpr) {
          dmgParts.push(`(${callBounce}).dmg * (${bounceHitsExpr})`)
          avgParts.push(`(${callBounce}).avg * (${bounceHitsExpr})`)
        }

        if (!didDynamic && dmgParts.length >= 2 && avgParts.length === dmgParts.length) {
          const full: CalcSuggestDetail = {
            title: '强化忆灵技伤害(完整)',
            kind: 'dmg',
            talent: (first as any)?.talent ?? (second as any)?.talent ?? (third as any)?.talent,
            table: (first as any)?.table ?? (second as any)?.table ?? (third as any)?.table,
            key: (first as any)?.key ?? (second as any)?.key ?? (third as any)?.key,
            ele: (first as any)?.ele ?? (second as any)?.ele ?? (third as any)?.ele,
            stat: (first as any)?.stat ?? (second as any)?.stat ?? (third as any)?.stat,
            params: (first as any)?.params ?? (second as any)?.params ?? (third as any)?.params,
            check: (first as any)?.check ?? (second as any)?.check ?? (third as any)?.check,
            dmgExpr: `({ dmg: (${dmgParts.join(' + ')}), avg: (${avgParts.join(' + ')}) })`
          } as any
          upsert(full)
        }
      }
    } catch {
      // ignore
    }

    // Per-stack "忆质" showcase (e.g. 长夜月): derive baseline-like爆发/自爆 totals.
    try {
      const me2Desc = descOf('me2')
      const isMemStack = /忆质/.test(me2Desc) && /每持有\s*1\s*点/.test(me2Desc)
      if (isMemStack) {
        const min0 =
          me2Desc.match(/大于等于\s*(\d{1,3})\s*点/) ||
          me2Desc.match(/>=\s*(\d{1,3})\s*点/) ||
          me2Desc.match(/≥\s*(\d{1,3})\s*点/)
        const minStack0 = min0 ? Math.trunc(Number(min0[1])) : NaN
        const minStack = Number.isFinite(minStack0) && minStack0 >= 1 && minStack0 <= 60 ? minStack0 : 16

        const textAll = [
          ...(Array.isArray(input.buffHints) ? input.buffHints : []),
          ...Object.values(input.talentDesc || {})
        ]
          .map((s) => norm(s))
          .filter(Boolean)
        let cap: number | null = null
        for (const s of textAll) {
          const m = s.match(/最多[^0-9]{0,12}(\d{1,3})\s*点[^。\n]{0,12}忆质/)
          if (!m) continue
          const n = Math.trunc(Number(m[1]))
          if (!Number.isFinite(n) || n < minStack || n > 120) continue
          cap = cap == null ? n : Math.max(cap, n)
        }
        const maxStack = Math.max(minStack, Math.min(28, cap ?? 28))
        const stacks = Array.from(new Set([minStack, maxStack])).filter((n) => n >= 1 && n <= 60)

        const me2Main =
          details.find(
            (d) =>
              isDmg(d) &&
              tkOf(d) === 'me2' &&
              /伤害/.test(norm(tableOf(d))) &&
              !/\(\s*2\s*\)/.test(String(tableOf(d) || '')) &&
              !/相邻目标/.test(norm(tableOf(d)))
          ) || null
        const me2Adj =
          details.find(
            (d) =>
              isDmg(d) &&
              tkOf(d) === 'me2' &&
              /伤害/.test(norm(tableOf(d))) &&
              (/\(\s*2\s*\)/.test(String(tableOf(d) || '')) || /相邻目标/.test(norm(tableOf(d))))
          ) || null

        const callMain = me2Main ? makeDmgCallExpr(me2Main) : null
        const callAdj = me2Adj ? makeDmgCallExpr(me2Adj) : null
        if (me2Main && callMain) {
          for (const n of stacks) {
            const titleMain = `${spriteName}自爆伤害(${n}忆质 主目标)`
            upsert({
              title: titleMain,
              kind: 'dmg',
              talent: (me2Main as any)?.talent,
              table: (me2Main as any)?.table,
              key: (me2Main as any)?.key,
              ele: (me2Main as any)?.ele,
              stat: (me2Main as any)?.stat,
              params: (me2Main as any)?.params,
              check: (me2Main as any)?.check,
              dmgExpr: `({ dmg: (${callMain}).dmg * ${n}, avg: (${callMain}).avg * ${n} })`
            } as any)

            if (me2Adj && callAdj) {
              const titleFull = `${spriteName}自爆伤害(${n}忆质 3目标完整)`
              upsert({
                title: titleFull,
                kind: 'dmg',
                talent: (me2Main as any)?.talent,
                table: (me2Main as any)?.table,
                key: (me2Main as any)?.key,
                ele: (me2Main as any)?.ele,
                stat: (me2Main as any)?.stat,
                params: (me2Main as any)?.params,
                check: (me2Main as any)?.check,
                dmgExpr: `({ dmg: ((${callMain}).dmg + (${callAdj}).dmg * 2) * ${n}, avg: ((${callMain}).avg + (${callAdj}).avg * 2) * ${n} })`
              } as any)
            }
          }
        }

        // Also derive "忆灵技伤害(N忆质)" when the skill provides an extra component per 4 points.
        const meDesc = descOf('me')
        if (/忆质/.test(meDesc) && /每\s*4\s*点/.test(meDesc)) {
          const meBase =
            details.find((d) => isDmg(d) && tkOf(d) === 'me' && /^技能伤害$/.test(norm(tableOf(d)))) || null
          const meExtra =
            details.find((d) => isDmg(d) && tkOf(d) === 'me' && /^附加伤害$/.test(norm(tableOf(d)))) || null
          const callBase = meBase ? makeDmgCallExpr(meBase) : null
          const callExtra = meExtra ? makeDmgCallExpr(meExtra) : null
          if (meBase && meExtra && callBase && callExtra) {
            for (const n of stacks) {
              const k = Math.trunc(Math.floor(n / 4))
              if (!(k >= 1 && k <= 60)) continue
              upsert({
                title: `忆灵技伤害(${n}忆质)`,
                kind: 'dmg',
                talent: (meBase as any)?.talent,
                table: (meBase as any)?.table,
                key: (meBase as any)?.key,
                ele: (meBase as any)?.ele,
                stat: (meBase as any)?.stat,
                params: (meBase as any)?.params,
                check: (meBase as any)?.check,
                dmgExpr: `({ dmg: (${callBase}).dmg + (${callExtra}).dmg * ${k}, avg: (${callBase}).avg + (${callExtra}).avg * ${k} })`
              } as any)
            }
          }
        }
      }
    } catch {
      // ignore
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 0c) Common SR blast pattern: tables provide both main-target dmg (技能伤害/目标伤害/主目标伤害) and
  // adjacent-target dmg (相邻目标伤害),
  // but models often only emit a single generic row (e.g. "战技伤害").
  // Add the missing adjacent row so the later blast-style pass can normalize "(主目标)" and derive a "(完整)" total.
  try {
    const preferBaseTitleByTalent = (tk: string): string => {
      if (tk === 'e') return '战技伤害'
      if (tk === 'q') return '终结技伤害'
      if (tk === 'e2') return '强化战技伤害'
      if (tk === 'q2') return '强化终结技伤害'
      if (tk === 'a' || tk === 'a2' || tk === 'a3') return '普攻伤害'
      if (tk === 't') return '天赋伤害'
      return ''
    }

    const findDmgDetail = (tk: string, table: string): CalcSuggestDetail | null => {
      const t = String(tk || '').trim()
      const tn = norm(table)
      if (!t || !tn) return null
      for (const d of details) {
        if (!d || typeof d !== 'object') continue
        if (!isDmg(d)) continue
        if (String((d as any).talent || '').trim() !== t) continue
        const curTable = norm(String((d as any).table || ''))
        if (curTable === tn) return d
      }
      return null
    }

    const pushPrefer = (d: CalcSuggestDetail): void => {
      const title = String((d as any)?.title || '').trim()
      if (!title) return
      if (hasTitle(title)) return
      if (details.length < 20) {
        details.push(d)
        return
      }
      // Replace a low-signal normal-attack row if possible.
      for (let i = details.length - 1; i >= 0; i--) {
        const cur: any = details[i]
        if (!cur || typeof cur !== 'object') continue
        if (normalizeKind(cur.kind) !== 'dmg') continue
        const tk = String(cur.talent || '').trim()
        if (tk === 'a' || tk === 'a2' || tk === 'a3') {
          details.splice(i, 1, d)
          return
        }
      }
      details[details.length - 1] = d
    }

    for (const [tk0, listRaw] of Object.entries(tables || {})) {
      const tk = String(tk0 || '').trim()
      if (!tk) continue
      if (/^m[et]\d*$/.test(tk)) continue // Memory kit handled separately.

      const list = Array.isArray(listRaw) ? listRaw.map((s) => norm(s)).filter(Boolean) : []
      if (!list.includes('相邻目标伤害')) continue
      const mainTable = ['技能伤害', '目标伤害', '主目标伤害'].find((t) => list.includes(t)) || ''
      if (!mainTable) continue

      const main = findDmgDetail(tk, mainTable)
      const adj = findDmgDetail(tk, '相邻目标伤害')

      const basePrefer = preferBaseTitleByTalent(tk)
      const baseFromMain = main ? baseOf(String((main as any).title || '')) : ''
      const base = basePrefer || baseFromMain
      if (!base) continue

      // Ensure the main row exists; blast-style pass will normalize it to "(主目标)" if needed.
      if (!main) {
        const key = tk.startsWith('e') ? 'e' : tk.startsWith('q') ? 'q' : tk
        pushPrefer({
          title: `${base}(主目标)`,
          kind: 'dmg',
          talent: tk as any,
          table: mainTable,
          key,
          stat: inferScaleStat(tk, mainTable) as any
        } as any)
      } else {
        // Normalize existing main row title so base-grouping works even when the adjacent row already exists.
        const t = String((main as any).title || '').trim()
        if (!/\(主目标\)/.test(t)) (main as any).title = `${base}(主目标)`
      }

      // Ensure the adjacent row exists for blast derivation.
      if (!adj) {
        const proto: any = main || {}
        const key = typeof proto.key === 'string' && proto.key.trim() ? proto.key.trim() : tk.startsWith('e') ? 'e' : tk.startsWith('q') ? 'q' : tk
        pushPrefer({
          title: `${base}(相邻目标)`,
          kind: 'dmg',
          talent: tk as any,
          table: '相邻目标伤害',
          key,
          ele: typeof proto.ele === 'string' ? proto.ele : undefined,
          stat: (typeof proto.stat === 'string' && proto.stat.trim() ? proto.stat.trim() : inferScaleStat(tk, '相邻目标伤害')) as any,
          cons: typeof proto.cons === 'number' ? proto.cons : undefined,
          params: proto.params,
          check: typeof proto.check === 'string' ? proto.check : undefined
        } as any)
      } else {
        // IMPORTANT: always normalize the adjacent row title to share the same base,
        // even when the model already emitted a raw "相邻目标..." title.
        ;(adj as any).title = `${base}(相邻目标)`
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 1) Drop adjacent-target rows when the official talent description has no adjacent-target wording and
  // the talent tables also provide no adjacent variant table. This avoids hallucinated "blast split" rows.
  try {
    const descByTalent = (input.talentDesc || {}) as Record<string, unknown>
    const descOf = (tk: string): string => norm((descByTalent as any)[tk])

    for (let i = details.length - 1; i >= 0; i--) {
      const d: any = details[i]
      if (!d || typeof d !== 'object') continue
      if (normalizeKind(d.kind) !== 'dmg') continue
      const titleN = norm(d.title)
      if (!/相邻目标/.test(titleN)) continue
      const tk = typeof d.talent === 'string' ? String(d.talent).trim() : ''
      if (!tk) continue
      const desc = descOf(tk)
      if (/相邻目标/.test(desc)) continue

      const allowed = (tables as any)?.[tk]
      const hasAdjTable =
        Array.isArray(allowed) &&
        allowed.some((t: string) => /相邻目标/.test(String(t || '')) || /[（(]\s*2\s*[)）]/.test(String(t || '')))
      if (hasAdjTable) continue

      details.splice(i, 1)
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 2) Blast-style rows: if we have both main + adjacent rows, normalize the main title and derive a "(完整)" row.
  try {
    const descByTalent = (input.talentDesc || {}) as Record<string, unknown>
    const descOf = (tkRaw: unknown): string => {
      const tk = String(tkRaw || '').trim()
      return tk ? norm((descByTalent as any)[tk]) : ''
    }
    const inferRepeatCount = (tkRaw: unknown): number => {
      const desc = descOf(tkRaw)
      if (!desc) return 1
      // Common SR wording: "可重复2次" / "重复2次"
      const m = desc.match(/(?:可重复|重复)\s*(\d{1,2})\s*次/)
      if (!m) return 1
      const n = Math.trunc(Number(m[1]))
      // Keep conservative bounds to avoid accidental explosions.
      return Number.isFinite(n) && n >= 2 && n <= 6 ? n : 1
    }

    const byBase = new Map<string, CalcSuggestDetail[]>()
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (!isDmg(d)) continue
      const title = String((d as any).title || '').trim()
      if (!title) continue
      const base = baseOf(title)
      if (!base) continue
      const list = byBase.get(base) || []
      list.push(d)
      byBase.set(base, list)
    }

    for (const [base, list] of byBase.entries()) {
      const adj = list.find((d) => isAdjTitle(String((d as any).title || ''))) || null
      if (!adj) continue

      const titleFull = `${base}(完整)`
      const fullExisting =
        list.find((d) => normTitleKey(String((d as any).title || '')) === normTitleKey(titleFull)) ||
        list.find((d) => isFullTitle(String((d as any).title || ''))) ||
        null

      const main =
        list.find((d) => isMainTitle(String((d as any).title || ''))) ||
        list.find((d) => {
          const t = String((d as any).title || '')
          return !isAdjTitle(t) && !isFullTitle(t)
        }) ||
        null
      if (!main) continue

      // Normalize main title for matching.
      if (!/\(主目标\)/.test(String((main as any).title || ''))) {
        ;(main as any).title = `${base}(主目标)`
      }

      const callMain = makeDmgCallExpr(main)
      const callAdj = makeDmgCallExpr(adj)
      if (!callMain || !callAdj) continue

      // If the skill explicitly repeats the blast hit, scale the derived total accordingly.
      // This is a major source of underestimation vs baseline for some SR kits.
      const repeat = inferRepeatCount((main as any).talent)

      // IMPORTANT: Prefer a single combined dmg() call for the "(完整)" total:
      // - Baseline meta commonly models blast totals as `dmg(main + adj*2)` instead of summing separate dmg() calls.
      // - Summing separate calls can double-count non-linear terms (e.g. Plus damage) and drift badly vs baseline.
      const tkMain = String((main as any).talent || '').trim()
      const tkAdj = String((adj as any).talent || '').trim()
      const tblMain = String((main as any).table || '').trim()
      const tblAdj = String((adj as any).table || '').trim()
      const key0 = typeof (main as any).key === 'string' && String((main as any).key).trim() ? String((main as any).key).trim() : tkMain || 'e'
      const ele0 = typeof (main as any).ele === 'string' && String((main as any).ele).trim() ? String((main as any).ele).trim() : ''
      const pickMain = typeof (main as any).pick === 'number' && Number.isFinite((main as any).pick) ? Math.trunc((main as any).pick) : undefined
      const pickAdj = typeof (adj as any).pick === 'number' && Number.isFinite((adj as any).pick) ? Math.trunc((adj as any).pick) : undefined
      const stat0 = typeof (main as any).stat === 'string' ? String((main as any).stat).trim() : ''
      const stat = stat0 && stat0 !== 'atk' ? stat0 : inferScaleStat(tkMain, tblMain)

      const ratioExpr = (tk: string, table: string, pick?: number): string => {
        const acc = `talent.${tk}[${jsString(table)}]`
        if (typeof pick === 'number' && Number.isFinite(pick) && pick >= 0 && pick <= 12) {
          return `toRatio(Array.isArray(${acc}) ? ${acc}[${pick}] : ${acc})`
        }
        return `toRatio(Array.isArray(${acc}) ? ${acc}[0] : ${acc})`
      }

      let blastCall = ''
      if (tkMain && tkAdj === tkMain && tblMain && tblAdj) {
        const mult = `(${ratioExpr(tkMain, tblMain, pickMain)} + ${ratioExpr(tkMain, tblAdj, pickAdj)} * 2)`
        const keyArg = jsString(key0)
        const eleArg = ele0 ? `, ${jsString(ele0)}` : ''
        if (!stat || stat === 'atk') {
          blastCall = `dmg(${mult}, ${keyArg}${eleArg})`
        } else if (stat === 'hp' || stat === 'def' || stat === 'mastery') {
          blastCall = `dmg.basic(calc(attr.${stat}) * ${mult}, ${keyArg}${eleArg})`
        }
      }
      if (!blastCall) {
        // Fallback to summing separate calls (best-effort).
        blastCall = `({ dmg: (${callMain}).dmg + (${callAdj}).dmg * 2, avg: (${callMain}).avg + (${callAdj}).avg * 2 })`
      }

      const dmgExpr =
        repeat > 1
          ? `({ dmg: (${blastCall}).dmg * ${repeat}, avg: (${blastCall}).avg * ${repeat} })`
          : blastCall

      // Patch existing "(完整)" rows: many LLMs emit a "(完整)" title but forget the adjacent*2 factor, causing
      // systematic drift vs baseline. Always prefer the derived blast total when main+adj are present.
      if (fullExisting) {
        ;(fullExisting as any).title = titleFull
        ;(fullExisting as any).kind = 'dmg'
        ;(fullExisting as any).talent = main.talent
        ;(fullExisting as any).table = main.table
        ;(fullExisting as any).key = main.key
        ;(fullExisting as any).ele = main.ele
        ;(fullExisting as any).stat = (main as any).stat
        ;(fullExisting as any).cons = (main as any).cons
        ;(fullExisting as any).params = (main as any).params
        ;(fullExisting as any).check = (main as any).check
        ;(fullExisting as any).dmgExpr = dmgExpr
        continue
      }

      if (hasTitle(titleFull)) continue

      const full: CalcSuggestDetail = {
        title: titleFull,
        kind: 'dmg',
        talent: main.talent,
        table: main.table,
        key: main.key,
        ele: main.ele,
        stat: (main as any).stat,
        cons: (main as any).cons,
        params: (main as any).params,
        check: (main as any).check,
        dmgExpr
      } as any

      if (details.length >= 20) {
        // Replace the adjacent row to stay within the cap.
        const idx = details.indexOf(adj)
        if (idx >= 0) details.splice(idx, 1, full)
      } else {
        details.push(full)
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 2b) Enhanced/strength state convention:
  // - Baseline SR meta frequently uses `params.strength===true` to represent an enhanced/transformed state.
  // - Many SR kits store enhanced multipliers in `e2/q2` talent blocks.
  // Mark those rows as strength-state and add a `q+strength` variant when only `q` rows exist.
  try {
    const hasEnhancedBlock = Object.keys(tables || {}).some((tk) => /^e2\b|^q2\b/.test(String(tk || '').trim()))
    if (hasEnhancedBlock) {
      const ensureStrength = (d: CalcSuggestDetail): void => {
        const p0 = (d as any)?.params
        const p =
          p0 && typeof p0 === 'object' && !Array.isArray(p0)
            ? ({ ...(p0 as Record<string, number | boolean | string>) } as Record<string, number | boolean | string>)
            : ({} as Record<string, number | boolean | string>)
        if (!Object.prototype.hasOwnProperty.call(p, 'strength')) p.strength = true
        ;(d as any).params = p
      }

      for (const d of details) {
        if (!d || typeof d !== 'object') continue
        if (!isDmg(d)) continue
        const tk = String((d as any).talent || '').trim()
        if (!/^e2\b|^q2\b/.test(tk)) continue
        ensureStrength(d)
      }

      const hasStrengthUlt = details.some((d: any) => {
        if (!d || typeof d !== 'object') return false
        if (normalizeKind(d.kind) !== 'dmg') return false
        const tk = String(d.talent || '').trim()
        if (!tk.startsWith('q')) return false
        const p = d.params
        return !!(p && typeof p === 'object' && !Array.isArray(p) && (p as any).q === true && (p as any).strength === true)
      })

      if (!hasStrengthUlt) {
        const pickQ = (): CalcSuggestDetail | null => {
          const full = details.find((d: any) => {
            if (!d || typeof d !== 'object') return false
            if (normalizeKind(d.kind) !== 'dmg') return false
            if (String(d.talent || '').trim() !== 'q') return false
            const p = d.params
            if (!(p && typeof p === 'object' && !Array.isArray(p) && (p as any).q === true)) return false
            return isFullTitle(String(d.title || ''))
          })
          if (full) return full as any
          return (
            (details.find((d: any) => {
              if (!d || typeof d !== 'object') return false
              if (normalizeKind(d.kind) !== 'dmg') return false
              if (String(d.talent || '').trim() !== 'q') return false
              const p = d.params
              return !!(p && typeof p === 'object' && !Array.isArray(p) && (p as any).q === true)
            }) as any) || null
          )
        }

        const qRow = pickQ()
        if (qRow) {
          const clone: CalcSuggestDetail = JSON.parse(JSON.stringify(qRow))
          const t0 = String((clone as any).title || '').trim()
          ;(clone as any).title = t0 ? `${baseOf(t0)}(强化状态)` : '终结技伤害(强化状态)'

          const p0 = (clone as any)?.params
          const p =
            p0 && typeof p0 === 'object' && !Array.isArray(p0)
              ? ({ ...(p0 as Record<string, number | boolean | string>) } as Record<string, number | boolean | string>)
              : ({} as Record<string, number | boolean | string>)
          p.q = true
          p.strength = true
          ;(clone as any).params = p

          if (details.length < 20) {
            details.push(clone)
          } else {
            // Replace a low-signal normal attack row if possible.
            for (let i = details.length - 1; i >= 0; i--) {
              const cur: any = details[i]
              if (!cur || typeof cur !== 'object') continue
              if (normalizeKind(cur.kind) !== 'dmg') continue
              const tk = String(cur.talent || '').trim()
              if (tk === 'a' || tk === 'a2' || tk === 'a3') {
                details.splice(i, 1, clone)
                break
              }
            }
          }
        }
      }
    }
  } catch {
    // ignore
  }

  // 3) Multi-hit segment showcase: when the official talent desc exposes a hard cap like
  // "【XXX】最多累计10段攻击段数", add an aggregated "10层XXX单体伤害" row.
  try {
    const hintLines = (Array.isArray(input.buffHints) ? input.buffHints : [])
      .map((h) => norm(h))
      .filter(Boolean) as string[]
    const descByTalent = (input.talentDesc || {}) as Record<string, unknown>

    const parseMaxSegments = (descRaw: unknown): { name: string; hits: number } | null => {
      const desc = norm(descRaw)
      if (!desc) return null
      let m = /【([^】]{1,12})】[^。\n]{0,160}?最多(?:累计)?\s*(\d+)\s*段攻击段数/.exec(desc)
      if (!m) {
        m = /【([^】]{1,12})】[^。\n]{0,160}?(?:攻击段数).{0,16}?(?:上限|最多)\s*(\d+)\s*段/.exec(desc)
      }
      if (!m) return null
      const name = String(m[1] || '').trim()
      const n = Math.trunc(Number(m[2]))
      if (!name || !Number.isFinite(n) || n < 2 || n > 30) return null
      return { name, hits: n }
    }

    const pickMaxPct = (text: string): number | null => {
      const out: number[] = []
      const re = /(\d+(?:\.\d+)?)\s*[%％]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const n = Number(m[1])
        if (!Number.isFinite(n) || n <= 0 || n > 2000) continue
        out.push(n)
      }
      return out.length ? Math.max(...out) : null
    }

    const sumMin = (hits: number, maxStacks: number): number => {
      const n = Math.trunc(hits)
      const s = Math.trunc(maxStacks)
      if (!(n > 1) || !(s >= 1)) return 0
      const maxI = n - 1
      if (maxI <= s) return (maxI * (maxI + 1)) / 2
      return (s * (s + 1)) / 2 + s * (maxI - s)
    }

    const parsed: Array<{ tk: TalentKey; name: string; hits: number }> = []
    for (const tk0 of Object.keys(tables)) {
      const tk = tk0 as TalentKey
      const p = parseMaxSegments((descByTalent as any)[tk])
      if (p) parsed.push({ tk, ...p })
    }

    for (const ent of parsed) {
      const title = `${ent.hits}层${ent.name}单体伤害`
      if (hasTitle(title)) continue

      const perHit =
        details.find((d) => {
          if (!isDmg(d)) return false
          if (d.talent !== ent.tk) return false
          const t = norm(String((d as any).title || ''))
          if (!t || !t.includes(ent.name)) return false
          if (isAdjTitle(t)) return false
          if (/\d+\s*层/.test(t) || isFullTitle(t)) return false
          return true
        }) || null
      const perHitFallback =
        perHit ||
        (() => {
          // Fallback: when there's only one dmg row for that talent key (common for heuristic plans),
          // use it as the per-hit row even if the title does not mention the entity name.
          const cands = details.filter((d) => {
            if (!isDmg(d)) return false
            if (d.talent !== ent.tk) return false
            const t = norm(String((d as any).title || ''))
            if (!t) return false
            if (isAdjTitle(t)) return false
            if (/\d+\s*层/.test(t) || isFullTitle(t)) return false
            return true
          })
          return cands.length === 1 ? cands[0]! : null
        })()
      if (!perHitFallback) continue

      const call = makeDmgCallExpr(perHitFallback)
      if (!call) continue

      type Ramp = { cons: number; pct: number; stacks: number }
      const ramps: Ramp[] = []
      for (const h of hintLines) {
        const mCons = /^\s*(\d)\s*魂[：:]/.exec(h)
        if (!mCons) continue
        const cons = Math.trunc(Number(mCons[1]))
        if (!(cons >= 1 && cons <= 6)) continue
        if (!h.includes(ent.name)) continue
        if (!/每段攻击后/.test(h)) continue
        if (!/受到.{0,10}伤害.{0,8}(提高|提升|增加)/.test(h)) continue
        const pct = pickMaxPct(h)
        const mStack = h.match(/(?:至多|最多)叠加\s*(\d+)\s*(?:层|次)/)
        const stacks = mStack ? Math.trunc(Number(mStack[1])) : NaN
        if (pct == null || !Number.isFinite(stacks) || stacks < 1) continue
        ramps.push({ cons, pct, stacks })
      }
      ramps.sort((a, b) => a.cons - b.cons || b.pct - a.pct)
      const ramp = ramps[0] || null

      const mk = (factor: number, check?: string): CalcSuggestDetail =>
        ({
          title,
          kind: 'dmg',
          talent: perHitFallback.talent,
          table: perHitFallback.table,
          key: perHitFallback.key,
          ele: perHitFallback.ele,
          stat: (perHitFallback as any).stat,
          params: (perHitFallback as any).params,
          ...(check ? { check } : {}),
          dmgExpr: `({ dmg: (${call}).dmg * ${factor}, avg: (${call}).avg * ${factor} })`
        }) as any

      if (ramp && details.length + 2 <= 20) {
        const sum = sumMin(ent.hits, ramp.stacks)
        const factor0 = ent.hits
        const factor1 = Number((ent.hits + (ramp.pct / 100) * sum).toFixed(6))
        details.push(mk(factor0, `cons < ${ramp.cons}`))
        details.push(mk(factor1, `cons >= ${ramp.cons}`))
      } else if (details.length < 20) {
        details.push(mk(ent.hits))
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 3b) Ultimate segment cap showcase: when Q desc exposes a hard cap like
  // "终结技最多累计10段攻击段数", add baseline-like "终结技伤害·10段" rows.
  // Also support eidolons that increase the cap, e.g. "最多额外增加5段".
  try {
    const descQ = norm((input.talentDesc as any)?.q)
    if (descQ) {
      const mBase =
        descQ.match(/最多(?:累计)?\s*(\d{1,2})\s*段攻击段数/) ||
        descQ.match(/最多(?:累计)?\s*(\d{1,2})\s*段攻击/) ||
        descQ.match(/最多(?:累计)?\s*(\d{1,2})\s*段/)
      const baseHits0 = mBase ? Math.trunc(Number(mBase[1])) : NaN
      const baseHits = Number.isFinite(baseHits0) && baseHits0 >= 2 && baseHits0 <= 30 ? baseHits0 : 0

      if (baseHits) {
        const pickPerHit = (): CalcSuggestDetail | null => {
          // Prefer explicit single-hit ult rows.
          const cands = details.filter((d: any) => {
            if (!d || typeof d !== 'object') return false
            if (normalizeKind(d.kind) !== 'dmg') return false
            if (String(d.talent || '').trim() !== 'q') return false
            const title = norm(String(d.title || ''))
            const table = norm(String(d.table || ''))
            const merged = `${title} ${table}`.trim()
            if (!merged) return false
            if (/(附加|追加|持续|冻结|击破|超击破|削韧|能量恢复|能量回复)/.test(merged)) return false
            if (/单段|每段|每次/.test(merged)) return true
            if (/每段/.test(table) && /伤害/.test(table)) return true
            return false
          })
          if (cands.length) return cands[0] as any

          // Fallback: any q row that uses a per-hit table.
          return (
            (details.find((d: any) => {
              if (!d || typeof d !== 'object') return false
              if (normalizeKind(d.kind) !== 'dmg') return false
              if (String(d.talent || '').trim() !== 'q') return false
              const table = norm(String(d.table || ''))
              return /每段/.test(table) && /伤害/.test(table)
            }) as any) || null
          )
        }

        const perHit = pickPerHit()
        if (perHit) {
          const key =
            typeof (perHit as any).key === 'string' && String((perHit as any).key).trim()
              ? String((perHit as any).key).trim()
              : 'q'
          const eleArg =
            typeof (perHit as any).ele === 'string' && String((perHit as any).ele).trim()
              ? String((perHit as any).ele).trim()
              : ''

          const perHitExpr0 = typeof (perHit as any).dmgExpr === 'string' ? String((perHit as any).dmgExpr).trim() : ''
          const call = perHitExpr0 ? `(${perHitExpr0})` : makeDmgCallExpr(perHit)
          if (call) {
            const baseParams0 = (perHit as any).params
            const baseParams =
              baseParams0 && typeof baseParams0 === 'object' && !Array.isArray(baseParams0)
                ? { ...(baseParams0 as Record<string, unknown>) }
                : {}
            if (!Object.prototype.hasOwnProperty.call(baseParams, 'q')) baseParams.q = true

            const pushTotal = (hits: number, consReq?: number): void => {
              if (!(hits >= 2 && hits <= 60)) return
              const title = `终结技伤害·${hits}段`
              if (hasTitle(title)) return

              const d: CalcSuggestDetail = {
                title,
                kind: 'dmg',
                talent: 'q',
                key,
                ...(eleArg ? { ele: eleArg } : {}),
                ...(typeof (perHit as any).table === 'string' && String((perHit as any).table).trim()
                  ? { table: String((perHit as any).table).trim() }
                  : {}),
                ...(consReq ? { cons: consReq } : {}),
                ...(Object.keys(baseParams).length ? { params: baseParams as any } : {}),
                dmgExpr: `({ dmg: (${call}).dmg * ${hits}, avg: (${call}).avg * ${hits} })`
              } as any

              if (details.length < 20) {
                details.push(d)
                return
              }
              // Replace a low-signal NA segment row when capped.
              for (let i = details.length - 1; i >= 0; i--) {
                const cur: any = details[i]
                if (!cur || typeof cur !== 'object') continue
                if (normalizeKind(cur.kind) !== 'dmg') continue
                const t = norm(String(cur.title || ''))
                if (!/普攻/.test(t)) continue
                details.splice(i, 1, d)
                return
              }
            }

            pushTotal(baseHits)

            // Cons-based extra segments (max showcase): "最多额外增加X段" / "攻击段数上限提高X段".
            const hintLines = (Array.isArray(input.buffHints) ? input.buffHints : [])
              .map((h) => norm(h))
              .filter(Boolean) as string[]
            let best: { cons: number; extra: number } | null = null
            for (const h of hintLines) {
              const mCons = /^\s*(\d)\s*魂[：:]/.exec(h)
              if (!mCons) continue
              const consReq = Math.trunc(Number(mCons[1]))
              if (!(consReq >= 1 && consReq <= 6)) continue
              if (!/攻击段数/.test(h)) continue

              const mMax = h.match(/最多额外增加\s*(\d{1,2})\s*段/)
              const mUp = h.match(/(?:上限提高|上限增加|段数上限).{0,8}?(\d{1,2})\s*段/)
              const extra0 = mMax ? Math.trunc(Number(mMax[1])) : mUp ? Math.trunc(Number(mUp[1])) : NaN
              const extra = Number.isFinite(extra0) && extra0 >= 1 && extra0 <= 30 ? extra0 : 0
              if (!extra) continue
              if (!best || consReq < best.cons || extra > best.extra) best = { cons: consReq, extra }
            }
            if (best) {
              pushTotal(baseHits + best.extra, best.cons)
            }
          }
        }
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 4) SR stack-based enhanced-skill showcase (max stacks).
  // Some SR kits provide per-stack multipliers (e.g. "主目标每层倍率/相邻目标每层倍率") that should be applied
  // to enhanced skills. Missing these rows is a major cause of "too-low maxAvg" drift vs baseline.
  try {
    if (input.game === 'sr' && details.length) {
      const tDesc = norm((input.talentDesc as any)?.t)
      if (tDesc && /(强化战技|战技强化)/.test(tDesc) && /每层/.test(tDesc) && /(叠加|层数|最多|上限)/.test(tDesc)) {
        const mBuff = tDesc.match(/【([^】]{1,12})】[^。\n]{0,180}?最多(?:可)?叠加\s*(\d{1,3})\s*层/)
        const stackName = mBuff ? String(mBuff[1] || '').trim() : ''
        const maxStack0 = mBuff ? Math.trunc(Number(mBuff[2])) : NaN
        const maxStack = Number.isFinite(maxStack0) && maxStack0 >= 1 && maxStack0 <= 200 ? maxStack0 : null
        if (maxStack && stackName) {
          const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const waveM = tDesc.match(new RegExp(`波次开始[^。\\n]{0,160}?施加\\s*(\\d{1,3})\\s*层【${esc(stackName)}】`))
          const enterM = tDesc.match(new RegExp(`进入战斗[^。\\n]{0,160}?施加\\s*(\\d{1,3})\\s*层【${esc(stackName)}】`))
          const wave = waveM ? Math.trunc(Number(waveM[1])) : NaN
          const enter = enterM ? Math.trunc(Number(enterM[1])) : NaN
          const typical0 = Number.isFinite(wave) && wave >= 1 ? (Number.isFinite(enter) && enter >= 1 ? wave + enter : wave) : null
          const typicalStack = typical0 ? Math.max(1, Math.min(maxStack, typical0)) : null

          // If the text explicitly says "每层额外..." under a ">=2名" condition, baseline often showcases the max case.
          const stackCoef = /每层额外/.test(tDesc) && /(大于等于|≥)\s*2\s*名/.test(tDesc) ? 2 : 1

          const tList = (tables as any).t || []
          const perMain =
            tList.find((t: string) => /主目标.*每层.*倍率/.test(String(t || ''))) ||
            tList.find((t: string) => /主目标每层倍率/.test(String(t || ''))) ||
            null
          const perAdj =
            tList.find((t: string) => /(相邻|其他).*每层.*倍率/.test(String(t || ''))) ||
            tList.find((t: string) => /相邻目标每层倍率/.test(String(t || ''))) ||
            null
          if (!perMain || !perAdj) {
            // If we cannot identify the per-stack tables, do not attempt to synthesize a formula.
            throw new Error('missing per-stack tables')
          }

          const e2List = (tables as any).e2 as string[] | undefined
          if (!Array.isArray(e2List) || e2List.length === 0) throw new Error('missing e2 tables')
          const pickDmgTable = (list: string[]): string | null => {
            if (list.includes('技能伤害')) return '技能伤害'
            const any = list.find(
              (t) => /伤害/.test(String(t || '')) && !srIsBuffOnlyTableName(t) && !/(能量恢复|削韧)/.test(String(t || ''))
            )
            return any ? String(any || '').trim() || null : null
          }
          const baseTable = pickDmgTable(e2List)
          if (!baseTable) throw new Error('missing base damage table')
          const allTable =
            e2List.find((t) => /(所有目标|敌方全体|全体)/.test(String(t || '')) && /伤害/.test(String(t || ''))) || null

          const e2Desc = norm((input.talentDesc as any)?.e2)
          const repM = e2Desc ? e2Desc.match(/(?:可重复|重复)\s*(\d{1,2})\s*次/) : null
          const extraRepeats0 = repM ? Math.trunc(Number(repM[1])) : 0
          const extraRepeats =
            Number.isFinite(extraRepeats0) && extraRepeats0 >= 1 && extraRepeats0 <= 6 ? extraRepeats0 : 0

          const mkTotalExpr = (stackExpr: string): string => {
            const baseMain = `(Number(talent.e2[${jsString(baseTable)}]) || 0)`
            const perMainExpr = `(Number(talent.t[${jsString(perMain)}]) || 0) * (${stackExpr}) * ${stackCoef}`
            const perAdjExpr = `(Number(talent.t[${jsString(perAdj)}]) || 0) * (${stackExpr}) * ${stackCoef}`

            const hitMain = `dmg(${baseMain} + ${perMainExpr}, \"e\")`
            const hitAdj = `dmg(${baseMain} + ${perAdjExpr}, \"e\")`

            const hasAll = !!allTable
            const baseAll = hasAll ? `(Number(talent.e2[${jsString(allTable!)}]) || 0)` : '0'
            const hitAllMain = hasAll ? `dmg(${baseAll} + ${perMainExpr}, \"e\")` : 'null'
            const hitAllAdj = hasAll ? `dmg(${baseAll} + ${perAdjExpr}, \"e\")` : 'null'

            if (hasAll) {
              // 3-target showcase: initial main hit + (extraRepeats) blast hits (main+2adj) + final all-target hit (main+2adj).
              return `({ dmg: (${hitMain}).dmg * ${1 + extraRepeats} + (${hitAdj}).dmg * ${extraRepeats * 2} + (${hitAllMain}).dmg + (${hitAllAdj}).dmg * 2, avg: (${hitMain}).avg * ${1 + extraRepeats} + (${hitAdj}).avg * ${extraRepeats * 2} + (${hitAllMain}).avg + (${hitAllAdj}).avg * 2 })`
            }
            // Fallback: no explicit all-target table, treat as repeated blast total only.
            return `({ dmg: (${hitMain}).dmg * ${Math.max(1, extraRepeats)} + (${hitAdj}).dmg * ${Math.max(0, extraRepeats - 1) * 2}, avg: (${hitMain}).avg * ${Math.max(1, extraRepeats)} + (${hitAdj}).avg * ${Math.max(0, extraRepeats - 1) * 2} })`
          }

          const pushPrefer = (d: CalcSuggestDetail): void => {
            if (details.length < 20) details.push(d)
            else details[details.length - 1] = d
          }

          if (typicalStack && typicalStack !== maxStack) {
            const title = `强化战技伤害(完整 3目标 ${typicalStack}层${stackName})`
            if (!hasTitle(title)) {
              pushPrefer({
                title,
                kind: 'dmg',
                talent: 'e2',
                table: baseTable,
                key: 'e',
                params: { q: true, stacks: typicalStack },
                dmgExpr: mkTotalExpr(`params.stacks || ${typicalStack}`)
              } as any)
            }
          }

          {
            const title = `强化战技伤害(完整 3目标 满层${stackName})`
            if (!hasTitle(title)) {
              pushPrefer({
                title,
                kind: 'dmg',
                talent: 'e2',
                table: baseTable,
                key: 'e',
                params: { q: true, stacks: maxStack },
                dmgExpr: mkTotalExpr(`params.stacks || ${maxStack}`)
              } as any)
            }
          }
        }
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 4b) Drop trivial "(完整)" rows for pure AoE tables (no adjacent-split present).
  // Baseline SR meta usually treats "所有目标伤害" as per-target showcase, not 3-target total.
  // Keep blast-style "(完整)" rows (they have adjacent tables and are handled above).
  try {
    const byBase = new Map<string, CalcSuggestDetail[]>()
    for (const d of details) {
      const title = String((d as any)?.title || '').trim()
      if (!title) continue
      const base = baseOf(title)
      if (!base) continue
      const list = byBase.get(base) || []
      list.push(d)
      byBase.set(base, list)
    }

    for (const [base, list] of byBase.entries()) {
      const hasAdj = list.some((d) => /相邻目标/.test(norm(String((d as any)?.title || ''))))
      if (hasAdj) continue
      for (let i = list.length - 1; i >= 0; i--) {
        const d: any = list[i]
        if (!d || typeof d !== 'object') continue
        if (normalizeKind(d.kind) !== 'dmg') continue
        // Memory/Remembrance totals like "强化忆灵技伤害(完整)" are not trivial AoE 3-target sums.
        // Keep them even when the underlying table name is "所有目标伤害".
        const tk = String(d.talent || '').trim()
        if (/^m[et]\d*$/.test(tk)) continue
        const titleN = norm(d.title)
        if (!/完整/.test(titleN)) continue
        const tableN = norm(d.table)
        const looksLikeAllTarget = /(所有目标|敌方全体|全体)/.test(tableN) || /(所有目标|敌方全体|全体)/.test(titleN)
        if (!looksLikeAllTarget) continue
        const idx = details.indexOf(d as any)
        if (idx >= 0) details.splice(idx, 1)
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 4c) Random extra-hit ultimates: patch per-hit rows into baseline-like "总伤害" rows.
  // Example: "并额外造成6次伤害，每次伤害..." should be showcased as base + extra * 6.
  try {
    const q2Desc = norm((input.talentDesc as any)?.q2)
    const mHits = q2Desc.match(/额外造成\s*(\d{1,2})\s*次伤害/)
    const hits0 = mHits ? Math.trunc(Number(mHits[1])) : 0
    const hits = Number.isFinite(hits0) && hits0 >= 2 && hits0 <= 30 ? hits0 : 0
    if (hits) {
      const q2Tables = Array.isArray((tables as any)?.q2) ? ((tables as any).q2 as string[]) : []
      const pickBase = (): string | null => {
        if (q2Tables.includes('技能伤害')) return '技能伤害'
        if (q2Tables.includes('每次伤害')) return '每次伤害'
        const cand = q2Tables.find(
          (t) => /伤害/.test(String(t || '')) && !srIsBuffOnlyTableName(t) && !/(能量恢复|削韧)/.test(String(t || ''))
        )
        return cand ? String(cand || '').trim() : null
      }
      const pickExtra = (): string | null => {
        if (q2Tables.includes('额外随机伤害')) return '额外随机伤害'
        if (q2Tables.includes('随机伤害')) return '随机伤害'
        const cand = q2Tables.find((t) => /随机/.test(String(t || '')) && /伤害/.test(String(t || '')))
        return cand ? String(cand || '').trim() : null
      }
      const baseTable = pickBase()
      const extraTable = pickExtra()
      if (baseTable && extraTable) {
        // Patch the first q2 dmg row that looks like an enhanced ultimate.
        const d = details.find((x: any) => {
          if (!x || typeof x !== 'object') return false
          if (normalizeKind(x.kind) !== 'dmg') return false
          if (String(x.talent || '').trim() !== 'q2') return false
          const t = norm(String(x.title || ''))
          return /终结技/.test(t) || /强化终结技/.test(t)
        }) as any
        if (d) {
          const title0 = String(d.title || '').trim()
          if (title0 && !/总伤害/.test(title0) && /终结技/.test(title0)) {
            d.title = title0.endsWith('伤害') ? title0.replace(/伤害$/, '总伤害') : `${title0}总伤害`
          }
          const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : 'q'
          const eleArg = typeof d.ele === 'string' && d.ele.trim() ? `, ${jsString(d.ele.trim())}` : ''
          d.table = baseTable
          d.key = key
          d.dmgExpr = `dmg(talent.q2[${jsString(baseTable)}] + talent.q2[${jsString(extraTable)}] * ${hits}, ${jsString(
            key
          )}${eleArg})`
        }
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }

  // 5) Normalize "(主目标)" titles for single-target skills to better align with baseline naming.
  const hasMultiTargetVariant = new Set<string>()
  for (const d of details) {
    const title = String((d as any)?.title || '')
    if (!title) continue
    const base = baseOf(title)
    if (!base) continue
    if (/(相邻目标|完整|全体)/.test(title)) hasMultiTargetVariant.add(base)
  }
  for (const d of details) {
    const title = String((d as any)?.title || '')
    if (!/\(主目标\)/.test(title)) continue
    const base = baseOf(title)
    if (!base) continue
    if (hasMultiTargetVariant.has(base)) continue
    ;(d as any).title = base
  }
}
