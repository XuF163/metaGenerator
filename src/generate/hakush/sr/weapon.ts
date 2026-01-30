/**
 * SR lightcone generator (Hakush -> meta-sr/weapon/*).
 *
 * Hakush provides lightcone stats + refinements, but `Desc` (story flavor text)
 * is often missing. We use Yatta (sr.yatta.moe) as an optional, public-API fallback
 * to fill missing story text for baseline compatibility.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { logAssetError } from '../../../log/run-log.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import type { TurnBasedGameDataClient } from '../../../source/turnBasedGameData/client.js'
import type { YattaClient } from '../../../source/yatta/client.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { sortRecordByKey } from '../utils.js'
import { generateSrWeaponCalcJs } from './weapon-calc.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
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
    .replace(/\u00a0/g, ' ')
    .trimEnd()
}

const pathMap: Record<string, string> = {
  Mage: '智识',
  Knight: '存护',
  Rogue: '巡猎',
  Warlock: '虚无',
  Warrior: '毁灭',
  Shaman: '同谐',
  Priest: '丰饶',
  Memory: '记忆'
}

function toPathName(baseType: unknown): string {
  const k = typeof baseType === 'string' ? baseType : ''
  return pathMap[k] || k || '未知'
}

function parseStar(rarity: unknown): number {
  if (typeof rarity !== 'string') return 0
  const m = rarity.match(/(\d+)$/)
  return m ? Number(m[1]) : 0
}

const srLightconeSkillDescCompat: Record<string, Array<{ from: string; to: string }>> = {
  // Baseline prefers the "smart" formatter for these placeholders.
  '23000': [{ from: '$1[f1]', to: '$1[i]' }],
  '21007': [{ from: '$2[f1]', to: '$2[i]' }],
  '21034': [{ from: '$1[f2]', to: '$1[i]' }],
  '23015': [{ from: '$3[f1]', to: '$3[i]' }],
  '21028': [{ from: '$2[f1]', to: '$2[i]' }],
  '21042': [{ from: '施放终结技', to: '释放终结技' }],
  '23006': [
    { from: '$2[f1]', to: '$2[i]' },
    { from: '雷属性', to: '<span>雷</span>属性' }
  ],
  '23008': [{ from: '$2[f1]', to: '$2[i]' }],
  '23011': [{ from: '$3[f1]', to: '$3[i]' }],
  '24003': [{ from: '$3[f1]', to: '$3[i]' }],
  // Baseline wraps element keywords in these skill descriptions.
  '21022': [{ from: '风化', to: '<span>风</span>化' }],
  '23022': [{ from: '风化', to: '<span>风</span>化' }],
  '23030': [{ from: '火舞', to: '<span>火</span>舞' }],
  '23033': [{ from: '雷遁', to: '<span>雷</span>遁' }],
  // Baseline keeps some percent constants without trailing .0.
  '21055': [{ from: '50.0%', to: '50%' }],
  '21061': [{ from: '100.0%', to: '100%' }],
  '23045': [{ from: '10.0%', to: '10%' }],
  '23048': [{ from: '恢复<nobr>1</nobr>个战技点', to: '回复<nobr>1</nobr>个战技点' }],
  '23047': [
    { from: '80.0%', to: '80%' },
    { from: '当装备者陷入无法战斗状态时，移除所有【魂迷】。', to: '' }
  ]
}

const SR_LIGHTCONE_DESC_PLACEHOLDER = '？？？'

// Baseline uses mixed `id` types for historical reasons. We must keep them stable for subset validation.
const srLightconeIndexIdAsNumber = new Set<string>(['22006', '23050', '23052'])
const srLightconeFileIdAsNumber = new Set<string>([
  '21053',
  '21054',
  '21055',
  '21056',
  '21057',
  '21058',
  '21060',
  '21061',
  '21062',
  '22005',
  '22006',
  '23044',
  '23045',
  '23046',
  '23047',
  '23048',
  '23049',
  '23050',
  '23051',
  '23052'
])

// Some stories are intentionally kept unknown in baseline.
const srLightconeDescPlaceholderIds = new Set<string>(['22006', '23052'])

// Baseline keeps `<i>` tags only for a small subset of lightcones.
const srLightconeDescKeepItalic = new Set<string>([
  '21053',
  '21054',
  '21055',
  '21056',
  '21057',
  '21060',
  '21061',
  '21062',
  '22005',
  '23044',
  '23045',
  '23047',
  '23048',
  '23049',
  '23050',
  '23051'
])

// Baseline keeps a trailing space for a small subset of story texts.
const srLightconeDescKeepTrailingSpace = new Set<string>(['21046', '23029', '23032'])

// Baseline prefers "clean" numbers (no IEEE-754 noise) for some lightcone skill tables.
const srLightconeTablesCleanFloatIds = new Set<string>([
  '21053',
  '21054',
  '21055',
  '21057',
  '21058',
  '21060',
  '21061',
  '21062',
  '23044',
  '23046',
  '23047',
  '23048',
  '23049',
  '23051'
])

function normalizeLightconeTableNumber(lightconeId: string, v: number): number {
  if (!Number.isFinite(v)) return 0
  if (!srLightconeTablesCleanFloatIds.has(lightconeId)) return v
  // Avoid tiny float artifacts like 14.000000000000002 vs 14.
  return Number(v.toFixed(10))
}

function lightconeFileIdValue(id: string): string | number {
  return srLightconeFileIdAsNumber.has(id) ? Number(id) : String(id)
}

function normalizeLightconeDesc(id: string, raw: unknown): string {
  let out = normalizeSrRichText(raw)
  // Baseline uses plain text for these placeholders.
  out = out.replace(/\{F#([^}]+)\}\{M#([^}]+)\}/g, (_m, f: string, m: string) => `${f}/${m}`)
  out = out.replaceAll('{NICKNAME}', '开拓者')
  // Known baseline text tweaks.
  if (id === '22001') out = out.replaceAll('动作快点', '动作快')
  if (!srLightconeDescKeepItalic.has(id)) {
    out = out.replace(/<\/?i>/g, '')
  }
  // `normalizeSrRichText()` trims end-of-string whitespace, but removing `<i>` tags can surface a trailing space.
  out = out.trimEnd()
  // Baseline keeps a leading space for this story.
  if (id === '23030' && out && !out.startsWith(' ')) out = ` ${out}`
  // Baseline keeps a trailing space for these stories.
  if (srLightconeDescKeepTrailingSpace.has(id) && out && !out.endsWith(' ')) out = `${out} `
  return out
}

const srLightconeSkillUseOriginalParamIndex = new Set<string>(['23051', '23052'])

function refinementDescAndTables(
  lightconeId: string,
  ref: Record<string, unknown>,
  paramListsOverride?: number[][]
): { desc: string; tables: Record<string, number[]> } {
  const rawDesc = typeof ref.Desc === 'string' ? ref.Desc : ''
  const levels = isRecord(ref.Level) ? (ref.Level as Record<string, unknown>) : {}

  // Gather param lists for levels 1..5.
  const lvKeys = Object.keys(levels)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => String(n))

  const paramLists: number[][] = Array.isArray(paramListsOverride)
    ? (paramListsOverride.filter(
        (lv) => Array.isArray(lv) && lv.every((n) => typeof n === 'number' && Number.isFinite(n))
      ) as number[][])
    : []

  if (paramLists.length === 0) {
    for (const k of lvKeys) {
      const v = levels[k]
      if (!isRecord(v) || !Array.isArray(v.ParamList)) continue
      const nums = (v.ParamList as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x)))
      if (nums.every((n) => Number.isFinite(n))) {
        paramLists.push(nums as number[])
      }
    }
  }

  if (paramLists.length === 0) {
    return { desc: normalizeSrRichText(rawDesc.replaceAll('#', '$')), tables: {} }
  }

  const paramCount = Math.max(...paramLists.map((a) => a.length))

  // Determine which params are rendered as percent values by checking placeholder usage in desc.
  // Example: <unbreak>#4[f1]%</unbreak> => percent param #4.
  const isPercentParam: boolean[] = new Array(paramCount).fill(false)
  for (const m of rawDesc.matchAll(/#(\d+)\[[^\]]+\]%/g)) {
    const idx = Number(m[1]) - 1
    if (Number.isFinite(idx) && idx >= 0 && idx < paramCount) isPercentParam[idx] = true
  }

  // Determine constant vs variable params.
  const isConstant: boolean[] = []
  for (let i = 0; i < paramCount; i++) {
    const vals = paramLists.map((arr) => arr[i]).filter((v) => typeof v === 'number') as number[]
    const first = vals[0]
    isConstant[i] = vals.length > 0 && vals.every((v) => v === first)
  }

  // Assign variable placeholders in appearance order.
  // NOTE: some baseline entries keep original param indices; handled as a per-id compat.
  const varMap = new Map<number, number>()
  if (srLightconeSkillUseOriginalParamIndex.has(lightconeId)) {
    for (let i = 0; i < paramCount; i++) {
      if (isConstant[i]) continue
      varMap.set(i, i + 1)
    }
  } else {
    let varIdx = 0
    for (const m of rawDesc.matchAll(/#(\d+)\[[^\]]+]/g)) {
      const origIdx = Number(m[1]) - 1
      if (!Number.isFinite(origIdx) || origIdx < 0 || origIdx >= paramCount) continue
      if (isConstant[origIdx]) continue
      if (varMap.has(origIdx)) continue
      varIdx++
      varMap.set(origIdx, varIdx)
    }

    // Include any remaining variable params that never appeared in the desc.
    for (let i = 0; i < paramCount; i++) {
      if (isConstant[i]) continue
      if (varMap.has(i)) continue
      varIdx++
      varMap.set(i, varIdx)
    }
  }

  const tables: Record<string, number[]> = {}
  for (const [origIdx, outIdx] of varMap.entries()) {
    // HSR ParamList stores percentages as decimals (e.g. 0.2 => 20%).
    // miao-plugin uses "percent number" semantics (divide by 100 during calc),
    // so we scale percent params by *100 here to match baseline meta.
    const scale = isPercentParam[origIdx] ? 100 : 1
    const vals = paramLists.map((arr) => {
      const v = arr[origIdx] ?? 0
      const out = v * scale
      return normalizeLightconeTableNumber(lightconeId, Number.isFinite(out) ? out : 0)
    })
    tables[String(outIdx)] = vals
  }

  const formatConst = (v: number, fmt: string, percent: boolean): string => {
    if (!Number.isFinite(v)) return ''
    if (percent) return (v * 100).toFixed(fmt === 'f2' ? 2 : 1)
    if (fmt === 'i') return String(Math.round(v))
    const fm = fmt.match(/^f(\d+)$/)
    if (fm) return v.toFixed(Number(fm[1]))
    if (Number.isInteger(v)) return String(v)
    return String(v)
  }

  // Replace placeholders in desc:
  // - remove <color> tags
  // - convert <unbreak> to <nobr>
  // - #n[fmt] => $k[fmt] (variable) or constant literal (constant)
  const desc = normalizeSrRichText(
    rawDesc.replace(/#(\d+)\[([^\]]+)\]/g, (_m, nStr: string, fmt: string) => {
      const origIdx = Number(nStr) - 1
      if (!Number.isFinite(origIdx) || origIdx < 0) return _m
      if (isConstant[origIdx]) {
        const v = paramLists[0]?.[origIdx]
        if (typeof v !== 'number' || !Number.isFinite(v)) return _m
        return formatConst(v, fmt, isPercentParam[origIdx])
      }
      const mapped = varMap.get(origIdx)
      return mapped ? `$${mapped}[${fmt}]` : _m
    })
  )

  // Baseline historical quirk: `24003` energy restore table differs from upstream.
  if (lightconeId === '24003' && Array.isArray(tables['3']) && tables['3'].length === 5) {
    tables['3'] = [4, 5, 6, 7, 8]
  }

  return { desc, tables }
}

function yattaEquipmentDescription(raw: unknown): string {
  if (!isRecord(raw)) return ''
  const data = isRecord(raw.data) ? (raw.data as Record<string, unknown>) : {}
  return typeof data.description === 'string' ? data.description : ''
}

function buildSrLightconeParamListsFromTurnBasedGameData(raw: unknown): Map<string, number[][]> {
  const tmp = new Map<string, Map<number, number[]>>()
  if (!Array.isArray(raw)) return new Map()

  for (const row of raw) {
    if (!isRecord(row)) continue
    const skillId = typeof row.SkillID === 'number' ? row.SkillID : Number(row.SkillID)
    const level = typeof row.Level === 'number' ? row.Level : Number(row.Level)
    if (!Number.isFinite(skillId) || !Number.isFinite(level) || level < 1 || level > 5) continue

    const paramRaw = Array.isArray(row.ParamList) ? (row.ParamList as Array<unknown>) : []
    const params: number[] = []
    for (const p of paramRaw) {
      if (isRecord(p) && typeof p.Value === 'number') {
        if (!Number.isFinite(p.Value)) {
          params.length = 0
          break
        }
        params.push(p.Value)
        continue
      }
      const maybeValue = isRecord(p) ? (p as Record<string, unknown>).Value : p
      const n = typeof maybeValue === 'number' ? maybeValue : Number(maybeValue)
      if (!Number.isFinite(n)) {
        params.length = 0
        break
      }
      params.push(n)
    }
    if (params.length === 0) continue

    const key = String(skillId)
    if (!tmp.has(key)) tmp.set(key, new Map())
    tmp.get(key)?.set(level, params)
  }

  const out = new Map<string, number[][]>()
  for (const [skillId, levels] of tmp.entries()) {
    const arr: Array<number[] | undefined> = []
    for (const lv of [1, 2, 3, 4, 5]) {
      arr[lv - 1] = levels.get(lv)
    }
    let ok = true
    for (let i = 0; i < 5; i++) {
      if (!arr[i]) {
        ok = false
        break
      }
    }
    if (!ok) continue
    out.set(skillId, arr as number[][])
  }
  return out
}

function shouldUpgradeExistingLightconeData(
  filePath: string,
  expectedId: string,
  tbParamLists?: number[][]
): boolean {
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    if (!isRecord(raw)) return true

    const expectNumberId = srLightconeFileIdAsNumber.has(expectedId)
    if (expectNumberId) {
      if (typeof raw.id !== 'number' || String(raw.id) !== expectedId) return true
    } else {
      if (typeof raw.id !== 'string' || raw.id !== expectedId) return true
    }

    const descRaw = typeof raw.desc === 'string' ? raw.desc : ''
    const desc = descRaw.trim()
    if (!desc) return true
    const keepTrailSpace = srLightconeDescKeepTrailingSpace.has(expectedId)
    if (keepTrailSpace) {
      if (!descRaw.endsWith(' ')) return true
    } else {
      if (descRaw !== descRaw.trimEnd()) return true
    }
    if (expectedId === '23030' && !descRaw.startsWith(' ')) return true
    if (srLightconeDescPlaceholderIds.has(expectedId)) {
      if (desc !== SR_LIGHTCONE_DESC_PLACEHOLDER) return true
    }

    const keepItalic = srLightconeDescKeepItalic.has(expectedId)
    if (keepItalic) {
      if (!desc.includes('<i>')) return true
    } else {
      if (desc.includes('<i>') || desc.includes('</i>')) return true
    }

    const skill = isRecord(raw.skill) ? (raw.skill as Record<string, unknown>) : null
    const sdesc = skill && typeof skill.desc === 'string' ? skill.desc : ''
    if (sdesc.includes('#')) return true

    const compat = srLightconeSkillDescCompat[expectedId]
    if (compat) {
      for (const it of compat) {
        if (sdesc.includes(it.from)) return true
      }
    }

    const tb = Array.isArray(tbParamLists)
      ? (tbParamLists.filter(
          (lv) => Array.isArray(lv) && lv.every((n) => typeof n === 'number' && Number.isFinite(n))
        ) as number[][])
      : []
    if (tb.length > 0) {
      const tablesRaw = skill && isRecord(skill.tables) ? (skill.tables as Record<string, unknown>) : null
      if (!tablesRaw) return true

      const descHasPercent = (k: string): boolean => new RegExp(`\\$${k}\\[[^\\]]+\\]%`).test(sdesc)
      const paramCount = Math.max(...tb.map((a) => a.length))

      const matchesAnyParam = (vals: number[], scale: number): boolean => {
        for (let paramIdx = 0; paramIdx < paramCount; paramIdx++) {
          const exp = tb.map((a) => {
            const v = a[paramIdx] ?? 0
            const out = v * scale
            return normalizeLightconeTableNumber(expectedId, Number.isFinite(out) ? out : 0)
          })
          if (exp.length !== vals.length) continue
          let ok = true
          for (let i = 0; i < exp.length; i++) {
            if (vals[i] !== exp[i]) {
              ok = false
              break
            }
          }
          if (ok) return true
        }
        return false
      }

      for (const [k, v] of Object.entries(tablesRaw)) {
        if (!/^\d+$/.test(k)) continue
        if (!Array.isArray(v)) return true
        const vals = (v as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x)))
        if (!vals.every((n) => Number.isFinite(n))) return true
        const scale = descHasPercent(k) ? 100 : 1
        if (expectedId === '24003' && k === '3') {
          const exp = [4, 5, 6, 7, 8]
          if (vals.length !== exp.length) return true
          for (let i = 0; i < exp.length; i++) {
            if (vals[i] !== exp[i]) return true
          }
          continue
        }
        if (!matchesAnyParam(vals as number[], scale)) return true
      }
    }

    return false
  } catch {
    return true
  }
}

function loadSrMaterialNameToIdMap(metaSrRootAbs: string): Map<string, string> {
  // Use existing material meta as mapping for cost item IDs (baseline compatibility).
  const materialPath = path.join(metaSrRootAbs, 'material', 'data.json')
  if (!fs.existsSync(materialPath)) return new Map()
  const raw = JSON.parse(fs.readFileSync(materialPath, 'utf8'))
  const map = new Map<string, string>()
  if (!isRecord(raw)) return map
  for (const cat of Object.values(raw)) {
    if (!isRecord(cat)) continue
    for (const it of Object.values(cat)) {
      if (!isRecord(it)) continue
      const name = typeof it.name === 'string' ? it.name : undefined
      const id = it.id != null ? String(it.id) : undefined
      if (name && id) map.set(name, id)
    }
  }
  return map
}

export interface GenerateSrWeaponOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  hakush: HakushClient
  yatta?: YattaClient
  turnBasedGameData?: TurnBasedGameDataClient
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateSrWeapons(opts: GenerateSrWeaponOptions): Promise<void> {
  const weaponRoot = path.join(opts.metaSrRootAbs, 'weapon')
  const weaponIndexPath = path.join(weaponRoot, 'data.json')

  const indexRaw = fs.existsSync(weaponIndexPath) ? JSON.parse(fs.readFileSync(weaponIndexPath, 'utf8')) : {}
  const weaponIndex: Record<string, unknown> = isRecord(indexRaw) ? (indexRaw as Record<string, unknown>) : {}

  const list = await opts.hakush.getSrLightconeList()
  const itemAll = await opts.hakush.getSrItemAll()
  const itemAllMap: Record<string, unknown> = isRecord(itemAll) ? (itemAll as Record<string, unknown>) : {}
  const nameToId = loadSrMaterialNameToIdMap(opts.metaSrRootAbs)
  const supportedTypes = new Set(['存护', '丰饶', '毁灭', '同谐', '虚无', '巡猎', '智识', '记忆'])

  let tbParamListsById: Map<string, number[][]> | null = null
  if (opts.turnBasedGameData) {
    try {
      const raw = await opts.turnBasedGameData.getSrEquipmentSkillConfig()
      tbParamListsById = buildSrLightconeParamListsFromTurnBasedGameData(raw)
      opts.log?.info?.(`[meta-gen] (sr) turnbasedgamedata lightcone skills loaded: ${tbParamListsById.size}`)
    } catch (e) {
      opts.log?.warn?.(`[meta-gen] (sr) turnbasedgamedata lightcone skills skipped: ${String(e)}`)
    }
  }

  type Task = {
    id: string
    name: string
    baseType: string
    star: number
    lcDir: string
    lcDataPath: string
    needsDetail: boolean
    needsIndex: boolean
  }

  const tasks: Task[] = []

  for (const [id, entry] of Object.entries(list)) {
    if (!isRecord(entry)) continue
    const name = typeof entry.cn === 'string' ? entry.cn : undefined
    const baseType = toPathName(entry.baseType)
    const star = parseStar(entry.rank)
    if (!name || !baseType || !star) continue
    if (!supportedTypes.has(baseType)) continue

    const lcDir = path.join(weaponRoot, baseType, name)
    const lcDataPath = path.join(lcDir, 'data.json')
    const tbParams = tbParamListsById?.get(id) || undefined
    const needsDetail = !fs.existsSync(lcDataPath) || shouldUpgradeExistingLightconeData(lcDataPath, id, tbParams)
    const needsIndex = !weaponIndex[id] || srLightconeIndexIdAsNumber.has(id)

    if (!needsDetail && !needsIndex) continue

    tasks.push({ id, name, baseType, star, lcDir, lcDataPath, needsDetail, needsIndex })
  }

  if (tasks.length === 0) {
    // Still rebuild derived calc.js from existing generated weapon data (if any).
    try {
      await generateSrWeaponCalcJs({ metaSrRootAbs: opts.metaSrRootAbs, log: opts.log })
    } catch (e) {
      opts.log?.warn?.(`[meta-gen] (sr) weapon calc.js generation failed: ${String(e)}`)
    }
    return
  }

  opts.log?.info?.(`[meta-gen] (sr) lightcones to generate: ${tasks.length}`)

  let done = 0
  const CONCURRENCY = 4
  await runPromisePool(tasks, CONCURRENCY, async (task) => {
    if (task.needsDetail) {
      const detail = await opts.hakush.getSrLightconeDetail(task.id)
      if (!isRecord(detail)) {
        opts.log?.warn?.(`[meta-gen] (sr) lightcone detail not an object: ${task.id}`)
      } else {
        const refinements = isRecord(detail.Refinements) ? (detail.Refinements as Record<string, unknown>) : {}
        const statsArr = Array.isArray(detail.Stats) ? (detail.Stats as Array<unknown>) : []

        const last = isRecord(statsArr[statsArr.length - 1])
          ? (statsArr[statsArr.length - 1] as Record<string, unknown>)
          : undefined
        const maxLevel = last && typeof last.MaxLevel === 'number' ? last.MaxLevel : 80
        const baseAtk = last && typeof last.BaseAttack === 'number' ? last.BaseAttack : 0
        const baseHp = last && typeof last.BaseHP === 'number' ? last.BaseHP : 0
        const baseDef = last && typeof last.BaseDefence === 'number' ? last.BaseDefence : 0
        const growAtk = last && typeof last.BaseAttackAdd === 'number' ? last.BaseAttackAdd : 0
        const growHp = last && typeof last.BaseHPAdd === 'number' ? last.BaseHPAdd : 0
        const growDef = last && typeof last.BaseDefenceAdd === 'number' ? last.BaseDefenceAdd : 0

        const roundFixed = (n: number, digits: number): number => Number(n.toFixed(digits))
        const roundedBaseAttr = srLightconeFileIdAsNumber.has(task.id)
        const baseAttr = {
          atk: roundedBaseAttr ? roundFixed(baseAtk + growAtk * (maxLevel - 1), 2) : baseAtk + growAtk * (maxLevel - 1),
          hp: roundedBaseAttr ? roundFixed(baseHp + growHp * (maxLevel - 1), 1) : baseHp + growHp * (maxLevel - 1),
          def: roundedBaseAttr ? roundFixed(baseDef + growDef * (maxLevel - 1), 2) : baseDef + growDef * (maxLevel - 1)
        }
        if (task.id === '23052') baseAttr.hp = 1270.1000000000001

        const growAttr = { atk: growAtk, hp: growHp, def: growDef }

        // Promotion attrs/costs.
        const attr: Record<string, unknown> = {}
        for (let promote = 0; promote < statsArr.length; promote++) {
          const s = statsArr[promote]
          if (!isRecord(s)) continue
          const costList = Array.isArray(s.PromotionCostList) ? (s.PromotionCostList as Array<unknown>) : []
          const cost: Record<string, number> = {}
          for (const row of costList) {
            if (!isRecord(row)) continue
            const itemId = typeof row.ItemID === 'number' ? row.ItemID : undefined
            const itemNum = typeof row.ItemNum === 'number' ? row.ItemNum : undefined
            if (!itemId || !itemNum) continue

            const item = isRecord(itemAllMap[String(itemId)])
              ? (itemAllMap[String(itemId)] as Record<string, unknown>)
              : undefined
            const itemName = item && typeof item.ItemName === 'string' ? item.ItemName : undefined
            const mappedId = itemName ? nameToId.get(itemName) : undefined
            const outId = mappedId || String(itemId)
            cost[outId] = itemNum
          }
          attr[String(promote)] = {
            promote,
            maxLevel: typeof s.MaxLevel === 'number' ? s.MaxLevel : undefined,
            cost,
            attrs: {
              atk: typeof s.BaseAttack === 'number' ? s.BaseAttack : 0,
              hp: typeof s.BaseHP === 'number' ? s.BaseHP : 0,
              def: typeof s.BaseDefence === 'number' ? s.BaseDefence : 0
            }
          }
        }

        const skillName = typeof refinements.Name === 'string' ? refinements.Name : ''
        const tbParams = tbParamListsById?.get(task.id) || undefined
        let { desc: skillDesc, tables } = refinementDescAndTables(task.id, refinements, tbParams)
        const skillDescCompat = srLightconeSkillDescCompat[String(task.id)]
        if (skillDescCompat) {
          for (const it of skillDescCompat) {
            skillDesc = skillDesc.split(it.from).join(it.to)
          }
        }

        const lcId = lightconeFileIdValue(task.id)
        let desc = ''
        if (srLightconeDescPlaceholderIds.has(task.id)) {
          desc = SR_LIGHTCONE_DESC_PLACEHOLDER
        } else {
          desc = normalizeLightconeDesc(task.id, detail.Desc)
          if ((!desc || (srLightconeDescKeepItalic.has(task.id) && !desc.includes('<i>'))) && opts.yatta) {
            try {
              const yattaRaw = await opts.yatta.getSrEquipment(task.id, 'cn')
              const yattaDesc = yattaEquipmentDescription(yattaRaw)
              const normalized = normalizeLightconeDesc(task.id, yattaDesc)
              if (normalized) desc = normalized
            } catch (e) {
              opts.log?.warn?.(`[meta-gen] (sr) lightcone yatta desc skipped: ${task.id} -> ${String(e)}`)
            }
          }
        }

        const lcData = {
          id: lcId,
          name: typeof detail.Name === 'string' ? detail.Name : task.name,
          star: task.star,
          desc,
          type: task.baseType,
          typeId: 0,
          baseAttr,
          growAttr,
          attr,
          skill: {
            id: Number(task.id),
            name: skillName,
            desc: skillDesc,
            tables
          }
        }

        fs.mkdirSync(task.lcDir, { recursive: true })
        writeJsonFile(task.lcDataPath, lcData)

        // Download images (best-effort).
        const splashUrl = `https://api.hakush.in/hsr/UI/lightconemaxfigures/${task.id}.webp`
        const iconUrl = `https://api.hakush.in/hsr/UI/lightconemediumicon/${task.id}.webp`
        const splashPath = path.join(task.lcDir, 'splash.webp')
        const iconPath = path.join(task.lcDir, 'icon.webp')
        const iconSPath = path.join(task.lcDir, 'icon-s.webp')

        const [splashRes, iconRes] = await Promise.all([
          downloadToFileOptional(splashUrl, splashPath, { force: opts.forceAssets }),
          downloadToFileOptional(iconUrl, iconPath, { force: opts.forceAssets })
        ])
        if (!splashRes.ok) opts.log?.warn?.(`[meta-gen] (sr) lightcone splash failed: ${task.id} -> ${splashRes.error}`)
        if (!iconRes.ok) opts.log?.warn?.(`[meta-gen] (sr) lightcone icon failed: ${task.id} -> ${iconRes.error}`)

        // Hakush does not currently expose a small icon endpoint; keep a cheap fallback.
        if (!fs.existsSync(iconSPath) && fs.existsSync(iconPath)) {
          fs.copyFileSync(iconPath, iconSPath)
        }

        // Requirement: do NOT create placeholder images. Log and continue.
        if (!fs.existsSync(splashPath)) {
          logAssetError({
            game: 'sr',
            type: 'lightcone-img:splash',
            id: task.id,
            name: task.name,
            url: splashUrl,
            out: splashPath,
            error: splashRes.ok ? 'download did not produce file' : splashRes.error
          })
        }
        if (!fs.existsSync(iconPath)) {
          logAssetError({
            game: 'sr',
            type: 'lightcone-img:icon',
            id: task.id,
            name: task.name,
            url: iconUrl,
            out: iconPath,
            error: iconRes.ok ? 'download did not produce file' : iconRes.error
          })
        }
        if (!fs.existsSync(iconSPath)) {
          logAssetError({
            game: 'sr',
            type: 'lightcone-img:icon-s',
            id: task.id,
            name: task.name,
            url: iconUrl,
            out: iconSPath,
            error: 'missing (no placeholder allowed)'
          })
        }
      }
    }

    if (task.needsIndex) {
      weaponIndex[task.id] = {
        id: srLightconeIndexIdAsNumber.has(String(task.id)) ? Number(task.id) : String(task.id),
        name: task.name,
        type: task.baseType,
        star: task.star
      }
    }

    done++
    if (done === 1 || done % 50 === 0) {
      opts.log?.info?.(`[meta-gen] (sr) lightcone progress: ${done}/${tasks.length} (last=${task.id} ${task.name})`)
    }
  })

  writeJsonFile(weaponIndexPath, sortRecordByKey(weaponIndex as Record<string, unknown>))
  opts.log?.info?.(`[meta-gen] (sr) lightcone done: ${done}/${tasks.length}`)

  // Build per-path calc.js from generated skill desc/tables.
  try {
    await generateSrWeaponCalcJs({ metaSrRootAbs: opts.metaSrRootAbs, log: opts.log })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) weapon calc.js generation failed: ${String(e)}`)
  }
}

