import type { CalcSuggestDetail, CalcSuggestInput } from '../types.js'
import { normalizePromptText } from '../utils.js'
import { normalizeKind } from './normalize.js'

function keyBucket(keyRaw: unknown, fallback: string): string {
  const k0 = typeof keyRaw === 'string' ? keyRaw.trim() : ''
  const k = k0 || fallback
  const head = k.split(',')[0]?.trim() || ''
  return head.toLowerCase()
}

function mapAltAttackTable(tableRaw: unknown): { key: 'a' | 'a2' | 'a3'; title: string } | null {
  const table = normalizePromptText(tableRaw)
  if (!table) return null

  const seg = /^(一|二|三|四|五|六|七|八|九|十)段伤害/.exec(table)
  if (seg) {
    const cn = seg[1]!
    const segName = cn === '一' ? '首段' : `${cn}段`
    return { key: 'a', title: `Q状态·普攻${segName}` }
  }

  if (/重击伤害/.test(table)) return { key: 'a2', title: `Q状态·重击伤害` }

  if (/下落攻击伤害/.test(table)) return { key: 'a3', title: `Q状态·下落攻击伤害` }
  if (/坠地冲击伤害/.test(table)) return { key: 'a3', title: `Q状态·坠地冲击伤害` }
  if (/下坠期间伤害/.test(table)) return { key: 'a3', title: `Q状态·下坠期间伤害` }

  return null
}

function inferReactionSuffixFromTitle(titleRaw: unknown): string {
  const t = normalizePromptText(titleRaw)
  if (!t) return ''
  const picks = ['蒸发', '融化', '超激化', '激化', '扩散', '结晶', '超绽放', '烈绽放', '绽放', '超导', '感电', '碎冰']
  for (const p of picks) {
    if (t.includes(p)) return p
  }
  return ''
}

/**
 * GS: when Burst (Q) enters a state that *replaces* normal/charged/plunging attack multipliers,
 * and the description does NOT say those attacks "count as Elemental Burst DMG",
 * we should route those rows into the normal-attack dmgKey buckets (a/a2/a3), like baseline meta.
 *
 * This is a common source of large regression drift:
 * - LLM emits q-table segment rows but uses key=q, so aPlus/aDmg buffs don't apply.
 * - Baseline typically renders them as "Q状态·普攻首段" with key=a.
 */
export function applyGsBurstAltAttackKeyMapping(input: CalcSuggestInput, details: CalcSuggestDetail[]): void {
  if (input.game !== 'gs') return
  if (!Array.isArray(details) || details.length === 0) return

  const descQ = normalizePromptText((input.talentDesc as any)?.q)
  if (!descQ) return

  const hasAttackWords = /(普通攻击|普攻|重击|下落攻击)/.test(descQ)
  const hasConvertWords = /(转为|转化为|转换为|附魔|替换为|变为|变成)/.test(descQ)
  if (!hasAttackWords || !hasConvertWords) return

  // If the official wording explicitly says the converted attacks are Burst DMG, keep key=q (e.g. Raiden).
  const countsAsBurst = /(视为|视作).{0,24}元素爆发伤害/.test(descQ)
  if (countsAsBurst) return

  for (const d0 of details) {
    const d: any = d0 as any
    if (!d || typeof d !== 'object') continue
    if (normalizeKind(d.kind) !== 'dmg') continue
    if (d.talent !== 'q') continue
    if (typeof d.table !== 'string' || !d.table.trim()) continue

    const mapped = mapAltAttackTable(d.table)
    if (!mapped) continue

    // Only rewrite when it was emitted as a Q-bucket row (avoid double-rewriting if the model already did it).
    const bucket = keyBucket(d.key, 'q')
    if (bucket !== 'q') continue

    d.key = mapped.key

    const suffix = inferReactionSuffixFromTitle(d.title)
    if (!suffix) {
      d.title = mapped.title
    } else {
      // Keep reaction variants distinguishable, but still route them to the correct bucket.
      d.title = `${mapped.title}${suffix}`
    }

    const p0 = d.params
    const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as any) } : {}
    if (p.q === undefined) p.q = true
    d.params = p
  }
}

