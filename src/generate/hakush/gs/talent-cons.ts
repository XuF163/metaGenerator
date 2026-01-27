/**
 * Infer `talentCons` for GI (GS) characters.
 *
 * miao-plugin uses `talentCons` mainly for UI icon selection:
 * - When a talent is boosted by a constellation, it may use the constellation icon instead of the skill icon.
 * - When a talent is NOT boosted (value=0), UI falls back to `icons/talent-{e|q}.webp`.
 *
 * Hakush provides constellation descriptions like:
 *   "<color=#FFD780FF>热情过载</color>的技能等级提高3级。"
 *
 * We match the referenced skill name against A/E/Q names.
 */

export type GiTalentCons = { a: number; e: number; q: number }

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stripGiRichText(text: string): string {
  return text
    .replaceAll('\\n', '\n')
    .replaceAll('\r\n', '\n')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<[^>]+>/g, '')
    .trim()
}

function normalizeSkillNameForMatch(name: string): string {
  return name.trim()
}

function isNameMatch(a: string, b: string): boolean {
  const x = normalizeSkillNameForMatch(a)
  const y = normalizeSkillNameForMatch(b)
  if (!x || !y) return false
  if (x === y) return true
  // Constellation descriptions may prefix skill names (e.g. 普通攻击·XXX).
  return x.endsWith(y) || y.endsWith(x)
}

function extractLevelUpSkillNameFromDesc(desc: string): string {
  const text = stripGiRichText(desc)
  // Most C3/C5 descriptions follow this pattern.
  const m = text.match(/^(.*?)(?:的)?技能等级提高3级/)
  return (m?.[1] || '').trim()
}

export function inferGiTalentConsFromParts(parts: {
  aName: string
  eName: string
  qName: string
  c3Desc: string
  c5Desc: string
}): GiTalentCons {
  const out: GiTalentCons = { a: 0, e: 0, q: 0 }

  const apply = (consNo: 3 | 5, desc: string): void => {
    const ref = extractLevelUpSkillNameFromDesc(desc)
    if (!ref) return
    if (isNameMatch(ref, parts.aName)) out.a = consNo
    else if (isNameMatch(ref, parts.eName)) out.e = consNo
    else if (isNameMatch(ref, parts.qName)) out.q = consNo
  }

  apply(3, parts.c3Desc)
  apply(5, parts.c5Desc)

  return out
}

export function inferGiTalentConsFromHakushDetail(detail: Record<string, unknown>, qIdx: number): GiTalentCons {
  const skills = Array.isArray(detail.Skills) ? (detail.Skills as Array<unknown>) : []
  const aName = isRecord(skills[0]) && typeof skills[0].Name === 'string' ? (skills[0].Name as string) : ''
  const eName = isRecord(skills[1]) && typeof skills[1].Name === 'string' ? (skills[1].Name as string) : ''
  const qSkill = isRecord(skills[qIdx]) ? (skills[qIdx] as Record<string, unknown>) : undefined
  const qName = qSkill && typeof qSkill.Name === 'string' ? (qSkill.Name as string) : ''

  const consts = Array.isArray(detail.Constellations) ? (detail.Constellations as Array<unknown>) : []
  const c3 = isRecord(consts[2]) && typeof consts[2].Desc === 'string' ? (consts[2].Desc as string) : ''
  const c5 = isRecord(consts[4]) && typeof consts[4].Desc === 'string' ? (consts[4].Desc as string) : ''

  const inferred = inferGiTalentConsFromParts({ aName, eName, qName, c3Desc: c3, c5Desc: c5 })

  // Fallback for unexpected upstream formats: keep baseline-like defaults.
  if (!inferred.a && !inferred.e && !inferred.q) {
    return { a: 0, e: 5, q: 3 }
  }

  return inferred
}

/**
 * Infer from an existing `meta-gs/character/<name>/data.json`.
 * Useful for incremental repair without re-fetching Hakush data.
 */
export function inferGiTalentConsFromMetaJson(metaJson: unknown): GiTalentCons | null {
  if (!isRecord(metaJson)) return null

  const talent = isRecord(metaJson.talent) ? (metaJson.talent as Record<string, unknown>) : null
  const cons = isRecord(metaJson.cons) ? (metaJson.cons as Record<string, unknown>) : null
  if (!talent || !cons) return null

  const a = isRecord(talent.a) ? (talent.a as Record<string, unknown>) : null
  const e = isRecord(talent.e) ? (talent.e as Record<string, unknown>) : null
  const q = isRecord(talent.q) ? (talent.q as Record<string, unknown>) : null
  if (!a || !e || !q) return null

  const aName = typeof a.name === 'string' ? (a.name as string) : ''
  const eName = typeof e.name === 'string' ? (e.name as string) : ''
  const qName = typeof q.name === 'string' ? (q.name as string) : ''

  const c3 = isRecord(cons['3']) ? (cons['3'] as Record<string, unknown>) : null
  const c5 = isRecord(cons['5']) ? (cons['5'] as Record<string, unknown>) : null
  const c3DescArr = c3 && Array.isArray(c3.desc) ? (c3.desc as Array<unknown>) : []
  const c5DescArr = c5 && Array.isArray(c5.desc) ? (c5.desc as Array<unknown>) : []
  const c3Desc = typeof c3DescArr[0] === 'string' ? (c3DescArr[0] as string) : ''
  const c5Desc = typeof c5DescArr[0] === 'string' ? (c5DescArr[0] as string) : ''

  if (!aName || !eName || !qName) return null
  if (!c3Desc && !c5Desc) return null

  return inferGiTalentConsFromParts({ aName, eName, qName, c3Desc, c5Desc })
}

