import fs from 'node:fs'
import path from 'node:path'

export interface CalcUpstreamContext {
  source: string
  file?: string
  excerpt?: string
}

function shortenText(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function tryReadText(filePathAbs: string): string | null {
  try {
    if (!fs.existsSync(filePathAbs)) return null
    return fs.readFileSync(filePathAbs, 'utf8')
  } catch {
    return null
  }
}

const gsIdMapCache = new Map<string, Record<string, string>>()
function loadGsIdToKeyMap(genshinOptimizerRootAbs: string): Record<string, string> | null {
  const root = genshinOptimizerRootAbs
  if (gsIdMapCache.has(root)) return gsIdMapCache.get(root)!

  const mapPath = path.join(
    root,
    'libs',
    'gi',
    'dm',
    'src',
    'dm',
    'character',
    'AvatarExcelConfigData_idmap_gen.json'
  )
  const raw = tryReadText(mapPath)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      const id = String(k || '').trim()
      const key = typeof v === 'string' ? v.trim() : ''
      if (!id || !key) continue
      out[id] = key
    }
    gsIdMapCache.set(root, out)
    return out
  } catch {
    return null
  }
}

function extractBlockByStart(lines: string[], startIdx: number, maxLines: number): string[] {
  const out: string[] = []
  for (let i = startIdx; i < lines.length && out.length < maxLines; i++) out.push(lines[i] ?? '')
  return out
}

function extractConstObjectBlock(lines: string[], constName: string, maxLines = 80): string[] {
  const start = lines.findIndex((l) => new RegExp(`\\bconst\\s+${constName}\\b`).test(l) && l.includes('{'))
  if (start < 0) return []
  const out: string[] = []
  let depth = 0
  for (let i = start; i < lines.length && out.length < maxLines; i++) {
    const line = lines[i] ?? ''
    out.push(line)
    for (const ch of line) {
      if (ch === '{') depth++
      else if (ch === '}') depth--
    }
    if (depth <= 0 && out.length > 1) break
  }
  return out
}

function buildSrUpstreamContext(opts: { hsrOptimizerRootAbs: string; id: number; includeTeamBuffs?: boolean }): CalcUpstreamContext | null {
  const root = opts.hsrOptimizerRootAbs
  const resolverPath = path.join(root, 'src', 'lib', 'conditionals', 'resolver', 'characterConditionalsResolver.ts')
  const resolverText = tryReadText(resolverPath)
  if (!resolverText) return null

  const varToRel = new Map<string, string>()
  for (const m of resolverText.matchAll(/import\s+([A-Za-z0-9_]+)\s+from\s+'(lib\/conditionals\/character\/[^']+)'/g)) {
    const varName = String(m[1] || '').trim()
    const rel = String(m[2] || '').trim()
    if (varName && rel) varToRel.set(varName, rel)
  }

  const idToVar = new Map<string, string>()
  for (const line of resolverText.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s*:\s*([A-Za-z0-9_]+)\s*,/.exec(line)
    if (!m) continue
    const id = String(m[1] || '').trim()
    const varName = String(m[2] || '').trim()
    if (!id || !varName) continue
    idToVar.set(id, varName)
  }

  const varName = idToVar.get(String(opts.id))
  const rel = varName ? varToRel.get(varName) : undefined
  if (!rel) return null

  const fileAbs = path.join(root, 'src', `${rel}.ts`)
  const text = tryReadText(fileAbs)
  if (!text) return null

  const lines = text.split(/\r?\n/)
  const defaultsBlock = extractConstObjectBlock(lines, 'defaults', 120)

  const buffLines: string[] = []
  const includeTeamBuffs = Boolean(opts.includeTeamBuffs)
  for (const line of lines) {
    const t = line.trim()
    if (!t) continue
    if (t.includes('.buff(') || (includeTeamBuffs && t.includes('.buffTeam(')) || t.includes('buffAbilityDmg(')) {
      // Reduce noise: skip obvious scaling/toughness rows (they are already in talent tables).
      if (/_SCALING\b/.test(t)) continue
      if (/_TOUGHNESS/.test(t)) continue
      buffLines.push(t)
      if (buffLines.length >= 80) break
    }
  }

  const activeAbilities = lines.find((l) => l.includes('activeAbilities:'))?.trim() || ''
  const excerptParts = [
    activeAbilities ? `// ${activeAbilities}` : '',
    ...(defaultsBlock.length ? ['// defaults', ...defaultsBlock] : []),
    ...(buffLines.length ? ['// buffs/boosts (excerpt)', ...buffLines] : [])
  ].filter(Boolean)

  const excerpt = shortenText(excerptParts.join('\n'), 2800)
  return {
    source: 'hsr-optimizer',
    file: path.relative(root, fileAbs).replace(/\\/g, '/'),
    excerpt
  }
}

function buildGsUpstreamContext(opts: { genshinOptimizerRootAbs: string; id: number; includeTeamBuffs?: boolean }): CalcUpstreamContext | null {
  const root = opts.genshinOptimizerRootAbs
  const idToKey = loadGsIdToKeyMap(root)
  const charKey = idToKey ? idToKey[String(opts.id)] : undefined
  if (!charKey) return null

  const baseDir = path.join(root, 'libs', 'gi', 'sheets', 'src', 'Characters', charKey)
  const fileAbs =
    (fs.existsSync(path.join(baseDir, 'index.tsx')) && path.join(baseDir, 'index.tsx')) ||
    (fs.existsSync(path.join(baseDir, 'index.ts')) && path.join(baseDir, 'index.ts')) ||
    ''
  if (!fileAbs) return null

  const text = tryReadText(fileAbs)
  if (!text) return null

  const lines = text.split(/\r?\n/)
  const idxData = lines.findIndex((l) => /\bexport\s+const\s+data\b/.test(l))
  const idxSheet = idxData >= 0 ? lines.findIndex((l, i) => i > idxData && /\bconst\s+sheet\b/.test(l)) : -1
  const dataBlock =
    idxData >= 0
      ? extractBlockByStart(lines, Math.max(0, idxData - 80), Math.max(40, (idxSheet > idxData ? idxSheet - Math.max(0, idxData - 80) : 160)))
      : []

  const filtered: string[] = []
  const includeTeamBuffs = Boolean(opts.includeTeamBuffs)
  const keepCore = (l: string): boolean =>
    /\bpremod\b|\binfusion\b|\bcond\s*\(|\bgreaterEq\b|\bequal\b|\bpercent\b|\blookup\b|\bnonStackBuff\b|\bexport\s+const\s+data\b/.test(l)
  const keep = (l: string): boolean => keepCore(l) || (includeTeamBuffs && /\bteamBuff\b/.test(l))
  for (const l of dataBlock) {
    const t = l.trimEnd()
    if (!t.trim()) continue
    if (keep(t)) filtered.push(t)
    if (filtered.length >= 160) break
  }

  const excerpt = shortenText(filtered.join('\n'), 2800)
  return {
    source: 'genshin-optimizer',
    file: path.relative(root, fileAbs).replace(/\\/g, '/'),
    excerpt
  }
}

export function buildCalcUpstreamContext(opts: {
  projectRootAbs: string
  game: 'gs' | 'sr'
  id?: number
  name?: string
  genshinOptimizerRootAbs?: string
  hsrOptimizerRootAbs?: string
  includeTeamBuffs?: boolean
}): CalcUpstreamContext | null {
  const id = typeof opts.id === 'number' && Number.isFinite(opts.id) ? Math.trunc(opts.id) : 0
  if (!id) return null

  if (opts.game === 'sr') {
    const root = opts.hsrOptimizerRootAbs || path.join(opts.projectRootAbs, 'upstream', 'hsr-optimizer')
    if (!fs.existsSync(root)) return null
    return buildSrUpstreamContext({ hsrOptimizerRootAbs: root, id, includeTeamBuffs: opts.includeTeamBuffs })
  }

  const root = opts.genshinOptimizerRootAbs || path.join(opts.projectRootAbs, 'upstream', 'genshin-optimizer')
  if (!fs.existsSync(root)) return null
  return buildGsUpstreamContext({ genshinOptimizerRootAbs: root, id, includeTeamBuffs: opts.includeTeamBuffs })
}
