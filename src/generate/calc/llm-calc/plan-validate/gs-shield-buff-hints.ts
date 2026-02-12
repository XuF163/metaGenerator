import type { CalcSuggestBuff, CalcSuggestDetail, CalcSuggestInput } from '../types.js'
import { normalizePromptText } from '../utils.js'
import { normalizeKind } from './normalize.js'

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n))
}

export function applyGsShieldStrengthBuffFromHints(opts: {
  input: CalcSuggestInput
  details: CalcSuggestDetail[]
  buffs: CalcSuggestBuff[]
}): void {
  if (opts.input.game !== 'gs') return
  if (!opts.details.some((d) => normalizeKind((d as any)?.kind) === 'shield')) return

  const hintLines = (Array.isArray(opts.input.buffHints) ? opts.input.buffHints : [])
    .map((s) => normalizePromptText(s))
    .filter(Boolean)
  if (hintLines.length === 0) return

  // Example (Zhongli passive):
  // - "·处于玉璋护盾庇护下的角色，护盾强效提升5%；"
  // - "·该效果至多叠加5次..."
  let perStackPct: number | null = null
  let maxStacks: number | null = null

  const rePer = /护盾强效.{0,12}(?:提升|提高|增加)\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/
  const reCap = /(?:至多|最多|最高)\s*(?:可)?(?:叠加|累积)\s*([0-9]{1,2})\s*(?:次|层)/
  for (const line of hintLines) {
    const mPer = rePer.exec(line)
    if (mPer) {
      const n = Number(mPer[1])
      if (Number.isFinite(n) && n > 0 && n <= 80) {
        perStackPct = perStackPct == null ? n : Math.max(perStackPct, n)
      }
    }
    const mCap = reCap.exec(line)
    if (mCap) {
      const n = Number(mCap[1])
      if (Number.isFinite(n) && n >= 1 && n <= 20) {
        maxStacks = maxStacks == null ? n : Math.max(maxStacks, n)
      }
    }
  }

  if (perStackPct == null) return
  const stacks = maxStacks ?? 1
  const total = clamp(perStackPct * stacks, 0, 200)
  if (!Number.isFinite(total) || total <= 0) return

  const title = stacks > 1 ? `推导：护盾强效提高${total}%（默认满层）` : `推导：护盾强效提高${total}%`
  const already = opts.buffs.some((b) => {
    if (!b || typeof b !== 'object') return false
    const t = typeof (b as any).title === 'string' ? String((b as any).title) : ''
    if (t === title) return true
    if (!/^推导：护盾强效提高/.test(t)) return false
    const data = (b as any).data
    if (!data || typeof data !== 'object' || Array.isArray(data)) return false
    const shield = (data as any).shield
    return typeof shield === 'number' && Number.isFinite(shield) && Math.abs(shield - total) < 1e-9
  })
  if (already) return

  opts.buffs.unshift({ title, data: { shield: total } })
}
