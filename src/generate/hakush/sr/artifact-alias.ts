/**
 * SR relic alias.js generator (meta-sr/artifact/data.json -> alias.js).
 *
 * Why we generate this file:
 * - Baseline meta contains a large hand-maintained alias table.
 * - For a pure API-driven generator we derive a safe, deterministic alias/abbr table from
 *   official set names and effect texts.
 *
 * Notes:
 * - We avoid ambiguous aliases (collisions) to keep lookups deterministic.
 * - Always overwrite: alias.js is a derived QoL file.
 */

import fs from 'node:fs'
import path from 'node:path'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function cleanName(name: string): string {
  return name.replace(/\s+/g, '').trim()
}

function splitByLast(name: string, needle: string): { left: string; right: string } {
  const i = name.lastIndexOf(needle)
  if (i === -1) return { left: '', right: name }
  return { left: name.slice(0, i), right: name.slice(i + needle.length) }
}

const GENERIC_RIGHT = new Set(['尊者', '贤人', '系囚', '信使'])
const KEEP_RIGHT_FULL_SUFFIX = new Set(['站点', '轨迹'])

function stripCjkQuotes(s: string): string {
  return s.replaceAll('「', '').replaceAll('」', '')
}

function derivePieceAbbr(pieceNameRaw: string): string {
  const pieceName = cleanName(pieceNameRaw)
  if (!pieceName) return ''

  const { left, right } = splitByLast(pieceName, '的')
  if (!left || !right) return pieceName

  const prefix = stripCjkQuotes(cleanName(left))
  let r = cleanName(right)
  if (!prefix || !r) return pieceName

  // Baseline-style shortening rules for common SR relic/ornament piece naming patterns.
  r = r.replaceAll('之', '') // e.g. 诞生之岛 -> 诞生岛
  if (r.endsWith('马靴')) r = r.replace(/马靴$/, '靴') // e.g. 铆钉马靴 -> 铆钉靴
  if (r.endsWith('枝蔓') && r.length === 4) r = r.slice(0, 2) // e.g. 建木枝蔓 -> 建木

  if (r.length === 4 && KEEP_RIGHT_FULL_SUFFIX.has(r.slice(-2))) {
    return `${prefix}的${r}`
  }

  // Most piece names are "XXYY" where YY is the part noun (2 chars).
  if (r.length === 4) r = r.slice(-2)

  return `${prefix}的${r}`
}

function bestToken(segRaw: string): string {
  const seg = cleanName(segRaw)
  if (!seg) return ''

  if (seg.length === 3 && seg.endsWith('士')) return seg.slice(0, 2)
  if (seg.length === 4) return seg.slice(-2)
  if (seg.length > 4) return seg.slice(0, 2)

  return seg
}

function deriveAbbrCandidates(setNameRaw: string): string[] {
  const setName = cleanName(setNameRaw)
  if (!setName) return []

  const { left, right } = splitByLast(setName, '的')
  const aRight = bestToken(right)
  const aLeft = bestToken(left)

  const out: string[] = []
  const push = (s: string): void => {
    const t = cleanName(s)
    if (!t) return
    if (t === setName) return
    if (t.length < 2) return
    if (t.length > 10) return
    if (!out.includes(t)) out.push(t)
  }

  if (aRight && !GENERIC_RIGHT.has(aRight)) push(aRight)
  if (aLeft) push(aLeft)
  if (aRight && GENERIC_RIGHT.has(aRight)) push(aRight)

  if (right && right !== aRight) push(right)
  if (left && left !== aLeft) push(left)
  push(setName.slice(0, 2))
  push(setName.slice(-2))

  return out
}

function pickUniqueToken(cands: string[], used: Set<string>): string {
  for (const c of cands) {
    if (!used.has(c)) return c
  }
  return cands[0] || ''
}

function detectElementAlias(skillTexts: string[]): string[] {
  const txt = skillTexts.join(' ')
  const out: string[] = []
  const push = (s: string): void => {
    if (!out.includes(s)) out.push(s)
  }
  if (/物理/.test(txt) && /属性伤害/.test(txt)) push('物理套')
  if (/火/.test(txt) && /属性伤害/.test(txt)) push('火套')
  if (/冰/.test(txt) && /属性伤害/.test(txt)) push('冰套')
  if (/雷/.test(txt) && /属性伤害/.test(txt)) push('雷套')
  if (/风/.test(txt) && /属性伤害/.test(txt)) push('风套')
  if (/量子/.test(txt) && /属性伤害/.test(txt)) push('量子套')
  if (/虚数/.test(txt) && /属性伤害/.test(txt)) push('虚数套')
  return out
}

function buildExportsJs(k: string, obj: Record<string, string>): string {
  const keys = Object.keys(obj).sort()
  const lines: string[] = []
  lines.push(`export const ${k} = {`)
  for (const name of keys) {
    lines.push(`  ${JSON.stringify(name)}: ${JSON.stringify(obj[name])},`)
  }
  lines.push('}')
  return lines.join('\n')
}

export function buildSrArtifactAliasJs(artifactIndex: Record<string, unknown>): string {
  const sets: Array<{ name: string; skills: string[] }> = []
  const pieceNames = new Set<string>()
  for (const v of Object.values(artifactIndex)) {
    if (!isRecord(v)) continue
    const name = cleanName(toStr(v.name))
    if (!name) continue
    const skillsRaw = isRecord(v.skills) ? (v.skills as Record<string, unknown>) : {}
    const skillTexts = Object.values(skillsRaw).filter((s): s is string => typeof s === 'string' && Boolean(s.trim()))
    sets.push({ name, skills: skillTexts })

    const idxsRaw = isRecord(v.idxs) ? (v.idxs as Record<string, unknown>) : {}
    for (const idxV of Object.values(idxsRaw)) {
      if (!isRecord(idxV)) continue
      const n = cleanName(toStr(idxV.name))
      if (n) pieceNames.add(n)
    }
  }

  // Element alias count (keep only unique ones to avoid collisions).
  const elemBySet = new Map<string, string[]>()
  const elemCounts = new Map<string, number>()
  for (const s of sets) {
    const els = detectElementAlias(s.skills)
    elemBySet.set(s.name, els)
    for (const e of els) elemCounts.set(e, (elemCounts.get(e) || 0) + 1)
  }

  const namesSorted = [...new Set(sets.map((s) => s.name))].sort()
  const usedAbbr = new Set<string>()
  const usedAlias = new Set<string>()

  const artiAbbr: Record<string, string> = {}
  const artiSetAbbr: Record<string, string> = {}
  const aliasCfg: Record<string, string> = {}

  for (const piece of [...pieceNames].sort()) {
    const abbr = derivePieceAbbr(piece)
    if (abbr && abbr !== piece) artiAbbr[piece] = abbr
  }

  for (const name of namesSorted) {
    const abbr = pickUniqueToken(deriveAbbrCandidates(name), usedAbbr)
    if (abbr) usedAbbr.add(abbr)
    artiSetAbbr[name] = abbr || name

    const aliasTokens: string[] = []
    const pushAlias = (t: string): void => {
      const tok = cleanName(t)
      if (!tok) return
      if (tok === name) return
      if (tok.length < 2) return
      if (usedAlias.has(tok)) return
      usedAlias.add(tok)
      aliasTokens.push(tok)
    }

    if (abbr) pushAlias(abbr)

    // Add a unique element tag (e.g. 虚数套) when available.
    const els = elemBySet.get(name) || []
    for (const e of els) {
      if ((elemCounts.get(e) || 0) === 1) pushAlias(e)
    }

    // Add a few stable derived tokens (collision-safe).
    for (const c of deriveAbbrCandidates(name)) pushAlias(c)

    aliasCfg[name] = aliasTokens.join(',') || abbr || name
  }

  return [
    '/**',
    ' * Relic alias/abbr table (generated).',
    ' *',
    ' * Derived from meta-sr/artifact/data.json set/piece names and effect texts.',
    ' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.',
    ' */',
    '',
    buildExportsJs('artiAbbr', artiAbbr),
    '',
    buildExportsJs('artiSetAbbr', artiSetAbbr),
    '',
    buildExportsJs('aliasCfg', aliasCfg),
    ''
  ].join('\n')
}

export function writeSrArtifactAliasJs(opts: {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  artifactIndex: Record<string, unknown>
  log?: Pick<Console, 'info' | 'warn'>
}): void {
  const artifactRoot = path.join(opts.metaSrRootAbs, 'artifact')
  fs.mkdirSync(artifactRoot, { recursive: true })
  const outFile = path.join(artifactRoot, 'alias.js')
  fs.writeFileSync(outFile, buildSrArtifactAliasJs(opts.artifactIndex), 'utf8')
  opts.log?.info?.('[meta-gen] (sr) generated artifact alias.js from data.json')
}
