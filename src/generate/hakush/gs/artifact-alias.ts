/**
 * GS artifact alias.js generator (meta-gs/artifact/data.json -> alias.js).
 *
 * Why we generate this file:
 * - Baseline meta contains a large hand-maintained alias table.
 * - For a pure API-driven generator we derive a safe, deterministic alias/abbr table from
 *   official set names (and optionally their effect texts).
 *
 * Notes:
 * - We avoid generating ambiguous aliases (collisions) to keep lookups deterministic.
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

const GENERIC_RIGHT = new Set(['尊者', '贤人'])

function bestToken(segRaw: string): string {
  const seg = cleanName(segRaw)
  if (!seg) return ''

  // Heuristic: "...士" is commonly abbreviated by dropping the trailing character.
  if (seg.length === 3 && seg.endsWith('士')) return seg.slice(0, 2)

  // Prefer 2-char suffix for 4-char segments (e.g. 昔日宗室 -> 宗室).
  if (seg.length === 4) return seg.slice(-2)

  // Generic fallback for longer segments.
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
    if (t.length > 6) return
    if (!out.includes(t)) out.push(t)
  }

  // Prefer the right part unless it's a generic noun.
  if (aRight && !GENERIC_RIGHT.has(aRight)) push(aRight)
  if (aLeft) push(aLeft)
  if (aRight && GENERIC_RIGHT.has(aRight)) push(aRight)

  // Extra fallbacks.
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
  // Fallback: allow collisions rather than returning empty (keeps exports usable).
  return cands[0] || ''
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

export function buildGsArtifactAliasJs(artifactIndex: Record<string, unknown>): string {
  const setNames = new Set<string>()
  for (const v of Object.values(artifactIndex)) {
    if (!isRecord(v)) continue
    const name = cleanName(toStr(v.name))
    if (name) setNames.add(name)
  }

  const namesSorted = [...setNames].sort()
  const usedAbbr = new Set<string>()
  const usedAlias = new Set<string>()

  const setAbbr: Record<string, string> = {}
  const setAlias: Record<string, string> = {}

  for (const name of namesSorted) {
    const abbr = pickUniqueToken(deriveAbbrCandidates(name), usedAbbr)
    if (abbr) usedAbbr.add(abbr)
    setAbbr[name] = abbr || name

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

    // Ensure abbr is always present as the first alias.
    if (abbr) pushAlias(abbr)
    for (const c of deriveAbbrCandidates(name)) pushAlias(c)

    // Fallback: at least one alias token.
    if (!aliasTokens.length && abbr) aliasTokens.push(abbr)
    setAlias[name] = aliasTokens.join(',') || abbr || name
  }

  return [
    '/**',
    ' * Artifact set alias/abbr table (generated).',
    ' *',
    ' * Derived from meta-gs/artifact/data.json set names.',
    ' * Do NOT edit by hand. Re-run `meta-gen gen` to regenerate.',
    ' */',
    '',
    buildExportsJs('setAbbr', setAbbr),
    '',
    buildExportsJs('setAlias', setAlias),
    ''
  ].join('\n')
}

export function writeGsArtifactAliasJs(opts: {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  artifactIndex: Record<string, unknown>
  log?: Pick<Console, 'info' | 'warn'>
}): void {
  const artifactRoot = path.join(opts.metaGsRootAbs, 'artifact')
  fs.mkdirSync(artifactRoot, { recursive: true })
  const outFile = path.join(artifactRoot, 'alias.js')
  fs.writeFileSync(outFile, buildGsArtifactAliasJs(opts.artifactIndex), 'utf8')
  opts.log?.info?.('[meta-gen] (gs) generated artifact alias.js from data.json')
}

