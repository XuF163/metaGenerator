/**
 * Generate `meta-gs/artifact/calc.js` from upstream artifact set bonus texts (Hakush).
 *
 * Why:
 * - `scaffold/meta-gs/artifact/calc.js` should stay minimal (skeleton only).
 * - Real artifact set bonuses update with game versions; we want to derive what we can from API texts.
 *
 * Scope (deterministic, no LLM):
 * - Parse common 2/4-piece bonus patterns into miao-plugin buff objects.
 * - Focus on base-attr static buffs (applied automatically) and simple dmg/crit bonus buffs (shown in buff list).
 * - Complex conditional mechanics are left unparsed (omitted).
 */

type Buff = {
  title: string
  isStatic?: boolean
  elem?: string
  data: Record<string, unknown>
}

export interface ArtifactSetSkills {
  setName: string
  /** Map: pieceCount -> bonus text (e.g. { "2": "...", "4": "..." }) */
  skills: Record<string, string>
}

function normalize(text: string): string {
  return text
    .replaceAll('\r', '')
    .replaceAll('\n', '')
    .replaceAll('\\n', '')
    .replaceAll('％', '%')
    .replaceAll('点。', '点')
    .replaceAll('。', '')
    .trim()
}

function num(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) ? n : 0
}

function mkStatic(title: string, key: string, value: number, extra?: Pick<Buff, 'elem'>): Buff {
  return {
    title,
    isStatic: true,
    ...(extra ?? {}),
    data: { [key]: value }
  }
}

function mkBuff(title: string, data: Record<string, unknown>, extra?: Pick<Buff, 'elem'>): Buff {
  return {
    title,
    ...(extra ?? {}),
    data
  }
}

const ELEMENTS = ['火', '水', '雷', '冰', '风', '岩', '草'] as const
type ElementCn = (typeof ELEMENTS)[number]

function parseElementCn(s: string): ElementCn | null {
  for (const e of ELEMENTS) {
    if (s.includes(e)) return e
  }
  return null
}

/**
 * Parse a single bonus text into a buff object.
 * Returns null if we cannot deterministically map it into miao-plugin keys.
 */
export function parseGsArtifactBonus(textRaw: string, need: number): Buff | null {
  const text = normalize(textRaw)
  if (!text) return null

  // ----- Crit patterns (skill-specific) -----
  // NOTE: must come before generic "暴击率提高" to avoid mis-classifying charged crit bonuses.
  let m = text.match(/重击的暴击率(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { a2Cpct: num(m[1]) })

  m = text.match(/(?:普通攻击|普攻)的暴击率(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { aCpct: num(m[1]) })

  m = text.match(/元素爆发的暴击率(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { qCpct: num(m[1]) })

  // ----- Simple dmg/crit bonuses (shown in buff list) -----
  // Normal/charged/skill/burst dmg bonus
  m = text.match(/(?:普通攻击|普攻)与重击造成的伤害(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { aDmg: num(m[1]), a2Dmg: num(m[1]) })

  m = text.match(/(?:普通攻击|普攻)造成的伤害(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { aDmg: num(m[1]) })

  m = text.match(/重击造成的伤害(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { a2Dmg: num(m[1]) })

  m = text.match(/元素战技造成的伤害(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { eDmg: num(m[1]) })

  m = text.match(/元素爆发造成的伤害(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkBuff(textRaw, { qDmg: num(m[1]) })

  // Generic "damage +X%" (ambiguous, but baseline uses `dmg` for some sets)
  m = text.match(/造成的伤害(?:增加|提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) {
    // If text explicitly mentions an element, try to treat it as element-specific dmg bonus.
    const elem = parseElementCn(text)
    if (elem) return mkBuff(textRaw, { dmg: num(m[1]) }, { elem })
    return mkBuff(textRaw, { dmg: num(m[1]) })
  }

  // Only 2-piece bonuses are guaranteed to be unconditional stat bonuses.
  // We only auto-apply (isStatic=true) for <=2 piece effects to avoid wrong calculations on complex 4-piece texts.
  const allowStatic = Number.isFinite(need) && need > 0 && need <= 2
  if (!allowStatic) return null

  // ----- Base-attr static buffs (auto applied) -----
  // HP/ATK/DEF %
  m = text.match(/生命值(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'hpPct', num(m[1]))
  m = text.match(/攻击力(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'atkPct', num(m[1]))
  m = text.match(/防御力(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'defPct', num(m[1]))

  // EM / ER
  m = text.match(/元素精通(?:提高|提升)(\d+)(?:点)?/)
  if (m) return mkStatic(textRaw, 'mastery', num(m[1]))
  m = text.match(/元素充能效率(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'recharge', num(m[1]))

  // Crit / Heal / Shield / Physical
  m = text.match(/暴击率(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'cpct', num(m[1]))
  m = text.match(/治疗加成(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'heal', num(m[1]))
  m = text.match(/护盾强效(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'shield', num(m[1]))
  m = text.match(/物理伤害(?:加成)?(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'phy', num(m[1]))

  // Elemental dmg bonus (element-specific)
  // Examples: "获得15%火元素伤害加成" / "火元素伤害加成提高15%"
  m = text.match(/获得(\d+(?:\.\d+)?)%([火水雷冰风岩草])元素伤害加成/)
  if (m) return mkStatic(textRaw, 'dmg', num(m[1]), { elem: m[2] })
  m = text.match(/([火水雷冰风岩草])元素伤害加成(?:提高|提升)(\d+(?:\.\d+)?)%/)
  if (m) return mkStatic(textRaw, 'dmg', num(m[2]), { elem: m[1] })

  return null
}

function renderBuff(buff: Buff): string {
  const lines: string[] = []
  lines.push('{')
  lines.push(`  title: ${JSON.stringify(buff.title)},`)
  if (buff.isStatic) lines.push('  isStatic: true,')
  if (buff.elem) lines.push(`  elem: ${JSON.stringify(buff.elem)},`)
  lines.push(`  data: ${renderDataObject(buff.data, 2)}`)
  lines.push('}')
  return lines.join('\n')
}

function renderDataObject(data: Record<string, unknown>, indentLevel: number): string {
  const indent = '  '.repeat(indentLevel)
  const innerIndent = '  '.repeat(indentLevel + 1)
  const entries = Object.entries(data)
  if (entries.length === 0) return '{}'

  const lines: string[] = ['{']
  for (const [k, v] of entries) {
    lines.push(`${innerIndent}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)},`)
  }
  lines.push(`${indent}}`)
  return lines.join('\n')
}

export function buildGsArtifactCalcJs(sets: ArtifactSetSkills[]): string {
  const out: Array<{ name: string; buffs: Record<number, Buff> }> = []

  for (const s of sets) {
    const parsed: Record<number, Buff> = {}
    for (const [k, v] of Object.entries(s.skills || {})) {
      const need = Number(k)
      if (!Number.isFinite(need) || need <= 0) continue
      if (typeof v !== 'string' || !v.trim()) continue

      const buff = parseGsArtifactBonus(v, need)
      if (!buff) continue
      parsed[need] = buff
    }

    if (Object.keys(parsed).length === 0) continue
    out.push({ name: s.setName, buffs: parsed })
  }

  out.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))

  const lines: string[] = [
    '/**',
    ' * Auto-generated artifact buff table.',
    ' *',
    ' * Source: Hakush artifact set bonus texts (meta-gs/artifact/data.json -> skills).',
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
      const buff = s.buffs[need]
      const rendered = renderBuff(buff)
        .split('\n')
        .map((l) => `    ${l}`)
        .join('\n')
      lines.push(`    ${need}: ${rendered},`)
    }
    lines.push('  },')
  }

  lines.push('}')
  lines.push('')
  lines.push('export default buffs')
  lines.push('')
  return lines.join('\n')
}
