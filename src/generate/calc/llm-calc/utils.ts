import type { CalcSuggestDetail } from './types.js'

export function jsString(v: string): string {
  // JSON.stringify does NOT escape U+2028/U+2029, which can break JS parsing when embedded in source.
  return JSON.stringify(v).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
}

export function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

export function normalizeTableList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return uniq(list.map((s) => String(s || '').trim()).filter(Boolean))
}

export function clampDetails(details: Array<unknown>, max = 20): CalcSuggestDetail[] {
  const out: CalcSuggestDetail[] = []
  for (const dRaw of details) {
    if (!dRaw || typeof dRaw !== 'object') continue
    if (out.length >= max) break

    const d = dRaw as Record<string, unknown>
    const title = typeof d.title === 'string' ? d.title.trim() : ''
    if (!title) continue

    const kind = typeof d.kind === 'string' ? d.kind.trim() : undefined
    const talent = typeof d.talent === 'string' ? d.talent.trim() : undefined
    const table = typeof d.table === 'string' ? d.table.trim() : undefined
    const key = typeof d.key === 'string' ? d.key.trim() : undefined
    const ele = typeof d.ele === 'string' ? d.ele.trim() : undefined
    const pick =
      typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
    const stat = typeof d.stat === 'string' ? d.stat.trim() : undefined
    const reaction = typeof d.reaction === 'string' ? d.reaction.trim() : undefined
    const dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : undefined
    const check = typeof d.check === 'string' ? d.check.trim() : undefined
    const cons = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    const paramsRaw = d.params
    const params =
      paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw)
        ? (paramsRaw as Record<string, number | boolean | string>)
        : undefined

    out.push({
      title,
      kind: kind as any,
      talent: talent as any,
      table,
      key,
      ele,
      pick,
      stat: stat as any,
      reaction,
      dmgExpr,
      check,
      cons,
      params
    })
  }
  return out
}

export function clampBuffs(buffs: Array<unknown>, max = 30): Array<unknown> {
  const out: Array<unknown> = []
  for (const b of buffs) {
    if (!b || typeof b !== 'object') continue
    if (out.length >= max) break
    if (!(b as any).title) continue
    out.push(b)
  }
  return out
}

export function isAllowedMiaoBuffDataKey(game: string, key: string): boolean {
  // Prevent emitting keys that miao-plugin will interpret and then crash on
  // due to missing attr buckets in that game mode (e.g. gs + speedPct).
  //
  // Keep this aligned with miao-plugin's DmgAttr.calcAttr key parsing:
  // - gs creates attr buckets: atk/def/hp + mastery/recharge/cpct/cdmg/heal/dmg/phy + shield
  // - sr creates attr buckets: atk/def/hp/speed + recharge/cpct/cdmg/heal/dmg/enemydmg/effPct/effDef/stance + shield
  if (!key) return false
  if (key.startsWith('_')) return true // placeholder-only keys (safe, ignored by DmgAttr)

  if (game === 'gs') {
    if (/^(hp|atk|def)(Base|Plus|Pct|Inc)?$/.test(key)) return true
    if (/^(mastery|cpct|cdmg|heal|recharge|dmg|phy|shield)(Plus|Pct|Inc)?$/.test(key)) return true
    if (/^(enemyDef|enemyIgnore|ignore)$/.test(key)) return true
    if (/^(kx|fykx|multi|fyplus|fypct|fybase|fyinc|fycdmg|elevated)$/.test(key)) return true
    if (
      /^(vaporize|melt|crystallize|burning|superConduct|swirl|electroCharged|shatter|overloaded|bloom|burgeon|hyperBloom|aggravate|spread|lunarCharged|lunarBloom|lunarCrystallize)$/.test(
        key
      )
    ) {
      return true
    }
    if (/^(a|a2|a3|e|q|nightsoul)(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(key)) return true
    return false
  }

  // sr
  if (/^(hp|atk|def|speed)(Base|Plus|Pct|Inc)?$/.test(key)) return true
  if (/^(speed|recharge|cpct|cdmg|heal|dmg|enemydmg|effPct|effDef|shield|stance)(Plus|Pct|Inc)?$/.test(key)) return true
  if (/^(enemyDef|enemyIgnore|ignore)$/.test(key)) return true
  if (/^(kx|multi)$/.test(key)) return true
  // Keep aligned with miao-plugin's DmgAttr key parsing (SR does NOT recognize e2/q2/me2/mt2 in buff keys).
  if (/^(a|a2|a3|e|q|t|me|mt|dot|break)(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(key))
    return true
  if (/^elation(Pct|Enemydmg|Merrymake|Def|Ignore)?$/.test(key)) return true
  return false
}

export function normalizePromptText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u00a0/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('\\n', ' ')
    .replaceAll('\n', ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function shortenText(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

