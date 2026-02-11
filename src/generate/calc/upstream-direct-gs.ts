import fs from 'node:fs'
import path from 'node:path'

import type { CalcSuggestBuff } from './llm-calc/types.js'
import { isAllowedMiaoBuffDataKey } from './llm-calc/utils.js'
import { buildCalcUpstreamContext } from './upstream-follow/context.js'

function resolveMaybeRelative(projectRootAbs: string, p: string | undefined): string | undefined {
  const t = typeof p === 'string' ? p.trim() : ''
  if (!t) return undefined
  return path.isAbsolute(t) ? t : path.resolve(projectRootAbs, t)
}

const allStatsCache = new Map<string, any>()

function loadAllStats(genshinOptimizerRootAbs: string): any | null {
  const root = genshinOptimizerRootAbs
  if (allStatsCache.has(root)) return allStatsCache.get(root)

  const p = path.join(root, 'libs', 'gi', 'stats', 'src', 'allStat_gen.json')
  if (!fs.existsSync(p)) {
    allStatsCache.set(root, null)
    return null
  }
  try {
    const j = JSON.parse(fs.readFileSync(p, 'utf8')) as any
    allStatsCache.set(root, j)
    return j
  } catch {
    allStatsCache.set(root, null)
    return null
  }
}

function extractBraceBlock(text: string, openBraceIdx: number): string {
  if (openBraceIdx < 0 || openBraceIdx >= text.length) return ''
  let depth = 0
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') depth--
    if (depth === 0 && i > openBraceIdx) return text.slice(openBraceIdx, i + 1)
  }
  return ''
}

function normalizeSkillParamAccess(access: string): string {
  return String(access || '').replace(/!/g, '')
}

function getSkillParamValue(skillParam: any, access: string): unknown {
  const a = normalizeSkillParamAccess(access)
  const m = /^([A-Za-z0-9_]+)(.*)$/.exec(a)
  if (!m) return undefined
  let cur: any = skillParam?.[m[1]!]
  if (cur == null) return undefined

  const rest = m[2] || ''
  const re = /\[(\d+)\]/g
  let mm: RegExpExecArray | null
  while ((mm = re.exec(rest))) {
    const idx = Number(mm[1])
    if (!Number.isFinite(idx)) return undefined
    cur = cur?.[idx]
    if (cur == null) return undefined
  }
  return cur
}

type ConstExpr = { kind: 'percent'; dmPath: string }

function parseDmMapping(dmBlock: string): Map<string, string> {
  const out = new Map<string, string>()
  const stack: string[] = []
  const lines = dmBlock.split(/\r?\n/)
  for (const line0 of lines) {
    const line = line0.trim()
    if (!line) continue

    const openObj = /^([A-Za-z0-9_]+)\s*:\s*{\s*$/.exec(line)
    if (openObj) {
      stack.push(openObj[1]!)
      continue
    }

    const m = /^([A-Za-z0-9_]+)\s*:\s*skillParam_gen\.([^,]+),?\s*$/.exec(line)
    if (m) {
      const prop = m[1]!
      const rhs = String(m[2] || '').trim()
      if (!rhs) continue
      if (/[+\-*/]/.test(rhs)) continue
      if (!/^[A-Za-z0-9_!\[\]]+$/.test(rhs)) continue
      const fullPath = [...stack, prop].join('.')
      out.set(fullPath, rhs)
    }

    const closeCount = (line.match(/}/g) || []).length
    for (let i = 0; i < closeCount; i++) stack.pop()
  }
  return out
}

function parseConstExprs(text: string): Map<string, ConstExpr> {
  const out = new Map<string, ConstExpr>()
  for (const line0 of text.split(/\r?\n/)) {
    const line = line0.trim()
    if (!line.startsWith('const ')) continue
    const m = /^const\s+([A-Za-z0-9_]+)\s*=\s*percent\(\s*dm\.([A-Za-z0-9_.]+)\s*\)\s*;?\s*$/.exec(line)
    if (!m) continue
    const name = m[1]!
    const dmPath = m[2]!
    out.set(name, { kind: 'percent', dmPath })
  }
  return out
}

function mapPremodKeyToMiaoBuffKey(elem: string, key: string): string | null {
  const k = key.trim()
  if (!k) return null

  const e = elem.trim().toLowerCase()
  if (k === `${e}_dmg_`) return 'dmg'
  if (k === 'dmg_' || k === 'all_dmg_') return 'dmg'
  if (k === 'physical_dmg_') return 'phy'
  if (k === 'atk_') return 'atkPct'
  if (k === 'hp_') return 'hpPct'
  if (k === 'def_') return 'defPct'
  if (k === 'atk') return 'atkPlus'
  if (k === 'hp') return 'hpPlus'
  if (k === 'def') return 'defPlus'
  if (k === 'enerRech_') return 'recharge'
  if (k === 'critRate_') return 'cpct'
  if (k === 'critDMG_') return 'cdmg'
  if (k === 'heal_') return 'heal'
  if (k === 'shield_') return 'shield'
  if (k === 'enemyDefRed_') return 'enemyDef'
  if (k === 'enemyDefIgn_') return 'enemyIgnore'

  const skillMap: Record<string, string> = {
    normal: 'a',
    charged: 'a2',
    plunging: 'a3',
    skill: 'e',
    burst: 'q'
  }
  for (const [prefix, bucket] of Object.entries(skillMap)) {
    if (k === `${prefix}_dmg_`) return `${bucket}Dmg`
    if (k === `${prefix}_critRate_`) return `${bucket}Cpct`
    if (k === `${prefix}_critDMG_`) return `${bucket}Cdmg`
  }

  return null
}

function extractPremodPairs(text: string): Array<{ key: string; value: string }> {
  const idx = text.indexOf('premod:')
  if (idx < 0) return []
  const brace = text.indexOf('{', idx)
  if (brace < 0) return []
  const block = extractBraceBlock(text, brace)
  if (!block) return []

  const out: Array<{ key: string; value: string }> = []
  for (const line0 of block.split(/\r?\n/)) {
    const line = line0.trim()
    const m = /^([A-Za-z0-9_]+)\s*:\s*([A-Za-z0-9_]+)\s*,?\s*$/.exec(line)
    if (!m) continue
    out.push({ key: m[1]!, value: m[2]! })
  }
  return out
}

export function buildGsUpstreamDirectBuffs(opts: {
  projectRootAbs: string
  id?: number
  elem: string
  upstream?: {
    genshinOptimizerRoot?: string
  }
}): CalcSuggestBuff[] {
  const id = typeof opts.id === 'number' && Number.isFinite(opts.id) ? Math.trunc(opts.id) : 0
  if (!id) return []

  const rootAbs =
    resolveMaybeRelative(opts.projectRootAbs, opts.upstream?.genshinOptimizerRoot) ||
    path.join(opts.projectRootAbs, 'upstream', 'genshin-optimizer')
  if (!fs.existsSync(rootAbs)) return []

  const ctx = buildCalcUpstreamContext({
    projectRootAbs: opts.projectRootAbs,
    game: 'gs',
    id,
    genshinOptimizerRootAbs: rootAbs
  })
  if (!ctx?.file) return []

  const fileAbs = path.join(rootAbs, ...ctx.file.split('/'))
  if (!fs.existsSync(fileAbs)) return []

  let text = ''
  try {
    text = fs.readFileSync(fileAbs, 'utf8')
  } catch {
    return []
  }

  const mKey = /\bconst\s+key\b[^=]*=\s*['"]([^'"]+)['"]/.exec(text)
  const charKey = mKey?.[1]?.trim() || ''
  if (!charKey) return []

  const allStats = loadAllStats(rootAbs)
  const skillParam = allStats?.char?.skillParam?.[charKey]
  if (!skillParam || typeof skillParam !== 'object') return []

  const idxDm = text.indexOf('const dm')
  const idxDmBrace = idxDm >= 0 ? text.indexOf('{', idxDm) : -1
  const dmBlock = idxDmBrace >= 0 ? extractBraceBlock(text, idxDmBrace) : ''
  const dmMap = dmBlock ? parseDmMapping(dmBlock) : new Map<string, string>()

  const constExprs = parseConstExprs(text)
  const premodPairs = extractPremodPairs(text)
  if (!premodPairs.length) return []

  const data: Record<string, number> = {}

  for (const { key, value } of premodPairs) {
    const buffKey = mapPremodKeyToMiaoBuffKey(opts.elem, key)
    if (!buffKey) continue
    if (!isAllowedMiaoBuffDataKey('gs', buffKey)) continue

    const ce = constExprs.get(value)
    if (!ce || ce.kind !== 'percent') continue
    const access = dmMap.get(ce.dmPath)
    if (!access) continue
    const raw = getSkillParamValue(skillParam, access)
    const n = typeof raw === 'number' ? raw : Number(raw)
    if (!Number.isFinite(n)) continue

    const pct = n * 100
    const v = Math.abs(pct - Math.round(pct)) < 1e-9 ? Math.round(pct) : Number(pct.toFixed(6))
    if (!Number.isFinite(v) || v === 0) continue
    data[buffKey] = v
  }

  const keys = Object.keys(data)
  if (!keys.length) return []
  return [{ title: 'upstream:genshin-optimizer(premod)', data }]
}
