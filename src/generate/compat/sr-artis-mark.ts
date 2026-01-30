/**
 * Generate `meta-sr/artifact/artis-mark.js` from generated character meta.
 *
 * Goal:
 * - Provide broad, auto-updating relic scoring weights without copying baseline tables.
 * - Keep it deterministic and safe: derive from character path + talent keywords.
 *
 * Notes:
 * - If character data is missing, we skip generation (keep scaffold file).
 * - Always overwrite when generated: it is a derived QoL file.
 */

import fs from 'node:fs'
import path from 'node:path'

type SrAttrKey =
  | 'hp'
  | 'atk'
  | 'def'
  | 'speed'
  | 'cpct'
  | 'cdmg'
  | 'stance'
  | 'heal'
  | 'recharge'
  | 'effPct'
  | 'effDef'
  | 'dmg'

type Weights = Partial<Record<SrAttrKey, number>>

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function tryReadJson(filePath: string): unknown | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return JSON.parse(raw) as unknown
  } catch {
    return null
  }
}

function collectTalentText(charData: unknown): string {
  if (!isRecord(charData)) return ''
  const talent = isRecord(charData.talent) ? (charData.talent as Record<string, unknown>) : null
  if (!talent) return ''

  const lines: string[] = []
  for (const block of Object.values(talent)) {
    if (!isRecord(block)) continue
    const desc = block.desc
    if (!Array.isArray(desc)) continue
    for (const line of desc) {
      if (typeof line === 'string' && line.trim()) lines.push(line.trim())
    }
  }
  return lines.join('\n')
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k))
}

function baseByPath(pathName: string): Weights {
  // SR "weapon" field in meta actually stores Path/Profession names (e.g. 毁灭/同谐/丰饶).
  if (pathName === '丰饶') {
    return { hp: 100, speed: 75, heal: 100, recharge: 100, effDef: 50 }
  }
  if (pathName === '存护') {
    return { def: 100, hp: 50, speed: 100, effDef: 75, recharge: 75 }
  }
  if (pathName === '同谐') {
    return { speed: 100, recharge: 100, hp: 50, def: 50, effDef: 50 }
  }
  if (pathName === '虚无') {
    return { speed: 100, effPct: 100, recharge: 75, atk: 75, dmg: 80 }
  }
  if (pathName === '记忆') {
    return { speed: 100, recharge: 100, hp: 50, def: 50, effDef: 50 }
  }
  // Default DPS-like.
  return { atk: 75, speed: 100, cpct: 100, cdmg: 100, dmg: 100 }
}

function refineByKeywords(base: Weights, text: string): Weights {
  const w: Weights = { ...base }

  const isHealer = hasAny(text, ['治疗', '回复', '恢复生命值'])
  const isShield = hasAny(text, ['护盾'])
  const wantsCrit = hasAny(text, ['暴击率', '暴击伤害', '暴击'])
  const wantsBreak = hasAny(text, ['击破特攻', '击破', '弱点击破', '破韧'])
  const wantsEffHit = hasAny(text, ['效果命中'])
  const wantsEffRes = hasAny(text, ['效果抵抗'])

  if (isHealer) {
    w.heal = 100
    w.hp = w.hp ?? 100
    w.speed = w.speed ?? 100
    w.recharge = w.recharge ?? 100
    w.cpct = 0
    w.cdmg = 0
    w.dmg = w.dmg ?? 0
  }

  if (isShield) {
    w.def = w.def ?? 100
    w.hp = w.hp ?? 50
    w.effDef = w.effDef ?? 75
  }

  if (wantsBreak) {
    w.stance = 100
    w.speed = w.speed ?? 100
    // Break builds typically de-emphasize crit unless explicitly mentioned.
    if (!wantsCrit) {
      w.cpct = 0
      w.cdmg = 0
    }
  }

  if (wantsEffHit) {
    w.effPct = 100
    // Debuff builds usually don't rely on crit.
    if (!wantsCrit) {
      w.cpct = 0
      w.cdmg = 0
    }
  }

  if (wantsEffRes) {
    w.effDef = 100
  }

  return w
}

const KEY_ORDER: SrAttrKey[] = ['hp', 'atk', 'def', 'speed', 'cpct', 'cdmg', 'stance', 'heal', 'recharge', 'effPct', 'effDef', 'dmg']

function formatWeights(w: Weights): string {
  const entries: Array<[SrAttrKey, number]> = []
  for (const k of KEY_ORDER) {
    const v = w[k]
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) entries.push([k, v])
  }
  const parts = entries.map(([k, v]) => `${k}: ${v}`)
  return `{ ${parts.join(', ')} }`
}

export function generateSrArtifactArtisMarkJs(opts: {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  log?: Pick<Console, 'info' | 'warn'>
}): void {
  const charIndexPath = path.join(opts.metaSrRootAbs, 'character', 'data.json')
  if (!fs.existsSync(charIndexPath)) {
    opts.log?.info?.('[meta-gen] (sr) artifact artis-mark.js skipped: character/data.json missing')
    return
  }

  const indexRaw = tryReadJson(charIndexPath)
  if (!isRecord(indexRaw)) {
    opts.log?.warn?.('[meta-gen] (sr) artifact artis-mark.js skipped: character/data.json invalid')
    return
  }

  const charRoot = path.join(opts.metaSrRootAbs, 'character')
  const rows: Array<{ name: string; pathName: string; text: string }> = []

  for (const v of Object.values(indexRaw)) {
    if (!isRecord(v)) continue
    const name = toStr(v.name).trim()
    if (!name) continue
    const pathName = toStr(v.weapon).trim()

    const dataPath = path.join(charRoot, name, 'data.json')
    const charData = fs.existsSync(dataPath) ? tryReadJson(dataPath) : null
    const text = collectTalentText(charData)

    rows.push({ name, pathName, text })
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const outLines: string[] = []
  outLines.push('/**')
  outLines.push(' * 角色的默认遗器评分权重（generated）。')
  outLines.push(' *')
  outLines.push(' * 说明：')
  outLines.push(' * - 由 metaGenerator 根据命途 + 天赋描述做关键词启发式推导（不依赖/不拷贝基线）。')
  outLines.push(' * - 如 `character/<name>/artis.js` 有自定义规则，运行时会优先使用自定义。')
  outLines.push(' */')
  outLines.push('')
  outLines.push('export const usefulAttr = {')

  for (const r of rows) {
    const base = baseByPath(r.pathName)
    const w = refineByKeywords(base, r.text)
    outLines.push(`  ${JSON.stringify(r.name)}: ${formatWeights(w)},`)
  }

  outLines.push('}')
  outLines.push('')

  const outPath = path.join(opts.metaSrRootAbs, 'artifact', 'artis-mark.js')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, outLines.join('\n'), 'utf8')
  opts.log?.info?.('[meta-gen] (sr) generated artifact artis-mark.js from character meta')
}

