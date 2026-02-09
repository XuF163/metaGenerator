/**
 * Generate `meta-sr/artifact/calc.js` from upstream relic set bonus texts (Hakush).
 *
 * Why:
 * - `scaffold/meta-sr/artifact/calc.js` should stay minimal (skeleton only).
 * - Real relic set bonuses update with game versions; we want to derive what we can from API texts.
 *
 * Scope (deterministic, no LLM):
 * - Parse common 2/4-piece bonus patterns into miao-plugin buff objects.
 * - Only emit buffs when we can map them to stable numeric keys safely.
 * - Complex conditional mechanics are omitted to avoid wrong calculations.
 *
 * NOTE: This file intentionally avoids raw CJK literals in regex patterns (uses \\u escapes)
 * to reduce encoding-related issues on Windows.
 */

type Buff = {
  title: string
  /** Whether the buff should be auto-applied (unconditional base stats). */
  isStatic?: boolean
  /** Optional condition to enable the buff. */
  check?: string
  data: Record<string, number>
}

export interface SrRelicSetSkills {
  setName: string
  /** Map: pieceCount -> bonus text (e.g. { "2": "...", "4": "..." }) */
  skills: Record<string, string>
}

function normalize(textRaw: string): string {
  // Convert rich-text to plain for parsing:
  // - <br/> -> 。 (sentence splitter)
  // - strip <nobr> and other tags
  return textRaw
    .replaceAll('\r', '')
    .replaceAll('\n', '')
    .replaceAll('<br />', '\u3002')
    .replaceAll('<br/>', '\u3002')
    .replaceAll('<br>', '\u3002')
    .replaceAll('<nobr>', '')
    .replaceAll('</nobr>', '')
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, '')
    .trim()
}

function num(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

type Condition = { check: string; effectText: string }

function splitEffectTextFromConditionalSentence(seg: string): string {
  // Prefer: 当...时，<effect>
  const commaIdx = seg.indexOf('\uff0c')
  if (commaIdx >= 0 && commaIdx + 1 < seg.length) return seg.slice(commaIdx + 1)
  const commaIdx2 = seg.indexOf(',')
  if (commaIdx2 >= 0 && commaIdx2 + 1 < seg.length) return seg.slice(commaIdx2 + 1)
  const thenIdx = seg.indexOf('\u5219') // 则
  if (thenIdx >= 0 && thenIdx + 1 < seg.length) return seg.slice(thenIdx + 1)
  return seg
}

function parseCondition(seg: string): Condition | null {
  // Complex dual-threshold forms like "110/95" are not supported (skip to avoid wrong buffs).
  if (/\d+\/\d+/.test(seg)) return null

  // Action-like triggers (no stable numeric condition): keep deterministic by omitting `check`
  // and letting the caller decide whether to fall back to an unconditional approximation.

  // Speed <= N
  let m = seg.match(/\u901f\u5ea6(?:\u5c0f\u4e8e\u7b49\u4e8e|\u4e0d\u5927\u4e8e|<=|\u2264)(\d+(?:\.\d+)?)/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.speed) <= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // Speed < N
  m = seg.match(/\u901f\u5ea6(?:\u5c0f\u4e8e|<|\u4f4e\u4e8e)(\d+(?:\.\d+)?)/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.speed) < ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  // Speed >= N
  m = seg.match(/\u901f\u5ea6(?:\u5927\u4e8e\u7b49\u4e8e|\u4e0d\u4f4e\u4e8e|>=|\u2265)(\d+(?:\.\d+)?)/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.speed) >= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // Speed > N
  m = seg.match(/\u901f\u5ea6(?:\u5927\u4e8e|>|\u9ad8\u4e8e)(\d+(?:\.\d+)?)/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.speed) > ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  // HP >= N (points)
  m = seg.match(
    /\u751f\u547d(?:\u4e0a\u9650|\u503c\u4e0a\u9650)(?:\u5927\u4e8e\u7b49\u4e8e|\u4e0d\u4f4e\u4e8e|>=|\u2265)(\d+(?:\.\d+)?)(?:\u70b9)?/
  )
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.hp) >= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // HP > N (points)
  m = seg.match(
    /\u751f\u547d(?:\u4e0a\u9650|\u503c\u4e0a\u9650)(?:\u5927\u4e8e|>|\u8d85\u8fc7)(\d+(?:\.\d+)?)(?:\u70b9)?/
  )
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.hp) > ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // HP <= N (points)
  m = seg.match(
    /\u751f\u547d(?:\u4e0a\u9650|\u503c\u4e0a\u9650)(?:\u5c0f\u4e8e\u7b49\u4e8e|\u4e0d\u5927\u4e8e|<=|\u2264)(\d+(?:\.\d+)?)(?:\u70b9)?/
  )
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.hp) <= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // HP < N (points)
  m = seg.match(
    /\u751f\u547d(?:\u4e0a\u9650|\u503c\u4e0a\u9650)(?:\u5c0f\u4e8e|<|\u4f4e\u4e8e)(\d+(?:\.\d+)?)(?:\u70b9)?/
  )
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.hp) < ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  // Crit rate >= N%
  m = seg.match(/\u66b4\u51fb\u7387(?:\u5927\u4e8e\u7b49\u4e8e|\u4e0d\u4f4e\u4e8e|>=|\u2265)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.cpct) >= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // Crit rate > N%
  m = seg.match(/\u66b4\u51fb\u7387(?:\u5927\u4e8e|>|\u9ad8\u4e8e)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.cpct) > ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  // Effect hit >= N%
  m = seg.match(/\u6548\u679c\u547d\u4e2d(?:\u5927\u4e8e\u7b49\u4e8e|\u4e0d\u4f4e\u4e8e|>=|\u2265)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.effPct) >= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // Effect hit > N%
  m = seg.match(/\u6548\u679c\u547d\u4e2d(?:\u5927\u4e8e|>|\u9ad8\u4e8e)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.effPct) > ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  // Effect RES (效果抵抗) >= N%
  m = seg.match(/\u6548\u679c\u62b5\u6297(?:\u5927\u4e8e\u7b49\u4e8e|\u4e0d\u4f4e\u4e8e|>=|\u2265)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.effDef) >= ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }
  // Effect RES (效果抵抗) > N%
  m = seg.match(/\u6548\u679c\u62b5\u6297(?:\u5927\u4e8e|>|\u9ad8\u4e8e)(\d+(?:\.\d+)?)%/)
  if (m) {
    const n = num(m[1])
    if (n > 0) {
      return {
        check: `({ calc, attr }) => calc(attr.effDef) > ${n}`,
        effectText: splitEffectTextFromConditionalSentence(seg)
      }
    }
  }

  return null
}

const STATIC_KEYS = new Set([
  'atkPct',
  'hpPct',
  'defPct',
  'atkPlus',
  'hpPlus',
  'defPlus',
  'speedPct',
  'speed',
  'cpct',
  'cdmg',
  'recharge',
  'heal',
  'shield',
  'stance',
  'effPct',
  'effDef',
  // Elements
  'phy',
  'fire',
  'ice',
  'elec',
  'wind',
  'quantum',
  'imaginary'
])

function isStaticData(data: Record<string, number>): boolean {
  const keys = Object.keys(data)
  if (keys.length === 0) return false
  return keys.every((k) => STATIC_KEYS.has(k))
}

function parseElementDmgBonus(seg: string): Record<string, number> {
  // e.g. "火属性伤害提高10%" / "物理属性伤害提升10%"
  const inc = '(?:\\u63d0\\u9ad8|\\u63d0\\u5347)'
  const re = new RegExp(
    `(${[
      '\\\\u7269\\\\u7406', // 物理
      '\\\\u706b', // 火
      '\\\\u51b0', // 冰
      '\\\\u96f7', // 雷
      '\\\\u98ce', // 风
      '\\\\u91cf\\\\u5b50', // 量子
      '\\\\u865a\\\\u6570' // 虚数
    ].join('|')})\\\\u5c5e\\\\u6027\\\\u4f24\\\\u5bb3${inc}(\\\\d+(?:\\\\.\\\\d+)?)%`
  )
  const m = seg.match(re)
  if (!m) return {}
  const elem = m[1]
  const v = num(m[2])
  if (!(v > 0)) return {}
  const map: Record<string, string> = {
    '\u7269\u7406': 'phy',
    '\u706b': 'fire',
    '\u51b0': 'ice',
    '\u96f7': 'elec',
    '\u98ce': 'wind',
    '\u91cf\u5b50': 'quantum',
    '\u865a\u6570': 'imaginary'
  }
  const key = map[elem]
  return key ? { [key]: v } : {}
}

function parseData(segRaw: string): Record<string, number> {
  const seg = segRaw
  const data: Record<string, number> = {}
  const inc = '(?:\\u63d0\\u9ad8|\\u63d0\\u5347|\\u589e\\u52a0)'

  const add = (k: string, v: number): void => {
    if (!(v > 0)) return
    data[k] = v
  }

  const addSum = (k: string, v: number): void => {
    if (!(v > 0)) return
    data[k] = (data[k] || 0) + v
  }

  // Base stats
  let m = seg.match(new RegExp(`\\u653b\\u51fb\\u529b${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('atkPct', num(m[1]))
  m = seg.match(new RegExp(`\\u751f\\u547d(?:\\u503c|\\u4e0a\\u9650)${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('hpPct', num(m[1]))
  m = seg.match(new RegExp(`\\u9632\\u5fa1\\u529b${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('defPct', num(m[1]))
  m = seg.match(new RegExp(`\\u901f\\u5ea6${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('speedPct', num(m[1]))

  // Crit
  m = seg.match(new RegExp(`\\u66b4\\u51fb\\u7387${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('cpct', num(m[1]))
  m = seg.match(new RegExp(`\\u66b4\\u51fb\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('cdmg', num(m[1]))

  // Break / energy / effect hit-res
  m = seg.match(new RegExp(`\\u51fb\\u7834\\u7279\\u653b${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('stance', num(m[1]))
  m = seg.match(new RegExp(`(?:\\u80fd\\u91cf\\u6062\\u590d\\u6548\\u7387|\\u5145\\u80fd\\u6548\\u7387)${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('recharge', num(m[1]))
  m = seg.match(new RegExp(`\\u6548\\u679c\\u547d\\u4e2d${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('effPct', num(m[1]))
  m = seg.match(new RegExp(`\\u6548\\u679c\\u62b5\\u6297${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('effDef', num(m[1]))

  // Heal / shield
  m = seg.match(new RegExp(`(?:\\u6cbb\\u7597\\u91cf|\\u6cbb\\u7597\\u52a0\\u6210)${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('heal', num(m[1]))
  m = seg.match(new RegExp(`(?:\\u62a4\\u76fe\\u5f3a\\u6548|\\u62a4\\u76fe)${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) add('shield', num(m[1]))

  // Element dmg bonus
  Object.assign(data, parseElementDmgBonus(seg))

  // Damage bonuses (SR)
  // - 普攻/战技/终结技/追击(追加攻击)
  let hasSkillSpecificDmgBonus = false

  m = seg.match(new RegExp(`(?:\\u666e\\u901a\\u653b\\u51fb|\\u666e\\u653b)\\u548c\\u6218\\u6280(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    const v = num(m[1])
    add('aDmg', v)
    add('eDmg', v)
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`\\u6218\\u6280(?:\\u4e0e|\\u548c)\\u7ec8\\u7ed3\\u6280(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    const v = num(m[1])
    add('eDmg', v)
    add('qDmg', v)
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`\\u7ec8\\u7ed3\\u6280(?:\\u4e0e|\\u548c)(?:\\u8ffd\\u51fb|\\u8ffd\\u52a0\\u653b\\u51fb)(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    const v = num(m[1])
    add('qDmg', v)
    add('tDmg', v)
    hasSkillSpecificDmgBonus = true
  }

  // Baseline-style approximation: treat “after ult, next skill extra dmg%” as always-on for E.
  // Example: “战技和终结技造成的伤害提高20%，施放终结技后，下一次施放战技时造成的伤害额外提高25%”
  m = seg.match(
    new RegExp(
      `\\u65bd\\u653e\\u7ec8\\u7ed3\\u6280\\u540e[^\\u3002;]*?\\u4e0b\\u4e00\\u6b21\\u65bd\\u653e\\u6218\\u6280[^\\u3002;]*?\\u4f24\\u5bb3(?:\\u989d\\u5916)?${inc}(\\d+(?:\\.\\d+)?)%`
    )
  )
  if (m) {
    addSum('eDmg', num(m[1]))
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`(?:\\u666e\\u901a\\u653b\\u51fb|\\u666e\\u653b)(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    add('aDmg', num(m[1]))
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`\\u6218\\u6280(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    add('eDmg', num(m[1]))
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`\\u7ec8\\u7ed3\\u6280(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    add('qDmg', num(m[1]))
    hasSkillSpecificDmgBonus = true
  }
  m = seg.match(new RegExp(`(?:\\u8ffd\\u51fb|\\u8ffd\\u52a0\\u653b\\u51fb)(?:\\u9020\\u6210\\u7684)?\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m) {
    add('tDmg', num(m[1]))
    hasSkillSpecificDmgBonus = true
  }

  // Generic dmg% (ambiguous, keep as dmg)
  m = seg.match(new RegExp(`\\u9020\\u6210\\u7684\\u4f24\\u5bb3${inc}(\\d+(?:\\.\\d+)?)%`))
  if (m && !hasSkillSpecificDmgBonus) add('dmg', num(m[1]))

  // Ignore DEF
  m = seg.match(/(?:\u65e0\u89c6|ignore).*?(\d+(?:\.\d+)?)%.*?\u9632\u5fa1/)
  if (m) add('ignore', num(m[1]))

  return data
}

function parseSkillText(textRaw: string): Buff[] {
  const text = normalize(textRaw)
  if (!text) return []

  // Split into short sentences (keep deterministic, avoid overfitting).
  const segs = text
    .split(/[\u3002\uff1b;]/g)
    .map((s) => s.trim())
    .filter(Boolean)

  const out: Buff[] = []

  for (const seg of segs) {
    // If the sentence contains an explicit conditional marker, try to:
    // 1) parse the prefix part as unconditional buffs
    // 2) parse the conditional part only when we can map it into a safe `check` function
    const markers: Array<{ idx: number; len: number }> = []
    const idxIf = seg.indexOf('\u5982\u679c') // 如果
    if (idxIf >= 0) markers.push({ idx: idxIf, len: 2 })
    const idxWhen = seg.indexOf('\u5f53') // 当
    if (idxWhen >= 0) markers.push({ idx: idxWhen, len: 1 })
    const idxIf2 = seg.indexOf('\u82e5') // 若
    if (idxIf2 >= 0) markers.push({ idx: idxIf2, len: 1 })

    const marker = markers.sort((a, b) => a.idx - b.idx)[0]
    if (marker) {
      const prefix = seg.slice(0, marker.idx).replace(/^[\uff0c,]+|[\uff0c,]+$/g, '')
      const condPart = seg.slice(marker.idx)

      const prefixData = parseData(prefix)
      if (Object.keys(prefixData).length > 0) {
        out.push({
          title: prefix,
          ...(isStaticData(prefixData) ? { isStatic: true } : {}),
          data: prefixData
        })
      }

      const cond = parseCondition(condPart)
      if (cond) {
        const data = parseData(cond.effectText)
        if (Object.keys(data).length > 0) {
          out.push({
            title: seg,
            check: cond.check,
            data
          })
        }
      } else {
        // Some upstream relic bonuses use action-like "当...施放战技/终结技时..." triggers.
        // Baseline meta often approximates these as always-on showcase buffs; keep them *only* when the
        // trigger is action/battle-flow related (not status/threshold), to avoid wrong unconditional buffs.
        const isActionLike =
          /\u65bd\u653e|\u91ca\u653e|\u4f7f\u7528|\u5165\u6218|\u6218\u6597\u5f00\u59cb|\u56de\u5408\u5f00\u59cb/.test(
            condPart
          )
        if (isActionLike) {
          const effectText = splitEffectTextFromConditionalSentence(condPart)
          const data = parseData(effectText)
          if (Object.keys(data).length > 0) {
            out.push({
              title: seg,
              ...(isStaticData(data) ? { isStatic: true } : {}),
              data
            })
          }
        }
      }
      continue
    }

    const data = parseData(seg)
    if (Object.keys(data).length === 0) continue
    out.push({
      title: seg,
      ...(isStaticData(data) ? { isStatic: true } : {}),
      data
    })
  }

  return out
}

function renderDataObject(data: Record<string, number>, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel)
  const innerIndent = '  '.repeat(indentLevel + 1)
  const entries = Object.entries(data).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return '{}'

  const lines: string[] = ['{']
  for (const [k, v] of entries) {
    lines.push(`${innerIndent}${k}: ${Number.isFinite(v) ? String(v) : '0'},`)
  }
  lines.push(`${indent}}`)
  return lines.join('\n')
}

function renderBuff(buff: Buff): string {
  const lines: string[] = []
  lines.push('{')
  lines.push(`  title: ${JSON.stringify(buff.title)},`)
  if (buff.isStatic) lines.push('  isStatic: true,')
  if (buff.check) lines.push(`  check: ${buff.check},`)
  lines.push(`  data: ${renderDataObject(buff.data, 1)}`)
  lines.push('}')
  return lines.join('\n')
}

export function buildSrArtifactCalcJs(sets: SrRelicSetSkills[]): string {
  const out: Array<{ name: string; buffs: Record<number, Buff | Buff[]> }> = []

  for (const s of sets) {
    const parsed: Record<number, Buff | Buff[]> = {}
    for (const [k, v] of Object.entries(s.skills || {})) {
      const need = Number(k)
      if (!Number.isFinite(need) || need <= 0) continue
      if (typeof v !== 'string' || !v.trim()) continue

      const buffs = parseSkillText(v)
      if (buffs.length === 0) continue
      parsed[need] = buffs.length === 1 ? buffs[0]! : buffs
    }

    if (Object.keys(parsed).length === 0) continue
    out.push({ name: s.setName, buffs: parsed })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const lines: string[] = [
    '/**',
    ' * Auto-generated relic buff table.',
    ' *',
    ' * Source: Hakush relic set bonus texts (meta-sr/artifact/data.json -> skills).',
    ' * Notes:',
    ' * - Only deterministic patterns are converted into miao-plugin buff keys.',
    ' * - Complex conditional effects are omitted (not represented) to avoid wrong calculations.',
    ' */',
    'const buffs = {'
  ]

  for (const s of out) {
    lines.push(`  ${JSON.stringify(s.name)}: {`)
    const needs = Object.keys(s.buffs)
      .map((n) => Number(n))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    for (const need of needs) {
      const v = s.buffs[need]
      if (!v) continue
      if (Array.isArray(v)) {
        const rendered = v
          .map((b) => renderBuff(b).split('\n').map((l) => `      ${l}`).join('\n'))
          .join(',\n')
        lines.push(`    ${need}: [`)
        lines.push(rendered)
        lines.push('    ],')
      } else {
        const rendered = renderBuff(v)
          .split('\n')
          .map((l) => `    ${l}`)
          .join('\n')
        lines.push(`    ${need}: ${rendered},`)
      }
    }
    lines.push('  },')
  }

  lines.push('}')
  lines.push('')
  lines.push('export default buffs')
  lines.push('')
  return lines.join('\n')
}
