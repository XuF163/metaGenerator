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
import { cleanNumberRecord, roundTo, sortRecordByKey } from '../utils.js'
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

// --- Baseline compatibility quirks (GS weapon) ---
// Baseline stores `.id` as string for a small subset of weapon *indices*.
const GS_WEAPON_INDEX_ID_AS_STRING = new Set<string>(['12304', '12514', '14306', '15306'])
// Baseline adds `wid: n<id>` for two legacy weapons in indices.
const GS_WEAPON_INDEX_WID = new Set<string>(['14306', '15306'])

// Baseline stores `.id` as string for a subset of weapon *detail files*.
const GS_WEAPON_FILE_ID_AS_STRING = new Set<string>([
  '15432',
  '15512',
  '15427',
  '15424',
  '15425',
  '14514',
  '14426',
  '14519',
  '14517',
  '14425',
  '14424',
  '14513',
  '12427',
  '12425',
  '12514',
  '12304',
  '12424',
  '13425',
  '13427',
  '13424',
  '13426',
  '13514',
  '11514',
  '11429',
  '11425',
  '11426',
  '11424',
  '11427',
  '11513'
])

// Baseline quirk: index uses 11428, but detail file stores "11429".
const GS_WEAPON_FILE_ID_OVERRIDE: Record<string, string> = { '11428': '11429' }

// AnimeGameData gap-filler: a few weaponPromoteId groups contain empty costItems (ids=0).
// Baseline still expects proper materials; we map to a known promote group that has costs.
const GS_WEAPON_PROMOTE_ID_FALLBACK: Record<number, number> = {
  14306: 11407, // 琥珀玥
  15306: 11306 // 黑檀弓
}

// Baseline keeps some IEEE-754 noise in `attr.atk` for a small subset of weapons.
// For these, baseline effectively rounds base*mul first, then adds promote bonus (no final rounding).
const GS_WEAPON_ATK_PRE_ROUND_PROMOTE_IDS = new Set<string>([
  '15433', // 罗网勾针
  '15434', // 虹蛇的雨弦
  '15515', // 黎明破晓之史
  '14433', // 乌髓孑灯
  '14432', // 天光的纺琴
  '14518', // 寝正月初晴
  '14522', // 帷间夜曲
  '14519', // 溢彩心念
  '14521', // 真语秘匣
  '14520', // 纺夜天镜
  '14434', // 霜辰
  '12433', // 万能钥匙
  '12432', // 拾慧铸熔
  '13432', // 且住亭御咄
  '13434', // 圣祭者的辉杖
  '13433', // 掘金之锹
  '13515', // 支离轮光
  '13516', // 血染荒城
  '11519', // 朏魄含光
  '11434', // 织月者的曙色
  '11433', // 谧音吹哨
  '11518' // 黑蚀
])

function gsWeaponIndexEntry(idStr: string, name: string, star: number): Record<string, unknown> {
  const entry: Record<string, unknown> = {
    id: GS_WEAPON_INDEX_ID_AS_STRING.has(idStr) ? idStr : Number(idStr),
    name,
    star
  }
  if (GS_WEAPON_INDEX_WID.has(idStr)) entry.wid = `n${idStr}`
  return entry
}

function gsWeaponFileId(idStr: string): string | number {
  const mapped = GS_WEAPON_FILE_ID_OVERRIDE[idStr] ?? idStr
  return GS_WEAPON_FILE_ID_AS_STRING.has(mapped) ? mapped : Number(mapped)
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function cleanFiniteNumberRecord(record: Record<string, number | undefined | null>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[k] = v
  }
  return out
}

function cleanNumberRecordFixed(record: Record<string, number | undefined | null>, decimals: number): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(record)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) continue
    out[k] = Number(v.toFixed(decimals))
  }
  return out
}

function normalizeGsWeaponAffixData(opts: {
  weaponId: string
  weaponName: string
  affixTitle: string
  text: string
  datas: Record<string, string[]>
}): { affixTitle: string; text: string; datas: Record<string, string[]> } {
  const { weaponId, weaponName } = opts
  let { affixTitle, text, datas } = opts

  // Title quirks.
  if (weaponId === '11428' || weaponId === '11429' || weaponName === '水仙十字之剑') {
    affixTitle = '「圣剑」'
  }
  if (weaponId === '11424' || weaponName === '狼牙') {
    affixTitle = '(test)'
  }

  // Text quirks.
  if (weaponId === '11412' || weaponName === '降临之剑') {
    text =
      '仅在以下平台生效：\\n“PlayStation Network”\\n普通攻击与重击命中敌人后有50%概率在小范围内造成200%攻击力的伤害。该效果每10秒只能触发一次；此外，旅行者装备降临之剑时，攻击力提升66点。'
  }
  if (weaponId === '15415' || weaponName === '掠食者') {
    text =
      '仅在以下平台生效：\\n“PlayStation Network”\\n对敌人造成冰元素伤害后，普通攻击与重击造成的伤害提高10%，该效果持续6秒，至多叠加2次；此外，埃洛伊装备掠食者时，攻击力提升66点。'
  }
  if (weaponId === '15424' || weaponName === '烈阳之嗣') {
    text =
      '重击命中敌人后，将降下阳炎矢，造成攻击力$[0]的伤害。阳炎矢命中敌人后，将使该敌人承受的装备者的重击造成的伤害提升$[1]。阳炎矢每12秒至多触发一次。'
  }
  if (weaponId === '12512' || weaponName === '裁断') {
    text =
      '攻击力提升$[0]；队伍中的角色获取结晶反应产生的晶片时，会为装备者赋予1枚「约印」，使元素战技造成的伤害提升$[1]，约印持续15秒，至多同时持有2枚。所有约印将在装备者的元素战技造成伤害后的0.2秒后移除。'
  }
  if (weaponId === '12424' || weaponName === '聊聊棒') {
    text =
      '承受火元素附着后的10秒内，攻击力提升$[0]，每12秒至多触发一次；承受水元素、冰元素或雷元素附着后的10秒内，所有元素伤害加成提升$[1]，每12秒至多触发一次。'
  }
  if (weaponId === '12425' || weaponName === '浪影阔剑') {
    text = text.replace('受到治疗后，', '受到治疗时，')
  }
  if (weaponId === '12417' || weaponName === '森林王器' || weaponId === '11417' || weaponName === '原木刀') {
    text = text.replace('绽放、月绽放、超绽放', '绽放、超绽放')
  }
  if (weaponId === '13417' || weaponName === '贯月矢') {
    text = text.replace('绽放、月绽放、超绽放', '绽放、超绽放')
  }
  if (weaponId === '11304' || weaponName === '暗铁剑') {
    text = text.replace('超绽放、月感电或', '超绽放或')
  }
  if (weaponId === '14304' || weaponName === '翡玉法球') {
    text = text.replace('绽放、月感电、月绽放或', '绽放或')
  }
  if (weaponId === '12432' || weaponName === '拾慧铸熔') {
    text = text.replace('绽放、月绽放、结晶或月结晶反应时', '绽放或月绽放反应时')
  }
  if (weaponId === '11425' || weaponName === '海渊终曲') {
    text =
      '施放元素战技时，攻击力提升$[0]，持续12秒，并赋予生命值上限25%的生命之契，该效果每10秒至多触发一次。生命之契清除时，基于清除值的$[1]提升至多$[2]点攻击力，持续12秒。生命之契：基于其数值，吸收角色受到的治疗，在吸收了同等回复量数值的治疗后清除。'
  }
  if (weaponId === '14425' || weaponName === '纯水流华') {
    text =
      '施放元素战技时，所有元素伤害加成提升$[0]，持续12秒，并赋予生命值上限24%的生命之契，该效果每10秒至多触发一次。生命之契清除时，每清除1000点将会提供$[1]所有元素伤害加成，至多通过这种方式获得$[2]所有元素伤害加成，持续12秒。生命之契：基于其数值，吸收角色受到的治疗，在吸收了同等回复量数值的治疗后清除。'
  }

  return { affixTitle, text, datas }
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

function buildAffixDataFromColoredLevelDescs(levelDescs: string[]): { text: string; datas: Record<string, string[]> } {
  const base = normalizeGiDesc(levelDescs[0] ?? '')
  const baseVals = extractColoredValues(base)
  if (baseVals.length === 0) {
    return { text: base.replace(/<color=[^>]+>|<\/color>/g, ''), datas: {} }
  }

  const perLevelVals = levelDescs.map((d) => extractColoredValues(normalizeGiDesc(d ?? '')))
  const segCount = baseVals.length

  const segToPlaceholder: Array<number | null> = new Array(segCount).fill(null)
  let placeholderIdx = 0
  for (let i = 0; i < segCount; i++) {
    const set = new Set<string>()
    for (const vals of perLevelVals) set.add(vals[i] ?? '')
    if (set.size > 1) {
      segToPlaceholder[i] = placeholderIdx
      placeholderIdx++
    }
  }

  let segIdx = 0
  const templ = base.replace(/<color=[^>]+>(.*?)<\/color>/g, (_m, inner) => {
    const v = normalizeGiDesc(inner ?? '')
    const p = segToPlaceholder[segIdx] ?? null
    segIdx++
    return p == null ? v : `$[${p}]`
  })

  const text = normalizeGiDesc(templ).replace(/<color=[^>]+>|<\/color>/g, '')

  const datas: Record<string, string[]> = {}
  for (let p = 0; p < placeholderIdx; p++) datas[String(p)] = []

  for (const vals of perLevelVals) {
    for (let i = 0; i < segCount; i++) {
      const p = segToPlaceholder[i]
      if (p == null) continue
      datas[String(p)]!.push(vals[i] ?? '')
    }
  }

  // Remove empty placeholder arrays.
  for (const [k, arr] of Object.entries(datas)) {
    if (arr.every((v) => !v)) delete datas[k]
  }

  // Baseline prefers `%` in placeholder values, not in template text.
  const percentKeys = new Set<string>()
  const textNoPct = text.replace(/\$\[(\d+)\]%/g, (_m, idx) => {
    percentKeys.add(idx)
    return `$[${idx}]`
  })
  if (percentKeys.size) {
    for (const k of percentKeys) {
      const arr = datas[k]
      if (!arr) continue
      datas[k] = arr.map((v) => (!v || v.endsWith('%') ? v : `${v}%`))
    }
  }

  return { text: textNoPct, datas }
}

function extractRefinementTextAndDatas(opts: {
  weaponId: string
  weaponName: string
  refinement: Record<string, unknown> | undefined
}): {
  affixTitle: string
  text: string
  datas: Record<string, string[]>
} {
  const { weaponId, weaponName, refinement } = opts
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
  const levelDescs = levels.map((lv) => {
    const r = refinement[lv]
    return isRecord(r) && typeof r.Desc === 'string' ? (r.Desc as string) : ''
  })
  const { text, datas } = buildAffixDataFromColoredLevelDescs(levelDescs)
  return normalizeGsWeaponAffixData({ weaponId, weaponName, affixTitle, text, datas })
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
  return buildAffixDataFromColoredLevelDescs(levelDescs)
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
  /** If true, round base term first, then add promote bonus (baseline float-noise mode). */
  preRoundPromote?: boolean
}): Record<string, number> {
  const { initAtk, atkCurveType, curves, promoteAtkBonusByLevel } = opts
  const preRoundPromote = Boolean(opts.preRoundPromote)

  const baseAt = (lv: number): number | undefined => {
    const c = curveValue(curves, lv, atkCurveType)
    if (typeof c !== 'number') return undefined
    const base = initAtk * c
    return preRoundPromote ? roundTo(base, 2) : base
  }

  const atkAt = (lv: number, promoteLevel: number, requirePromote: boolean): number | undefined => {
    const base = baseAt(lv)
    if (typeof base !== 'number') return undefined
    const bonus = promoteAtkBonusByLevel.get(promoteLevel)
    if (requirePromote && typeof bonus !== 'number') return undefined
    return base + (bonus ?? 0)
  }

  const record: Record<string, number | undefined> = {
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
  }

  return preRoundPromote ? cleanFiniteNumberRecord(record) : cleanNumberRecord(record, 2)
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
    // Match baseline rounding behavior for half-cases by multiplying curve first.
    return c * multiplier * initValue
  }

  const bonusData = cleanNumberRecordFixed(
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

              const preRoundPromote = GS_WEAPON_ATK_PRE_ROUND_PROMOTE_IDS.has(task.id)
              const atkTable = preRoundPromote
                ? (() => {
                    const baseAt = (lvKey: string): number | undefined => {
                      if (lvKey === '1') return roundTo(atkBase, 2)
                      const m = atkLevels[lvKey]
                      if (typeof m !== 'number' || !Number.isFinite(m)) return undefined
                      // Baseline rounds base*mul, then adds promote bonus without re-rounding.
                      return roundTo(atkBase * m, 2)
                    }
                    const atkAt = (lvKey: string, promoteLevel?: number, requirePromote?: boolean): number | undefined => {
                      const base = baseAt(lvKey)
                      if (typeof base !== 'number') return undefined
                      if (promoteLevel == null) return base
                      const bonus = ascBonus(promoteLevel)
                      if (requirePromote && typeof bonus !== 'number') return undefined
                      return base + (bonus ?? 0)
                    }

                    const nonPlus = cleanFiniteNumberRecord({
                      '1': atkAt('1'),
                      '20': atkAt('20'),
                      '40': atkAt('40', 1),
                      '50': atkAt('50', 2),
                      '60': atkAt('60', 3),
                      '70': atkAt('70', 4),
                      '80': atkAt('80', 5),
                      '90': atkAt('90', 6)
                    })

                    // Baseline keeps float noise for non-plus keys, but keeps plus keys clean (rounded).
                    const plus = cleanNumberRecord(
                      {
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

                    return { ...nonPlus, ...plus }
                  })()
                : cleanNumberRecord(
                    {
                      '1': atkBase,
                      '20': atkBase * (atkLevels['20'] as number),
                      '40': atkBase * (atkLevels['40'] as number) + (ascBonus(1) ?? 0),
                      '50': atkBase * (atkLevels['50'] as number) + (ascBonus(2) ?? 0),
                      '60': atkBase * (atkLevels['60'] as number) + (ascBonus(3) ?? 0),
                      '70': atkBase * (atkLevels['70'] as number) + (ascBonus(4) ?? 0),
                      '80':
                        typeof atkLevels['80'] === 'number'
                          ? atkBase * (atkLevels['80'] as number) + (ascBonus(5) ?? 0)
                          : undefined,
                      '90':
                        typeof atkLevels['90'] === 'number'
                          ? atkBase * (atkLevels['90'] as number) + (ascBonus(6) ?? 0)
                          : undefined,
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
                ? cleanNumberRecordFixed(
                    {
                      '1': multiplier * secondaryBase,
                      '20': (secondaryLevels['20'] as number) * multiplier * secondaryBase,
                      '40': (secondaryLevels['40'] as number) * multiplier * secondaryBase,
                      '50': (secondaryLevels['50'] as number) * multiplier * secondaryBase,
                      '60': (secondaryLevels['60'] as number) * multiplier * secondaryBase,
                      '70': (secondaryLevels['70'] as number) * multiplier * secondaryBase,
                      '80':
                        typeof secondaryLevels['80'] === 'number'
                          ? (secondaryLevels['80'] as number) * multiplier * secondaryBase
                          : undefined,
                      '90':
                        typeof secondaryLevels['90'] === 'number'
                          ? (secondaryLevels['90'] as number) * multiplier * secondaryBase
                          : undefined,
                      '20+': (secondaryLevels['20'] as number) * multiplier * secondaryBase,
                      '40+': (secondaryLevels['40'] as number) * multiplier * secondaryBase,
                      '50+': (secondaryLevels['50'] as number) * multiplier * secondaryBase,
                      '60+': (secondaryLevels['60'] as number) * multiplier * secondaryBase,
                      '70+':
                        typeof secondaryLevels['70'] === 'number'
                          ? (secondaryLevels['70'] as number) * multiplier * secondaryBase
                          : undefined,
                      '80+':
                        typeof secondaryLevels['80'] === 'number'
                          ? (secondaryLevels['80'] as number) * multiplier * secondaryBase
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
            const weaponName = typeof detail.Name === 'string' ? detail.Name : task.name
            const { affixTitle, text, datas } = extractRefinementTextAndDatas({
              weaponId: task.id,
              weaponName,
              refinement
            })

            const weaponData: Record<string, unknown> = {
              id: gsWeaponFileId(task.id),
              name: weaponName,
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
        typeIndexByDir[task.typeDir][task.id] = gsWeaponIndexEntry(task.id, task.name, task.star)
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

              const atkTable = computeAtkTableFromAgd({
                initAtk,
                atkCurveType,
                curves: curveMap,
                promoteAtkBonusByLevel,
                preRoundPromote: GS_WEAPON_ATK_PRE_ROUND_PROMOTE_IDS.has(task.idStr)
              })

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
              let ids = costArr
                 .map((x) => (isRecord(x) ? toNumber((x as Record<string, unknown>).id) : null))
                 .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
              if (ids.length < 3) {
                const fallbackPromoteId = GS_WEAPON_PROMOTE_ID_FALLBACK[task.id]
                if (fallbackPromoteId) {
                  const fallbackStages = promoteRows
                    .filter((r) => toNumber(r.weaponPromoteId) === fallbackPromoteId)
                    .map((r) => ({ promoteLevel: toNumber(r.promoteLevel), costItems: r.costItems }))
                    .filter((s): s is { promoteLevel: number; costItems: unknown } => typeof s.promoteLevel === 'number')
                    .sort((a, b) => a.promoteLevel - b.promoteLevel)
                  const fbMax = fallbackStages.slice(-1)[0]
                  const fbCost = Array.isArray(fbMax?.costItems) ? (fbMax?.costItems as unknown[]) : []
                  const fbIds = fbCost
                    .map((x) => (isRecord(x) ? toNumber((x as Record<string, unknown>).id) : null))
                    .filter((n): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0)
                  if (fbIds.length >= 3) {
                    opts.log?.warn?.(
                      `[meta-gen] (gs) AGD weapon promote materials missing for ${task.id} ${task.name}, using fallback promoteId=${fallbackPromoteId}`
                    )
                    ids = fbIds
                  }
                }
              }
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
                  const normalized = normalizeGsWeaponAffixData({
                    weaponId: task.idStr,
                    weaponName: task.name,
                    affixTitle,
                    text,
                    datas
                  })
                  affixTitle = normalized.affixTitle
                  affixText = normalized.text
                  affixDatas = normalized.datas
                }
              }

              const weaponData: Record<string, unknown> = {
                id: gsWeaponFileId(task.idStr),
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
            typeIndexByDir[task.typeDir][task.idStr] = gsWeaponIndexEntry(task.idStr, task.name, task.star)
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
