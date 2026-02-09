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

  const makeDmgCallExpr = (d: CalcSuggestDetail): string | null => {
    const tk = typeof d.talent === 'string' ? String(d.talent).trim() : ''
    const table = typeof d.table === 'string' ? String(d.table).trim() : ''
    if (!tk || !table) return null
    const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : tk
    const ele = typeof d.ele === 'string' && d.ele.trim() ? `, ${jsString(d.ele.trim())}` : ''
    const stat = typeof (d as any).stat === 'string' ? String((d as any).stat).trim() : ''
    if (!stat || stat === 'atk') return `dmg(talent.${tk}[${jsString(table)}], ${jsString(key)}${ele})`
    if (stat === 'hp' || stat === 'def' || stat === 'mastery') {
      return `dmg.basic(calc(attr.${stat}) * (${makeRatioExpr(tk, table)}), ${jsString(key)}${ele})`
    }
    return `dmg(talent.${tk}[${jsString(table)}], ${jsString(key)}${ele})`
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
      const hasFull = list.some((d) => isFullTitle(String((d as any).title || '')))
      if (hasFull) continue

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

      const titleFull = `${base}(完整)`
      if (hasTitle(titleFull)) continue

      const callMain = makeDmgCallExpr(main)
      const callAdj = makeDmgCallExpr(adj)
      if (!callMain || !callAdj) continue

      // If the skill explicitly repeats the blast hit, scale the derived total accordingly.
      // This is a major source of underestimation vs baseline for some SR kits.
      const repeat = inferRepeatCount((main as any).talent)

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
        dmgExpr:
          repeat > 1
            ? `({ dmg: ((${callMain}).dmg + (${callAdj}).dmg * 2) * ${repeat}, avg: ((${callMain}).avg + (${callAdj}).avg * 2) * ${repeat} })`
            : `({ dmg: (${callMain}).dmg + (${callAdj}).dmg * 2, avg: (${callMain}).avg + (${callAdj}).avg * 2 })`
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
      if (!perHit) continue

      const call = makeDmgCallExpr(perHit)
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
          talent: perHit.talent,
          table: perHit.table,
          key: perHit.key,
          ele: perHit.ele,
          stat: (perHit as any).stat,
          params: (perHit as any).params,
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

