import type { CalcSuggestBuff, CalcSuggestInput } from '../types.js'
import { normalizePromptText } from '../utils.js'

/**
 * Apply conservative, baseline-aligned filters for GS buffs.
 *
 * Motivation:
 * - Some constellations/passives have "next cast only" (一次性) multipliers like:
 *   "使下次元素战技造成原本300%伤害".
 * - Baseline meta typically omits those one-shot multipliers (to avoid rotation/state modeling).
 * - When LLM includes them unconditionally (via simple params tags), showcases drift by ~3x+.
 *
 * This filter drops `*Multi` keys from such one-shot buffs (and removes the buff if it becomes empty).
 */
export function applyGsBuffFilterTowardsBaseline(input: CalcSuggestInput, buffs: CalcSuggestBuff[]): void {
  if (input.game !== 'gs') return
  if (!Array.isArray(buffs) || buffs.length === 0) return

  const norm = (sRaw: unknown): string =>
    normalizePromptText(sRaw)
      .replace(/\s+/g, '')
      .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

  const hintsRaw = Array.isArray(input.buffHints) ? input.buffHints : []
  const consHints = new Map<number, string>()
  for (const h0 of hintsRaw) {
    const h = normalizePromptText(h0)
    if (!h) continue
    const m = /^([1-6])\s*命[:：]/.exec(h)
    if (!m) continue
    const cons = Number(m[1])
    if (!Number.isFinite(cons)) continue
    const prev = consHints.get(cons) || ''
    consHints.set(cons, prev ? `${prev} ${h}` : h)
  }

  // One-shot / consumed-after-use markers.
  // Keep this strict: do NOT include generic "本次" (too broad).
  const isOneShotLike = (s: string): boolean => {
    const t = String(s || '')
    if (!t) return false
    // Classic phrasing.
    if (/(下次|下一次|首次)(施放|释放|使用|攻击|普攻|重击|战技|元素战技|爆发|元素爆发|技能)?/.test(t)) return true
    // "Effect lasts N seconds and will be removed after (press/hold/cast/...)".
    // Baseline commonly omits these consumed multipliers to avoid rotation/state modeling.
    const consumed =
      /(后移除|使用后移除|施放后移除|释放后移除|命中后移除|并将在.{0,40}后移除|将在.{0,40}后移除)/.test(t)
    const looksLikeMultiplier = /(造成|提高为|变为|改为).{0,12}原本.{0,6}\d+/.test(t) || /原本\s*\d+(\.\d+)?\s*%/.test(t)
    return consumed && looksLikeMultiplier
  }

  const hasDamageIntent = (evidence: string): boolean => {
    const t = norm(evidence)
    if (!t) return false
    // Keep broad: some buffs omit "提升/增加" but still describe direct damage.
    return /伤害|增伤|造成.{0,12}伤害/.test(t)
  }

  const hasMultiplierIntent = (evidence: string): boolean => {
    const t = norm(evidence)
    if (!t) return false
    return (
      /(倍率|系数|原本|提高到|提升到|提高至|提升至|变为|变成|改为|伤害为原伤害的)/.test(t) ||
      /原本\s*\d+(\.\d+)?\s*%/.test(t)
    )
  }

  const isGsScopedKey = (kRaw: string): boolean => {
    const k = String(kRaw || '').trim()
    if (!k) return false
    // Skill-scoped keys: baseline often uses them for persistent states, but typically omits one-shot ("next cast") effects.
    return /^(a|a2|a3|e|q|nightsoul)(Dmg|Pct|Multi|Plus|Cpct|Cdmg|Enemydmg|Elevated|Def|Ignore)$/.test(k)
  }

  const isDamageLikeKey = (kRaw: string): boolean => {
    const k = String(kRaw || '').trim()
    if (!k || k.startsWith('_')) return false
    if (k === 'dmg' || k === 'phy' || k === 'enemydmg') return true
    if (/Dmg$/.test(k) || /Enemydmg$/.test(k)) return true
    // Skill-scoped buckets that affect outgoing damage numbers in miao-plugin.
    if (/^(a|a2|a3|e|q|nightsoul)(Plus|Pct)$/.test(k)) return true
    return false
  }

  for (let i = buffs.length - 1; i >= 0; i--) {
    const b: any = buffs[i]
    if (!b || typeof b !== 'object') continue
    const title = normalizePromptText(b.title)
    const cons = typeof b.cons === 'number' && Number.isFinite(b.cons) ? Math.trunc(b.cons) : 0
    const hint = cons >= 1 && cons <= 6 ? consHints.get(cons) || '' : ''
    const evidence = `${title} ${hint}`.trim()
    const data = b.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue

    const dmgIntent = hasDamageIntent(evidence)
    const mulIntent = hasMultiplierIntent(evidence)

    let changed = false

    // 1) Drop one-shot ("next cast") multiplier-like keys to match baseline semantics.
    if (evidence && isOneShotLike(evidence)) {
      for (const k of Object.keys(data)) {
        if (/Multi$/.test(String(k || '')) || isGsScopedKey(k)) {
          delete (data as any)[k]
          changed = true
        }
      }
    }

    // 2) Semantic sanity: if the evidence does NOT talk about damage, do NOT emit *Dmg/*Pct/*Plus buckets.
    // This prevents common LLM mistakes like mapping “持续时间延长/施加层数/攻速提升” into qDmg/eMulti.
    for (const k of Object.keys(data)) {
      const key = String(k || '').trim()
      if (!key || key.startsWith('_')) continue

      if (/Multi$/.test(key)) {
        // `*Multi` is only valid for explicit multiplier-change semantics ("原本170%/倍率提高到...").
        if (!mulIntent) {
          delete (data as any)[k]
          changed = true
        }
        continue
      }

      if (isDamageLikeKey(key) && !dmgIntent) {
        delete (data as any)[k]
        changed = true
      }
    }

    if (!changed) continue

    const effectKeys = Object.keys(data).filter((k) => k && !String(k).startsWith('_'))
    if (effectKeys.length === 0) {
      buffs.splice(i, 1)
    }
  }
}
