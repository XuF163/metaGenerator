/**
 * GS weapon generator (Hakush -> meta-gs/weapon/*).
 *
 * Strategy (update-mode):
 * - Read existing meta output (incremental; do not overwrite by default)
 * - Generate only missing weapons (directory or data.json entry missing)
 * - Never overwrite existing files (unless caller prepares a fresh output)
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { cleanNumberRecord, sortRecordByKey } from '../utils.js'
import { generateGsWeaponCalcJs } from './weapon-calc.js'
import { ensureGsWeaponImages } from './weapon-images.js'

type WeaponTypeDir = 'sword' | 'claymore' | 'polearm' | 'catalyst' | 'bow'

const weaponTypeMap: Record<string, WeaponTypeDir | undefined> = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_CATALYST: 'catalyst',
  WEAPON_BOW: 'bow'
}

const bonusKeyMap: Record<string, string | undefined> = {
  FIGHT_PROP_HP_PERCENT: 'hpPct',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPct',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPct',
  FIGHT_PROP_ELEMENT_MASTERY: 'mastery',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'recharge',
  FIGHT_PROP_CRITICAL: 'cpct',
  FIGHT_PROP_CRITICAL_HURT: 'cdmg',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'phy',
  FIGHT_PROP_FIRE_ADD_HURT: 'pyro',
  FIGHT_PROP_WATER_ADD_HURT: 'hydro',
  FIGHT_PROP_WIND_ADD_HURT: 'anemo',
  FIGHT_PROP_ELEC_ADD_HURT: 'electro',
  FIGHT_PROP_ICE_ADD_HURT: 'cryo',
  FIGHT_PROP_GRASS_ADD_HURT: 'dendro',
  FIGHT_PROP_ROCK_ADD_HURT: 'geo'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeGiDesc(text: unknown): string {
  if (typeof text !== 'string') return ''
  // Hakush GI strings sometimes include literal "\n" sequences.
  return text.replaceAll('\\n', '').replaceAll('\n', '').trim()
}

function weaponUiBaseUrl(): string {
  return 'https://api.hakush.in/gi/UI/'
}

function weaponDirFromType(weaponType: string): WeaponTypeDir {
  const dir = weaponTypeMap[weaponType]
  if (!dir) {
    throw new Error(`[meta-gen] Unknown GS weapon type: ${weaponType}`)
  }
  return dir
}

function firstNumberValue(obj: unknown): number | undefined {
  if (!isRecord(obj)) return undefined
  for (const v of Object.values(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) return v
  }
  return undefined
}

function extractRefinementTextAndDatas(refinement: Record<string, unknown> | undefined): {
  affixTitle: string
  text: string
  datas: Record<string, string[]>
} {
  if (!refinement || Object.keys(refinement).length === 0) {
    return { affixTitle: '', text: '', datas: {} }
  }

  const levels = Object.keys(refinement)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => String(n))

  const ref1 = refinement['1']
  if (!isRecord(ref1)) {
    return { affixTitle: '', text: '', datas: {} }
  }

  const affixTitle = typeof ref1.Name === 'string' ? ref1.Name : ''
  const desc1 = typeof ref1.Desc === 'string' ? ref1.Desc : ''

  let idx = 0
  const text = normalizeGiDesc(
    desc1.replace(/<color=[^>]+>(.*?)<\/color>/g, () => {
      const v = `$[${idx}]`
      idx++
      return v
    })
  ).replace(/<color=[^>]+>|<\/color>/g, '')

  // Collect per-placeholder values across refinement levels.
  const datas: Record<string, string[]> = {}
  for (let i = 0; i < idx; i++) datas[String(i)] = []

  for (const lv of levels) {
    const r = refinement[lv]
    if (!isRecord(r) || typeof r.Desc !== 'string') {
      for (let i = 0; i < idx; i++) datas[String(i)]!.push('')
      continue
    }
    const parts = Array.from(r.Desc.matchAll(/<color=[^>]+>(.*?)<\/color>/g)).map((m) => m[1] ?? '')
    for (let i = 0; i < idx; i++) {
      datas[String(i)]!.push(normalizeGiDesc(parts[i] ?? ''))
    }
  }

  // Remove empty placeholder arrays (for safety).
  for (const [k, arr] of Object.entries(datas)) {
    if (arr.every((v) => !v)) delete datas[k]
  }

  return { affixTitle, text, datas }
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function firstNonZeroNumber(arr: unknown): number | null {
  if (!Array.isArray(arr)) return null
  for (const v of arr) {
    const n = toNumber(v)
    if (n != null && n > 0) return n
  }
  return null
}

type AgdTextMap = Record<string, string>

function textMapGet(map: AgdTextMap, hash: unknown): string {
  const key = String(hash ?? '')
  return typeof map[key] === 'string' ? map[key] : ''
}

function extractColoredValues(desc: string): string[] {
  return Array.from(desc.matchAll(/<color=[^>]+>(.*?)<\/color>/g)).map((m) => normalizeGiDesc(m[1] ?? ''))
}

function buildAffixDataFromTextMapLevels(levelDescs: string[]): { text: string; datas: Record<string, string[]> } {
  const base = normalizeGiDesc(levelDescs[0] ?? '')
  const baseVals = extractColoredValues(base)
  if (baseVals.length === 0) {
    return { text: base.replace(/<color=[^>]+>|<\/color>/g, ''), datas: {} }
  }

  // Build template text by replacing each colored segment with $[idx].
  let idx = 0
  const text = normalizeGiDesc(
    base.replace(/<color=[^>]+>(.*?)<\/color>/g, () => {
      const v = `$[${idx}]`
      idx++
      return v
    })
  ).replace(/<color=[^>]+>|<\/color>/g, '')

  const datas: Record<string, string[]> = {}
  for (let i = 0; i < idx; i++) datas[String(i)] = []

  for (const d of levelDescs) {
    const vals = extractColoredValues(normalizeGiDesc(d ?? ''))
    for (let i = 0; i < idx; i++) datas[String(i)]!.push(vals[i] ?? '')
  }

  // Remove empty placeholder arrays.
  for (const [k, arr] of Object.entries(datas)) {
    if (arr.every((v) => !v)) delete datas[k]
  }

  return { text, datas }
}

type AgdCurveMap = Map<number, Map<string, number>>

function buildCurveMap(curveRaw: unknown): AgdCurveMap {
  const out: AgdCurveMap = new Map()
  if (!Array.isArray(curveRaw)) return out
  for (const row of curveRaw) {
    if (!isRecord(row)) continue
    const level = toNumber(row.level)
    if (level == null) continue
    const infos = Array.isArray(row.curveInfos) ? (row.curveInfos as unknown[]) : []
    const m = new Map<string, number>()
    for (const it of infos) {
      if (!isRecord(it)) continue
      const t = typeof it.type === 'string' ? (it.type as string) : ''
      const v = toNumber(it.value)
      if (!t || v == null) continue
      m.set(t, v)
    }
    out.set(level, m)
  }
  return out
}

function curveValue(curves: AgdCurveMap, level: number, type: string): number | undefined {
  return curves.get(level)?.get(type)
}

function computeAtkTableFromAgd(opts: {
  initAtk: number
  atkCurveType: string
  curves: AgdCurveMap
  promoteAtkBonusByLevel: Map<number, number>
}): Record<string, number> {
  const { initAtk, atkCurveType, curves, promoteAtkBonusByLevel } = opts

  const atkAt = (lv: number, promoteLevel: number, requirePromote: boolean): number | undefined => {
    const c = curveValue(curves, lv, atkCurveType)
    if (typeof c !== 'number') return undefined
    const bonus = promoteAtkBonusByLevel.get(promoteLevel)
    if (requirePromote && typeof bonus !== 'number') return undefined
    return initAtk * c + (bonus ?? 0)
  }

  return cleanNumberRecord(
    {
      '1': atkAt(1, 0, false),
      '20': atkAt(20, 0, false),
      '40': atkAt(40, 1, false),
      '50': atkAt(50, 2, false),
      '60': atkAt(60, 3, false),
      '70': atkAt(70, 4, false),
      '80': atkAt(80, 5, false),
      '90': atkAt(90, 6, false),
      '20+': atkAt(20, 1, false),
      '40+': atkAt(40, 2, false),
      '50+': atkAt(50, 3, false),
      '60+': atkAt(60, 4, false),
      '70+': atkAt(70, 5, true),
      '80+': atkAt(80, 6, true)
    },
    2
  )
}

function computeSecondaryTableFromAgd(opts: {
  initValue: number
  curveType: string
  propType: string
  curves: AgdCurveMap
}): { bonusKey?: string; bonusData: Record<string, number> } {
  const { initValue, curveType, propType, curves } = opts
  const bonusKey = bonusKeyMap[propType]
  if (!bonusKey) return { bonusData: {} }
  if (!initValue) return { bonusData: {} }

  const multiplier = bonusKey === 'mastery' ? 1 : 100
  const vAt = (lv: number): number | undefined => {
    const c = curveValue(curves, lv, curveType)
    if (typeof c !== 'number') return undefined
    return initValue * c * multiplier
  }

  const bonusData = cleanNumberRecord(
    {
      '1': vAt(1),
      '20': vAt(20),
      '40': vAt(40),
      '50': vAt(50),
      '60': vAt(60),
      '70': vAt(70),
      '80': vAt(80),
      '90': vAt(90),
      '20+': vAt(20),
      '40+': vAt(40),
      '50+': vAt(50),
      '60+': vAt(60),
      '70+': vAt(70),
      '80+': vAt(80)
    },
    2
  )
  return { ...(Object.keys(bonusData).length ? { bonusKey } : {}), bonusData }
}

export interface GenerateGsWeaponOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  hakush: HakushClient
  animeGameData: AnimeGameDataClient
  /** When true, overwrite downloaded images if they exist (does not overwrite JSON). */
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateGsWeapons(opts: GenerateGsWeaponOptions): Promise<void> {
  const weaponRoot = path.join(opts.metaGsRootAbs, 'weapon')

  const list = await opts.hakush.getGsWeaponList()
  const hakushIdSet = new Set<string>(Object.keys(list))

  const typeDirs: WeaponTypeDir[] = ['sword', 'claymore', 'polearm', 'catalyst', 'bow']

  // Load per-type indices once (major perf win vs reading/writing inside the hot loop).
  const typeIndexByDir: Record<WeaponTypeDir, Record<string, unknown>> = {
    sword: {},
    claymore: {},
    polearm: {},
    catalyst: {},
    bow: {}
  }

  for (const typeDir of typeDirs) {
    const typeDirAbs = path.join(weaponRoot, typeDir)
    const typeIndexPath = path.join(typeDirAbs, 'data.json')
    const raw = fs.existsSync(typeIndexPath) ? JSON.parse(fs.readFileSync(typeIndexPath, 'utf8')) : {}
    typeIndexByDir[typeDir] = isRecord(raw) ? (raw as Record<string, unknown>) : {}
  }

  type WeaponTask = {
    id: string
    name: string
    typeDir: WeaponTypeDir
    star: number
    needsIndex: boolean
    needsDetail: boolean
    needsAssets: boolean
    weaponDirAbs: string
    weaponDataPath: string
  }

  const tasks: WeaponTask[] = []

  for (const [id, entry] of Object.entries(list)) {
    if (!isRecord(entry)) continue
    // Skip weapon skins (not part of baseline meta structure).
    if (entry.skin === true) continue

    const name = typeof entry.CHS === 'string' ? entry.CHS : undefined
    const type = typeof entry.type === 'string' ? entry.type : undefined
    const star = typeof entry.rank === 'number' ? entry.rank : undefined
    if (!name || !type || !star) continue

    const typeDir = weaponDirFromType(type)
    const typeDirAbs = path.join(weaponRoot, typeDir)
    const weaponDirAbs = path.join(typeDirAbs, name)
    const weaponDataPath = path.join(weaponDirAbs, 'data.json')

    const typeIndex = typeIndexByDir[typeDir]

    const needsIndex = !typeIndex[id]
    const needsDetail = !fs.existsSync(weaponDataPath)
    const needsAssets =
      opts.forceAssets ||
      !fs.existsSync(path.join(weaponDirAbs, 'icon.webp')) ||
      !fs.existsSync(path.join(weaponDirAbs, 'gacha.webp')) ||
      !fs.existsSync(path.join(weaponDirAbs, 'awaken.webp'))

    if (!needsIndex && !needsDetail && !needsAssets) {
      continue
    }

    tasks.push({
      id,
      name,
      typeDir,
      star,
      needsIndex,
      needsDetail,
      needsAssets,
      weaponDirAbs,
      weaponDataPath
    })
  }

  let doneHakush = 0
  if (tasks.length > 0) {
    opts.log?.info?.(`[meta-gen] (gs) weapons to generate: ${tasks.length}`)

    const CONCURRENCY = 4
    await runPromisePool(tasks, CONCURRENCY, async (task) => {
      // Fetch detail when we need to write data or (re)generate images.
      if (task.needsDetail || task.needsAssets) {
        const detail = await opts.hakush.getGsWeaponDetail(task.id)
        if (!isRecord(detail)) {
          opts.log?.warn?.(`[meta-gen] (gs) weapon detail not an object: ${task.id}`)
        } else {
          const rarity = typeof detail.Rarity === 'number' ? detail.Rarity : task.star
          const icon = typeof detail.Icon === 'string' ? detail.Icon : undefined

          const statsMod = isRecord(detail.StatsModifier) ? (detail.StatsModifier as Record<string, unknown>) : undefined
          const atkMod = statsMod && isRecord(statsMod.ATK) ? (statsMod.ATK as Record<string, unknown>) : undefined
          const atkBase = atkMod && typeof atkMod.Base === 'number' ? atkMod.Base : undefined
          const atkLevels = atkMod && isRecord(atkMod.Levels) ? (atkMod.Levels as Record<string, unknown>) : undefined
          const asc = isRecord(detail.Ascension) ? (detail.Ascension as Record<string, unknown>) : undefined

          if (task.needsDetail) {
            if (atkBase && atkLevels && asc) {
              const ascBonus = (n: number): number | undefined => firstNumberValue(asc[String(n)])

              const atkTable = cleanNumberRecord(
                {
                  '1': atkBase,
                  '20': atkBase * (atkLevels['20'] as number),
                  '40': atkBase * (atkLevels['40'] as number) + (ascBonus(1) ?? 0),
                  '50': atkBase * (atkLevels['50'] as number) + (ascBonus(2) ?? 0),
                  '60': atkBase * (atkLevels['60'] as number) + (ascBonus(3) ?? 0),
                  '70': atkBase * (atkLevels['70'] as number) + (ascBonus(4) ?? 0),
                  '80': typeof atkLevels['80'] === 'number' ? atkBase * (atkLevels['80'] as number) + (ascBonus(5) ?? 0) : undefined,
                  '90': typeof atkLevels['90'] === 'number' ? atkBase * (atkLevels['90'] as number) + (ascBonus(6) ?? 0) : undefined,
                  '20+': atkBase * (atkLevels['20'] as number) + (ascBonus(1) ?? 0),
                  '40+': atkBase * (atkLevels['40'] as number) + (ascBonus(2) ?? 0),
                  '50+': atkBase * (atkLevels['50'] as number) + (ascBonus(3) ?? 0),
                  '60+': atkBase * (atkLevels['60'] as number) + (ascBonus(4) ?? 0),
                  '70+':
                    typeof atkLevels['70'] === 'number' && typeof ascBonus(5) === 'number'
                      ? atkBase * (atkLevels['70'] as number) + (ascBonus(5) as number)
                      : undefined,
                  '80+':
                    typeof atkLevels['80'] === 'number' && typeof ascBonus(6) === 'number'
                      ? atkBase * (atkLevels['80'] as number) + (ascBonus(6) as number)
                      : undefined
                },
                2
              )

            // Secondary stat.
            const secondaryKey = statsMod ? Object.keys(statsMod).find((k) => k !== 'ATK') : undefined
            const secondary =
              secondaryKey && isRecord(statsMod?.[secondaryKey])
                ? (statsMod?.[secondaryKey] as Record<string, unknown>)
                : undefined
            const secondaryBase = secondary && typeof secondary.Base === 'number' ? secondary.Base : undefined
            const secondaryLevels = secondary && isRecord(secondary.Levels) ? (secondary.Levels as Record<string, unknown>) : undefined
            const bonusKey = secondaryKey ? bonusKeyMap[secondaryKey] : undefined

            const multiplier = bonusKey === 'mastery' ? 1 : 100

            const bonusData =
              secondaryBase && secondaryLevels && bonusKey && secondaryKey !== 'FIGHT_PROP_NONE'
                ? cleanNumberRecord(
                    {
                      '1': secondaryBase * multiplier,
                      '20': secondaryBase * multiplier * (secondaryLevels['20'] as number),
                      '40': secondaryBase * multiplier * (secondaryLevels['40'] as number),
                      '50': secondaryBase * multiplier * (secondaryLevels['50'] as number),
                      '60': secondaryBase * multiplier * (secondaryLevels['60'] as number),
                      '70': secondaryBase * multiplier * (secondaryLevels['70'] as number),
                      '80':
                        typeof secondaryLevels['80'] === 'number'
                          ? secondaryBase * multiplier * (secondaryLevels['80'] as number)
                          : undefined,
                      '90':
                        typeof secondaryLevels['90'] === 'number'
                          ? secondaryBase * multiplier * (secondaryLevels['90'] as number)
                          : undefined,
                      '20+': secondaryBase * multiplier * (secondaryLevels['20'] as number),
                      '40+': secondaryBase * multiplier * (secondaryLevels['40'] as number),
                      '50+': secondaryBase * multiplier * (secondaryLevels['50'] as number),
                      '60+': secondaryBase * multiplier * (secondaryLevels['60'] as number),
                      '70+':
                        typeof secondaryLevels['70'] === 'number'
                          ? secondaryBase * multiplier * (secondaryLevels['70'] as number)
                          : undefined,
                      '80+':
                        typeof secondaryLevels['80'] === 'number'
                          ? secondaryBase * multiplier * (secondaryLevels['80'] as number)
                          : undefined
                    },
                    2
                  )
                : {}

            // Materials: take the highest ascension stage available.
            const materials = isRecord(detail.Materials) ? (detail.Materials as Record<string, unknown>) : undefined
            let matWeapon = ''
            let matMonster = ''
            let matNormal = ''
            if (materials) {
              const stages = Object.keys(materials)
                .map((k) => Number(k))
                .filter((n) => Number.isFinite(n))
                .sort((a, b) => a - b)
              const lastStage = stages.length ? String(stages[stages.length - 1]!) : undefined
              const stage = lastStage ? (materials[lastStage] as unknown) : undefined
              if (isRecord(stage) && Array.isArray(stage.Mats)) {
                const mats = stage.Mats as Array<unknown>
                const getName = (x: unknown): string => (isRecord(x) && typeof x.Name === 'string' ? x.Name : '')
                matWeapon = getName(mats[0])
                matMonster = getName(mats[1])
                matNormal = getName(mats[2])
              }
            }

            // Refinement (affix).
            const refinement = isRecord(detail.Refinement) ? (detail.Refinement as Record<string, unknown>) : undefined
            const { affixTitle, text, datas } = extractRefinementTextAndDatas(refinement)

            const weaponData: Record<string, unknown> = {
              id: Number(task.id),
              name: typeof detail.Name === 'string' ? detail.Name : task.name,
              affixTitle,
              star: rarity,
              desc: normalizeGiDesc(detail.Desc),
              attr: {
                atk: atkTable,
                ...(bonusKey && Object.keys(bonusData).length ? { bonusKey } : {}),
                bonusData
              },
              materials: {
                weapon: matWeapon,
                monster: matMonster,
                normal: matNormal
              },
              affixData: {
                text,
                datas
              }
            }

              fs.mkdirSync(task.weaponDirAbs, { recursive: true })
              writeJsonFile(task.weaponDataPath, weaponData)
            } else {
              opts.log?.warn?.(`[meta-gen] (gs) weapon stats missing for ${task.id}`)
            }
          }

          if (task.needsAssets && icon) {
            await ensureGsWeaponImages({
              weaponDirAbs: task.weaponDirAbs,
              weaponId: task.id,
              iconName: icon,
              forceAssets: opts.forceAssets,
              label: task.name,
              log: opts.log
            })
          }
        }
      }

      // Update per-type index (in memory; flushed once at the end).
      if (task.needsIndex) {
        typeIndexByDir[task.typeDir][task.id] = { id: Number(task.id), name: task.name, star: task.star }
      }

      doneHakush++
      if (doneHakush === 1 || doneHakush % 50 === 0) {
        opts.log?.info?.(`[meta-gen] (gs) weapon progress: ${doneHakush}/${tasks.length} (last=${task.id} ${task.name})`)
      }
    })
  }

  // Secondary source: AnimeGameData (gap-filler). Some weapons are missing in Hakush structured list/detail.
  // We generate those when the weapon ID is NOT present in Hakush list and output is missing.
  let doneAgd = 0
  let totalAgd = 0
  try {
    const excelRaw = await opts.animeGameData.getGsWeaponExcelConfigData()
    const excelRows: Array<Record<string, unknown>> = Array.isArray(excelRaw)
      ? ((excelRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
      : []

    const candidates: Array<{
      id: number
      weaponType: string
      typeDir: WeaponTypeDir
      star: number
      icon: string
      nameTextMapHash: number
      descTextMapHash: number
      weaponProp: Array<{ initValue: number; propType: string; type: string }>
      weaponPromoteId: number
      skillAffix: unknown
    }> = []

    for (const row of excelRows) {
      const id = toNumber(row.id)
      if (id == null) continue
      const idStr = String(id)
      if (hakushIdSet.has(idStr)) continue

      const weaponType = typeof row.weaponType === 'string' ? (row.weaponType as string) : ''
      const typeDir = weaponType ? weaponTypeMap[weaponType] : undefined
      if (!typeDir) continue

      const star = toNumber(row.rankLevel)
      if (star == null) continue

      const icon = typeof row.icon === 'string' ? (row.icon as string) : ''
      const nameHash = toNumber(row.nameTextMapHash)
      const descHash = toNumber(row.descTextMapHash)
      if (!nameHash || !descHash) continue

      const weaponPromoteId = toNumber(row.weaponPromoteId) ?? id
      const weaponPropRaw = Array.isArray(row.weaponProp) ? (row.weaponProp as unknown[]) : []
      const weaponProp = weaponPropRaw
        .map((p) => {
          if (!isRecord(p)) return null
          const initValue = toNumber(p.initValue)
          const propType = typeof p.propType === 'string' ? (p.propType as string) : ''
          const type = typeof p.type === 'string' ? (p.type as string) : ''
          return initValue != null && propType && type ? { initValue, propType, type } : null
        })
        .filter(Boolean) as Array<{ initValue: number; propType: string; type: string }>
      if (weaponProp.length === 0) continue

      candidates.push({
        id,
        weaponType,
        typeDir,
        star,
        icon,
        nameTextMapHash: nameHash,
        descTextMapHash: descHash,
        weaponProp,
        weaponPromoteId,
        skillAffix: row.skillAffix
      })
    }

    if (candidates.length > 0) {
      const textMapRaw = await opts.animeGameData.getGsTextMapCHS()
      const textMap: AgdTextMap = isRecord(textMapRaw) ? (textMapRaw as AgdTextMap) : {}

      const curveMap = buildCurveMap(await opts.animeGameData.getGsWeaponCurveExcelConfigData())
      const promoteRaw = await opts.animeGameData.getGsWeaponPromoteExcelConfigData()
      const promoteRows: Array<Record<string, unknown>> = Array.isArray(promoteRaw)
        ? ((promoteRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
        : []

      const equipAffixRaw = await opts.animeGameData.getGsEquipAffixExcelConfigData()
      const equipAffixRows: Array<Record<string, unknown>> = Array.isArray(equipAffixRaw)
        ? ((equipAffixRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
        : []

      // Hakush item_all is a convenient name map for material IDs.
      const itemAllRaw = await opts.hakush.getGsItemAll()
      const itemAll: Record<string, unknown> = isRecord(itemAllRaw) ? (itemAllRaw as Record<string, unknown>) : {}
      const itemIdToName = new Map<number, string>()
      for (const [idStr, raw] of Object.entries(itemAll)) {
        const id = Number.parseInt(idStr, 10)
        if (!Number.isFinite(id)) continue
        if (!isRecord(raw)) continue
        const name = typeof raw.Name === 'string' ? (raw.Name as string) : ''
        if (!name) continue
        if (!itemIdToName.has(id)) itemIdToName.set(id, name)
      }

      type AgdTask = {
        id: number
        idStr: string
        name: string
        typeDir: WeaponTypeDir
        star: number
        icon: string
        descTextMapHash: number
        weaponProp: Array<{ initValue: number; propType: string; type: string }>
        weaponPromoteId: number
        skillAffix: unknown
        needsIndex: boolean
        needsDetail: boolean
        needsAssets: boolean
        weaponDirAbs: string
        weaponDataPath: string
      }

      const tasksAgd: AgdTask[] = []
      for (const c of candidates) {
        const name = textMapGet(textMap, c.nameTextMapHash)
        if (!name) continue
        const idStr = String(c.id)
        const typeDirAbs = path.join(weaponRoot, c.typeDir)
        const weaponDirAbs = path.join(typeDirAbs, name)
        const weaponDataPath = path.join(weaponDirAbs, 'data.json')
        const needsDetail = !fs.existsSync(weaponDataPath)
        const needsIndex = !typeIndexByDir[c.typeDir][idStr]
        const needsAssets =
          opts.forceAssets ||
          !fs.existsSync(path.join(weaponDirAbs, 'icon.webp')) ||
          !fs.existsSync(path.join(weaponDirAbs, 'gacha.webp')) ||
          !fs.existsSync(path.join(weaponDirAbs, 'awaken.webp'))
        if (!needsDetail && !needsIndex && !needsAssets) continue
        tasksAgd.push({
          id: c.id,
          idStr,
          name,
          typeDir: c.typeDir,
          star: c.star,
          icon: c.icon,
          descTextMapHash: c.descTextMapHash,
          weaponProp: c.weaponProp,
          weaponPromoteId: c.weaponPromoteId,
          skillAffix: c.skillAffix,
          needsIndex,
          needsDetail,
          needsAssets,
          weaponDirAbs,
          weaponDataPath
        })
      }

      totalAgd = tasksAgd.length
      if (tasksAgd.length > 0) {
        opts.log?.info?.(`[meta-gen] (gs) weapons (AnimeGameData) to generate: ${tasksAgd.length}`)
        const CONCURRENCY = 2
        await runPromisePool(tasksAgd, CONCURRENCY, async (task) => {
          if (task.needsDetail) {
            const atkProp = task.weaponProp.find((p) => p.propType === 'FIGHT_PROP_BASE_ATTACK') ?? task.weaponProp[0]
            const secProp = task.weaponProp.find((p) => p.propType !== 'FIGHT_PROP_BASE_ATTACK') ?? task.weaponProp[1]

            const initAtk = atkProp?.initValue
            const atkCurveType = atkProp?.type
            if (typeof initAtk !== 'number' || !atkCurveType) {
              opts.log?.warn?.(`[meta-gen] (gs) AGD weapon missing base atk prop: ${task.id} ${task.name}`)
            } else {
              // Promote: base ATK bonus per ascension stage.
              const promoteAtkBonusByLevel = new Map<number, number>()
              const promoteStages = promoteRows
                .filter((r) => toNumber(r.weaponPromoteId) === task.weaponPromoteId)
                .map((r) => {
                  const promoteLevel = toNumber(r.promoteLevel)
                  const addProps = Array.isArray(r.addProps) ? (r.addProps as unknown[]) : []
                  const baseAtk = addProps
                    .map((p) => (isRecord(p) && p.propType === 'FIGHT_PROP_BASE_ATTACK' ? toNumber(p.value) : null))
                    .find((x) => x != null)
                  const costItems = r.costItems
                  return promoteLevel != null && baseAtk != null ? { promoteLevel, baseAtk, costItems } : null
                })
                .filter(Boolean) as Array<{ promoteLevel: number; baseAtk: number; costItems: unknown }>
              for (const s of promoteStages) promoteAtkBonusByLevel.set(s.promoteLevel, s.baseAtk)

              const atkTable = computeAtkTableFromAgd({ initAtk, atkCurveType, curves: curveMap, promoteAtkBonusByLevel })

              // Secondary.
              const secondaryPropType = secProp?.propType ?? 'FIGHT_PROP_NONE'
              const secInit = secProp?.initValue ?? 0
              const secCurveType = secProp?.type ?? ''
              const secondary =
                secCurveType && secondaryPropType !== 'FIGHT_PROP_NONE'
                  ? computeSecondaryTableFromAgd({
                      initValue: secInit,
                      curveType: secCurveType,
                      propType: secondaryPropType,
                      curves: curveMap
                    })
                  : { bonusData: {} }

              // Materials: pick max promote stage cost items (same strategy as Hakush: highest-tier names).
              let matWeapon = ''
              let matMonster = ''
              let matNormal = ''
              const maxStage = promoteStages.sort((a, b) => a.promoteLevel - b.promoteLevel).slice(-1)[0]
              const costArr = Array.isArray(maxStage?.costItems) ? (maxStage?.costItems as unknown[]) : []
              const ids = costArr
                .map((x) => (isRecord(x) ? toNumber((x as Record<string, unknown>).id) : null))
                .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
              matWeapon = ids[0] ? itemIdToName.get(ids[0]) ?? '' : ''
              matMonster = ids[1] ? itemIdToName.get(ids[1]) ?? '' : ''
              matNormal = ids[2] ? itemIdToName.get(ids[2]) ?? '' : ''

              // Refinement (affix).
              const skillAffixId = firstNonZeroNumber(task.skillAffix)
              let affixTitle = ''
              let affixText = ''
              let affixDatas: Record<string, string[]> = {}
              if (skillAffixId) {
                const rows = equipAffixRows
                  .filter((r) => toNumber(r.id) === skillAffixId)
                  .map((r) => ({
                    level: toNumber(r.level) ?? 0,
                    title: textMapGet(textMap, r.nameTextMapHash),
                    desc: textMapGet(textMap, r.descTextMapHash)
                  }))
                  .sort((a, b) => a.level - b.level)
                if (rows.length > 0) {
                  affixTitle = rows[0]!.title
                  const { text, datas } = buildAffixDataFromTextMapLevels(rows.map((r) => r.desc))
                  affixText = text
                  affixDatas = datas
                }
              }

              const weaponData: Record<string, unknown> = {
                id: task.id,
                name: task.name,
                affixTitle,
                star: task.star,
                desc: normalizeGiDesc(textMapGet(textMap, task.descTextMapHash)),
                attr: {
                  atk: atkTable,
                  ...(secondary.bonusKey ? { bonusKey: secondary.bonusKey } : {}),
                  bonusData: secondary.bonusData
                },
                materials: {
                  weapon: matWeapon,
                  monster: matMonster,
                  normal: matNormal
                },
                affixData: {
                  text: affixText,
                  datas: affixDatas
                }
              }

              fs.mkdirSync(task.weaponDirAbs, { recursive: true })
              writeJsonFile(task.weaponDataPath, weaponData)
            }
          }

          if (task.needsAssets && task.icon) {
            await ensureGsWeaponImages({
              weaponDirAbs: task.weaponDirAbs,
              weaponId: task.id,
              iconName: task.icon,
              forceAssets: opts.forceAssets,
              label: task.name,
              log: opts.log
            })
          }

          if (task.needsIndex) {
            typeIndexByDir[task.typeDir][task.idStr] = { id: task.id, name: task.name, star: task.star }
          }

          doneAgd++
          if (doneAgd === 1 || doneAgd % 20 === 0) {
            opts.log?.info?.(`[meta-gen] (gs) weapon (AGD) progress: ${doneAgd}/${tasksAgd.length} (last=${task.id} ${task.name})`)
          }
        })
      }
    }
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) AnimeGameData weapon fallback failed: ${String(e)}`)
  }

  // Flush per-type indices once.
  for (const typeDir of typeDirs) {
    const typeDirAbs = path.join(weaponRoot, typeDir)
    fs.mkdirSync(typeDirAbs, { recursive: true })
    writeJsonFile(path.join(typeDirAbs, 'data.json'), sortRecordByKey(typeIndexByDir[typeDir]))
  }

  // Generate deterministic weapon passive static buffs from AnimeGameData.
  // This overwrites scaffold calc.js with an upstream-derived table.
  try {
    await generateGsWeaponCalcJs({
      metaGsRootAbs: opts.metaGsRootAbs,
      animeGameData: opts.animeGameData,
      log: opts.log
    })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (gs) weapon calc.js generation failed: ${String(e)}`)
  }

  opts.log?.info?.(`[meta-gen] (gs) weapon done: hakush=${doneHakush}/${tasks.length} agd=${doneAgd}/${totalAgd}`)
}
