import type { CalcSuggestBuff, CalcSuggestInput } from '../types.js'
import { jsString, normalizePromptText } from '../utils.js'

const parseMemospriteName = (textRaw: unknown): string | null => {
  const s = normalizePromptText(textRaw)
  if (!s || !/召唤忆灵/.test(s)) return null
  const m =
    /召唤忆灵[^“「『"《》]{0,20}(?:“([^”]{1,12})”|「([^」]{1,12})」|『([^』]{1,12})』|"([^"]{1,12})"|《([^》]{1,12})》)/.exec(
      s
    )
  const name = String(m?.[1] || m?.[2] || m?.[3] || m?.[4] || m?.[5] || '').trim()
  return name || null
}

const parseInitSpeed = (textRaw: unknown): number | null => {
  const s = normalizePromptText(textRaw)
  if (!s) return null
  const m = s.match(/初始拥有\s*(\d{2,3})\s*点速度/)
  if (!m) return null
  const n = Math.trunc(Number(m[1]))
  return Number.isFinite(n) && n >= 1 && n <= 400 ? n : null
}

const hasAnyBuffKey = (buffs: CalcSuggestBuff[], key: string): boolean => {
  const k = String(key || '').trim()
  if (!k) return false
  for (const b of buffs) {
    const data = (b as any)?.data
    if (!data || typeof data !== 'object' || Array.isArray(data)) continue
    if (Object.prototype.hasOwnProperty.call(data, k)) return true
  }
  return false
}

export function applySrBuffPostprocess(opts: {
  input: CalcSuggestInput
  tables: Record<string, string[]>
  buffs: CalcSuggestBuff[]
}): void {
  const { input, tables, buffs } = opts
  if (input.game !== 'sr') return

  const desc = (input.talentDesc || {}) as Record<string, unknown>
  const descZ = normalizePromptText((desc as any).z)
  const descQ = normalizePromptText((desc as any).q)
  const descT = normalizePromptText((desc as any).t)
  const allDesc = [descZ, descQ, descT].filter(Boolean).join(' ')

  // 1) Memosprite base stats: baseline-like `_hpBase/_speedBase` so memosprite damage does not collapse.
  // Trigger when the profile clearly contains Memory/Remembrance blocks (me/mt).
  const hasMemKit = Object.keys(tables || {}).some((k) => /^m[et]\d*$/.test(String(k || '').trim()))
  if (!hasMemKit) return

  const spriteName = parseMemospriteName(descZ) || parseMemospriteName(descQ) || '忆灵'
  const speedBase = parseInitSpeed(descZ) || parseInitSpeed(descQ)

  // Prefer a formula exposed as tables: "<hpPct> + <hpFlat>".
  const pctNames = [
    '生命上限·百分比',
    '生命上限百分比',
    '生命·百分比',
    '生命百分比',
    '生命值·百分比',
    '生命值百分比'
  ]
  const flatNames = ['生命上限·固定值', '生命上限固定值', '生命·固定值', '生命固定值', '生命值·固定值', '生命值固定值']

  let hpExpr: string | null = null
  for (const [tk0, listRaw] of Object.entries(tables || {})) {
    const tk = String(tk0 || '').trim()
    if (!tk) continue
    const list = Array.isArray(listRaw) ? listRaw.map((s) => String(s || '').trim()) : []
    const pct = pctNames.find((n) => list.includes(n)) || ''
    const flat = flatNames.find((n) => list.includes(n)) || ''
    if (!pct || !flat) continue
    hpExpr = `calc(attr.hp) * talent.${tk}[${jsString(pct)}] + talent.${tk}[${jsString(flat)}]`
    break
  }

  // Fallback: a few kits explicitly state the memosprite HP cap is derived from party levels (not representable here).
  // Use the common max-level assumption (4 members at Lv.80) to avoid severe underestimation in regressions.
  if (!hpExpr) {
    const looksLikePartyLevelCap =
      /(上限与场上全体角色等级有关)/.test(allDesc) && /(固定生命上限|固定生命值上限)/.test(allDesc)
    if (looksLikePartyLevelCap) {
      hpExpr = String(80 * 4 * 100)
    }
  }

  if (hpExpr && !hasAnyBuffKey(buffs, '_hpBase')) {
    const title = `${spriteName}状态：基础生命值: [_hpBase]，基础速度: [_speedBase]`
    const data: Record<string, number | string> = {
      _hpBase: hpExpr,
      _speedBase: typeof speedBase === 'number' ? speedBase : 0
    }

    buffs.unshift({
      title,
      tree: 1,
      data
    })
  }

  // 2) Talent stack buffs: when the official talent text clearly exposes a max stack count,
  // align showcase-style buffs to the max stack by default (baseline pattern).
  // Example: "伤害提高…最多叠加3层" -> multiply the derived `dmg` buff by 3.
  try {
    const mMax =
      descT.match(/(?:最多|最高).{0,10}?叠加\s*(\d{1,2})\s*层/) ||
      descT.match(/叠加上限.{0,10}?(\d{1,2})\s*层/)
    const maxStacks0 = mMax ? Math.trunc(Number(mMax[1])) : NaN
    const maxStacks = Number.isFinite(maxStacks0) && maxStacks0 >= 2 && maxStacks0 <= 12 ? maxStacks0 : 0

    if (maxStacks) {
      const hasTTables = Array.isArray((tables as any)?.t) && ((tables as any).t as string[]).includes('伤害提高')
      if (hasTTables) {
        let patched = false
        for (const b of buffs) {
          const data = (b as any)?.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          for (const k0 of Object.keys(data)) {
            const k = String(k0 || '').trim()
            if (!k || k.startsWith('_')) continue
            const v0 = (data as any)[k]
            if (typeof v0 !== 'string') continue
            const v = v0.trim()
            if (!v) continue
            if (!/talent\.t\s*\[\s*["']伤害提高["']\s*\]/.test(v)) continue

            // If the expression already uses a stack param (common LLM output), prefer showcasing max stacks by
            // replacing the param with a constant rather than multiplying again (prevents accidental 3*3).
            const hasMaxMult = new RegExp(`\\*\\s*${maxStacks}(\\D|$)`).test(v)
            const stackConst = hasMaxMult ? '1' : String(maxStacks)
            const reMin = new RegExp(
              `Math\\.min\\(\\s*params\\.[A-Za-z0-9_]+\\s*(?:\\|\\|\\s*0)?\\s*,\\s*${maxStacks}\\s*\\)`,
              'g'
            )
            let out = v
            out = out.replace(reMin, stackConst)
            out = out.replace(/params\.[A-Za-z0-9_]*stacks?\b/gi, stackConst)
            if (out !== v) {
              ;(data as any)[k] = out
              patched = true
              continue
            }

            // Avoid double-scaling if it already contains a stack multiplier.
            if (new RegExp(`\\*\\s*${maxStacks}(\\D|$)`).test(v)) continue
            ;(data as any)[k] = `(${v}) * ${maxStacks}`
            patched = true
          }
        }

        if (!patched) {
          const escapeRe = (s: string): string => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const looksLikeSpriteOnlyDmg =
            spriteName &&
            spriteName !== '忆灵' &&
            new RegExp(`${escapeRe(spriteName)}.{0,18}(?:造成|造成的).{0,18}伤害`).test(descT)
          const key = looksLikeSpriteOnlyDmg ? 'meDmg' : 'dmg'
          buffs.push({
            title: `天赋：伤害提高(${maxStacks}层)`,
            data: {
              [key]: `talent.t[${jsString('伤害提高')}] * 100 * ${maxStacks}`
            }
          })
        }
      }
    }
  } catch {
    // ignore
  }

  // 3) Party-wide constant dmg% buffs: some Memory kits grant a fixed "我方全体造成的伤害提高X%".
  // Baseline often models these as a plain `dmg: X` buff (no params/check).
  try {
    const hintLines = Array.isArray(input.buffHints) ? (input.buffHints as unknown[]) : []
    const lines = [
      ...hintLines,
      (desc as any).z,
      (desc as any).q,
      (desc as any).t
    ]
      .map((s) => normalizePromptText(s))
      .filter(Boolean)

    const re =
      /(我方全体|我方全队|全队|队伍中(?:附近)?的所有角色).{0,12}造成的伤害.{0,12}(?:提高|提升|增加).{0,12}?(\d{1,3}(?:\.\d+)?)\s*%/

    let bestPct = 0
    for (const line of lines) {
      for (const m of line.matchAll(re)) {
        const n0 = Number(m[2])
        if (!Number.isFinite(n0) || n0 <= 0 || n0 > 200) continue
        if (n0 > bestPct) bestPct = n0
      }
    }
    if (bestPct) {
      const hasSimilar = buffs.some((b) => {
        const title = normalizePromptText((b as any)?.title)
        if (!title) return false
        if (!/(全体|全队)/.test(title) || !/伤害/.test(title) || !/(提高|提升|增加)/.test(title)) return false
        const data = (b as any)?.data
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          const v = (data as any).dmg
          if (typeof v === 'number' && Number.isFinite(v)) return Math.abs(v - bestPct) < 1e-9
          if (typeof v === 'string' && v.trim()) return true
        }
        return true
      })
      if (!hasSimilar) {
        buffs.push({
          title: `推导：我方全体造成的伤害提高[dmg]%`,
          data: { dmg: bestPct }
        })
      }
    }
  } catch {
    // ignore
  }

  // 4) Memosprite-only damage buffs: some kits clearly state "忆灵/小X 造成的伤害提高...".
  // LLM may mistakenly model these as global `dmg` (inflating self/basic attack). Normalize them to `meDmg`.
  try {
    if (!descT) return
    if (!/(造成的伤害提高|造成伤害提高)/.test(descT)) return
    if (/(我方全体|我方全队|全队|队伍中|队伍内|队伍里|队友|我方目标|指定我方|除自身)/.test(descT)) return

    const escapeRe = (s: string): string => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const sprite = spriteName && spriteName !== '忆灵' ? spriteName : ''
    const hasSpriteHint =
      /忆灵/.test(descT) ||
      (sprite ? new RegExp(escapeRe(sprite)).test(descT) || new RegExp(`小${escapeRe(sprite)}`).test(descT) : false)
    if (!hasSpriteHint) return

    const refRe = /talent\.t\s*\[\s*["']伤害提高["']\s*\]/
    for (const b of buffs) {
      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue

      let hasMeDmg = Object.prototype.hasOwnProperty.call(data, 'meDmg')
      for (const k0 of Object.keys(data)) {
        const k = String(k0 || '').trim()
        if (!k || k === 'meDmg' || k.startsWith('_')) continue
        const v = (data as any)[k]
        if (typeof v !== 'string' || !v.trim()) continue
        if (!refRe.test(v)) continue

        const looksLikeDmgKey = k === 'dmg' || k.endsWith('Dmg') || k.endsWith('Inc') || k.endsWith('Multi')
        if (!looksLikeDmgKey) continue

        delete (data as any)[k]
        if (!hasMeDmg) {
          ;(data as any).meDmg = v.trim()
          hasMeDmg = true
        }
      }
    }
  } catch {
    // ignore
  }
}
