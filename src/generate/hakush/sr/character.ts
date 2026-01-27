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
import { runPromisePool } from '../../../utils/promise-pool.js'
import { sortRecordByKey } from '../utils.js'
import type { LlmService } from '../../../llm/service.js'
import { buildCalcJsWithLlmOrHeuristic } from '../../calc/llm-calc.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeTextInline(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replaceAll('\\n', ' ').replaceAll('\n', ' ').replace(/\s+/g, ' ').trim()
}

function normalizeSrRichText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replaceAll('\\n\\n', '<br /><br />')
    .replaceAll('\\n', '<br />')
    .replaceAll('\n\n', '<br /><br />')
    .replaceAll('\n', '<br />')
    .replaceAll('<unbreak>', '<nobr>')
    .replaceAll('</unbreak>', '</nobr>')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .replace(/<\/?i>/g, '')
    .trim()
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

function formatConstParam(value: number, format: string, pct: string): string {
  if (pct === '%') {
    const dec = format === 'f2' ? 2 : 1
    return (value * 100).toFixed(dec)
  }
  if (format === 'f1') return value.toFixed(1)
  if (format === 'f2') return value.toFixed(2)
  if (Number.isInteger(value)) return String(value)
  return String(value)
}

/**
 * Replace Hakush placeholders (#1[i] etc) with constants using ParamList.
 * Used for rank/trace descriptions that do not have per-level tables.
 */
function renderSrTextWithParams(rawDesc: unknown, paramList: unknown): string {
  const desc = typeof rawDesc === 'string' ? rawDesc : ''
  const params = Array.isArray(paramList) ? (paramList as Array<unknown>) : []
  const replaced = desc.replace(/#(\d+)\[(i|f1|f2)](%?)/g, (m, idxStr: string, fmt: string, pct: string) => {
    const idx = Number(idxStr) - 1
    if (!Number.isFinite(idx) || idx < 0) return m
    const v = toNum(params[idx])
    if (v == null) return m
    return formatConstParam(v, fmt, pct)
  })
  return normalizeSrRichText(replaced)
}

function guessPrimaryParamName(descPlain: string, idx: number): string {
  if (idx !== 1) return `参数${idx}`
  if (/(治疗|恢复).{0,8}(生命|生命值)/.test(descPlain) || /治疗量/.test(descPlain)) return '治疗量'
  if (/伤害/.test(descPlain)) return '技能伤害'
  return `参数${idx}`
}

function skillDescAndTables(
  rawDesc: unknown,
  levelObj: unknown,
  spBase: unknown,
  showStanceList: unknown,
  elemCn: string
): { desc: string; tables: Record<string, { name: string; isSame: boolean; values: number[] }> } {
  const descSrc = typeof rawDesc === 'string' ? rawDesc : ''
  const levels = isRecord(levelObj) ? (levelObj as Record<string, unknown>) : {}

  // Gather ParamList by level number.
  const lvKeys = Object.keys(levels)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b)
    .map((n) => String(n))

  const paramLists: number[][] = []
  for (const k of lvKeys) {
    const v = levels[k]
    if (!isRecord(v) || !Array.isArray(v.ParamList)) continue
    const nums = (v.ParamList as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x)))
    if (nums.every((n) => Number.isFinite(n))) paramLists.push(nums as number[])
  }

  // If no ParamList, just normalize and return.
  if (paramLists.length === 0) {
    return { desc: wrapElemSpan(normalizeSrRichText(descSrc), elemCn), tables: {} }
  }

  const paramCount = Math.max(...paramLists.map((a) => a.length))
  const isPercentParam = (idx: number): boolean =>
    descSrc.includes(`#${idx + 1}[i]%`) || descSrc.includes(`#${idx + 1}[f1]%`) || descSrc.includes(`#${idx + 1}[f2]%`)

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
  for (let i = 0; i < paramCount; i++) {
    if (!isConst[i]) {
      varIdx++
      varMap.set(i, varIdx)
    }
  }

  // Build variable tables.
  const tables: Record<string, { name: string; isSame: boolean; values: number[] }> = {}
  for (const [origIdx, outIdx] of varMap.entries()) {
    const values = paramLists.map((arr) => arr[origIdx] ?? 0)
    const name = guessPrimaryParamName(normalizeTextInline(descSrc), outIdx)
    tables[String(outIdx)] = { name, isSame: false, values }
  }

  // Replace placeholders:
  // - constants => literal numbers (keep <nobr> wrapper if upstream had it)
  // - variables => $k[i]/$k[f1] etc
  const replaced = descSrc.replace(/#(\d+)\[(i|f1|f2)](%?)/g, (m, idxStr: string, fmt: string, pct: string) => {
    const origIdx = Number(idxStr) - 1
    if (!Number.isFinite(origIdx) || origIdx < 0) return m
    if (isConst[origIdx]) {
      const v = paramLists[0]?.[origIdx]
      if (typeof v !== 'number' || !Number.isFinite(v)) return m
      if (pct === '%' || isPercentParam(origIdx)) return (v * 100).toFixed(fmt === 'f2' ? 2 : 1)
      return formatConstParam(v, fmt, pct)
    }
    const mapped = varMap.get(origIdx)
    return mapped ? `$${mapped}[${fmt}]${pct}` : m
  })

  const desc = wrapElemSpan(normalizeSrRichText(replaced), elemCn)

  // Append constant tables for energy gain / toughness damage.
  const baseEnergy = toNum(spBase)
  const stanceArr = Array.isArray(showStanceList) ? (showStanceList as Array<unknown>) : []
  const stanceRaw = toNum(stanceArr[0])
  const levelLen = Math.max(1, paramLists.length)
  let nextIdx = varIdx

  if (baseEnergy != null && baseEnergy > 0) {
    nextIdx++
    tables[String(nextIdx)] = {
      name: '能量恢复',
      isSame: true,
      values: Array.from({ length: levelLen }).map(() => baseEnergy)
    }
  }

  if (stanceRaw != null && stanceRaw > 0) {
    nextIdx++
    const stance = stanceRaw / 30
    tables[String(nextIdx)] = {
      name: '削韧',
      isSame: true,
      values: Array.from({ length: levelLen }).map(() => stance)
    }
  }

  // Energy/stance tables are for display only; they are not referenced in desc.
  return { desc, tables }
}

type SrTalentKey = 'a' | 'e' | 'q' | 't' | 'z' | 'a2' | 'e2' | 'q2' | 'me' | 'mt' | 'me2' | 'mt1' | 'mt2'

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
    Support: '辅助',
    Impair: '妨害',
    Heal: '治疗',
    Shield: '防御',
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
    const primary = (['e', 'q', 't', 'a', 'me', 'mt'] as const).find((k) => found.includes(k)) || 'e'
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
    AttackDelta: { key: 'atkPlus', valueIsPercent: false },
    DefenceDelta: { key: 'defPlus', valueIsPercent: false },
    HPDelta: { key: 'hpPlus', valueIsPercent: false },
    SpeedDelta: { key: 'speed', valueIsPercent: false },
    CriticalChanceBase: { key: 'cpct', valueIsPercent: true },
    CriticalDamageBase: { key: 'cdmg', valueIsPercent: true },
    StatusProbabilityBase: { key: 'effPct', valueIsPercent: true },
    StatusResistanceBase: { key: 'effDef', valueIsPercent: true },
    BreakDamageAddedRatio: { key: 'stance', valueIsPercent: true },
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

function buildTree(skillTrees: Record<string, unknown>): Record<string, { key: string; value: number }> {
  const tree: Record<string, { key: string; value: number }> = {}

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

      const outVal = mapped.valueIsPercent ? value * 100 : value
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

function nodeLevelReq(node: Record<string, unknown>): number {
  const lvl = toNum(node.AvatarLevelLimit)
  if (lvl != null) return lvl <= 1 ? 0 : lvl
  const promote = toNum(node.AvatarPromotionLimit)
  if (promote == null) return 0
  // promote 0..6 => max levels 20..80
  return 20 + promote * 10
}

function treeIdxFromIcon(icon: unknown): number {
  if (typeof icon !== 'string') return 1
  const m = icon.match(/SkillTree(\d+)/)
  return m ? Number(m[1]) : 1
}

function buildTreeData(
  skillTrees: Record<string, unknown>,
  itemAll: Record<string, unknown>,
  nameToId: Map<string, string>
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

  // De-duplicate nodes by PointID (Hakush repeats nodes across anchors for leveling steps).
  const nodesById = new Map<number, Record<string, unknown>>()
  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      const pid = typeof node.PointID === 'number' ? node.PointID : null
      if (!pid) continue
      const pt = toNum(node.PointType)
      if (pt !== 1 && pt !== 3) continue
      if (!nodesById.has(pid)) nodesById.set(pid, node)
    }
  }

  // Build initial entries.
  const out: Record<string, TreeNode> = {}
  const childMap = new Map<number, Set<number>>()
  for (const [pid, node] of nodesById.entries()) {
    const pt = toNum(node.PointType)
    if (pt !== 1 && pt !== 3) continue
    const pre = Array.isArray(node.PrePoint) ? (node.PrePoint as Array<unknown>) : []
    const preIds = pre.map((x) => toNum(x)).filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
    for (const p of preIds) {
      if (!childMap.has(p)) childMap.set(p, new Set())
      childMap.get(p)?.add(pid)
    }

    const root = preIds.length === 0
    const name = typeof node.PointName === 'string' ? node.PointName : ''
    const levelReq = nodeLevelReq(node)
    const cost = materialListToCost(node.MaterialList, itemAll, nameToId)

    if (pt === 3) {
      out[String(pid)] = {
        id: pid,
        type: 'skill',
        root,
        name,
        levelReq,
        desc: renderSrTextWithParams(node.PointDesc, node.ParamList),
        cost,
        idx: treeIdxFromIcon(node.Icon)
      }
    } else {
      // Buff/stat node: store only the raw stat data for completeness.
      const statusArr = Array.isArray(node.StatusAddList) ? (node.StatusAddList as Array<unknown>) : []
      const first = isRecord(statusArr[0]) ? (statusArr[0] as Record<string, unknown>) : null
      const propType = first && typeof first.PropertyType === 'string' ? first.PropertyType : ''
      const v = first ? toNum(first.Value) : null
      const mapped = propType ? treeKeyFromPropertyType(propType) : null
      const data: Record<string, number> = {}
      if (mapped && v != null) {
        const outVal = mapped.valueIsPercent ? v * 100 : v
        data[mapped.key] = outVal
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

  return sortRecordByKey(out as Record<string, unknown>)
}

function buildAttr(detail: Record<string, unknown>, itemAll: Record<string, unknown>, nameToId: Map<string, string>): Record<string, unknown> {
  const stats = isRecord(detail.Stats) ? (detail.Stats as Record<string, unknown>) : {}
  const maxLevels = [20, 30, 40, 50, 60, 70, 80]
  const out: Record<string, unknown> = {}
  for (let promote = 0; promote <= 6; promote++) {
    const s = stats[String(promote)]
    if (!isRecord(s)) continue
    const atkBase = toNum(s.AttackBase) ?? 0
    const atkAdd = toNum(s.AttackAdd) ?? 0
    const hpBase = toNum(s.HPBase) ?? 0
    const hpAdd = toNum(s.HPAdd) ?? 0
    const defBase = toNum(s.DefenceBase) ?? 0
    const defAdd = toNum(s.DefenceAdd) ?? 0
    const speed = toNum(s.SpeedBase) ?? 0
    const cpct = ((toNum(s.CriticalChance) ?? 0) * 100) || 5
    const cdmg = ((toNum(s.CriticalDamage) ?? 0) * 100) || 50
    const aggro = toNum(s.BaseAggro) ?? 0
    const cost = materialListToCost(s.Cost, itemAll, nameToId)

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

  const talent: Record<string, unknown> = {}
  const talentId: Record<string, SrTalentKey> = {}

  // Assign keys for normal character skills.
  const used: Partial<Record<'a' | 'e' | 'q' | 't' | 'z', number>> = {}
  for (const [sidStr, sRaw] of Object.entries(skills)) {
    const sid = toNum(sidStr)
    if (!sid || !isRecord(sRaw)) continue
    const baseKey = typeToTalentKey(sRaw.Type)
    if (!baseKey) continue

    const count = (used[baseKey] || 0) + 1
    used[baseKey] = count

    let key: SrTalentKey = baseKey
    if (count > 1 && (baseKey === 'a' || baseKey === 'e' || baseKey === 'q')) {
      key = `${baseKey}2` as SrTalentKey
    }

    const pointId = skillIdToPointId.get(sid) ?? derivePointIdFromSkillId(charId, sid) ?? sid
    talentId[String(pointId)] = key
    talentId[String(sid)] = key

    const { desc, tables } = skillDescAndTables(sRaw.Desc, sRaw.Level, sRaw.SPBase, sRaw.ShowStanceList, elemCn)
    talent[key] = {
      id: pointId,
      name: typeof sRaw.Name === 'string' ? sRaw.Name : '',
      type: typeLabelFromKey(key),
      tag: tagLabel(sRaw.Tag),
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
      talentId[String(skillId)] = key
      const { desc, tables } = skillDescAndTables(s.Desc, s.Level, s.SPBase, s.ShowStanceList, elemCn)
      talent[key] = {
        id: pointId,
        name: typeof s.Name === 'string' ? s.Name : '',
        type: typeLabelFromKey(key),
        tag: tagLabel(s.Tag),
        desc,
        tables
      }
    }

    // Main servant skill (301) and servant passive (302), plus synthetic extra ids to match baseline convention.
    for (const [pid, ups] of pt4ByPointId.entries()) {
      const suffix = String(pid).slice(-3)
      if (suffix === '301') {
        if (ups[0]) addServant(pid, 'me', ups[0])
        if (ups[1]) addServant(pid + 5, 'me2', ups[1])
      } else if (suffix === '302') {
        if (ups[0]) addServant(pid, 'mt', ups[0])
        if (ups[1]) addServant(pid + 5, 'mt1', ups[1])
        if (ups[2]) addServant(pid + 6, 'mt2', ups[2])
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
  hakush: HakushClient
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
    const sp = toNum(detailRaw.SPNeed) ?? 0

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

    const { talent, talentId } = buildTalentAndIdMap(detailRaw, charId, elem)
    const ranks = isRecord(detailRaw.Ranks) ? (detailRaw.Ranks as Record<string, unknown>) : {}
    const talentCons = parseTalentConsFromRanks(ranks)

    // Index entry.
    index[id] = {
      id: charId,
      key,
      name,
      star,
      elem,
      weapon,
      sp,
      talentId,
      talentCons
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

    const growAttr = { atk: atkAdd, hp: hpAdd, def: defAdd, speed: 0 }

    const cons: Record<string, unknown> = {}
    for (let i = 1; i <= 6; i++) {
      const r = ranks[String(i)]
      if (!isRecord(r)) continue
      cons[String(i)] = {
        name: typeof r.Name === 'string' ? r.Name : '',
        desc: renderSrTextWithParams(r.Desc, r.ParamList)
      }
    }

    const skillTrees = isRecord(detailRaw.SkillTrees) ? (detailRaw.SkillTrees as Record<string, unknown>) : {}
    const coreIconId = resolveSrCoreSkillIconId(skillTrees, id)
    const tree = buildTree(skillTrees)
    const treeData = buildTreeData(skillTrees, itemAll, nameToId)
    const attr = buildAttr(detailRaw, itemAll, nameToId)

    const detailData = {
      id: charId,
      key,
      name,
      star,
      elem,
      allegiance: typeof info.Camp === 'string' ? info.Camp : '',
      weapon,
      sp,
      desc: normalizeTextInline(detailRaw.Desc),
      cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
      jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
      baseAttr,
      growAttr,
      talentId,
      talentCons,
      talent,
      cons,
      attr,
      tree,
      treeData
    }

    writeJsonFile(path.join(charDir, 'data.json'), detailData)
    const calcPath = path.join(charDir, 'calc.js')
    ensurePlaceholderCalcJs(calcPath, name)

    if (isPlaceholderCalc(calcPath)) {
      const getTables = (k: 'a' | 'e' | 'q' | 't'): string[] => {
        const blk = (talent as Record<string, unknown>)[k]
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

      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(opts.llm, {
        game: 'sr',
        name,
        elem,
        weapon,
        star,
        tables: { a: getTables('a'), e: getTables('e'), q: getTables('q'), t: getTables('t') }
      }, { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache })

      if (error) {
        opts.log?.warn?.(`[meta-gen] (sr) LLM calc plan failed (${name}), using heuristic: ${error}`)
      } else if (usedLlm) {
        opts.log?.info?.(`[meta-gen] (sr) LLM calc generated: ${name}`)
      }

      fs.writeFileSync(calcPath, js, 'utf8')
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

  writeJsonFile(indexPath, sortRecordByKey(index))

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
