/**
 * Generate `meta-gs/artifact/artis-mark.js` from generated character meta.
 *
 * Goal:
 * - Provide broad, auto-updating artifact scoring weights without copying baseline tables.
 * - Keep it deterministic and safe: derive from character talent texts (keywords) + simple heuristics.
 *
 * Notes:
 * - If character data is missing, we skip generation (keep scaffold file).
 * - Always overwrite when generated: it is a derived QoL file.
 */

import fs from 'node:fs'
import path from 'node:path'

type GsAttrKey = 'hp' | 'atk' | 'def' | 'mastery' | 'cpct' | 'cdmg' | 'recharge' | 'heal' | 'dmg' | 'phy'
type Weights = Partial<Record<GsAttrKey, number>>

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

function collectTalentTextLines(charData: unknown): string[] {
  const out: string[] = []
  if (!isRecord(charData)) return out

  const talent = isRecord(charData.talent) ? (charData.talent as Record<string, unknown>) : null
  if (!talent) return out

  for (const block of Object.values(talent)) {
    if (!isRecord(block)) continue
    const desc = block.desc
    if (Array.isArray(desc)) {
      for (const line of desc) {
        if (typeof line === 'string' && line.trim()) out.push(line.trim())
      }
    }
  }
  return out
}

function hasAny(text: string, keywords: string[]): boolean {
  return keywords.some((k) => text.includes(k))
}

function deriveGsWeights(opts: { name: string; elem: string; text: string }): Weights {
  const { elem, text } = opts

  const isHealer = hasAny(text, ['治疗', '治疗量', '恢复生命值', '生命值回复', '回复生命值'])
  const isShield = hasAny(text, ['护盾'])

  const hpScale = hasAny(text, ['基于生命值上限', '基于最大生命值', '基于生命值', '按生命值上限', '按最大生命值', '生命值上限'])
  const defScale = hasAny(text, ['基于防御力', '按防御力', '防御力'])

  const emScale = hasAny(text, ['元素精通', '精通'])
  const swirlLike = elem === 'anemo' && hasAny(text, ['扩散'])

  const physical = hasAny(text, ['物理伤害'])
  const energyHungry = hasAny(text, ['元素能量', '能量', '元素爆发']) && hasAny(text, ['消耗', '需要', '恢复'])

  if (isHealer) {
    return {
      hp: 100,
      atk: 50,
      cpct: 50,
      cdmg: 50,
      dmg: 80,
      recharge: energyHungry ? 100 : 75,
      heal: 100
    }
  }

  if (isShield && (hpScale || defScale)) {
    const w: Weights = {
      cpct: 50,
      cdmg: 50,
      dmg: 80,
      recharge: energyHungry ? 90 : 75
    }
    if (hpScale) w.hp = 100
    if (defScale) w.def = 100
    if (!w.hp && !w.def) w.hp = 80
    return w
  }

  if (emScale || swirlLike) {
    // EM-driven builds: keep crit lower to avoid misleading scores.
    return {
      mastery: 100,
      dmg: 80,
      recharge: energyHungry ? 90 : 55,
      cpct: 50,
      cdmg: 50,
      atk: hpScale ? 0 : 50,
      hp: hpScale ? 80 : 0
    }
  }

  // Default DPS-like weights.
  const w: Weights = {
    atk: 75,
    cpct: 100,
    cdmg: 100,
    dmg: 100,
    recharge: energyHungry ? 75 : 55
  }

  if (hpScale) {
    w.hp = 100
    w.atk = 50
  }
  if (defScale) {
    w.def = 100
    w.atk = 50
  }
  if (physical) {
    w.phy = 100
    w.dmg = 40
  }

  return w
}

const KEY_ORDER: GsAttrKey[] = ['hp', 'atk', 'def', 'mastery', 'cpct', 'cdmg', 'recharge', 'heal', 'dmg', 'phy']

function formatWeights(w: Weights): string {
  const entries: Array<[GsAttrKey, number]> = []
  for (const k of KEY_ORDER) {
    const v = w[k]
    if (typeof v === 'number' && Number.isFinite(v) && v !== 0) entries.push([k, v])
  }
  // Keep output minimal but stable.
  const parts = entries.map(([k, v]) => `${k}: ${v}`)
  return `{ ${parts.join(', ')} }`
}

export function generateGsArtifactArtisMarkJs(opts: {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  log?: Pick<Console, 'info' | 'warn'>
}): void {
  const charIndexPath = path.join(opts.metaGsRootAbs, 'character', 'data.json')
  if (!fs.existsSync(charIndexPath)) {
    opts.log?.info?.('[meta-gen] (gs) artifact artis-mark.js skipped: character/data.json missing')
    return
  }

  const indexRaw = tryReadJson(charIndexPath)
  if (!isRecord(indexRaw)) {
    opts.log?.warn?.('[meta-gen] (gs) artifact artis-mark.js skipped: character/data.json invalid')
    return
  }

  const charRoot = path.join(opts.metaGsRootAbs, 'character')
  const rows: Array<{ name: string; elem: string; text: string }> = []

  for (const v of Object.values(indexRaw)) {
    if (!isRecord(v)) continue
    const name = toStr(v.name).trim()
    if (!name) continue
    const elem = toStr(v.elem).trim()

    const dataPath = path.join(charRoot, name, 'data.json')
    const charData = fs.existsSync(dataPath) ? tryReadJson(dataPath) : null
    const lines = collectTalentTextLines(charData)
    const text = lines.join('\n')

    rows.push({ name, elem, text })
  }

  rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))

  const outLines: string[] = []
  outLines.push('/**')
  outLines.push(' * 角色的默认圣遗物评分权重（generated）。')
  outLines.push(' *')
  outLines.push(' * 说明：')
  outLines.push(' * - 由 metaGenerator 根据角色天赋描述做关键词启发式推导（不依赖/不拷贝基线）。')
  outLines.push(' * - 如 `character/<name>/artis.js` 有自定义规则，运行时会优先使用自定义。')
  outLines.push(' * - 若推导不理想，可在生成后手动覆盖本文件（或后续引入 LLM/更强规则生成）。')
  outLines.push(' */')
  outLines.push('')
  outLines.push('export const usefulAttr = {')

  for (const r of rows) {
    const weights = deriveGsWeights(r)
    outLines.push(`  ${JSON.stringify(r.name)}: ${formatWeights(weights)},`)
  }

  outLines.push('}')
  outLines.push('')

  const outPath = path.join(opts.metaGsRootAbs, 'artifact', 'artis-mark.js')
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, outLines.join('\n'), 'utf8')
  opts.log?.info?.('[meta-gen] (gs) generated artifact artis-mark.js from character talents')
}

