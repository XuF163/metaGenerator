import type { CalcSuggestDetail } from '../types.js'

/**
 * GS: normalize some common titles towards baseline conventions to improve
 * panel-regression matching while keeping generation generic.
 */
export function normalizeGsDetailTitlesTowardsBaseline(details: CalcSuggestDetail[]): void {
  if (!Array.isArray(details) || details.length === 0) return

  const cnSegToBaseline = (seg: string): string => {
    const s = String(seg || '').trim()
    if (!s) return s
    if (s === '一') return '首'
    return s
  }

  const shouldAppendDmgWord = (title: string): boolean => {
    const t = String(title || '').trim()
    if (!t) return false
    if (/伤害|治疗|回复|护盾|吸收量|护盾量/.test(t)) return false
    return true
  }

  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (typeof d.title !== 'string') continue
    let t = d.title.trim()
    if (!t) continue

    // Baseline commonly uses "首段/二段/三段..." for normal attack hit segments.
    // Only rewrite the "普攻一段" form when it's either the root title or under a "…状态·" prefix,
    // so we don't accidentally change contexts like "Q后普攻一段" (baseline tends to keep "一段" there).
    t = t.replace(/(^|状态[·・]?)普攻一段(?=[(（\\s]|伤害|$)/g, '$1普攻首段')

    // Some models output segmented NA titles as bare "一段伤害/二段伤害..." (missing "普攻" prefix).
    // Baseline typically uses "普攻首段伤害/普攻二段伤害...".
    if ((d as any).talent === 'a') {
      t = t.replace(/^([一二三四五六七八九十])段伤害/, (_, seg) => `普攻${cnSegToBaseline(seg)}段伤害`)
      t = t.replace(/^普攻一段伤害/, '普攻首段伤害')
    }

    // Baseline ordering for stage-like titles: "肆阶xxx伤害" instead of "xxx·肆阶".
    // Keep it generic: only handle obvious "·X阶" suffixes.
    const mStage = /^(.+?)[·・]([壹贰叁肆伍陆柒捌玖拾一二三四五六七八九十]阶)$/.exec(t)
    if (mStage) {
      const name = String(mStage[1] || '').trim()
      const stage = String(mStage[2] || '').trim()
      if (name && stage) t = `${stage}${name}${shouldAppendDmgWord(t) ? '伤害' : ''}`
    }

    d.title = t
  }
}
