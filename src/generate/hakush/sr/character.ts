/**
 * SR character generator (Hakush -> meta-sr/character/*).
 *
 * Behavior:
 * - Idempotent: only creates missing files/entries (unless output is wiped by `gen --force`)
 * - Adds characters with a schema compatible with miao-plugin:
 *   - character/data.json index entry
 *   - per-character data.json with talent/cons/attr/tree/treeData
 *   - placeholder calc.js (optional LLM pipeline can replace it later)
 *   - required images for panel/wiki rendering
 *
 * Notes on IDs:
 * - Different upstream providers may use different pointId spaces.
 * - We include multiple ids in talentId mapping when possible:
 *   - skill tree pointId (e.g. 1202001)
 *   - skill id (e.g. 120201)
 *   - derived pointId for "extra skills" (a2/e2/q2) when Hakush does not list them in SkillTrees.
 *
 * Notes on trees:
 * - Panel attribute bonuses come from `detail.tree` (Attr.setCharAttr reads it).
 * - We generate `detail.treeData` mainly for wiki display of trace skills.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { logAssetError } from '../../../log/run-log.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import type { YattaClient } from '../../../source/yatta/client.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { sortRecordByKey } from '../utils.js'
import { srTalentIdCompat } from '../../compat/sr-talent-id.js'
import { srTreeDataIdCompat } from '../../compat/sr-treeData-id.js'
import { srBaseAttrRoundCompat } from '../../compat/sr-baseAttr-round.js'
import { srTreeCpct7PercentByRatio, srTreeDataValueMode, srTreeFixedPercentByRatio, srTreeValueMode } from '../../compat/sr-tree-value.js'
import type { LlmService } from '../../../llm/service.js'
import { buildCalcJsWithLlmOrHeuristic } from '../../calc/llm-calc.js'
import type { CalcSuggestInput } from '../../calc/llm-calc.js'

const srEnhancedCompat: Record<string, { talentId: Record<string, string> }> = {
  '1005': {
    talentId: {
      '11005001': 'a',
      '11005002': 'e',
      '11005003': 'q',
      '11005004': 't',
      '11005007': 'z'
    }
  },
  '1006': {
    talentId: {
      '11006001': 'a',
      '11006002': 'e',
      '11006003': 'q',
      '11006004': 't',
      '11006007': 'z'
    }
  },
  '1205': {
    talentId: {
      '11205001': 'a',
      '11205002': 'e',
      '11205003': 'q',
      '11205004': 't',
      '11205007': 'z',
      '11205008': 'a2'
    }
  },
  '1212': {
    talentId: {
      '11212001': 'a',
      '11212002': 'e',
      '11212003': 'q',
      '11212004': 't',
      '11212007': 'z',
      '11212009': 'e2'
    }
  }
}

// Baseline quirk: some characters have different SP values in index vs per-character detail json.
// We match baseline by applying this override only to the index entry.
const srIndexSpCompatById: Record<string, number> = {
  '1015': 240,
  '1414': 140
}

// Baseline quirk: a few characters also differ on detail sp vs Hakush.
const srDetailSpCompatById: Record<string, number> = {
  '1414': 135
}

const srIdStringCompat = new Set(['1317'])

// Baseline stores talent point ids as strings for the Trailblazer (穹/星) non-memory forms.
const srTalentBlockIdStringCompatIds = new Set(['8001', '8002', '8003', '8004', '8005', '8006'])

// Baseline stores `allegiance: null` for some Trailblazer forms.
const srNullAllegianceCompatIds = new Set(['8003', '8004', '8005', '8006'])

// Baseline overrides for missing/fallback allegiance (upstream sources may return null/empty).
const srAllegianceCompatById: Record<string, string> = {
  // 三月七·巡猎
  '1224': '星穹列车',
  // Trailblazer (Memory)
  '8007': '星穹列车',
  '8008': '星穹列车'
}

// Baseline overrides for missing/combined CV fields.
const srCvCompatById: Record<string, { cn?: string; jp?: string }> = {
  // 三月七·巡猎
  '1224': { cn: '诺亚', jp: '小倉唯' },
  // 克拉拉（baseline uses only Clara's CV, not both Clara+史瓦罗）
  '1107': { cn: '紫苏九月', jp: '日高里菜' },
  // Trailblazer (Memory)
  '8007': { cn: '秦且歌', jp: '榎木淳弥' },
  '8008': { cn: '陈婷婷', jp: '石川由依' }
}

// Baseline rounds a subset of Trailblazer promotion base attrs more aggressively.
const srAttrBaseRound2CompatIds = new Set(['8001', '8002', '8003', '8004', '8005', '8006'])

const srTalentConsCompatById: Record<string, Record<string, string | number>> = {
  // Baseline icon-selection convention for E3/E5:
  // - 知更鸟 E3 affects E+Q but prefers Q icon; E5 affects A+T but prefers A icon.
  '1309': { '3': 'q', '5': 'a' },
  // Historical baseline expects `t=3` for these two characters.
  '1413': { t: 3 },
  '1415': { t: 3 }
}

// Baseline naming quirks for SR variable tables.
const srShieldDefPctNameCompatById: Record<string, string> = {
  // 砂金
  '1304': '防御力百分比'
}

type SrConstPercentMode = 'talent' | 'rank'

// Baseline formatting quirks for integer percent params rendered from `#k[i]%`:
//
// - `rank`: constellation + trace descriptions rendered via `renderSrTextWithParams()`
// - `talent`: skill descriptions rendered via `skillDescAndTables()`
//
// The baseline is not consistent across these two contexts, so we keep separate allowlists.
const srPercentNoDecimalInRankIds = new Set([
  '1006',
  '1008',
  '1014',
  '1015',
  '1101',
  '1104',
  '1110',
  '1201',
  '1203',
  '1205',
  '1213',
  '1223',
  '1224',
  '1301',
  '1313',
  '1321',
  '1401',
  '1407',
  '1408',
  '1410',
  '1412',
  '1413',
  '1414',
  '1415',
  '8001',
  '8002',
  '8003',
  '8004',
  '8005',
  '8006',
  '8007',
  '8008'
])

const srPercentNoDecimalInTalentIds = new Set([
  '1107',
  '1205',
  '1224',
  '1310',
  '1402',
  '1404',
  '1406',
  '1407',
  '1408',
  '1409',
  '8001',
  '8002',
  '8003',
  '8004',
  '8005',
  '8006',
  '8007',
  '8008'
])

// Baseline stores constant energy/toughness tables differently per character:
// some keep a single value ([20]) while others repeat it by level ([20,20,...]).
const srConstTablesCompactIds = new Set([
  '1005',
  '1006',
  '1014',
  '1015',
  '1205',
  '1212',
  '1321',
  '1408',
  '1410',
  '1412',
  '1413',
  '1414',
  '1415',
  '8007',
  '8008'
])

// Baseline treeData quirks:
// - Some characters use `atk/def/hp` for base stat ratio keys (instead of `atkPct/defPct/hpPct`).
// - Some quantum characters use the legacy misspelling `auantum` (instead of `quantum`).
// - SpeedDelta values are stored as `speed * 100` (200/300/400).
const srTreeDataBaseStatKeyCompatIds = new Set(['1224', '8001', '8002', '8003', '8004'])
const srTreeDataQuantumTypoCompatIds = new Set(['1201', '1214', '1314', '1406', '1407'])

// Baseline naming convention: only a small set of characters label Blast main-target damage as "目标伤害".
const srBlastTargetDamageNameCompatIds = new Set(['1014', '1210', '1212', '1213', '1218', '1221', '1310', '1314', '1413'])

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  if (v == null) return null
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function roundDecimal(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return value
  if (decimals <= 0) return Math.round(value)

  const s = String(value)
  const m = s.match(/^(-?)(\d+)(?:\.(\d+))?$/)
  if (!m) return Number(value.toFixed(decimals))

  const sign = m[1] === '-' ? -1n : 1n
  const intPart = m[2] ?? '0'
  const fracPart = m[3] ?? ''
  const scale = fracPart.length

  const raw = BigInt(intPart + fracPart) * sign
  if (scale === decimals) return Number(s)

  const pow10 = (exp: number): bigint => 10n ** BigInt(exp)

  let scaled: bigint
  if (scale < decimals) {
    scaled = raw * pow10(decimals - scale)
  } else {
    const factor = pow10(scale - decimals)
    const q = raw / factor
    const r = raw % factor
    const absR = r < 0n ? -r : r
    scaled = absR * 2n >= factor ? q + sign : q
  }

  const neg = scaled < 0n
  const abs = neg ? -scaled : scaled
  const digits = abs.toString().padStart(decimals + 1, '0')
  const head = digits.slice(0, -decimals)
  const tail = digits.slice(-decimals)
  return Number(`${neg ? '-' : ''}${head}.${tail}`)
}

function applySrBaseAttrCompat(baseAttr: Record<string, unknown>, charId: number): void {
  const spec = srBaseAttrRoundCompat[String(charId)]
  if (!spec) return

  for (const [k, dec] of Object.entries(spec)) {
    const v = (baseAttr as any)[k]
    if (typeof v !== 'number') continue
    if (typeof dec !== 'number' || !Number.isFinite(dec) || dec < 0) continue
    ;(baseAttr as any)[k] = roundDecimal(v, dec)
  }
}

function normalizeTextInline(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replaceAll('\\n', ' ')
    .replaceAll('\n', ' ')
    .replace(/\s+/g, ' ')
    // Keep baseline-style spacing before "——" but strip any trailing spaces after it.
    .replace(/——\s+/g, '——')
    .replace(/\s+([。！？；，、])/g, '$1')
    .replaceAll('?', '•')
    .trim()
}

function inferUnitHintFromTableValues(valuesRaw: unknown): string {
  const values = Array.isArray(valuesRaw) ? valuesRaw : []
  for (const v of values.slice(0, 3)) {
    const t = normalizeTextInline(v)
    if (!t) continue
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(t)) return '元素精通'
    if (/(生命值上限|最大生命值|生命值|\bhp\b)/i.test(t)) return '生命值上限'
    if (/(防御力|\bdef\b)/i.test(t)) return '防御力'
    if (/(攻击力|攻击|\batk\b)/i.test(t)) return '攻击力'
  }
  return ''
}

function normalizeSrRichText(text: unknown, opts?: { stripUnderline?: boolean }): string {
  if (typeof text !== 'string') return ''
  let out = text
    .replaceAll('\\n\\n', '<br /><br />')
    .replaceAll('\\n', '<br />')
    .replaceAll('\n\n', '<br /><br />')
    .replaceAll('\n', '<br />')
    .replace(/<unbreak>(.*?)<\/unbreak>/g, (_m, inner: string) => {
      const s = String(inner)
      // Keep <nobr> for numbers/params, strip it for names/words.
      if (/[\d$#%]/.test(s)) return `<nobr>${s}</nobr>`
      return s
    })
    // Baseline-style: lift common colored run-state labels into <nobr>.
    .replace(/<color=[^>]+>(整场生效|单次生效)<\/color>/g, '<nobr>$1</nobr>')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<\/?i>/g, '')
    .replaceAll('?', '•')
  if (opts?.stripUnderline) {
    out = out.replace(/<\/?u>/g, '')
  }
  return out.trim()
}

function applyFateCollabTextCompat(text: string): string {
  return text
    .replaceAll('红色衣衫', '红色圣骸布')
    // Fate collab baseline keeps spaces after `，` but removes sentence-breaking spaces after `。！？；、`.
    .replace(/([。！？；、])\s+(?=[\u4e00-\u9fff])/g, '$1')
    // Fate collab baseline also keeps "——" tight (no surrounding spaces).
    .replace(/\s*——\s*/g, '——')
}

function wrapElemSpan(desc: string, elemCn: string): string {
  if (!desc || !elemCn) return desc
  return desc.replaceAll(`${elemCn}属性`, `<span>${elemCn}</span>属性`)
}

const pathMap: Record<string, string> = {
  Mage: '智识',
  Knight: '存护',
  Rogue: '巡猎',
  Warlock: '虚无',
  Warrior: '毁灭',
  Shaman: '同谐',
  Priest: '丰饶',
  Memory: '记忆',
  Elation: '欢愉'
}

const elemMap: Record<string, string> = {
  Ice: '冰',
  Fire: '火',
  Thunder: '雷',
  Wind: '风',
  Quantum: '量子',
  Imaginary: '虚数',
  Physical: '物理'
}

function toPathName(baseType: unknown): string {
  const k = typeof baseType === 'string' ? baseType : ''
  return pathMap[k] || k || '未知'
}

function toElemName(damageType: unknown): string {
  const k = typeof damageType === 'string' ? damageType : ''
  return elemMap[k] || k || ''
}

function parseStar(rarity: unknown): number {
  if (typeof rarity !== 'string') return 0
  const m = rarity.match(/(\d+)$/)
  return m ? Number(m[1]) : 0
}

/**
 * Some characters (notably Trailblazer variants) may use a different numeric prefix
 * in Hakush UI skill icon filenames than their character ID.
 *
 * Instead of hardcoding `SkillIcon_${charId}_...`, derive the numeric prefix from
 * SkillTrees.Icon values when available.
 */
function resolveSrCoreSkillIconId(skillTrees: unknown, fallbackId: string): string {
  if (!isRecord(skillTrees)) return fallbackId

  const countById = new Map<string, number>()
  const bump = (id: string): void => {
    countById.set(id, (countById.get(id) || 0) + 1)
  }

  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      const icon = typeof node.Icon === 'string' ? node.Icon : ''
      const m = icon.match(/^SkillIcon_(\d+)_(Normal|BP|Ultra|Passive|Maze|SkillTree[1-4])\.png$/i)
      if (m?.[1]) bump(m[1])
    }
  }

  let best = ''
  let bestCount = 0
  for (const [id, n] of countById.entries()) {
    if (n > bestCount) {
      best = id
      bestCount = n
    }
  }
  return best || fallbackId
}

function ensurePlaceholderCalcJs(calcPath: string, name: string): void {
  if (fs.existsSync(calcPath)) return
  const content = [
    `// Auto-generated placeholder for ${name}.`,
    `// TODO: Replace with a real calc.js (can be generated with LLM-assisted pipeline).`,
    '',
    'export const details = []',
    'export const defDmgIdx = 0',
    'export const mainAttr = "atk,cpct,cdmg"',
    'export const buffs = []',
    'export const createdBy = "awesome-gpt5.2-xhigh"',
    ''
  ].join('\n')
  fs.writeFileSync(calcPath, content, 'utf8')
}

function buildSrCalcBuffHints(talent: unknown, cons: unknown, treeData: unknown): string[] {
  const hints: string[] = []

  // Technique (秘技): talent.z
  if (isRecord(talent)) {
    const z = (talent as Record<string, unknown>).z
    if (isRecord(z)) {
      const name = typeof z.name === 'string' ? (z.name as string).trim() : ''
      const descRaw = typeof z.desc === 'string' ? (z.desc as string) : ''
      const desc = normalizeTextInline(descRaw).replace(/<[^>]+>/g, '')
      const isBuffLike =
        /(提高|提升|增加|降低|减少|加成)/.test(desc) &&
        /(攻击力|防御力|生命值上限|生命值|速度|暴击率|暴击伤害|伤害|受到.{0,6}伤害|击破|效果命中|效果抵抗|无视|穿透|抗性)/.test(desc)
      if (name && desc && isBuffLike) hints.push(`秘技：${name}：${desc}`)
    }
  }

  // Eidolons (魂)
  if (isRecord(cons)) {
    const keys = Object.keys(cons)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    for (const n of keys) {
      const c = (cons as Record<string, unknown>)[String(n)]
      if (!isRecord(c)) continue
      const name = typeof c.name === 'string' ? (c.name as string).trim() : ''
      const desc = typeof c.desc === 'string' ? (c.desc as string).trim() : ''
      if (!name || !desc) continue
      hints.push(`${n}魂：${name}：${desc}`)
    }
  }

  // Major traces (行迹): treeData root skill nodes (idx=1..)
  if (isRecord(treeData)) {
    const nodes: Array<{ idx: number; name: string; desc: string }> = []
    for (const v of Object.values(treeData)) {
      if (!isRecord(v)) continue
      if (v.type !== 'skill' || v.root !== true) continue
      const idx = typeof v.idx === 'number' && Number.isFinite(v.idx) ? Math.trunc(v.idx) : 0
      const name = typeof v.name === 'string' ? (v.name as string).trim() : ''
      const desc = typeof v.desc === 'string' ? (v.desc as string).trim() : ''
      if (!idx || !name || !desc) continue
      nodes.push({ idx, name, desc })
    }
    nodes.sort((a, b) => a.idx - b.idx)
    for (const n of nodes) {
      hints.push(`行迹${n.idx}：${n.name}：${n.desc}`)
    }
  }

  return hints
}

function isPlaceholderCalc(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw.includes('Auto-generated placeholder')
  } catch {
    return false
  }
}

function loadSrMaterialNameToIdMap(metaSrRootAbs: string): Map<string, string> {
  // Use existing material meta as mapping for cost item IDs (baseline compatibility).
  const materialPath = path.join(metaSrRootAbs, 'material', 'data.json')
  if (!fs.existsSync(materialPath)) return new Map()
  const raw = JSON.parse(fs.readFileSync(materialPath, 'utf8')) as unknown
  const map = new Map<string, string>()
  if (!isRecord(raw)) return map
  for (const cat of Object.values(raw)) {
    if (!isRecord(cat)) continue
    for (const [id, item] of Object.entries(cat)) {
      if (!isRecord(item)) continue
      const name = typeof item.name === 'string' ? item.name : ''
      if (name) map.set(name, id)
    }
  }
  return map
}

function formatConstParam(value: number, format: string, pct: string, opts?: { charId?: number; mode?: SrConstPercentMode }): string {
  if (pct === '%') {
    const p = value * 100
    const int = Math.round(p)
    const isInt = Number.isFinite(int) && Math.abs(p - int) < 1e-9
    const cid = opts?.charId ? String(opts.charId) : ''
    const mode: SrConstPercentMode = opts?.mode || 'talent'
    const noDecimal =
      cid &&
      ((mode === 'rank' && srPercentNoDecimalInRankIds.has(cid)) || (mode === 'talent' && srPercentNoDecimalInTalentIds.has(cid)))
    if (isInt && noDecimal) return `${int}%`
    if (format === 'f2') return `${p.toFixed(2)}%`
    return `${p.toFixed(1)}%`
  }
  // Baseline trims trailing ".0"/".00" for non-percent placeholders.
  if (format === 'f1') return String(parseFloat(value.toFixed(1)))
  if (format === 'f2') return String(parseFloat(value.toFixed(2)))
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

/**
 * Replace Hakush placeholders (#1[i] etc) with constants using ParamList.
 * Used for rank/trace descriptions that do not have per-level tables.
 */
function renderSrTextWithParams(rawDesc: unknown, paramList: unknown, opts?: { charId?: number }): string {
  const desc = typeof rawDesc === 'string' ? rawDesc : ''
  const params = Array.isArray(paramList) ? (paramList as Array<unknown>) : []
  const replaced = desc.replace(/[#$](\d+)\[(i|f1|f2)](%?)/g, (m, idxStr: string, fmt: string, pct: string) => {
    const idx = Number(idxStr) - 1
    if (!Number.isFinite(idx) || idx < 0) return m
    const v = toNum(params[idx])
    if (v == null) return m
    return formatConstParam(v, fmt, pct, { charId: opts?.charId, mode: 'rank' })
  })
  // Baseline keeps <u> underline markers in constellation/trace text.
  return normalizeSrRichText(replaced)
}

function guessPrimaryParamName(descPlain: string, idx: number): string {
  if (idx !== 1) return `参数${idx}`
  if (/(治疗|恢复).{0,8}(生命|生命值)/.test(descPlain) || /治疗量/.test(descPlain)) return '治疗量'
  if (/伤害/.test(descPlain)) return '技能伤害'
  return `参数${idx}`
}

function stripSrTextForParamName(text: string): string {
  return text
    .replaceAll('<unbreak>', '')
    .replaceAll('</unbreak>', '')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<\/?i>/g, '')
    .replace(/<\/?u>/g, '')
}

function guessSrParamName(opts: {
  descSrc: string
  descPlain: string
  charId: number
  varCount: number
  outIdx: number
  origIdx: number
  tagCn: string
  memospriteName?: string
}): string {
  const { descSrc, descPlain, charId, varCount, outIdx, origIdx, tagCn } = opts

  const idx1 = origIdx + 1
  const needleHash = `#${idx1}[`
  const needleDollar = `$${idx1}[`
  const posHash = descPlain.indexOf(needleHash)
  const posDollar = posHash >= 0 ? -1 : descPlain.indexOf(needleDollar)
  const pos = posHash >= 0 ? posHash : posDollar
  const before = pos >= 0 ? descPlain.slice(Math.max(0, pos - 80), pos) : ''
  const after = pos >= 0 ? descPlain.slice(pos, Math.min(descPlain.length, pos + 80)) : ''
  const around = `${before}${after}`

  const beforeTrim = before.trim()
  const beforeSeg = (beforeTrim.split(/[，。,;；、：:]/).pop() || beforeTrim).trim()
  const afterClause = (after.split(/[，。,;；。！？]/)[0] || after).trim()
  const local = `${beforeSeg}${afterClause}`
  const afterNoVar = afterClause.replace(/^[#$]\d+\[(?:i|f1|f2)]%?/, '').trim()
  const memospriteNameRaw = typeof opts.memospriteName === 'string' ? opts.memospriteName.trim() : ''
  const memospriteName = memospriteNameRaw && memospriteNameRaw.length <= 16 ? memospriteNameRaw : ''
  const isMemospriteParam = Boolean(memospriteName && beforeSeg.includes(memospriteName))
  const withMemospriteSuffix = (name: string): string => {
    if (!isMemospriteParam) return name
    if (!name || name.includes('·')) return name
    if (!/伤害/.test(name)) return name
    return `${name}·${memospriteName}`
  }

  const isPercent = new RegExp(`[#$]${idx1}\\[(?:i|f1|f2)]%`).test(descSrc)
  const hasDamage = /伤害/.test(descPlain)
  const isShieldParam = local.includes('护盾')
  const isHealParam = /(治疗|回复|恢复)/.test(local) && /生命上限|生命值/.test(local)
  const isHpUpParam =
    /(?:生命上限|生命值)/.test(local) &&
    /(提高|提升|增加)/.test(local) &&
    !/(治疗|回复|恢复)/.test(local) &&
    !/伤害/.test(local)
  const isAtkUpParam =
    /攻击力/.test(local) && /(提高|提升|增加)/.test(local) && !/伤害/.test(local)
  const isDefUpParam =
    /防御力/.test(local) && /(提高|提升|增加)/.test(local) && !/伤害/.test(local)
  // Prefer the *local* clause around the placeholder to avoid false positives when the same skill mixes
  // adjacent-target wording and later "all targets" hits (e.g. $1 used for blast, $2 used for AoE finisher).
  const isAdjacentDamage = /相邻目标|相邻敌方|相邻/.test(local) && /伤害/.test(local)
  const isAllTargetDamage = /(敌方全体|所有敌方目标|所有目标|全体)/.test(local) && /伤害/.test(local)
  const isCounterDamage = local.includes('反击') && /伤害/.test(local)
  const isFollowUpDamage = local.includes('追加攻击') && /伤害/.test(local)
  const isExtraDamage = /(额外|附加)/.test(local) && /伤害/.test(local)

  const stat =
    around.includes('攻击力') ? 'atk' : around.includes('防御力') ? 'def' : /生命上限|生命值/.test(around) ? 'hp' : ''

  // Common buffs (these contain "伤害" but are NOT damage params).
  if (/抗性穿透.*(提高|增加)$/.test(beforeSeg)) return '抗性穿透提高'
  if (/暴击率.*(提高|增加)$/.test(beforeSeg)) return '暴击率提高'
  if (/暴击伤害.*(提高|增加)$/.test(beforeSeg)) return '暴击伤害提高'
  if (/效果命中.*(提高|增加)$/.test(beforeSeg)) return '效果命中提高'
  if (/效果抵抗.*(提高|增加)$/.test(beforeSeg)) return '效果抵抗提高'
  if (/击破特攻.*(提高|增加)$/.test(beforeSeg)) return '击破特攻提高'
  if (/速度.*(提高|增加)$/.test(beforeSeg)) return '速度提高'
  if (/攻击力.*(提高|增加)$/.test(beforeSeg)) return '攻击力提高'
  if (/防御力.*(提高|增加)$/.test(beforeSeg)) return '防御力提高'
  if (/(生命上限|生命值).*(提高|增加)$/.test(beforeSeg)) return '生命值提高'
  if (/击破伤害倍率.*(提高|增加)$/.test(beforeSeg)) return '击破倍率提高'
  if (/伤害倍率.*(提高|增加)$/.test(beforeSeg)) return '伤害倍率提高'
  if (/倍率.*(提高|增加)$/.test(beforeSeg)) return '倍率提高'
  if (/战技.*伤害.*(提高|增加)$/.test(beforeSeg)) return '战技伤害提高'
  if (/终结技.*伤害.*(提高|增加)$/.test(beforeSeg)) return '终结技伤害提高'
  if (/普攻.*伤害.*(提高|增加)$/.test(beforeSeg)) return '普攻伤害提高'
  if (/天赋.*伤害.*(提高|增加)$/.test(beforeSeg)) return '天赋伤害提高'
  if (/伤害.*(提高|增加)$/.test(beforeSeg)) return '伤害提高'

  // Common non-damage mechanics (often appear in mixed skills with damage).
  // Base chance: `$n% 的基础概率 ...`
  if (/^(?:的)?(?:基础概率|基础几率|概率|几率)/.test(afterNoVar) && !/暴击率/.test(afterNoVar)) return '基础概率'
  if (/全属性抗性/.test(beforeSeg) && /(降低|减少)/.test(beforeSeg)) return '全属性抗性降低'
  if (/(对应属性|该属性)/.test(beforeSeg) && /抗性/.test(beforeSeg) && /(降低|减少)/.test(beforeSeg)) return '对应属性抗性降低'
  if (/抗性/.test(beforeSeg) && /(降低|减少)/.test(beforeSeg) && !/(效果抵抗|效果抗性|抗性穿透)/.test(beforeSeg)) return '抗性降低'
  if (/防御力/.test(beforeSeg) && /(降低|减少|下降)/.test(beforeSeg) && !/(提高|提升|增加)/.test(beforeSeg)) return '防御力降低'
  if (/攻击力/.test(beforeSeg) && /(降低|减少|下降)/.test(beforeSeg) && !/(提高|提升|增加)/.test(beforeSeg)) return '攻击力降低'
  if (/速度/.test(beforeSeg) && /(降低|减少|下降)/.test(beforeSeg) && !/(提高|提升|增加)/.test(beforeSeg)) return '速度降低'
  if (/受到/.test(beforeSeg) && /伤害/.test(beforeSeg) && /(降低|减少)/.test(beforeSeg)) return '受到伤害降低'
  if (!/受到/.test(beforeSeg) && /伤害/.test(beforeSeg) && /(降低|减少)/.test(beforeSeg)) return '伤害降低'

  // Common non-heal stat-up params (HP/ATK/DEF). These are frequently shown alongside heals/buffs and should not
  // fall back to generic "参数1/2", otherwise LLMs may accidentally use them as heal multipliers.
  if (isHpUpParam) return isPercent ? '生命提高·百分比生命' : '生命提高·固定值'
  if (isAtkUpParam) return isPercent ? '攻击提高·攻击力百分比' : '攻击提高·固定值'
  if (isDefUpParam) return isPercent ? '防御提高·防御力百分比' : '防御提高·固定值'

  // Stat-up caps: "最高不超过自身攻击力的 $n% ..."
  // These are frequently the 2nd param in buff skills, and leaving them as 参数N makes downstream buff modeling harder.
  if (/最高不超过/.test(around) || /上限不超过/.test(around)) {
    if (/攻击力/.test(around)) return isPercent ? '攻击力上限比例' : '攻击力上限'
    if (/防御力/.test(around)) return isPercent ? '防御力上限比例' : '防御力上限'
    if (/(生命上限|生命值)/.test(around)) return isPercent ? '生命值上限比例' : '生命值上限'
  }

  if (isShieldParam) {
    if (isPercent && stat === 'def') return srShieldDefPctNameCompatById[String(charId)] || '百分比防御'
    if (!isPercent) return '固定值'
    return `参数${outIdx}`
  }

  // Mixed skills: if this param is clearly a heal amount, label it directly.
  if (isHealParam && hasDamage) {
    return '生命值回复'
  }

  // Damage params (including mixed skills): infer special cases from local context.
  if (/伤害/.test(local)) {
    // Break / Super-break damage ratios.
    // These are not regular "技能伤害" multipliers and should be named explicitly so downstream calc.js
    // can model them via `reaction("<elem>Break"/"superBreak")` and related buffs.
    if (/(击破伤害)/.test(local) || /(击破伤害)/.test(around)) {
      if (/超击破/.test(local) || /超击破/.test(around)) return '超击破伤害比例'
      // Special wording: "造成...属性击破伤害的击破伤害" / "无视弱点属性..." is closer to baseline "击破伤害".
      // Keep the generic "击破伤害比例" for regular break-ratio tables (e.g. Ruan Mei).
      if (/属性击破伤害/.test(local) || /属性击破伤害/.test(around) || /无视弱点属性/.test(around)) {
        return withMemospriteSuffix('击破伤害')
      }
      return withMemospriteSuffix('击破伤害比例')
    }

    // Repeated-release multipliers: "可重复发动... 伤害倍率依次提高至 $2%/$3% ..."
    // These MUST have distinct names; miao-plugin maps tables by name and overrides duplicates.
    if (
      varCount >= 2 &&
      /(重复|再次|再度)/.test(descPlain) &&
      /(依次|分别)/.test(descPlain) &&
      /(提高|提升|增加).{0,6}至/.test(descPlain) &&
      /[\/∕]/.test(descPlain)
    ) {
      if (outIdx === 2) return '二次释放伤害'
      if (outIdx === 3) return '三次释放伤害'
      if (outIdx === 4) return '四次释放伤害'
      if (outIdx === 5) return '五次释放伤害'
      if (outIdx === 6) return '六次释放伤害'
    }

    // Explicit "第N次/二次/三次..." context near the placeholder.
    if (/(二次|第二次)/.test(local)) return '二次释放伤害'
    if (/(三次|第三次)/.test(local)) return '三次释放伤害'
    if (/(四次|第四次)/.test(local)) return '四次释放伤害'

    if (/(随机).{0,6}(敌方|目标|单体)/.test(local)) return withMemospriteSuffix('随机伤害')
    if (local.includes('持续伤害')) return '持续伤害'
    if (/每段/.test(around)) return '每段伤害'
    if (/每次/.test(around)) return '每次伤害'
    if (isAllTargetDamage) return '所有目标伤害'
    if (isAdjacentDamage) return withMemospriteSuffix('相邻目标伤害')
    if (isCounterDamage) return '反击伤害'
    if (isFollowUpDamage) return varCount <= 1 ? '技能伤害' : '追加攻击伤害'
    if (isExtraDamage) {
      if (local.includes('附加伤害')) return '附加伤害'
      if (/(目标数量|每有|均分)/.test(local)) return '额外伤害'
      return '附加伤害'
    }
    if (tagCn === '单体') return '单体伤害'
    if (tagCn === '扩散' && outIdx === 1 && /相邻目标|相邻敌方/.test(descPlain)) {
      const base = srBlastTargetDamageNameCompatIds.has(String(charId)) ? '目标伤害' : '技能伤害'
      return withMemospriteSuffix(base)
    }
    return withMemospriteSuffix('技能伤害')
  }

  // Heal-only skills (no damage present in the whole description) use more specific naming.
  if (isHealParam) {
    const isRevive = /(复活|复苏|复原)/.test(descPlain)
    const hasInstantAndRegen = descPlain.includes('立即') && /(每回合|回合开始|持续)/.test(descPlain)
    const isRegenParam = /(每回合|回合开始|持续)/.test(before) || /(每回合|回合开始)/.test(afterClause)
    const prefix = isRevive ? '复活·' : hasInstantAndRegen ? (isRegenParam ? '持续治疗·' : '治疗·') : '治疗·'

    if (isPercent) {
      const name =
        stat === 'atk'
          ? '攻击力百分比'
          : stat === 'hp'
            ? '百分比生命'
            : stat === 'def'
              ? '防御力百分比'
              : `参数${outIdx}`
      return `${prefix}${name}`
    }

    // Fixed value.
    return `${prefix}固定值`
  }

  // Per-stack split multipliers: "...每层对主目标/其他目标提高 $1%/$2% ..."
  // These often lack the "伤害" keyword in the immediate placeholder vicinity, causing a generic 参数1/2 name,
  // which then blocks downstream calc.js generation (LLM/heuristics cannot infer main-vs-adj scaling).
  // Prefer baseline-like naming when we can confidently detect the pattern.
  if (
    isPercent &&
    /每层/.test(around) &&
    /(主目标|主目標)/.test(around) &&
    /(其他目标|其他目標|相邻目标|相邻目標)/.test(around) &&
    /(伤害倍率|伤害).*(提高|提升|增加)/.test(descPlain)
  ) {
    if (outIdx === 1) return '主目标每层倍率'
    if (outIdx === 2) return '相邻目标每层倍率'
  }

  return guessPrimaryParamName(local || descPlain, outIdx)
}

function skillDescAndTables(
  rawDesc: unknown,
  levelObj: unknown,
  spBase: unknown,
  showStanceList: unknown,
  elemCn: string,
  opts?: { levelCap?: number; tagCn?: string; noElemSpan?: boolean; charId?: number; memospriteName?: string }
): { desc: string; tables: Record<string, { name: string; isSame: boolean; values: number[] }> } {
  const descSrc = typeof rawDesc === 'string' ? rawDesc : ''
  const descPlain = normalizeTextInline(stripSrTextForParamName(descSrc))
  const levels = isRecord(levelObj) ? (levelObj as Record<string, unknown>) : {}

  // Gather ParamList by level number.
  const lvKeysRaw = Object.keys(levels)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
    .map((n) => String(n))

  const cap = typeof opts?.levelCap === 'number' && Number.isFinite(opts.levelCap) ? Math.max(1, opts.levelCap) : null
  const lvKeys = cap ? lvKeysRaw.slice(0, cap) : lvKeysRaw

  const paramLists: number[][] = []
  for (const k of lvKeys) {
    const v = levels[k]
    if (!isRecord(v) || !Array.isArray(v.ParamList)) continue
    const nums = (v.ParamList as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x)))
    if (nums.every((n) => Number.isFinite(n))) paramLists.push(nums as number[])
  }

  // If no ParamList, just normalize and return.
  if (paramLists.length === 0) {
    const base = normalizeSrRichText(descSrc)
    return { desc: opts?.noElemSpan ? base : wrapElemSpan(base, elemCn), tables: {} }
  }

  const paramCount = Math.max(...paramLists.map((a) => a.length))
  const isPercentParam = (idx: number): boolean =>
    descSrc.includes(`#${idx + 1}[i]%`) ||
    descSrc.includes(`#${idx + 1}[f1]%`) ||
    descSrc.includes(`#${idx + 1}[f2]%`) ||
    descSrc.includes(`$${idx + 1}[i]%`) ||
    descSrc.includes(`$${idx + 1}[f1]%`) ||
    descSrc.includes(`$${idx + 1}[f2]%`)

  // Determine constant vs variable params (with a tiny tolerance).
  const isConst: boolean[] = []
  for (let i = 0; i < paramCount; i++) {
    const vals = paramLists.map((arr) => arr[i]).filter((v) => typeof v === 'number') as number[]
    const first = vals[0]
    isConst[i] = vals.length > 0 && vals.every((v) => Math.abs(v - first) < 1e-12)
  }

  // Map original param index -> new variable index (1-based).
  const varMap = new Map<number, number>()
  let varIdx = 0

  // Baseline assigns variable indices in the order they appear in the description text
  // (not by the numeric param index), so that `$1` matches the first dynamic value shown to users.
  const ensureVar = (origIdx: number): void => {
    if (origIdx < 0 || origIdx >= paramCount) return
    if (isConst[origIdx]) return
    if (varMap.has(origIdx)) return
    varIdx++
    varMap.set(origIdx, varIdx)
  }

  for (const m of descSrc.matchAll(/[#$](\d+)\[(i|f1|f2)]%?/g)) {
    const origIdx = Number(m[1]) - 1
    if (!Number.isFinite(origIdx)) continue
    ensureVar(origIdx)
  }

  // Build variable tables.
  const tables: Record<string, { name: string; isSame: boolean; values: number[] }> = {}
  for (const [origIdx, outIdx] of varMap.entries()) {
    const values = paramLists.map((arr) => arr[origIdx] ?? 0)
    const name = guessSrParamName({
      descSrc,
      descPlain,
      charId: opts?.charId ?? 0,
      varCount: varMap.size,
      outIdx,
      origIdx,
      tagCn: opts?.tagCn ?? '',
      memospriteName: opts?.memospriteName
    })
    tables[String(outIdx)] = { name, isSame: false, values }
  }

  // Replace placeholders:
  // - constants => literal numbers (keep <nobr> wrapper if upstream had it)
  // - variables => $k[i]/$k[f1] etc
  const replaced = descSrc.replace(/[#$](\d+)\[(i|f1|f2)](%?)/g, (m, idxStr: string, fmt: string, pct: string) => {
    const origIdx = Number(idxStr) - 1
    if (!Number.isFinite(origIdx) || origIdx < 0) return m
      if (isConst[origIdx]) {
        const v = paramLists[0]?.[origIdx]
        if (typeof v !== 'number' || !Number.isFinite(v)) return m
        return formatConstParam(v, fmt, pct === '%' || isPercentParam(origIdx) ? '%' : pct, {
          charId: opts?.charId,
          mode: 'talent'
        })
      }
    const mapped = varMap.get(origIdx)
    return mapped ? `$${mapped}[${fmt}]${pct}` : m
  })

  const baseDesc = normalizeSrRichText(replaced)
  const desc = opts?.noElemSpan ? baseDesc : wrapElemSpan(baseDesc, elemCn)

  // Append constant tables for energy gain / toughness damage.
  const baseEnergy = toNum(spBase)
  const stanceArr = Array.isArray(showStanceList) ? (showStanceList as Array<unknown>) : []
  const stanceVals = stanceArr
    .map((v) => toNum(v))
    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
  // Hakush `ShowStanceList` is per-hit/per-part stance damage. Use sum for total toughness cost,
  // and keep a separate per-hit max to support super-break modeling (some traces/cons modify the 1st hit only).
  let stanceSumRaw = stanceVals.length ? stanceVals.reduce((a, b) => a + b, 0) : null
  const stanceMaxRaw = stanceVals.length ? Math.max(...stanceVals) : null

  // Some multi-hit skills (esp. bounce/extra-hit descriptions) use a compact stance list where:
  // - stanceVals[0] is the 1st hit stance dmg
  // - stanceVals[1..] is a repeating cycle for subsequent hits
  // To better approximate baseline-style “单怪全段命中” assumptions, expand by hit count when it is explicitly stated.
  if (stanceSumRaw != null && stanceVals.length >= 2) {
    const extraHitM = descPlain.match(/额外造成\s*(\d{1,2})\s*次伤害/)
    const totalHitM = descPlain.match(/共(?:弹射|造成)\s*(\d{1,2})\s*次/)
    const extraHits = extraHitM ? Math.trunc(Number(extraHitM[1])) : 0
    const totalHits = totalHitM ? Math.trunc(Number(totalHitM[1])) : 0
    const hits = extraHits > 0 ? 1 + extraHits : totalHits > 1 ? totalHits : 0
    const hitOk = Number.isFinite(hits) && hits >= 2 && hits <= 20
    if (hitOk) {
      const first = stanceVals[0] ?? 0
      const cycle = stanceVals.slice(1)
      if (cycle.length) {
        let sum = first
        for (let i = 0; i < hits - 1; i++) {
          sum += cycle[i % cycle.length] ?? 0
        }
        if (Number.isFinite(sum) && sum > 0) stanceSumRaw = sum
      }
    }
  }
  const levelLen = Math.max(1, paramLists.length)
  const compactConstTables = Boolean(opts?.charId && srConstTablesCompactIds.has(String(opts.charId)))
  let nextIdx = varIdx

  if (baseEnergy != null && baseEnergy > 0) {
    nextIdx++
    tables[String(nextIdx)] = {
      name: '能量恢复',
      isSame: true,
      values: compactConstTables ? [baseEnergy] : Array.from({ length: levelLen }, () => baseEnergy)
    }
  }

  if (stanceSumRaw != null && stanceSumRaw > 0) {
    nextIdx++
    const stance = stanceSumRaw / 30
    tables[String(nextIdx)] = {
      name: '削韧',
      isSame: true,
      values: compactConstTables ? [stance] : Array.from({ length: levelLen }, () => stance)
    }
  }

  if (stanceMaxRaw != null && stanceMaxRaw > 0 && stanceSumRaw != null && stanceSumRaw > stanceMaxRaw + 1e-12) {
    nextIdx++
    const stance = stanceMaxRaw / 30
    tables[String(nextIdx)] = {
      name: '削韧(单次)',
      isSame: true,
      values: compactConstTables ? [stance] : Array.from({ length: levelLen }, () => stance)
    }
  }

  // Ensure table names are unique within this skill.
  // miao-plugin runtime maps talent tables by name (object key), so duplicates will be overridden and
  // calc.js will observe missing params (often turning into 0 damage).
  const nameCounts = new Map<string, number>()
  for (const t of Object.values(tables)) {
    const n = typeof t?.name === 'string' ? t.name.trim() : ''
    if (!n) continue
    nameCounts.set(n, (nameCounts.get(n) || 0) + 1)
  }
  if (Array.from(nameCounts.values()).some((n) => n > 1)) {
    const seen = new Map<string, number>()
    for (const t of Object.values(tables)) {
      const baseName = typeof t?.name === 'string' ? t.name.trim() : ''
      if (!baseName) continue
      const total = nameCounts.get(baseName) || 0
      if (total <= 1) continue
      const idx = (seen.get(baseName) || 0) + 1
      seen.set(baseName, idx)
      if (idx === 1) continue
      t.name = `${baseName}(${idx})`
    }
  }

  // Energy/stance tables are for display only; they are not referenced in desc.
  return { desc, tables }
}

type SrTalentKey = 'a' | 'a2' | 'e' | 'e1' | 'e2' | 'q' | 'q2' | 't' | 't2' | 'z' | 'me' | 'me2' | 'mt' | 'mt1' | 'mt2'

function typeToTalentKey(type: unknown): 'a' | 'e' | 'q' | 't' | 'z' | null {
  if (type === null || type === undefined) return 't'
  if (typeof type !== 'string') return null
  const map: Record<string, 'a' | 'e' | 'q' | 't' | 'z' | undefined> = {
    Normal: 'a',
    BPSkill: 'e',
    Ultra: 'q',
    Passive: 't',
    Maze: 'z',
    MazeNormal: 'z'
  }
  return map[type] ?? null
}

function typeLabelFromKey(key: SrTalentKey): string {
  const base = key.replace(/\d+$/, '') as SrTalentKey
  if (base === 'a') return '普攻'
  if (base === 'e') return '战技'
  if (base === 'q') return '终结技'
  if (base === 't') return '天赋'
  if (base === 'z') return '秘技'
  if (base === 'me' || base === 'me2') return '忆灵技'
  if (base === 'mt' || base === 'mt1' || base === 'mt2') return '忆灵天赋'
  return '技能'
}

function tagLabel(tag: unknown): string {
  if (typeof tag !== 'string') return ''
  const map: Record<string, string> = {
    SingleAttack: '单攻',
    Blast: '扩散',
    BlastAttack: '扩散',
    AoEAttack: '群攻',
    AoeAttack: '群攻',
    Bounce: '弹射',
    Enhance: '强化',
    MazeAttack: '',
    Summon: '召唤',
    Support: '辅助',
    Impair: '妨害',
    Heal: '回复',
    Restore: '回复',
    Shield: '防御',
    Defence: '防御',
    Defend: '防御'
  }
  return map[tag] ?? tag
}

function derivePointIdFromSkillId(charId: number, skillId: number): number | null {
  const c = String(charId)
  const s = String(skillId)
  if (!s.startsWith(c)) return null
  const suffix = s.slice(c.length)
  if (!suffix) return null
  // Most skills are charId + 2-digit suffix (e.g. 1202 + 01 => 120201),
  // while pointId uses 3 digits (e.g. 1202001).
  if (suffix.length === 2) return Number(`${c}${suffix.padStart(3, '0')}`)
  if (suffix.length === 3) return Number(`${c}${suffix}`)
  return null
}

function mergePreferBaseline(base: unknown, out: unknown): unknown {
  if (base === out) return out
  if (base === null) return null
  if (Array.isArray(base)) return base
  if (typeof base !== 'object') return base

  const a = base as Record<string, unknown>
  const b = out && typeof out === 'object' && !Array.isArray(out) ? (out as Record<string, unknown>) : {}

  const merged: Record<string, unknown> = { ...b }
  for (const [k, v] of Object.entries(a)) {
    merged[k] = mergePreferBaseline(v, b[k])
  }
  return merged
}

function buildSkillIdToPointIdMap(skillTrees: Record<string, unknown>): Map<number, number> {
  const map = new Map<number, number>()
  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      if (node.PointType !== 2) continue
      const pointId = typeof node.PointID === 'number' ? node.PointID : null
      const up = Array.isArray(node.LevelUpSkillID) ? (node.LevelUpSkillID as Array<unknown>) : []
      const up0 = typeof up[0] === 'number' ? (up[0] as number) : null
      if (pointId && up0) map.set(up0, pointId)
    }
  }
  return map
}

function parseTalentConsFromRanks(ranks: Record<string, unknown>): Record<string, string | number> {
  const out: Record<string, string | number> = {}

  const applyRank = (rankNum: 3 | 5): void => {
    const r = ranks[String(rankNum)]
    if (!isRecord(r)) return
    const desc = normalizeSrRichText(r.Desc)

    const found: SrTalentKey[] = []
    const push = (k: SrTalentKey) => {
      if (!found.includes(k)) found.push(k)
      out[k] = rankNum
    }

    if (desc.includes('普攻等级')) push('a')
    if (desc.includes('战技等级')) push('e')
    if (desc.includes('终结技等级')) push('q')
    if (desc.includes('天赋等级')) push('t')
    if (desc.includes('忆灵技等级')) push('me')
    if (desc.includes('忆灵天赋等级')) push('mt')

    // Which icon to show for E3/E5 "skill level up" slot.
    //
    // Baseline convention: prefer Q for rank 3 and E for rank 5 when both are boosted,
    // otherwise pick the first found skill in stable priority.
    const primary =
      found.includes('q') && found.includes('e')
        ? rankNum === 3
          ? 'q'
          : 'e'
        : (['e', 'q', 't', 'a', 'me', 'mt'] as const).find((k) => found.includes(k)) || 'e'
    out[String(rankNum)] = primary
  }

  applyRank(3)
  applyRank(5)

  // Fallback if parsing didn't detect anything.
  if (!out['3'] || !out['5']) {
    return {
      '3': 'q',
      '5': 'e',
      a: 3,
      e: 5,
      q: 3,
      t: 5
    }
  }

  return out
}

function treeKeyFromPropertyType(propertyType: string): { key: string; valueIsPercent: boolean } | null {
  const map: Record<string, { key: string; valueIsPercent: boolean } | undefined> = {
    AttackAddedRatio: { key: 'atk', valueIsPercent: true },
    DefenceAddedRatio: { key: 'def', valueIsPercent: true },
    MaxHPAddedRatio: { key: 'hp', valueIsPercent: true },
    HPAddedRatio: { key: 'hp', valueIsPercent: true },
    AttackDelta: { key: 'atkPlus', valueIsPercent: false },
    DefenceDelta: { key: 'defPlus', valueIsPercent: false },
    HPDelta: { key: 'hpPlus', valueIsPercent: false },
    SpeedDelta: { key: 'speed', valueIsPercent: false },
    CriticalChanceBase: { key: 'cpct', valueIsPercent: true },
    CriticalDamageBase: { key: 'cdmg', valueIsPercent: true },
    StatusProbabilityBase: { key: 'effPct', valueIsPercent: true },
    StatusResistanceBase: { key: 'effDef', valueIsPercent: true },
    BreakDamageAddedRatio: { key: 'stance', valueIsPercent: true },
    BreakDamageAddedRatioBase: { key: 'stance', valueIsPercent: true },
    HealRatioBase: { key: 'heal', valueIsPercent: true },
    SPRatioBase: { key: 'recharge', valueIsPercent: true },
    PhysicalAddedRatio: { key: 'phy', valueIsPercent: true },
    FireAddedRatio: { key: 'fire', valueIsPercent: true },
    IceAddedRatio: { key: 'ice', valueIsPercent: true },
    ThunderAddedRatio: { key: 'elec', valueIsPercent: true },
    WindAddedRatio: { key: 'wind', valueIsPercent: true },
    QuantumAddedRatio: { key: 'quantum', valueIsPercent: true },
    ImaginaryAddedRatio: { key: 'imaginary', valueIsPercent: true }
  }
  return map[propertyType] ?? null
}

function treeDataKeyFromPropertyType(propertyType: string): { key: string; valueIsPercent: boolean } | null {
  const mapped = treeKeyFromPropertyType(propertyType)
  if (!mapped) return null

  // Baseline treeData uses `*Pct` keys for base stat ratios (atk/def/hp), but tree uses `atk/def/hp`.
  if (mapped.valueIsPercent && mapped.key === 'atk') return { key: 'atkPct', valueIsPercent: true }
  if (mapped.valueIsPercent && mapped.key === 'def') return { key: 'defPct', valueIsPercent: true }
  if (mapped.valueIsPercent && mapped.key === 'hp') return { key: 'hpPct', valueIsPercent: true }
  return mapped
}

function buildTree(skillTrees: Record<string, unknown>, charId: number): Record<string, { key: string; value: number }> {
  const tree: Record<string, { key: string; value: number }> = {}
  const mode = srTreeValueMode[String(charId)] ?? 'fixed'

  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      if (node.PointType !== 1) continue
      const pointId = typeof node.PointID === 'number' ? node.PointID : null
      if (!pointId) continue

      const statusArr = Array.isArray(node.StatusAddList) ? (node.StatusAddList as Array<unknown>) : []
      const first = isRecord(statusArr[0]) ? (statusArr[0] as Record<string, unknown>) : null
      if (!first) continue
      const propType = typeof first.PropertyType === 'string' ? first.PropertyType : ''
      const value = toNum(first.Value)
      if (!propType || value == null) continue

      const mapped = treeKeyFromPropertyType(propType)
      if (!mapped) continue

      const outVal = mapped.valueIsPercent
        ? (() => {
            const ratioKey = String(value)
            if (mode === 'fixed') return srTreeFixedPercentByRatio[ratioKey] ?? value * 100
            if (mode === 'cpct7') return srTreeCpct7PercentByRatio[ratioKey] ?? value * 100
            return value * 100
          })()
        : value
      tree[String(pointId)] = { key: mapped.key, value: outVal }
    }
  }

  return sortRecordByKey(tree)
}

function materialListToCost(
  materialList: unknown,
  itemAll: Record<string, unknown>,
  nameToId: Map<string, string>
): Record<string, number> {
  const out: Record<string, number> = {}
  const list = Array.isArray(materialList) ? (materialList as Array<unknown>) : []
  for (const row of list) {
    if (!isRecord(row)) continue
    const itemId = toNum(row.ItemID)
    const itemNum = toNum(row.ItemNum)
    if (!itemId || !itemNum) continue
    const item = isRecord(itemAll[String(itemId)]) ? (itemAll[String(itemId)] as Record<string, unknown>) : null
    const itemName = item && typeof item.ItemName === 'string' ? item.ItemName : ''
    const mappedId = itemName ? nameToId.get(itemName) : undefined
    const outId = mappedId || String(itemId)
    out[outId] = (out[outId] || 0) + itemNum
  }
  return out
}

function nodeLevelReq(node: Record<string, unknown>, charId: number): number {
  // Baseline convention:
  // - trace skill nodes: always show as 0
  // - trace buff nodes: prefer AvatarLevelLimit; otherwise some use AvatarPromotionLimit
  // - legacy-id-only characters typically keep promote-only nodes at 0
  // - Mar7 Hunt baseline keeps all nodes at 0
  const pt = toNum(node.PointType)
  if (pt === 3 || pt === 5) return 0
  if (charId === 1224) return 0

  const lvl = toNum(node.AvatarLevelLimit)
  if (lvl != null) return lvl <= 0 ? 0 : lvl

  const promote = toNum(node.AvatarPromotionLimit)
  if (promote == null) return 0
  const hasLegacyIds = Boolean(srTreeDataIdCompat[String(charId)])
  if (hasLegacyIds) return 0
  return promote <= 0 ? 0 : promote
}

function treeIdxFromIcon(icon: unknown): number {
  if (typeof icon !== 'string') return 1
  const m = icon.match(/SkillTree(\d+)/)
  if (m) return Number(m[1])
  // Some characters (e.g. Trailblazer Memory) use Normal02 for an extra trace skill node.
  if (/Normal02/i.test(icon)) return 4
  return 1
}

function buildTreeData(
  skillTrees: Record<string, unknown>,
  itemAll: Record<string, unknown>,
  nameToId: Map<string, string>,
  charId: number
): Record<string, unknown> {
  type TreeNode =
    | {
        id: number
        type: 'skill'
        root: boolean
        name: string
        levelReq: number
        desc: string
        cost: Record<string, number>
        idx: number
        children?: number[]
      }
    | {
        id: number
        type: 'buff'
        root: boolean
        name: string
        levelReq: number
        cost: Record<string, number>
        data: Record<string, number>
        children?: number[]
      }

  const valueMode = srTreeDataValueMode[String(charId)] ?? 'simple'

  // De-duplicate nodes by PointID (Hakush repeats nodes across anchors for leveling steps).
  const nodesById = new Map<number, Record<string, unknown>>()
  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      const pid = typeof node.PointID === 'number' ? node.PointID : null
      if (!pid) continue
      const pt = toNum(node.PointType)
      if (pt !== 1 && pt !== 3 && pt !== 5) continue
      if (!nodesById.has(pid)) nodesById.set(pid, node)
    }
  }

  // Build initial entries.
  const out: Record<string, TreeNode> = {}
  const childMap = new Map<number, Set<number>>()
  for (const [pid, node] of nodesById.entries()) {
    const pt = toNum(node.PointType)
    if (pt !== 1 && pt !== 3 && pt !== 5) continue
    const pre = Array.isArray(node.PrePoint) ? (node.PrePoint as Array<unknown>) : []
    const preIds = pre.map((x) => toNum(x)).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    for (const p of preIds) {
      if (!childMap.has(p)) childMap.set(p, new Set())
      childMap.get(p)?.add(pid)
    }

    const root = preIds.length === 0
    const name = typeof node.PointName === 'string' ? node.PointName : ''
    const levelReq = nodeLevelReq(node, charId)
    const cost = materialListToCost(node.MaterialList, itemAll, nameToId)

    if (pt === 3 || pt === 5) {
      out[String(pid)] = {
        id: pid,
        type: 'skill',
        root,
        name,
        levelReq,
        desc: renderSrTextWithParams(node.PointDesc, node.ParamList, { charId }),
        cost,
        idx: treeIdxFromIcon(node.Icon)
      }
    } else {
      // Buff/stat node: store only the raw stat data for completeness.
      const statusArr = Array.isArray(node.StatusAddList) ? (node.StatusAddList as Array<unknown>) : []
      const first = isRecord(statusArr[0]) ? (statusArr[0] as Record<string, unknown>) : null
      const propType = first && typeof first.PropertyType === 'string' ? first.PropertyType : ''
      const v = first ? toNum(first.Value) : null
      const mapped = propType ? treeDataKeyFromPropertyType(propType) : null
      const data: Record<string, number> = {}
      if (mapped && v != null) {
        let outKey = mapped.key
        if (outKey === 'quantum' && srTreeDataQuantumTypoCompatIds.has(String(charId))) outKey = 'auantum'
        if (srTreeDataBaseStatKeyCompatIds.has(String(charId))) {
          if (outKey === 'atkPct') outKey = 'atk'
          if (outKey === 'defPct') outKey = 'def'
          if (outKey === 'hpPct') outKey = 'hp'
        }

        const outVal = mapped.valueIsPercent
          ? (() => {
              const ratioKey = String(v)
              if (valueMode === 'fixed') return srTreeFixedPercentByRatio[ratioKey] ?? v * 100
              if (valueMode === 'cpct7' && mapped.key === 'cpct') return srTreeCpct7PercentByRatio[ratioKey] ?? v * 100
              return v * 100
            })()
          : outKey === 'speed'
            ? v * 100
            : v
        data[outKey] = outVal
      }
      out[String(pid)] = {
        id: pid,
        type: 'buff',
        root,
        name,
        levelReq,
        cost,
        data
      }
    }
  }

  // Attach children arrays.
  for (const [parent, set] of childMap.entries()) {
    const entry = out[String(parent)]
    if (!entry) continue
    const children = Array.from(set).sort((a, b) => a - b)
    if (children.length > 0) {
      entry.children = children
    }
  }

  // Duplicate selected entries into legacy id space for baseline compatibility.
  const compat = srTreeDataIdCompat[String(charId)]
  if (compat) {
    for (const [legacyId, spec] of Object.entries(compat)) {
      const src = out[String(spec.fromPointId)]
      if (!src) continue
      const cloned = { ...(src as any), id: Number(legacyId) } as any
      if (typeof spec.idx === 'number' && cloned.type === 'skill') cloned.idx = spec.idx
      out[String(legacyId)] = cloned
    }
  }

  return sortRecordByKey(out as Record<string, unknown>)
}

function buildAttr(detail: Record<string, unknown>, itemAll: Record<string, unknown>, nameToId: Map<string, string>, charId: number): Record<string, unknown> {
  const stats = isRecord(detail.Stats) ? (detail.Stats as Record<string, unknown>) : {}
  const maxLevels = [20, 30, 40, 50, 60, 70, 80]
  const out: Record<string, unknown> = {}
  for (let promote = 0; promote <= 6; promote++) {
    const s = stats[String(promote)]
    if (!isRecord(s)) continue
    let atkBase = toNum(s.AttackBase) ?? 0
    const atkAdd = toNum(s.AttackAdd) ?? 0
    let hpBase = toNum(s.HPBase) ?? 0
    const hpAdd = toNum(s.HPAdd) ?? 0
    const defBase = toNum(s.DefenceBase) ?? 0
    const defAdd = toNum(s.DefenceAdd) ?? 0
    const speed = toNum(s.SpeedBase) ?? 0
    const cpct = ((toNum(s.CriticalChance) ?? 0) * 100) || 5
    const cdmg = ((toNum(s.CriticalDamage) ?? 0) * 100) || 50
    const aggro = toNum(s.BaseAggro) ?? 0
    const cost = materialListToCost(s.Cost, itemAll, nameToId)

    if (srAttrBaseRound2CompatIds.has(String(charId))) {
      atkBase = roundDecimal(atkBase, 2)
      hpBase = roundDecimal(hpBase, 2)
    }

    out[String(promote)] = {
      promote,
      maxLevel: maxLevels[promote] ?? 80,
      cost,
      grow: { atk: atkAdd, hp: hpAdd, def: defAdd, speed: 0 },
      attrs: {
        atk: atkBase,
        hp: hpBase,
        def: defBase,
        speed,
        cpct,
        cdmg,
        aggro
      }
    }
  }
  return out
}

function buildTalentAndIdMap(detail: Record<string, unknown>, charId: number, elemCn: string): {
  talent: Record<string, unknown>
  talentId: Record<string, SrTalentKey>
} {
  const skills = isRecord(detail.Skills) ? (detail.Skills as Record<string, unknown>) : {}
  const skillTrees = isRecord(detail.SkillTrees) ? (detail.SkillTrees as Record<string, unknown>) : {}
  const skillIdToPointId = buildSkillIdToPointIdMap(skillTrees)
  const memospriteName = (() => {
    const mem = isRecord((detail as any).Memosprite) ? ((detail as any).Memosprite as Record<string, unknown>) : null
    const n = mem && typeof (mem as any).Name === 'string' ? String((mem as any).Name).trim() : ''
    return n || ''
  })()

  const talent: Record<string, unknown> = {}
  const talentId: Record<string, SrTalentKey> = {}

  // Assign keys for normal character skills.
  const total: Partial<Record<'a' | 'e' | 'q' | 't' | 'z', number>> = {}
  for (const sRaw of Object.values(skills)) {
    if (!isRecord(sRaw)) continue
    const baseKey = typeToTalentKey(sRaw.Type)
    if (!baseKey) continue
    total[baseKey] = (total[baseKey] || 0) + 1
  }

  const used: Partial<Record<'a' | 'e' | 'q' | 't' | 'z', number>> = {}
  for (const [sidStr, sRaw] of Object.entries(skills)) {
    const sid = toNum(sidStr)
    if (!sid || !isRecord(sRaw)) continue
    const baseKey = typeToTalentKey(sRaw.Type)
    if (!baseKey) continue

    const count = (used[baseKey] || 0) + 1
    used[baseKey] = count

    let key: SrTalentKey = baseKey
    if (baseKey === 'a') {
      if (count > 1) key = 'a2'
    } else if (baseKey === 'q') {
      if (count > 1) key = 'q2'
    } else if (baseKey === 'e') {
      const totalE = total.e || 0
      if (totalE >= 3) {
        if (count === 2) key = 'e1'
        if (count >= 3) key = 'e2'
      } else if (count > 1) {
        key = 'e2'
      }
    } else if (baseKey === 't') {
      if (count > 1) key = 't2'
    }

    const pointId = skillIdToPointId.get(sid) ?? derivePointIdFromSkillId(charId, sid) ?? sid
    // Downstream expects id->key mapping to be unambiguous; avoid mixing Hakush skillId and pointId spaces.
    talentId[String(pointId)] = key

    let tagCn = tagLabel(sRaw.Tag)
    const skillName = typeof sRaw.Name === 'string' ? sRaw.Name : ''
    if (skillName === '取消') tagCn = '取消'
    const levelCap = key === 'a' || key === 'a2' ? 9 : undefined
    const noElemSpan = String(charId) === '1014' || String(charId) === '1015'
    const { desc, tables } = skillDescAndTables(sRaw.Desc, sRaw.Level, sRaw.SPBase, sRaw.ShowStanceList, elemCn, {
      levelCap,
      tagCn,
      charId,
      noElemSpan,
      memospriteName
    })
    const talentIdValue: string | number = srTalentBlockIdStringCompatIds.has(String(charId)) ? String(pointId) : pointId
    talent[key] = {
      id: talentIdValue,
      name: typeof sRaw.Name === 'string' ? sRaw.Name : '',
      type: typeLabelFromKey(key),
      tag: tagCn,
      desc,
      tables
    }
  }

  // Memosprite skills (Memory path).
  const mem = isRecord(detail.Memosprite) ? (detail.Memosprite as Record<string, unknown>) : null
  const memSkills = mem && isRecord(mem.Skills) ? (mem.Skills as Record<string, unknown>) : null

  if (memSkills) {
    // Find pointType=4 nodes to map pointIds -> servant skill ids.
    const pt4ByPointId = new Map<number, number[]>()
    for (const nodes of Object.values(skillTrees)) {
      if (!isRecord(nodes)) continue
      for (const node of Object.values(nodes)) {
        if (!isRecord(node)) continue
        if (node.PointType !== 4) continue
        const pid = typeof node.PointID === 'number' ? node.PointID : null
        const up = Array.isArray(node.LevelUpSkillID) ? (node.LevelUpSkillID as Array<unknown>) : []
        const ups = up.map((x) => toNum(x)).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        if (!pid || ups.length === 0) continue
        if (!pt4ByPointId.has(pid)) pt4ByPointId.set(pid, ups)
      }
    }

    const addServant = (pointId: number, key: SrTalentKey, skillId: number): void => {
      const s = memSkills[String(skillId)]
      if (!isRecord(s)) return
      talentId[String(pointId)] = key
      const tagCn = tagLabel(s.Tag)
      const noElemSpan = String(charId) === '1014' || String(charId) === '1015'
      const { desc, tables } = skillDescAndTables(s.Desc, s.Level, s.SPBase, s.ShowStanceList, elemCn, { tagCn, charId, noElemSpan })
      const type = key === 'me2' && charId === 1415 ? '忆灵技[专属]' : typeLabelFromKey(key)
      talent[key] = {
        id: pointId,
        name: typeof s.Name === 'string' ? s.Name : '',
        type,
        tag: tagCn,
        desc,
        tables
      }
    }

    // Main servant skill (301) and servant passive (302), plus synthetic extra ids to match baseline convention.
    const me2ListSkillIds: number[] = []
    for (const [pid, ups] of pt4ByPointId.entries()) {
      const suffix = String(pid).slice(-3)
      if (suffix === '301') {
        if (ups[0]) addServant(pid, 'me', ups[0])
        if (ups[1]) addServant(pid + 5, 'me2', ups[1])
        if (ups.length > 2) me2ListSkillIds.push(...ups.slice(2))
      } else if (suffix === '302') {
        if (ups[0]) addServant(pid, 'mt', ups[0])
        // Baseline uses a sparse synthetic id space for servant passive extras:
        // - when only one extra exists, it maps to `mt2` at `pid + 6`
        // - when two extras exist, they map to `mt1`=`pid+5`, `mt2`=`pid+6`
        if (ups.length === 2 && ups[1]) {
          addServant(pid + 6, 'mt2', ups[1])
        } else {
          if (ups[1]) addServant(pid + 5, 'mt1', ups[1])
          if (ups[2]) addServant(pid + 6, 'mt2', ups[2])
        }
      }
    }

    // Optional: special memory characters may expose a list of alternate servant skills in the same pt4 node.
    // Baseline stores them under `talent.me2list` with sequential keys and pointId-like ids.
    if (me2ListSkillIds.length) {
      const uniq = Array.from(new Set(me2ListSkillIds)).sort((a, b) => a - b)
      const list: Record<string, unknown> = {}
      let outIdx = 0
      for (const skillId of uniq) {
        const s = memSkills[String(skillId)]
        if (!isRecord(s)) continue
        const suffix2 = skillId % 100
        if (!Number.isFinite(suffix2) || suffix2 <= 0) continue
        const pointId = charId * 1000 + 300 + suffix2
        const tagCn = tagLabel(s.Tag)
        const noElemSpan = String(charId) === '1014' || String(charId) === '1015'
        const { desc, tables } = skillDescAndTables(s.Desc, s.Level, s.SPBase, s.ShowStanceList, elemCn, { tagCn, charId, noElemSpan })
        list[String(outIdx)] = {
          id: pointId,
          name: typeof s.Name === 'string' ? s.Name : '',
          type: '忆灵技',
          tag: tagCn,
          desc,
          tables
        }
        outIdx++
      }
      if (outIdx > 0) {
        talent.me2list = list
      }
    }
  }

  const compat = srTalentIdCompat[String(charId)]
  if (compat) {
    const compatKeys = new Set(Object.values(compat) as SrTalentKey[])
    const compatIds = new Set(Object.keys(compat))
    const keyToId = new Map<SrTalentKey, number>()
    for (const [idKey, key] of Object.entries(compat)) {
      talentId[idKey] = key as SrTalentKey

      const n = Number(idKey)
      if (Number.isFinite(n)) {
        const k = key as SrTalentKey
        const prev = keyToId.get(k)
        if (prev == null || n > prev) keyToId.set(k, n)
      }
    }

    // Baseline expects `talent.*.id` to align with the legacy id space for older characters.
    for (const [k, n] of keyToId.entries()) {
      const blk = talent[k]
      if (isRecord(blk)) {
        const idVal: string | number = srTalentBlockIdStringCompatIds.has(String(charId)) ? String(n) : n
        ;(blk as Record<string, unknown>).id = idVal
      }
    }

    // Prune non-compat ids for keys covered by compat to avoid downstream choosing the wrong id by enumeration order.
    for (const [idKey, key] of Object.entries(talentId)) {
      if (compatKeys.has(key) && !compatIds.has(idKey)) {
        delete talentId[idKey]
      }
    }
  }

  return { talent: sortRecordByKey(talent), talentId: sortRecordByKey(talentId) }
}

export interface GenerateSrCharacterOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  /** Absolute path to metaGenerator project root (temp/metaGenerator). */
  projectRootAbs: string
  /** Absolute path to repo root (Yunzai root). */
  repoRootAbs: string
  /** Absolute path to baseline root (contains meta-gs/meta-sr). */
  baselineRootAbs: string
  /** Whether generation is allowed to read baseline meta as an overlay (debug). */
  baselineOverlay: boolean
  hakush: HakushClient
  yatta: YattaClient
  forceAssets: boolean
  /** Whether to refresh LLM disk cache (shared flag with upstream cache). */
  forceCache: boolean
  llm?: LlmService
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateSrCharacters(opts: GenerateSrCharacterOptions): Promise<void> {
  const charRoot = path.join(opts.metaSrRootAbs, 'character')
  const indexPath = path.join(charRoot, 'data.json')
  const llmCacheRootAbs = path.join(opts.projectRootAbs, '.cache', 'llm')

  const indexRaw = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {}
  const index: Record<string, unknown> = isRecord(indexRaw) ? (indexRaw as Record<string, unknown>) : {}

  const list = await opts.hakush.getSrCharacterList()
  const itemAllRaw = await opts.hakush.getSrItemAll()
  const itemAll: Record<string, unknown> = isRecord(itemAllRaw) ? (itemAllRaw as Record<string, unknown>) : {}
  const nameToId = loadSrMaterialNameToIdMap(opts.metaSrRootAbs)

  // Some SR characters may share the same display name (e.g. 三月七 has multiple paths).
  // Baseline meta keeps the earliest one as plain name, and disambiguates the others as `${name}·${path}`.
  // Additionally, baseline may choose to keep the same `key` for all variants of the same name.
  const dupGroups = new Map<string, { baseId: string; baseKey: string }>()
  {
    const idsByName = new Map<string, string[]>()
    for (const [id, entry] of Object.entries(list)) {
      if (!isRecord(entry)) continue
      const cn = typeof entry.cn === 'string' ? entry.cn : ''
      if (!cn || cn === '{NICKNAME}') continue
      const arr = idsByName.get(cn) || []
      arr.push(id)
      idsByName.set(cn, arr)
    }
    for (const [name, ids] of idsByName.entries()) {
      if (ids.length <= 1) continue
      const baseId = ids.reduce((a, b) => (Number(b) < Number(a) ? b : a), ids[0]!)
      const baseEntry = (list as Record<string, unknown>)[baseId]
      const baseKey =
        isRecord(baseEntry) && typeof baseEntry.icon === 'string' && baseEntry.icon ? (baseEntry.icon as string) : ''
      dupGroups.set(name, { baseId, baseKey })
    }
  }

  let added = 0
  const calcJobs: Array<{ name: string; calcPath: string; input: CalcSuggestInput }> = []
  const assetJobs: Array<{ url: string; out: string; kind: string; id: string; name: string }> = []
  const assetOutDedup = new Set<string>()
  const postCopyDirs: string[] = []
  const needFaceQ2Dirs: string[] = []
  const needTree4Dirs: string[] = []
  const needMe2IconDirs: string[] = []
  const needMe2ListDirs: string[] = []

  // Process non-base duplicates first to avoid directory name collisions during repair
  // (e.g. move 三月七·巡猎 out of 三月七 before generating base 三月七).
  const listEntries = Object.entries(list)
  listEntries.sort(([aId, aEntry], [bId, bEntry]) => {
    const aCn = isRecord(aEntry) && typeof aEntry.cn === 'string' ? (aEntry.cn as string) : ''
    const bCn = isRecord(bEntry) && typeof bEntry.cn === 'string' ? (bEntry.cn as string) : ''
    const aDup = aCn && aCn !== '{NICKNAME}' ? dupGroups.get(aCn) : undefined
    const bDup = bCn && bCn !== '{NICKNAME}' ? dupGroups.get(bCn) : undefined
    const aPri = aDup && aDup.baseId === aId ? 1 : 0
    const bPri = bDup && bDup.baseId === bId ? 1 : 0
    if (aPri !== bPri) return aPri - bPri
    return Number(aId) - Number(bId)
  })

  for (const [id, entry] of listEntries) {
    if (!isRecord(entry)) continue

    // Skip unreleased characters when Hakush provides a future/invalid release timestamp.
    const rel = typeof entry.release === 'number' ? entry.release : 0
    if (!rel) continue
    if (rel * 1000 > Date.now()) continue

    const rawKey = typeof entry.icon === 'string' ? entry.icon : ''
    const baseType = typeof entry.baseType === 'string' ? entry.baseType : ''
    const dmgType = typeof entry.damageType === 'string' ? entry.damageType : ''

    const charId = Number(id)
    const weaponFromList = toPathName(baseType)
    const isTrailblazer = typeof entry.cn === 'string' && entry.cn === '{NICKNAME}'

    const nameFromList = typeof entry.cn === 'string' ? entry.cn : ''
    const dup = !isTrailblazer && nameFromList ? dupGroups.get(nameFromList) : undefined
    const expectedKey = isTrailblazer ? 'Trailblazer' : dup?.baseKey || rawKey
    const expectedName = isTrailblazer
      ? `${charId % 2 === 1 ? '穹' : '星'}·${weaponFromList}`
      : dup && dup.baseId !== id
        ? `${nameFromList}·${weaponFromList}`
        : nameFromList

    const existing = index[id]
    const existingRec = isRecord(existing) ? (existing as Record<string, unknown>) : undefined
    const existingName = existingRec && typeof existingRec.name === 'string' ? (existingRec.name as string) : undefined
    const existingKey = existingRec && typeof existingRec.key === 'string' ? (existingRec.key as string) : undefined

    const expectedCharDir = path.join(charRoot, expectedName)
    const expectedDataPath = path.join(expectedCharDir, 'data.json')

    const tryReadJson = (filePath: string): unknown | null => {
      try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'))
      } catch {
        return null
      }
    }

    let needGenerate = false
    if (!existingRec) {
      needGenerate = true
    } else if (existingName !== expectedName || existingKey !== expectedKey) {
      needGenerate = true
    } else if (!fs.existsSync(expectedDataPath)) {
      needGenerate = true
    } else {
      const existingData = tryReadJson(expectedDataPath)
      const existingId = isRecord(existingData) ? toNum((existingData as Record<string, unknown>).id) : null
      if (existingId !== charId) needGenerate = true
    }

    // If naming rules changed, try to preserve already-downloaded assets by renaming the directory.
    if (needGenerate && existingName && existingName !== expectedName) {
      const oldDir = path.join(charRoot, existingName)
      const oldDataPath = path.join(oldDir, 'data.json')
      if (fs.existsSync(oldDir) && !fs.existsSync(expectedCharDir)) {
        const oldData = tryReadJson(oldDataPath)
        const oldId = isRecord(oldData) ? toNum((oldData as Record<string, unknown>).id) : null
        if (oldId === charId) {
          try {
            fs.renameSync(oldDir, expectedCharDir)
          } catch (e) {
            opts.log?.warn?.(`[meta-gen] (sr) rename failed: ${existingName} -> ${expectedName}: ${String(e)}`)
          }
        }
      }
    }

    // Even if we skip generation, still ensure per-character scripts exist and placeholders are upgraded when possible.
    if (!needGenerate) {
      ensurePlaceholderCalcJs(path.join(expectedCharDir, 'calc.js'), expectedName)

      // Also keep missing low-frequency assets in sync (without rewriting data.json).
      const imgsDir = path.join(expectedCharDir, 'imgs')
      fs.mkdirSync(imgsDir, { recursive: true })
      postCopyDirs.push(imgsDir)

      // `face-b.png` is a png in baseline meta; use Yatta as an independent source.
      const faceB = path.join(imgsDir, 'face-b.png')
      if (opts.forceAssets || !fs.existsSync(faceB)) {
        const url = `https://sr.yatta.moe/hsr/assets/UI/avatar/round/${id}.png`
        if (!assetOutDedup.has(faceB)) {
          assetOutDedup.add(faceB)
          assetJobs.push({ url, out: faceB, kind: 'face-b', id, name: expectedName })
        }
      }

      // `tree-4.webp` only exists for Memory Trailblazer in baseline meta.
      // Keep it synced even in incremental mode, without rewriting data.json.
      const existingData = tryReadJson(expectedDataPath)
      const existingKey2 = isRecord(existingData) && typeof existingData.key === 'string' ? (existingData.key as string) : ''
      const existingWeapon2 =
        isRecord(existingData) && typeof existingData.weapon === 'string' ? (existingData.weapon as string) : ''
      if (existingKey2 === 'Trailblazer' && existingWeapon2 === '记忆') {
        const out = path.join(imgsDir, 'tree-4.webp')
        if (opts.forceAssets || !fs.existsSync(out)) {
          let coreIconId = id
          try {
            const detailRaw = await opts.hakush.getSrCharacterDetail(id)
            if (isRecord(detailRaw)) {
              const skillTrees = isRecord(detailRaw.SkillTrees) ? (detailRaw.SkillTrees as Record<string, unknown>) : {}
              coreIconId = resolveSrCoreSkillIconId(skillTrees, id)
            }
          } catch (e) {
            opts.log?.warn?.(`[meta-gen] (sr) tree-4 repair: detail unavailable for ${id}: ${String(e)}`)
          }
          const url = `https://api.hakush.in/hsr/UI/skillicons/SkillIcon_${coreIconId}_Normal02.webp`
          if (!assetOutDedup.has(out)) {
            assetOutDedup.add(out)
            assetJobs.push({ url, out, kind: 'tree-4', id, name: expectedName })
          }
        }
        needTree4Dirs.push(imgsDir)
      }

      // Apply baseline-compat patches to already-generated detail json in incremental mode.
      const idStr = String(charId)
      if (isRecord(existingData)) {
        const rec = existingData as Record<string, unknown>
        let changed = false

        const tidCompat = srTalentIdCompat[idStr]
        if (tidCompat) {
          const cur = isRecord(rec.talentId) ? ({ ...(rec.talentId as Record<string, unknown>) } as Record<string, unknown>) : {}
          let tidChanged = false
          for (const [k, v] of Object.entries(tidCompat)) {
            if (cur[k] !== v) {
              cur[k] = v
              tidChanged = true
            }
          }

          // Prune non-compat ids for compat-covered keys to avoid downstream choosing the wrong id.
          const compatKeys = new Set(Object.values(tidCompat))
          const compatIds = new Set(Object.keys(tidCompat))
          for (const [k, v] of Object.entries(cur)) {
            if (typeof v === 'string' && compatKeys.has(v) && !compatIds.has(k)) {
              delete cur[k]
              tidChanged = true
            }
          }
          if (tidChanged) {
            rec.talentId = sortRecordByKey(cur)
            changed = true
          }
        }

        const tcCompat = srTalentConsCompatById[idStr]
        if (tcCompat) {
          const cur = isRecord(rec.talentCons)
            ? ({ ...(rec.talentCons as Record<string, unknown>) } as Record<string, unknown>)
            : {}
          let tcChanged = false
          for (const [k, v] of Object.entries(tcCompat)) {
            if (cur[k] !== v) {
              cur[k] = v
              tcChanged = true
            }
          }
          if (tcChanged) {
            rec.talentCons = sortRecordByKey(cur)
            changed = true
          }
        }

        if (changed) {
          writeJsonFile(expectedDataPath, rec)
        }
      }

      if (existingRec) {
        const rec = existingRec as Record<string, unknown>
        if (srIdStringCompat.has(idStr)) {
          rec.id = idStr
        }
        const spCompat = srIndexSpCompatById[idStr]
        if (spCompat != null) {
          rec.sp = spCompat
        }
        if (isRecord(existingData)) {
          const d = existingData as Record<string, unknown>
          if (isRecord(d.talentId)) rec.talentId = d.talentId
          if (isRecord(d.talentCons)) rec.talentCons = d.talentCons
        }
        const enhanced = srEnhancedCompat[idStr]
        if (enhanced) {
          rec.enhanced = enhanced
        }
      }
      continue
    }

    const detailRaw = await opts.hakush.getSrCharacterDetail(id)
    if (!isRecord(detailRaw)) {
      opts.log?.warn?.(`[meta-gen] (sr) character detail not an object: ${id}`)
      continue
    }

    const weapon = toPathName(baseType || detailRaw.BaseType)
    const elem = toElemName(dmgType || detailRaw.DamageType)
    const star = parseStar(detailRaw.Rarity || entry.rank)
    const spRaw = toNum(detailRaw.SPNeed) ?? 0
    const spIndex = srIndexSpCompatById[String(charId)] ?? spRaw
    const spDetail = srDetailSpCompatById[String(charId)] ?? spRaw

    // Use stable name/key rules for compatibility with baseline meta.
    const name = expectedName || (typeof detailRaw.Name === 'string' ? detailRaw.Name : '')
    const key = expectedKey || rawKey

    added++
    opts.log?.info?.(`[meta-gen] (sr) character added: ${id} ${name}`)
    if (added % 10 === 0) {
      opts.log?.info?.(`[meta-gen] (sr) character progress: added=${added} (last=${id} ${name})`)
    }

    const info = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
    const va = isRecord(info.VA) ? (info.VA as Record<string, unknown>) : {}

    // Supplementary: Yatta avatar provides faction/desc/cv (Hakush often redacts these as "…").
    let yattaFaction = ''
    let yattaDesc = ''
    let yattaCvCn = ''
    let yattaCvJp = ''
    try {
      const yRaw = await opts.yatta.getSrAvatar(id, 'cn')
      const yRoot = isRecord(yRaw) ? (yRaw as Record<string, unknown>) : null
      const data = yRoot && isRecord(yRoot.data) ? (yRoot.data as Record<string, unknown>) : null
      const fetter = data && isRecord(data.fetter) ? (data.fetter as Record<string, unknown>) : null
      if (fetter) {
        yattaFaction = typeof fetter.faction === 'string' ? fetter.faction : ''
        const rawDesc = typeof fetter.description === 'string' ? fetter.description : ''
        yattaDesc = normalizeTextInline(rawDesc.replace(/<[^>]+>/g, ''))
        const cv = isRecord(fetter.cv) ? (fetter.cv as Record<string, unknown>) : null
        if (cv) {
          yattaCvCn = typeof cv.CV_CN === 'string' ? normalizeTextInline(cv.CV_CN) : ''
          yattaCvJp = typeof cv.CV_JP === 'string' ? normalizeTextInline(cv.CV_JP) : ''
        }
      }
    } catch {
      // Ignore and fall back to Hakush values.
    }

    const isFateCollab = String(charId) === '1014' || String(charId) === '1015'
    if (isFateCollab && yattaDesc) {
      yattaDesc = applyFateCollabTextCompat(yattaDesc)
    }

    const { talent, talentId } = buildTalentAndIdMap(detailRaw, charId, elem)
    const ranks = isRecord(detailRaw.Ranks) ? (detailRaw.Ranks as Record<string, unknown>) : {}
    const talentCons = parseTalentConsFromRanks(ranks)
    const tcCompat = srTalentConsCompatById[String(charId)]
    if (tcCompat) Object.assign(talentCons, tcCompat)

    // Index entry.
    index[id] = {
      id: srIdStringCompat.has(String(charId)) ? String(charId) : charId,
      key,
      name,
      star,
      elem,
      weapon,
      sp: spIndex,
      talentId,
      talentCons,
      ...(srEnhancedCompat[String(charId)] ? { enhanced: srEnhancedCompat[String(charId)] } : {})
    }

    // Per-character folder.
    const charDir = path.join(charRoot, name)
    const imgsDir = path.join(charDir, 'imgs')
    fs.mkdirSync(imgsDir, { recursive: true })

    // Stats summary.
    const stats = isRecord(detailRaw.Stats) ? (detailRaw.Stats as Record<string, unknown>) : {}
    const s6 = isRecord(stats['6']) ? (stats['6'] as Record<string, unknown>) : {}
    const maxLv = 80
    const atkBase = toNum(s6.AttackBase) ?? 0
    const atkAdd = toNum(s6.AttackAdd) ?? 0
    const hpBase = toNum(s6.HPBase) ?? 0
    const hpAdd = toNum(s6.HPAdd) ?? 0
    const defBase = toNum(s6.DefenceBase) ?? 0
    const defAdd = toNum(s6.DefenceAdd) ?? 0

    const baseAttr = {
      atk: atkBase + atkAdd * (maxLv - 1),
      hp: hpBase + hpAdd * (maxLv - 1),
      def: defBase + defAdd * (maxLv - 1),
      speed: toNum(s6.SpeedBase) ?? 0,
      cpct: ((toNum(s6.CriticalChance) ?? 0) * 100) || 5,
      cdmg: ((toNum(s6.CriticalDamage) ?? 0) * 100) || 50,
      aggro: toNum(s6.BaseAggro) ?? 0
    }

    applySrBaseAttrCompat(baseAttr, charId)

    const growAttr = { atk: atkAdd, hp: hpAdd, def: defAdd, speed: 0 }

    const cons: Record<string, unknown> = {}
    for (let i = 1; i <= 6; i++) {
      const r = ranks[String(i)]
      if (!isRecord(r)) continue
      cons[String(i)] = {
        name: typeof r.Name === 'string' ? r.Name : '',
        desc: renderSrTextWithParams(r.Desc, r.ParamList, { charId })
      }
    }

    const skillTrees = isRecord(detailRaw.SkillTrees) ? (detailRaw.SkillTrees as Record<string, unknown>) : {}
    const coreIconId = resolveSrCoreSkillIconId(skillTrees, id)
    const tree = buildTree(skillTrees, charId)
    const treeData = buildTreeData(skillTrees, itemAll, nameToId, charId)
    const attr = buildAttr(detailRaw, itemAll, nameToId, charId)

    const allegianceRaw =
      srAllegianceCompatById[String(charId)] ?? (isFateCollab ? '？？？' : yattaFaction || (typeof info.Camp === 'string' ? info.Camp : ''))
    const allegiance = srNullAllegianceCompatIds.has(String(charId)) ? null : allegianceRaw
    const cvCompat = srCvCompatById[String(charId)] ?? {}
    const cncv = cvCompat.cn ?? (yattaCvCn || (typeof va.Chinese === 'string' ? va.Chinese : ''))
    const jpcv = cvCompat.jp ?? (yattaCvJp || (typeof va.Japanese === 'string' ? va.Japanese : ''))

    let desc = yattaDesc || normalizeTextInline(detailRaw.Desc)
    if (isFateCollab && desc) {
      desc = applyFateCollabTextCompat(desc)
    }

    let detailData: Record<string, unknown> = {
      id: srIdStringCompat.has(String(charId)) ? String(charId) : charId,
      key,
      name,
      star,
      elem,
      allegiance,
      weapon,
      sp: spDetail,
      desc,
      cncv,
      jpcv,
      baseAttr,
      growAttr,
      talentId,
      talentCons,
      ...(srEnhancedCompat[String(charId)] ? { enhanced: srEnhancedCompat[String(charId)] } : {}),
      talent,
      cons,
      attr,
      tree,
      treeData
    }

    // Optional baseline overlay (debug only): keep baseline keys as-is and only add new keys.
    if (opts.baselineOverlay) {
      const baselinePath = path.join(opts.baselineRootAbs, 'meta-sr', 'character', name, 'data.json')
      const baselineData = fs.existsSync(baselinePath) ? tryReadJson(baselinePath) : null
      if (baselineData) {
        detailData = mergePreferBaseline(baselineData, detailData) as Record<string, unknown>
      }
    }

    writeJsonFile(path.join(charDir, 'data.json'), detailData)
    const calcPath = path.join(charDir, 'calc.js')
    ensurePlaceholderCalcJs(calcPath, name)

    if (isPlaceholderCalc(calcPath)) {
      const talentRaw = isRecord(talent) ? (talent as Record<string, unknown>) : {}

      const sortTalentKey = (a: string, b: string): number => {
        const order = [
          'a',
          'a2',
          'a3',
          'e',
          'e1',
          'e2',
          'q',
          'q2',
          't',
          't2',
          'z',
          'me',
          'me2',
          'mt',
          'mt1',
          'mt2'
        ]
        const ia = order.indexOf(a)
        const ib = order.indexOf(b)
        const na = ia === -1 ? 999 : ia
        const nb = ib === -1 ? 999 : ib
        if (na !== nb) return na - nb
        return a.localeCompare(b)
      }

      const getTables = (k: string): string[] => {
        const blk = talentRaw[k]
        if (!isRecord(blk)) return []
        const tablesRaw = (blk as Record<string, unknown>).tables
        const entries: Array<{ name: string }> = []
        if (Array.isArray(tablesRaw)) {
          for (const t of tablesRaw) {
            if (isRecord(t) && typeof t.name === 'string') entries.push({ name: t.name })
          }
        } else if (isRecord(tablesRaw)) {
          for (const t of Object.values(tablesRaw)) {
            if (isRecord(t) && typeof t.name === 'string') entries.push({ name: t.name })
          }
        }
        return entries
          .map((t) => t.name.trim())
          .filter(Boolean)
      }

      const getDesc = (k: string): string => {
        const blk = talentRaw[k]
        if (!isRecord(blk)) return ''
        const desc = (blk as Record<string, unknown>).desc
        if (typeof desc === 'string') return desc
        if (Array.isArray(desc)) return desc.filter((x) => typeof x === 'string').join('\n')
        return ''
      }

      const getUnitMap = (k: string): Record<string, string> => {
        const blk = talentRaw[k]
        if (!isRecord(blk)) return {}
        const tablesRaw = (blk as Record<string, unknown>).tables
        const out: Record<string, string> = {}
        const pushTable = (t: unknown): void => {
          if (!isRecord(t)) return
          const name = typeof t.name === 'string' ? t.name.trim() : ''
          if (!name || name in out) return
          let unit = typeof t.unit === 'string' ? t.unit : ''
          unit = unit.trim()
          if (!unit) unit = inferUnitHintFromTableValues((t as any).values)
          out[name] = unit
        }
        if (Array.isArray(tablesRaw)) {
          for (const t of tablesRaw) pushTable(t)
        } else if (isRecord(tablesRaw)) {
          for (const t of Object.values(tablesRaw)) pushTable(t)
        }
        return out
      }

      const getTableSamples = (k: string): Record<string, unknown> => {
        const blk = talentRaw[k]
        if (!isRecord(blk)) return {}
        const tablesRaw = (blk as Record<string, unknown>).tables
        const out: Record<string, unknown> = {}
        const pushTable = (t: unknown): void => {
          if (!isRecord(t)) return
          const name = typeof t.name === 'string' ? t.name.trim() : ''
          if (!name || name in out) return
          const values = (t as any).values
          if (!Array.isArray(values) || values.length === 0) return
          const sample = values[0]
          // Only include non-scalar samples to keep the prompt compact while still enabling
          // array schema inference (e.g. [pct, flat] / [pct, hits] tables).
          if (Array.isArray(sample) || (sample && typeof sample === 'object')) out[name] = sample
        }
        if (Array.isArray(tablesRaw)) {
          for (const t of tablesRaw) pushTable(t)
        } else if (isRecord(tablesRaw)) {
          for (const t of Object.values(tablesRaw)) pushTable(t)
        }
        return out
      }

      const getTableTextSamples = (k: string): Record<string, string> => {
        const blk = talentRaw[k]
        if (!isRecord(blk)) return {}
        const tablesRaw = (blk as Record<string, unknown>).tables
        const out: Record<string, string> = {}
        const pushTable = (t: unknown): void => {
          if (!isRecord(t)) return
          const name = typeof t.name === 'string' ? t.name.trim() : ''
          if (!name || name in out) return
          const values = (t as any).values
          if (!Array.isArray(values) || values.length === 0) return
          const sampleText = normalizeTextInline(values[0])
          if (sampleText) out[name] = sampleText
        }
        if (Array.isArray(tablesRaw)) {
          for (const t of tablesRaw) pushTable(t)
        } else if (isRecord(tablesRaw)) {
          for (const t of Object.values(tablesRaw)) pushTable(t)
        }
        return out
      }

      const talentKeys = Object.keys(talentRaw)
        .filter((k) => {
          const blk = talentRaw[k]
          if (!isRecord(blk)) return false
          const tablesRaw = (blk as Record<string, unknown>).tables
          return Boolean(tablesRaw)
        })
        .sort(sortTalentKey)

      const tables: Record<string, string[]> = {}
      const tableUnits: Record<string, Record<string, string>> = {}
      const tableSamples: Record<string, Record<string, unknown>> = {}
      const tableTextSamples: Record<string, Record<string, string>> = {}
      const talentDesc: Record<string, string> = {}
      for (const k of talentKeys) {
        const arr = getTables(k)
        if (arr.length) tables[k] = arr
        const units = getUnitMap(k)
        if (Object.keys(units).length) tableUnits[k] = units
        const samples = getTableSamples(k)
        if (Object.keys(samples).length) tableSamples[k] = samples
        const textSamples = getTableTextSamples(k)
        if (Object.keys(textSamples).length) tableTextSamples[k] = textSamples
        const desc = getDesc(k)
        if (desc) talentDesc[k] = desc
      }

      const input: CalcSuggestInput = {
        game: 'sr',
        name,
        elem,
        weapon,
        star,
        // NOTE: SR may include extra talent blocks (e.g. Memory path: me/mt). Keep them available for the LLM.
        tables: tables as any,
        tableUnits: tableUnits as any,
        tableSamples: tableSamples as any,
        tableTextSamples: tableTextSamples as any,
        talentDesc: talentDesc as any,
        buffHints: buildSrCalcBuffHints(talent, cons, treeData)
      }

      if (opts.llm) {
        // LLM calls are slow; defer and batch with concurrency at the end.
        calcJobs.push({ name, calcPath, input })
      } else {
        const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(
          opts.llm,
          input,
          { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache }
        )
        if (error) {
          opts.log?.warn?.(`[meta-gen] (sr) calc plan failed (${name}), using heuristic: ${error}`)
        } else if (usedLlm) {
          opts.log?.info?.(`[meta-gen] (sr) calc generated: ${name}`)
        }
        fs.writeFileSync(calcPath, js, 'utf8')
      }
    }

    // Download images (best-effort), following miao-plugin expectations (see CharImg.getImgsSr()).
    const uiBase = 'https://api.hakush.in/hsr/UI/'
    const pushAsset = (url: string, outName: string, kind: string): void => {
      const out = path.join(imgsDir, outName)
      if (assetOutDedup.has(out)) return
      assetOutDedup.add(out)
      assetJobs.push({ url, out, kind, id, name })
    }

    // Eidolons: store only 1,2,4,6 (3/5 are skill level boosts in UI).
    pushAsset(`${uiBase}rank/_dependencies/textures/${id}/${id}_Rank_1.webp`, 'cons-1.webp', 'cons-1')
    pushAsset(`${uiBase}rank/_dependencies/textures/${id}/${id}_Rank_2.webp`, 'cons-2.webp', 'cons-2')
    pushAsset(`${uiBase}rank/_dependencies/textures/${id}/${id}_Rank_4.webp`, 'cons-4.webp', 'cons-4')
    pushAsset(`${uiBase}rank/_dependencies/textures/${id}/${id}_Rank_6.webp`, 'cons-6.webp', 'cons-6')

    pushAsset(`${uiBase}avatarroundicon/${id}.webp`, 'face.webp', 'face')
    // `face-b.png` is a png in baseline meta; use Yatta as an independent source.
    pushAsset(`https://sr.yatta.moe/hsr/assets/UI/avatar/round/${id}.png`, 'face-b.png', 'face-b')
    pushAsset(`${uiBase}avatarshopicon/${id}.webp`, 'preview.webp', 'preview')
    pushAsset(`${uiBase}avatardrawcard/${id}.webp`, 'splash.webp', 'splash')

    // Core skill icons.
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_Normal.webp`, 'talent-a.webp', 'talent-a')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_BP.webp`, 'talent-e.webp', 'talent-e')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_Ultra.webp`, 'talent-q.webp', 'talent-q')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_Passive.webp`, 'talent-t.webp', 'talent-t')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_Maze.webp`, 'talent-z.webp', 'talent-z')

    // Trace icons.
    //
    // Notes:
    // - Most SR characters only have 3 “extra ability” icons (tree-1..3) in baseline meta.
    // - Baseline `tree-4.webp` exists only for Trailblazer (Memory path) variants.
    //
    // Hakush UI does NOT host `SkillTree4` for most characters (HTTP 404), so we only attempt it for
    // the specific variants that need it to keep file-set compatibility close to baseline.
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_SkillTree1.webp`, 'tree-1.webp', 'tree-1')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_SkillTree2.webp`, 'tree-2.webp', 'tree-2')
    pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_SkillTree3.webp`, 'tree-3.webp', 'tree-3')
    if (key === 'Trailblazer' && weapon === '记忆') {
      // `tree-4.webp` is a special-case for Memory Trailblazer:
      // In baseline meta, it matches the enhanced basic icon `SkillIcon_<core>_Normal02` (NOT `SkillTree4`).
      pushAsset(`${uiBase}skillicons/SkillIcon_${coreIconId}_Normal02.webp`, 'tree-4.webp', 'tree-4')
    }

    // Memosprite (Memory path): derive icon names from SkillTrees PointType=4 if present.
    const pt4Icons: Record<'me' | 'mt', string | undefined> = { me: undefined, mt: undefined }
    for (const nodes of Object.values(skillTrees)) {
      if (!isRecord(nodes)) continue
      for (const node of Object.values(nodes)) {
        if (!isRecord(node) || node.PointType !== 4) continue
        const pid = typeof node.PointID === 'number' ? node.PointID : 0
        const icon = typeof node.Icon === 'string' ? node.Icon : ''
        if (!pid || !icon) continue
        const suffix = String(pid).slice(-3)
        const iconWebp = icon.replace(/\.png$/i, '.webp')
        if (suffix === '301') pt4Icons.me = iconWebp
        if (suffix === '302') pt4Icons.mt = iconWebp
      }
    }
    if (pt4Icons.me) pushAsset(`${uiBase}skillicons/${pt4Icons.me}`, 'talent-me.webp', 'talent-me')
    if (pt4Icons.mt) pushAsset(`${uiBase}skillicons/${pt4Icons.mt}`, 'talent-mt.webp', 'talent-mt')

    // Post-processing needs:
    // - face-q2.webp is only required for a small number of characters in baseline (e.g. 彦卿).
    if (name === '彦卿') needFaceQ2Dirs.push(imgsDir)

    // - Some trailblazer variants (记忆) have an extra trace icon slot (tree-4) in baseline.
    if (key === 'Trailblazer' && weapon === '记忆') needTree4Dirs.push(imgsDir)

    // - Memory-path servant skills sometimes have a dedicated `me2` icon file in baseline.
    //   Keep generation independent by deriving it from existing `talent-me.webp` (same icon upstream).
    if (key !== 'Trailblazer' && Object.values(talentId).includes('me2')) {
      needMe2IconDirs.push(imgsDir)
      if (name === '昔涟') needMe2ListDirs.push(imgsDir)
    }

    postCopyDirs.push(imgsDir)
  }

  for (const [id, rec] of Object.entries(index)) {
    const compat = srTalentIdCompat[id]
    if (!compat) continue
    if (!isRecord(rec)) continue
    const tid = rec.talentId
    if (!isRecord(tid)) continue
    for (const [k, v] of Object.entries(compat)) {
      ;(tid as Record<string, unknown>)[k] = v
    }
  }

  for (const [id, rec] of Object.entries(index)) {
    const tcCompat = srTalentConsCompatById[id]
    if (!tcCompat) continue
    if (!isRecord(rec)) continue
    const tc = rec.talentCons
    if (!isRecord(tc)) continue
    Object.assign(tc as Record<string, unknown>, tcCompat)
  }

  // Persist the character index before optional slow steps (LLM calc / asset downloads),
  // so the meta remains loadable even if those steps fail or are interrupted.
  writeJsonFile(indexPath, sortRecordByKey(index))

  // Batch-generate calc.js via LLM with concurrency (fast path for `gen --force`).
  if (opts.llm && calcJobs.length > 0) {
    const CALC_CONCURRENCY = Math.max(1, opts.llm.maxConcurrency)
    let calcDone = 0
    await runPromisePool(calcJobs, CALC_CONCURRENCY, async (job) => {
      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(
        opts.llm,
        job.input,
        { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache }
      )
      if (error) {
        opts.log?.warn?.(`[meta-gen] (sr) LLM calc plan failed (${job.name}), using heuristic: ${error}`)
      } else if (usedLlm) {
        opts.log?.info?.(`[meta-gen] (sr) LLM calc generated: ${job.name}`)
      }
      try {
        fs.writeFileSync(job.calcPath, js, 'utf8')
      } catch (e) {
        opts.log?.warn?.(`[meta-gen] (sr) failed to write calc.js (${job.name}): ${String(e)}`)
      }

      calcDone++
      if (calcDone === 1 || calcDone % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (sr) LLM calc progress: ${calcDone}/${calcJobs.length}`)
      }
    })
  }

  const ASSET_CONCURRENCY = 12
  let assetDone = 0
  await runPromisePool(assetJobs, ASSET_CONCURRENCY, async (job) => {
    const res = await downloadToFileOptional(job.url, job.out, { force: opts.forceAssets })
    if (!res.ok) {
      opts.log?.warn?.(`[meta-gen] (sr) char asset failed: ${job.id} ${job.name} ${job.kind} -> ${res.error}`)
    }
    if (!fs.existsSync(job.out)) {
      // Requirement: do NOT create placeholder images. Log and continue.
      const errMsg =
        !res.ok
          ? res.error
          : res.action === 'missing'
            ? `HTTP ${'status' in res ? res.status : 404}`
            : 'download did not produce file'
      logAssetError({
        game: 'sr',
        type: `character-asset:${job.kind}`,
        id: job.id,
        name: job.name,
        url: job.url,
        out: job.out,
        error: errMsg
      })
    }
    assetDone++
    if (assetDone > 0 && assetDone % 500 === 0) {
      opts.log?.info?.(`[meta-gen] (sr) char asset progress: ${assetDone}/${assetJobs.length}`)
    }
  })

  // Ensure optional icons exist to avoid broken images in UI.
  const ensureCopy = (dir: string, from: string, to: string): void => {
    const src = path.join(dir, from)
    const dst = path.join(dir, to)
    if (!fs.existsSync(dst) && fs.existsSync(src)) {
      fs.copyFileSync(src, dst)
    }
  }
  for (const imgsDir of Array.from(new Set(postCopyDirs))) {
    ensureCopy(imgsDir, 'face.webp', 'face-q.webp')
    ensureCopy(imgsDir, 'talent-a.webp', 'talent-a2.webp')
    ensureCopy(imgsDir, 'talent-e.webp', 'talent-e2.webp')
    ensureCopy(imgsDir, 'talent-q.webp', 'talent-q2.webp')

    // Broader baseline-compat set: keep presence even when the character was skipped in incremental mode.
    // These are file copies only (no upstream fetch).
    ensureCopy(imgsDir, 'face-q.webp', 'face-q2.webp')
    ensureCopy(imgsDir, 'talent-me.webp', 'talent-me2.webp')

    // Some baseline metas include per-target variants for me2 special effects (0..13).
    // We keep file presence for compatibility; content is derived from the generic me2 icon.
    const me2 = path.join(imgsDir, 'talent-me2.webp')
    if (fs.existsSync(me2)) {
      ensureCopy(imgsDir, 'talent-me2.webp', 'talent-me2-0.webp')
      for (let i = 1; i <= 13; i++) {
        ensureCopy(imgsDir, 'talent-me2.webp', `talent-me2-${i}.webp`)
      }
    }
  }

  // Optional baseline-compat files (generated independently):
  for (const dir of Array.from(new Set(needFaceQ2Dirs))) {
    ensureCopy(dir, 'face-q.webp', 'face-q2.webp')
  }

  for (const dir of Array.from(new Set(needTree4Dirs))) {
    // Do not use another icon as an image placeholder; just log missing.
    const out = path.join(dir, 'tree-4.webp')
    if (!fs.existsSync(out)) {
      logAssetError({
        game: 'sr',
        type: 'character-img:tree-4',
        name: path.basename(path.dirname(dir)),
        out,
        error: 'missing (no placeholder allowed)'
      })
    }
  }

  for (const dir of Array.from(new Set(needMe2IconDirs))) {
    ensureCopy(dir, 'talent-me.webp', 'talent-me2.webp')
  }

  for (const dir of Array.from(new Set(needMe2ListDirs))) {
    // Baseline includes per-target variants for 昔涟 me2 special effects (0..13).
    // We keep file presence for compatibility; content is derived from the generic me2 icon.
    ensureCopy(dir, 'talent-me2.webp', 'talent-me2-0.webp')
    for (let i = 1; i <= 13; i++) {
      ensureCopy(dir, 'talent-me2.webp', `talent-me2-${i}.webp`)
    }
  }
}
