/**
 * GS character generator (Hakush -> meta-gs/character/*).
 *
 * Behavior:
 * - Idempotent: only creates missing files/entries (unless output is wiped by `gen --force`)
 * - Generates full static meta from structured tables:
 *   - talent/talentData (from Hakush skill promote tables)
 *   - cons/passive text blocks
 * - calc.js for brand-new characters is a placeholder by default (LLM-assisted workflow is optional)
 *
 * This module still:
 * - updates `character/data.json` index
 * - writes per-character `data.json` (identity + base/grow attrs + materials + talents/cons/passives)
 * - ensures a placeholder `calc.js` exists for new characters
 * - downloads core images used by miao-plugin UI
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { logAssetError } from '../../../log/run-log.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { roundTo, sortRecordByKey } from '../utils.js'
import { buildGiAttrTable } from './attr.js'
import { buildGiTalent } from './talent.js'
import { inferGiTalentConsFromHakushDetail, inferGiTalentConsFromMetaJson } from './talent-cons.js'
import type { LlmService } from '../../../llm/service.js'
import { buildCalcJsWithLlmOrHeuristic } from '../../calc/llm-calc.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

type AssetJob = { url: string; out: string; kind: string; id: string; name: string }

const rarityMap: Record<string, number | undefined> = {
  QUALITY_ORANGE_SP: 5,
  QUALITY_ORANGE: 5,
  QUALITY_PURPLE: 4
}

const weaponMap: Record<string, string | undefined> = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_BOW: 'bow',
  WEAPON_CATALYST: 'catalyst'
}

const growKeyMap: Record<string, string | undefined> = {
  FIGHT_PROP_HP_PERCENT: 'hpPct',
  FIGHT_PROP_ATTACK_PERCENT: 'atkPct',
  FIGHT_PROP_DEFENSE_PERCENT: 'defPct',
  FIGHT_PROP_ELEMENT_MASTERY: 'mastery',
  FIGHT_PROP_CHARGE_EFFICIENCY: 'recharge',
  FIGHT_PROP_CRITICAL: 'cpct',
  FIGHT_PROP_CRITICAL_HURT: 'cdmg',
  FIGHT_PROP_HEAL_ADD: 'heal',
  FIGHT_PROP_PHYSICAL_ADD_HURT: 'phy',
  // Elemental DMG bonus (the element is inferred from character elem; meta uses key=dmg).
  FIGHT_PROP_FIRE_ADD_HURT: 'dmg',
  FIGHT_PROP_WATER_ADD_HURT: 'dmg',
  FIGHT_PROP_ICE_ADD_HURT: 'dmg',
  FIGHT_PROP_ELEC_ADD_HURT: 'dmg',
  FIGHT_PROP_WIND_ADD_HURT: 'dmg',
  FIGHT_PROP_ROCK_ADD_HURT: 'dmg',
  FIGHT_PROP_GRASS_ADD_HURT: 'dmg'
}

function normalizeTextInline(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text.replaceAll('\\n', ' ').replaceAll('\n', ' ').replace(/\s+/g, ' ').trim()
}

function giPlainDescToLines(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const text = raw
    .replaceAll('{LINK#', '')
    .replaceAll('{/LINK}', '')
    .replaceAll('\\n', '\n')
    .replaceAll('\r\n', '\n')
    .replace(/<color=[^>]+>/g, '')
    .replace(/<\/color>/g, '')
    .trim()
  return text
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean)
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

function sameTalentCons(a: unknown, b: unknown): boolean {
  if (!isRecord(a) || !isRecord(b)) return false
  return a.a === b.a && a.e === b.e && a.q === b.q
}

function toInt(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim())
  return null
}

function getCostumeInfo(charInfo: Record<string, unknown>): { ids: number[]; primaryIcon: string; primarySuffix: string } {
  const costumeArr = Array.isArray(charInfo.Costume) ? (charInfo.Costume as Array<unknown>) : []
  const alts: Array<{ id: number; icon: string }> = []
  for (const c of costumeArr) {
    if (!isRecord(c)) continue
    const id = toInt(c.Id)
    const icon = typeof c.Icon === 'string' ? (c.Icon as string).trim() : ''
    if (!id || !icon) continue
    alts.push({ id, icon })
  }
  // Baseline meta stores only non-default costumes; Hakush usually uses empty Icon for default.
  const ids = alts.map((c) => c.id)
  const primaryIcon = alts[0]?.icon || ''
  const primarySuffix = primaryIcon.startsWith('UI_AvatarIcon_')
    ? primaryIcon.replace('UI_AvatarIcon_', '')
    : primaryIcon.replace(/^UI_/, '')
  return { ids, primaryIcon, primarySuffix }
}

function getFirstPromoteIcon(skill: Record<string, unknown> | undefined): string | undefined {
  if (!skill) return undefined
  const promoteRaw = skill.Promote
  const promoteList: Array<unknown> = Array.isArray(promoteRaw)
    ? (promoteRaw as Array<unknown>)
    : isRecord(promoteRaw)
      ? Object.keys(promoteRaw)
          .map((k) => Number(k))
          .filter((n) => Number.isFinite(n))
          .sort((a, b) => a - b)
          .map((n) => (promoteRaw as Record<string, unknown>)[String(n)])
      : []
  const first = promoteList.find((p) => isRecord(p))
  return first && isRecord(first) && typeof first.Icon === 'string' ? (first.Icon as string) : undefined
}

function parseHakushVariantId(id: string): { baseId: string; variant: string } | null {
  const m = id.match(/^(\d+)-(\d+)$/)
  if (!m) return null
  return { baseId: m[1]!, variant: m[2]! }
}

function travelerTalentCons(elem: string): { a: number; e: number; q: number } {
  // miao-plugin special-cases traveler talent cons by element.
  // Keep data.json aligned with runtime behavior.
  if (['dendro', 'hydro', 'pyro'].includes(elem)) return { a: 0, e: 3, q: 5 }
  return { a: 0, e: 5, q: 3 }
}

async function generateGsTravelerAndMannequinsFromVariants(opts: {
  metaGsRootAbs: string
  /** Absolute path to metaGenerator project root (temp/metaGenerator). */
  projectRootAbs: string
  repoRootAbs: string
  hakush: HakushClient
  forceAssets: boolean
  /** Whether to refresh LLM disk cache (shared flag with upstream cache). */
  forceCache: boolean
  variantGroups: Map<string, string[]>
  index: Record<string, unknown>
  assetJobs: AssetJob[]
  assetOutDedup: Set<string>
  bannerFixDirs: string[]
  llm?: LlmService
  log?: Pick<Console, 'info' | 'warn'>
}): Promise<void> {
  const { metaGsRootAbs, projectRootAbs, repoRootAbs, hakush, variantGroups, index, assetJobs, assetOutDedup, bannerFixDirs, llm, log } = opts
  const charRoot = path.join(metaGsRootAbs, 'character')
  const llmCacheRootAbs = path.join(projectRootAbs, '.cache', 'llm')

  const travelerBaseIds = ['10000005', '10000007']
  const mannequinBaseIds = ['10000117', '10000118']

  // ---------- Traveler variants (旅行者 / 空 / 荧) ----------
  const hasTraveler = travelerBaseIds.some((id) => variantGroups.has(id))
  if (hasTraveler) {
    const outTravelerRoot = path.join(charRoot, '旅行者')
    const outAetherRoot = path.join(charRoot, '空')
    const outLumineRoot = path.join(charRoot, '荧')

    // If traveler has already been generated, avoid redoing work in incremental mode.
    const travelerAnemoPath = path.join(outTravelerRoot, 'anemo', 'data.json')
    const shouldGenerateTraveler = !index['20000000'] || !fs.existsSync(travelerAnemoPath)

    if (shouldGenerateTraveler) {
      log?.info?.('[meta-gen] (gs) generating traveler variants (旅行者/空/荧) from Hakush')

      // Prefer using male variants for shared element files (skills/stats are identical; only icons differ).
      const sharedVariantIds = (variantGroups.get('10000005') || []).length
        ? (variantGroups.get('10000005') || [])
        : Array.from(new Set([...(variantGroups.get('10000005') || []), ...(variantGroups.get('10000007') || [])]))

      const unionTalentId: Record<string, 'a' | 'e' | 'q'> = {}
      const unionTalentElem: Record<string, string> = {}

      for (const vid of sharedVariantIds) {
        const detailRaw = await hakush.getGsCharacterDetail(vid)
        if (!isRecord(detailRaw)) continue

        const elem = typeof detailRaw.Element === 'string' ? detailRaw.Element.toLowerCase() : ''
        if (!elem) continue

        const name = typeof detailRaw.Name === 'string' ? detailRaw.Name : '旅行者'
        const skillsArr = Array.isArray(detailRaw.Skills) ? (detailRaw.Skills as Array<unknown>) : []
        const s2 = isRecord(skillsArr[2]) ? (skillsArr[2] as Record<string, unknown>) : undefined
        const qIdxRaw = s2 && typeof s2.Desc === 'string' && s2.Desc.includes('替代冲刺') ? 3 : 2
        const qIdx = qIdxRaw < skillsArr.length ? qIdxRaw : 2

        const giTalent = buildGiTalent(skillsArr, qIdx)
        const aId = giTalent?.talent?.a?.id
        const eId = giTalent?.talent?.e?.id
        const qId = giTalent?.talent?.q?.id

        if (aId) unionTalentId[String(aId)] = 'a'
        if (eId) unionTalentId[String(eId)] = 'e'
        if (qId) unionTalentId[String(qId)] = 'q'
        if (eId) unionTalentElem[String(eId)] = elem
        if (qId) unionTalentElem[String(qId)] = elem

        // Skip if already generated for this element (still keep union mappings above).
        const elemDataPath = path.join(outTravelerRoot, elem, 'data.json')
        if (fs.existsSync(elemDataPath)) continue

        const elemDir = path.join(outTravelerRoot, elem)
        const imgsDir = path.join(elemDir, 'imgs')
        const iconsDir = path.join(elemDir, 'icons')
        fs.mkdirSync(imgsDir, { recursive: true })
        fs.mkdirSync(iconsDir, { recursive: true })

        const charInfo = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
        const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

        // Base/Grow attrs at Lv90 (using Hakush StatsModifier).
        const sm = isRecord(detailRaw.StatsModifier) ? (detailRaw.StatsModifier as Record<string, unknown>) : {}
        const ascArr = Array.isArray(sm.Ascension) ? (sm.Ascension as Array<unknown>) : []
        const asc5 = isRecord(ascArr[5]) ? (ascArr[5] as Record<string, unknown>) : {}
        const hpMul = isRecord(sm.HP) ? (sm.HP as Record<string, unknown>) : {}
        const atkMul = isRecord(sm.ATK) ? (sm.ATK as Record<string, unknown>) : {}
        const defMul = isRecord(sm.DEF) ? (sm.DEF as Record<string, unknown>) : {}

        const baseHP = typeof detailRaw.BaseHP === 'number' ? detailRaw.BaseHP : 0
        const baseATK = typeof detailRaw.BaseATK === 'number' ? detailRaw.BaseATK : 0
        const baseDEF = typeof detailRaw.BaseDEF === 'number' ? detailRaw.BaseDEF : 0

        const hp90 = baseHP * Number(hpMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_HP ?? 0)
        const atk90 = baseATK * Number(atkMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_ATTACK ?? 0)
        const def90 = baseDEF * Number(defMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_DEFENSE ?? 0)

        // Growth stat (one per character).
        const growCandidates = Object.entries(asc5)
          .filter(([k]) => !k.startsWith('FIGHT_PROP_BASE_'))
          .map(([k, v]) => ({ prop: k, value: typeof v === 'number' ? v : Number(v) }))
          .filter((x) => Number.isFinite(x.value) && x.value !== 0)

        const growPick = growCandidates.length
          ? growCandidates.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a))
          : undefined

        const growProp = growPick?.prop
        const growKey = growProp ? growKeyMap[growProp] : undefined
        const growRaw = growPick?.value ?? 0
        const growValue = growKey === 'mastery' ? growRaw : roundTo(growRaw >= 1 ? growRaw : growRaw * 100, 2)

        // Full milestone attr table used by miao-plugin profile/panel features.
        const ascRecords: Array<Record<string, unknown>> = []
        for (let i = 0; i < 6; i++) {
          ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
        }
        const attr = buildGiAttrTable({
          baseHP,
          baseATK,
          baseDEF,
          hpMul,
          atkMul,
          defMul,
          ascArr: ascRecords,
          growKey,
          growProp
        })

        // Materials: traveler does not use boss mats (CharMeta filters boss for traveler).
        const mats = isRecord(detailRaw.Materials) ? (detailRaw.Materials as Record<string, unknown>) : {}
        const ascensions = Array.isArray(mats.Ascensions) ? (mats.Ascensions as Array<unknown>) : []
        const ascLast = ascensions.length ? ascensions[ascensions.length - 1] : undefined
        const ascLastRec = isRecord(ascLast) ? (ascLast as Record<string, unknown>) : undefined
        const ascMatsArr = ascLastRec && Array.isArray(ascLastRec.Mats) ? (ascLastRec.Mats as Array<unknown>) : []
        const getMatName = (x: unknown): string => (isRecord(x) && typeof x.Name === 'string' ? x.Name : '')

        // Talent material: Talents[0][8].Mats[0] + weekly [2]
        let talentName = ''
        let weeklyName = ''
        const talents = Array.isArray(mats.Talents) ? (mats.Talents as Array<unknown>) : []
        const talent0 = Array.isArray(talents[0]) ? (talents[0] as Array<unknown>) : []
        const talent8 = isRecord(talent0[8]) ? (talent0[8] as Record<string, unknown>) : undefined
        const talentMatsArr = talent8 && Array.isArray(talent8.Mats) ? (talent8.Mats as Array<unknown>) : []
        talentName = getMatName(talentMatsArr[0])
        weeklyName = getMatName(talentMatsArr[2])

        const weapon = weaponMap[String(detailRaw.Weapon)] || ''
        const star = typeof detailRaw.Rarity === 'string' ? (rarityMap[detailRaw.Rarity] ?? 0) : 0
        const talentCons = travelerTalentCons(elem)

        const detailData = {
          id: 20000000,
          name,
          abbr: name,
          title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
          star,
          elem,
          allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
          weapon,
          birth: Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : '',
          astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
          desc: typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detailRaw.Desc),
          cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
          jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
          costume: false,
          ver: 1,
          baseAttr: {
            hp: roundTo(hp90, 2),
            atk: roundTo(atk90, 2),
            def: roundTo(def90, 2)
          },
          growAttr: growKey ? { key: growKey, value: growValue } : { key: '', value: 0 },
          talentId: giTalent?.talentId || {},
          talentElem:
            eId || qId
              ? ({
                  ...(eId ? { [String(eId)]: elem } : {}),
                  ...(qId ? { [String(qId)]: elem } : {})
                } as Record<string, string>)
              : {},
          talentCons,
          materials: {
            gem: getMatName(ascMatsArr[0]),
            specialty: getMatName(ascMatsArr[2]),
            normal: getMatName(ascMatsArr[3]),
            talent: talentName,
            weekly: weeklyName
          },
          ...(giTalent ? { talent: giTalent.talent, talentData: giTalent.talentData } : {}),
          attr
        }

        writeJsonFile(path.join(elemDir, 'data.json'), detailData)

        // calc.js: placeholder by default (LLM-assisted workflow is optional).
        const calcPath = path.join(elemDir, 'calc.js')
        ensurePlaceholderCalcJs(calcPath, `旅行者/${elem}`)

        if (giTalent && isPlaceholderCalc(calcPath)) {
          const aTables = Object.keys(giTalent.talentData.a || {}).filter((k) => !k.endsWith('2'))
          const eTables = Object.keys(giTalent.talentData.e || {}).filter((k) => !k.endsWith('2'))
          const qTables = Object.keys(giTalent.talentData.q || {}).filter((k) => !k.endsWith('2'))
          const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(llm, {
            game: 'gs',
            name: `旅行者/${elem}`,
            elem,
            weapon,
            star,
            tables: { a: aTables, e: eTables, q: qTables }
          }, { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache })
          if (error) {
            log?.warn?.(`[meta-gen] (gs) LLM calc plan failed (旅行者/${elem}), using heuristic: ${error}`)
          } else if (usedLlm) {
            log?.info?.(`[meta-gen] (gs) LLM calc generated: 旅行者/${elem}`)
          }
          fs.writeFileSync(calcPath, js, 'utf8')
        }

        // Download element-dependent assets (card/banner + cons/passive icons) used by UI.
        const uiBase = 'https://api.hakush.in/gi/UI/'
        const getIconName = (x: unknown): string | undefined =>
          isRecord(x) && typeof x.Icon === 'string' ? (x.Icon as string) : undefined

        const namecard = isRecord(charInfo.Namecard) ? (charInfo.Namecard as Record<string, unknown>) : {}
        if (typeof namecard.Icon === 'string' && namecard.Icon) {
          const out = path.join(imgsDir, 'card.webp')
          if (!assetOutDedup.has(out)) {
            assetOutDedup.add(out)
            assetJobs.push({ url: `${uiBase}${namecard.Icon}.webp`, out, kind: `traveler:${elem}:card`, id: '20000000', name: '旅行者' })
          }
        }
        // Always include in banner fix list: traveler variants have empty Namecard in Hakush and rely on fallback.
        bannerFixDirs.push(imgsDir)

        const passives = Array.isArray(detailRaw.Passives) ? (detailRaw.Passives as Array<unknown>) : []
        // Traveler has fewer passives; keep ordering stable (0..n) to match existing meta layout.
        for (let i = 0; i < Math.min(passives.length, 4); i++) {
          const iconName = getIconName(passives[i])
          if (!iconName) continue
          const out = path.join(iconsDir, `passive-${i}.webp`)
          if (assetOutDedup.has(out)) continue
          assetOutDedup.add(out)
          assetJobs.push({ url: `${uiBase}${iconName}.webp`, out, kind: `traveler:${elem}:passive:${i}`, id: '20000000', name: '旅行者' })
        }

        const consts = Array.isArray(detailRaw.Constellations) ? (detailRaw.Constellations as Array<unknown>) : []
        for (let i = 0; i < 6; i++) {
          const iconName = getIconName(consts[i])
          if (!iconName) continue
          const out = path.join(iconsDir, `cons-${i + 1}.webp`)
          if (assetOutDedup.has(out)) continue
          assetOutDedup.add(out)
          assetJobs.push({ url: `${uiBase}${iconName}.webp`, out, kind: `traveler:${elem}:cons:${i + 1}`, id: '20000000', name: '旅行者' })
        }
      }

      // Root meta entries (20000000 + gendered IDs). Required by miao-plugin character/index.js.
      index['20000000'] = {
        id: 20000000,
        name: '旅行者',
        abbr: '旅行者',
        star: 5,
        elem: 'multi',
        weapon: 'sword',
        talentId: unionTalentId,
        talentCons: { e: 5, q: 3 }
      }
      index['10000005'] = {
        id: 10000005,
        name: '空',
        abbr: '空',
        star: 5,
        elem: 'multi',
        weapon: 'sword',
        talentId: unionTalentId,
        talentCons: { e: 5, q: 3 }
      }
      index['10000007'] = {
        id: 10000007,
        name: '荧',
        abbr: '荧',
        star: 5,
        elem: 'multi',
        weapon: 'sword',
        talentId: unionTalentId,
        talentCons: { e: 5, q: 3 }
      }

      const writeTravelerRootData = async (baseId: string, outName: string, outDir: string): Promise<void> => {
        const variants = baseId === '20000000' ? sharedVariantIds : variantGroups.get(baseId) || []
        const sampleId = variants[0]
        if (!sampleId) return

        const detailRaw = await hakush.getGsCharacterDetail(sampleId)
        if (!isRecord(detailRaw)) return

        const charInfo = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
        const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

        // Reuse any generated element data.json (prefer anemo) for base/grow/materials when available.
        const preferElem = ['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro'].find((e) =>
          fs.existsSync(path.join(outTravelerRoot, e, 'data.json'))
        )
        let baseLike: Record<string, unknown> | null = null
        if (preferElem) {
          try {
            baseLike = JSON.parse(fs.readFileSync(path.join(outTravelerRoot, preferElem, 'data.json'), 'utf8')) as Record<string, unknown>
          } catch {
            baseLike = null
          }
        }

        const idNum = baseId === '20000000' ? 20000000 : Number(baseId)

        const data = {
          id: idNum,
          name: outName,
          abbr: outName,
          title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
          star: 5,
          elem: 'multi',
          allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
          weapon: weaponMap[String((detailRaw as Record<string, unknown>).Weapon)] || 'sword',
          birth: Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : '',
          astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
          desc: typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline((detailRaw as Record<string, unknown>).Desc),
          cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
          jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
          costume: false,
          ver: 1,
          baseAttr: isRecord(baseLike?.baseAttr) ? (baseLike!.baseAttr as Record<string, unknown>) : { hp: 0, atk: 0, def: 0 },
          growAttr: isRecord(baseLike?.growAttr) ? (baseLike!.growAttr as Record<string, unknown>) : { key: '', value: 0 },
          talentId: unionTalentId,
          talentElem: unionTalentElem,
          talentCons: { e: 5, q: 3 },
          materials: isRecord(baseLike?.materials)
            ? (baseLike!.materials as Record<string, unknown>)
            : { gem: '', specialty: '', normal: '', talent: '', weekly: '' }
        }

        fs.mkdirSync(outDir, { recursive: true })
        writeJsonFile(path.join(outDir, 'data.json'), data)

        // Base images (face/side/gacha/splash + optional face-q + card/banner) for 空/荧/旅行者.
        const imgsDir = path.join(outDir, 'imgs')
        fs.mkdirSync(imgsDir, { recursive: true })
        const icon = typeof (detailRaw as Record<string, unknown>).Icon === 'string' ? ((detailRaw as Record<string, unknown>).Icon as string) : ''
        const suffix = icon.startsWith('UI_AvatarIcon_') ? icon.replace('UI_AvatarIcon_', '') : icon.replace(/^UI_/, '')
        const uiBase = 'https://api.hakush.in/gi/UI/'

        const downloads: Array<{ url: string; out: string; kind: string }> = [
          { url: `${uiBase}UI_Gacha_AvatarImg_${suffix}.webp`, out: path.join(imgsDir, 'splash.webp'), kind: 'splash' },
          { url: `${uiBase}${icon}.webp`, out: path.join(imgsDir, 'face.webp'), kind: 'face' },
          // `face-b.png` is a png in baseline meta; use Yatta (Ambr mirror) as an independent source.
          { url: `https://gi.yatta.moe/assets/UI/${icon}.png`, out: path.join(imgsDir, 'face-b.png'), kind: 'face-b' },
          { url: `${uiBase}UI_AvatarIcon_Side_${suffix}.webp`, out: path.join(imgsDir, 'side.webp'), kind: 'side' },
          { url: `${uiBase}UI_Gacha_AvatarIcon_${suffix}.webp`, out: path.join(imgsDir, 'gacha.webp'), kind: 'gacha' },
          { url: `${uiBase}${icon}_Circle.webp`, out: path.join(imgsDir, 'face-q.webp'), kind: 'face-q' }
        ]

        const namecard = isRecord(charInfo.Namecard) ? (charInfo.Namecard as Record<string, unknown>) : {}
        if (typeof namecard.Icon === 'string' && namecard.Icon) {
          downloads.push({ url: `${uiBase}${namecard.Icon}.webp`, out: path.join(imgsDir, 'card.webp'), kind: 'card' })
        }

        for (const d of downloads) {
          if (assetOutDedup.has(d.out)) continue
          assetOutDedup.add(d.out)
          assetJobs.push({ url: d.url, out: d.out, kind: `travelerBase:${outName}:${d.kind}`, id: String(idNum), name: outName })
        }
        bannerFixDirs.push(imgsDir)
      }

      await writeTravelerRootData('20000000', '旅行者', outTravelerRoot)
      await writeTravelerRootData('10000005', '空', outAetherRoot)
      await writeTravelerRootData('10000007', '荧', outLumineRoot)

      // Traveler-specific scripts are generated independently (LLM/heuristics) when needed.
    }
  }

  // ---------- Mannequin variants (奇偶·男性/女性) ----------
  // Pick the Pyro variant (-2) to match existing meta shape (no element subfolders).
  for (const baseId of mannequinBaseIds) {
    const variants = variantGroups.get(baseId) || []
    if (variants.length === 0) continue

    if (index[baseId]) continue

    const pyroId = variants.find((v) => parseHakushVariantId(v)?.variant === '2') || variants[0]!
    const detail = await hakush.getGsCharacterDetail(pyroId)
    if (!isRecord(detail)) continue

    const name = typeof detail.Name === 'string' ? detail.Name : undefined
    if (!name) continue

    const weapon = weaponMap[String(detail.Weapon)] || ''
    const star = typeof detail.Rarity === 'string' ? (rarityMap[detail.Rarity] ?? 0) : 0
    const elem = typeof detail.Element === 'string' ? detail.Element.toLowerCase() : ''

    const skillsArr = Array.isArray(detail.Skills) ? (detail.Skills as Array<unknown>) : []
    const s2 = isRecord(skillsArr[2]) ? (skillsArr[2] as Record<string, unknown>) : undefined
    const qIdxRaw = s2 && typeof s2.Desc === 'string' && s2.Desc.includes('替代冲刺') ? 3 : 2
    const qIdx = qIdxRaw < skillsArr.length ? qIdxRaw : 2

    const giTalent = buildGiTalent(skillsArr, qIdx)

    index[baseId] = {
      id: Number(baseId),
      name,
      abbr: name.length >= 5 ? name.slice(-2) : name,
      star,
      elem,
      weapon,
      talentId: giTalent?.talentId || {},
      talentCons: { a: 0, e: 0, q: 0 }
    }

    const charDir = path.join(charRoot, name)
    const imgsDir = path.join(charDir, 'imgs')
    const iconsDir = path.join(charDir, 'icons')
    fs.mkdirSync(imgsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })

    const charInfo = isRecord(detail.CharaInfo) ? (detail.CharaInfo as Record<string, unknown>) : {}
    const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

    // Base/Grow attrs at Lv90.
    const sm = isRecord(detail.StatsModifier) ? (detail.StatsModifier as Record<string, unknown>) : {}
    const ascArr = Array.isArray(sm.Ascension) ? (sm.Ascension as Array<unknown>) : []
    const asc5 = isRecord(ascArr[5]) ? (ascArr[5] as Record<string, unknown>) : {}
    const hpMul = isRecord(sm.HP) ? (sm.HP as Record<string, unknown>) : {}
    const atkMul = isRecord(sm.ATK) ? (sm.ATK as Record<string, unknown>) : {}
    const defMul = isRecord(sm.DEF) ? (sm.DEF as Record<string, unknown>) : {}

    const baseHP = typeof detail.BaseHP === 'number' ? detail.BaseHP : 0
    const baseATK = typeof detail.BaseATK === 'number' ? detail.BaseATK : 0
    const baseDEF = typeof detail.BaseDEF === 'number' ? detail.BaseDEF : 0

    const hp90 = baseHP * Number(hpMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_HP ?? 0)
    const atk90 = baseATK * Number(atkMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_ATTACK ?? 0)
    const def90 = baseDEF * Number(defMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_DEFENSE ?? 0)

    const growCandidates = Object.entries(asc5)
      .filter(([k]) => !k.startsWith('FIGHT_PROP_BASE_'))
      .map(([k, v]) => ({ prop: k, value: typeof v === 'number' ? v : Number(v) }))
      .filter((x) => Number.isFinite(x.value) && x.value !== 0)

    const growPick = growCandidates.length
      ? growCandidates.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a))
      : undefined

    const growProp = growPick?.prop
    const growKey = growProp ? growKeyMap[growProp] : undefined
    const growRaw = growPick?.value ?? 0
    const growValue = growKey === 'mastery' ? growRaw : roundTo(growRaw >= 1 ? growRaw : growRaw * 100, 2)

    const ascRecords: Array<Record<string, unknown>> = []
    for (let i = 0; i < 6; i++) {
      ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
    }
    const attr = buildGiAttrTable({
      baseHP,
      baseATK,
      baseDEF,
      hpMul,
      atkMul,
      defMul,
      ascArr: ascRecords,
      growKey,
      growProp
    })

    const mats = isRecord(detail.Materials) ? (detail.Materials as Record<string, unknown>) : {}
    const ascensions = Array.isArray(mats.Ascensions) ? (mats.Ascensions as Array<unknown>) : []
    const ascLast = ascensions.length ? ascensions[ascensions.length - 1] : undefined
    const ascLastRec = isRecord(ascLast) ? (ascLast as Record<string, unknown>) : undefined
    const ascMatsArr = ascLastRec && Array.isArray(ascLastRec.Mats) ? (ascLastRec.Mats as Array<unknown>) : []
    const getMatName = (x: unknown): string => (isRecord(x) && typeof x.Name === 'string' ? x.Name : '')

    let talentName = ''
    let weeklyName = ''
    const talents = Array.isArray(mats.Talents) ? (mats.Talents as Array<unknown>) : []
    const talent0 = Array.isArray(talents[0]) ? (talents[0] as Array<unknown>) : []
    const talent8 = isRecord(talent0[8]) ? (talent0[8] as Record<string, unknown>) : undefined
    const talentMatsArr = talent8 && Array.isArray(talent8.Mats) ? (talent8.Mats as Array<unknown>) : []
    talentName = getMatName(talentMatsArr[0])
    weeklyName = getMatName(talentMatsArr[2])

    const detailData = {
      id: Number(baseId),
      name,
      abbr: name.length >= 5 ? name.slice(-2) : name,
      title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
      star,
      elem,
      allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
      weapon,
      birth: Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : '',
      astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
      desc: typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detail.Desc),
      cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
      jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
      costume: false,
      ver: 1,
      baseAttr: {
        hp: roundTo(hp90, 2),
        atk: roundTo(atk90, 2),
        def: roundTo(def90, 2)
      },
      growAttr: growKey ? { key: growKey, value: growValue } : { key: '', value: 0 },
      talentId: giTalent?.talentId || {},
      talentCons: { a: 0, e: 0, q: 0 },
      materials: {
        gem: getMatName(ascMatsArr[0]),
        boss: getMatName(ascMatsArr[1]),
        specialty: getMatName(ascMatsArr[2]),
        normal: getMatName(ascMatsArr[3]),
        talent: talentName,
        weekly: weeklyName
      },
      ...(giTalent ? { talent: giTalent.talent, talentData: giTalent.talentData } : {}),
      attr
    }

    writeJsonFile(path.join(charDir, 'data.json'), detailData)
    const calcPath = path.join(charDir, 'calc.js')
    ensurePlaceholderCalcJs(calcPath, name)

    if (giTalent && isPlaceholderCalc(calcPath)) {
      const aTables = Object.keys(giTalent.talentData.a || {}).filter((k) => !k.endsWith('2'))
      const eTables = Object.keys(giTalent.talentData.e || {}).filter((k) => !k.endsWith('2'))
      const qTables = Object.keys(giTalent.talentData.q || {}).filter((k) => !k.endsWith('2'))
      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(llm, {
        game: 'gs',
        name,
        elem,
        weapon,
        star,
        tables: { a: aTables, e: eTables, q: qTables }
      }, { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache })
      if (error) {
        log?.warn?.(`[meta-gen] (gs) LLM calc plan failed (${name}), using heuristic: ${error}`)
      } else if (usedLlm) {
        log?.info?.(`[meta-gen] (gs) LLM calc generated: ${name}`)
      }
      fs.writeFileSync(calcPath, js, 'utf8')
    }

    // Download core images (best-effort).
    const icon = typeof detail.Icon === 'string' ? detail.Icon : ''
    const suffix = icon.startsWith('UI_AvatarIcon_') ? icon.replace('UI_AvatarIcon_', '') : icon.replace(/^UI_/, '')
    const uiBase = 'https://api.hakush.in/gi/UI/'

    const downloads: Array<{ url: string; out: string }> = [
      { url: `${uiBase}UI_Gacha_AvatarImg_${suffix}.webp`, out: path.join(imgsDir, 'splash.webp') },
      { url: `${uiBase}${icon}.webp`, out: path.join(imgsDir, 'face.webp') },
      // `face-b.png` is a png in baseline meta; use Yatta (Ambr mirror) as an independent source.
      { url: `https://gi.yatta.moe/assets/UI/${icon}.png`, out: path.join(imgsDir, 'face-b.png') },
      { url: `${uiBase}UI_AvatarIcon_Side_${suffix}.webp`, out: path.join(imgsDir, 'side.webp') },
      { url: `${uiBase}UI_Gacha_AvatarIcon_${suffix}.webp`, out: path.join(imgsDir, 'gacha.webp') },
      { url: `${uiBase}${icon}_Circle.webp`, out: path.join(imgsDir, 'face-q.webp') }
    ]

    const namecard = isRecord(charInfo.Namecard) ? (charInfo.Namecard as Record<string, unknown>) : {}
    if (typeof namecard.Icon === 'string' && namecard.Icon) {
      downloads.push({ url: `${uiBase}${namecard.Icon}.webp`, out: path.join(imgsDir, 'card.webp') })
    }

    for (const d of downloads) {
      if (assetOutDedup.has(d.out)) continue
      assetOutDedup.add(d.out)
      assetJobs.push({ url: d.url, out: d.out, kind: `mannequin:${baseId}:img`, id: baseId, name })
    }
    bannerFixDirs.push(imgsDir)

    // Icons: passives + skill icons (e/q[/t]) used by UI.
    const getIconName = (x: unknown): string | undefined =>
      isRecord(x) && typeof x.Icon === 'string' ? (x.Icon as string) : undefined

    const passives = Array.isArray(detail.Passives) ? (detail.Passives as Array<unknown>) : []
    // Keep passive ordering stable (0..n) for special mannequin characters.
    for (let i = 0; i < Math.min(passives.length, 4); i++) {
      const iconName = getIconName(passives[i])
      if (!iconName) continue
      const out = path.join(iconsDir, `passive-${i}.webp`)
      if (assetOutDedup.has(out)) continue
      assetOutDedup.add(out)
      assetJobs.push({ url: `${uiBase}${iconName}.webp`, out, kind: `mannequin:${baseId}:passive:${i}`, id: baseId, name })
    }

    const skills = Array.isArray(detail.Skills) ? (detail.Skills as Array<unknown>) : []
    const skill1 = isRecord(skills[1]) ? (skills[1] as Record<string, unknown>) : undefined
    const skill2 = isRecord(skills[2]) ? (skills[2] as Record<string, unknown>) : undefined
    const skill3 = isRecord(skills[3]) ? (skills[3] as Record<string, unknown>) : undefined
    const qKey = skill2 && typeof skill2.Desc === 'string' && skill2.Desc.includes('替代冲刺') ? 3 : 2
    const qSkill = qKey === 3 ? skill3 : skill2

    const eIcon = getFirstPromoteIcon(skill1)
    if (eIcon) {
      const out = path.join(iconsDir, 'talent-e.webp')
      if (!assetOutDedup.has(out)) {
        assetOutDedup.add(out)
        assetJobs.push({ url: `${uiBase}${eIcon}.webp`, out, kind: `mannequin:${baseId}:talent-e`, id: baseId, name })
      }
    }
    const qIcon = getFirstPromoteIcon(qSkill)
    if (qIcon) {
      const out = path.join(iconsDir, 'talent-q.webp')
      if (!assetOutDedup.has(out)) {
        assetOutDedup.add(out)
        assetJobs.push({ url: `${uiBase}${qIcon}.webp`, out, kind: `mannequin:${baseId}:talent-q`, id: baseId, name })
      }
    }
  }
}

export interface GenerateGsCharacterOptions {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
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

export async function generateGsCharacters(opts: GenerateGsCharacterOptions): Promise<void> {
  const charRoot = path.join(opts.metaGsRootAbs, 'character')
  const indexPath = path.join(charRoot, 'data.json')
  const llmCacheRootAbs = path.join(opts.projectRootAbs, '.cache', 'llm')

  const indexRaw = fs.existsSync(indexPath) ? JSON.parse(fs.readFileSync(indexPath, 'utf8')) : {}
  const index: Record<string, unknown> = isRecord(indexRaw) ? (indexRaw as Record<string, unknown>) : {}

  const list = await opts.hakush.getGsCharacterList()

  // Hakush includes special multi-element variants using ids like "10000005-6" (traveler, mannequins).
  // We keep the main loop focused on normal characters and generate these special cases separately.
  const variantGroups = new Map<string, string[]>()
  for (const id of Object.keys(list)) {
    const v = parseHakushVariantId(id)
    if (!v) continue
    if (!variantGroups.has(v.baseId)) variantGroups.set(v.baseId, [])
    variantGroups.get(v.baseId)!.push(id)
  }
  for (const arr of variantGroups.values()) {
    arr.sort((a, b) => a.localeCompare(b))
  }

  let added = 0
  const assetJobs: AssetJob[] = []
  const assetOutDedup = new Set<string>()
  const bannerFixDirs: string[] = []

  const tryReadJson = (filePath: string): unknown | null => {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'))
    } catch {
      return null
    }
  }

  for (const [id, entry] of Object.entries(list)) {
    if (!isRecord(entry)) continue
    if (!/^\d+$/.test(id)) continue

    // Hakush character list includes unreleased placeholders (release=1970-01-01).
    const release = typeof entry.release === 'string' ? entry.release : ''
    if (!release || release.startsWith('1970-01-01')) {
      continue
    }

    const existing = index[id]
    const existingRec = isRecord(existing) ? (existing as Record<string, unknown>) : undefined
    const existingName = existingRec && typeof existingRec.name === 'string' ? (existingRec.name as string) : undefined

    // Incremental mode: keep existing outputs by default.
    // However, older/bad outputs may lack materials/growAttr due to parsing differences.
    // Detect the common "empty materials/growAttr" case and regenerate those entries.
    let needGenerate = !existingRec
    if (!needGenerate && !existingName) {
      needGenerate = true
    }
    if (!needGenerate && existingName) {
      const charDir = path.join(charRoot, existingName)
      const dataPath = path.join(charDir, 'data.json')
      if (!fs.existsSync(dataPath)) {
        needGenerate = true
      } else {
        const ds = tryReadJson(dataPath)
        const growAttr = isRecord(ds) ? (ds as Record<string, unknown>).growAttr : undefined
        const materials = isRecord(ds) ? (ds as Record<string, unknown>).materials : undefined
        const attr = isRecord(ds) ? (ds as Record<string, unknown>).attr : undefined
        const hasGrowKey = isRecord(growAttr) && typeof growAttr.key === 'string' && Boolean(growAttr.key)
        const hasGem = isRecord(materials) && typeof materials.gem === 'string' && Boolean(materials.gem)
        const hasAttr = isRecord(attr) && Array.isArray((attr as Record<string, unknown>).keys) && isRecord((attr as Record<string, unknown>).details)

        if (!hasGrowKey || !hasGem || !hasAttr) {
          needGenerate = true
        } else {
          // Even when skipping regeneration, keep per-character scripts usable.
          ensurePlaceholderCalcJs(path.join(charDir, 'calc.js'), existingName)

          // Repair previously generated wrong `talentCons` (older generator versions defaulted it).
          // This does not require refetching Hakush: we infer from the already-generated talent/cons blocks.
          if (isRecord(ds)) {
            const inferred = inferGiTalentConsFromMetaJson(ds)
            const dsRec = ds as Record<string, unknown>
            let detailForRepair: Record<string, unknown> | null = null
            const loadDetailForRepair = async (): Promise<Record<string, unknown> | null> => {
              if (detailForRepair) return detailForRepair
              try {
                const raw = await opts.hakush.getGsCharacterDetail(id)
                if (isRecord(raw)) {
                  detailForRepair = raw as Record<string, unknown>
                  return detailForRepair
                }
              } catch {}
              return null
            }
            if (inferred && !sameTalentCons(dsRec.talentCons, inferred)) {
              dsRec.talentCons = inferred
              writeJsonFile(dataPath, dsRec)
              if (existingRec) existingRec.talentCons = inferred
            }

            // Fill missing costume ids for older outputs (costume=false) when Hakush provides them.
            const costumeRaw = dsRec.costume
            const hasCostume = Array.isArray(costumeRaw) ? costumeRaw.length > 0 : false
            if (!hasCostume && costumeRaw !== false) {
              // Some historical outputs used `null`/missing; normalize to false unless we detect costumes.
              dsRec.costume = false
              writeJsonFile(dataPath, dsRec)
            }
            const shouldCheckCostume = !hasCostume && dsRec.costume === false
            if (shouldCheckCostume) {
              try {
                const detailRaw = await loadDetailForRepair()
                if (detailRaw) {
                  const ci = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
                  const info = getCostumeInfo(ci)
                  const costume = info.ids.length ? info.ids : false
                  if (costume !== false) {
                    dsRec.costume = costume
                    writeJsonFile(dataPath, dsRec)

                    // Best-effort download of alternate costume images.
                    const uiBase = 'https://api.hakush.in/gi/UI/'
                    const imgsDir = path.join(charDir, 'imgs')
                    fs.mkdirSync(imgsDir, { recursive: true })
                    const pushAsset = (url: string, outName: string, kind: string): void => {
                      const out = path.join(imgsDir, outName)
                      if (!opts.forceAssets && fs.existsSync(out)) return
                      if (assetOutDedup.has(out)) return
                      assetOutDedup.add(out)
                      assetJobs.push({ url, out, kind: `costume:${kind}`, id, name: existingName })
                    }
                    if (info.primaryIcon && info.primarySuffix) {
                      pushAsset(`${uiBase}${info.primaryIcon}.webp`, 'face2.webp', 'face2')
                      pushAsset(`${uiBase}UI_AvatarIcon_Side_${info.primarySuffix}.webp`, 'side2.webp', 'side2')
                      pushAsset(`${uiBase}UI_Gacha_AvatarImg_${info.primarySuffix}.webp`, 'splash2.webp', 'splash2')
                    }
                  }
                }
              } catch (e) {
                opts.log?.warn?.(`[meta-gen] (gs) costume repair failed: ${existingName} -> ${String(e)}`)
              }
            }

            // Repair missing skill icons when `talentCons` indicates UI should fall back to skill icon files.
            const tc = isRecord(dsRec.talentCons) ? (dsRec.talentCons as Record<string, unknown>) : {}
            const eCons = toInt(tc.e) ?? 0
            const qCons = toInt(tc.q) ?? 0
            const iconsDir = path.join(charDir, 'icons')
            const needEIcon = eCons === 0 && (opts.forceAssets || !fs.existsSync(path.join(iconsDir, 'talent-e.webp')))
            const needQIcon = qCons === 0 && (opts.forceAssets || !fs.existsSync(path.join(iconsDir, 'talent-q.webp')))
            if (needEIcon || needQIcon) {
              try {
                const detailRaw = await loadDetailForRepair()
                if (detailRaw) {
                  fs.mkdirSync(iconsDir, { recursive: true })
                  const uiBase = 'https://api.hakush.in/gi/UI/'
                  const pushIcon = (url: string, outName: string, kind: string): void => {
                    const out = path.join(iconsDir, outName)
                    if (!opts.forceAssets && fs.existsSync(out)) return
                    if (assetOutDedup.has(out)) return
                    assetOutDedup.add(out)
                    assetJobs.push({ url, out, kind: `talent:${kind}`, id, name: existingName })
                  }

                  const skills = Array.isArray(detailRaw.Skills) ? (detailRaw.Skills as Array<unknown>) : []
                  const skill1 = isRecord(skills[1]) ? (skills[1] as Record<string, unknown>) : undefined
                  const skill2 = isRecord(skills[2]) ? (skills[2] as Record<string, unknown>) : undefined
                  const skill3 = isRecord(skills[3]) ? (skills[3] as Record<string, unknown>) : undefined
                  const qKey = skill2 && typeof skill2.Desc === 'string' && skill2.Desc.includes('替代冲刺') ? 3 : 2
                  const qSkill = qKey === 3 ? skill3 : skill2

                  if (needEIcon) {
                    const eIcon = getFirstPromoteIcon(skill1)
                    if (eIcon) pushIcon(`${uiBase}${eIcon}.webp`, 'talent-e.webp', 'e')
                  }
                  if (needQIcon) {
                    const qIcon = getFirstPromoteIcon(qSkill)
                    if (qIcon) pushIcon(`${uiBase}${qIcon}.webp`, 'talent-q.webp', 'q')
                  }
                  // When Q is shifted (extra sprint skill), also keep the intermediate icon for completeness.
                  if (qKey === 3) {
                    const tIcon = getFirstPromoteIcon(skill2)
                    if (tIcon) pushIcon(`${uiBase}${tIcon}.webp`, 'talent-t.webp', 't')
                  }
                }
              } catch (e) {
                opts.log?.warn?.(`[meta-gen] (gs) talent icon repair failed: ${existingName} -> ${String(e)}`)
              }
            }
          }
        }
      }
    }

    // Even if we skip regeneration, still ensure optional baseline-compat assets exist.
    // (We avoid rewriting data.json unless needed.)
    if (!needGenerate && existingName) {
      const charDir = path.join(charRoot, existingName)
      const imgsDir = path.join(charDir, 'imgs')
      fs.mkdirSync(imgsDir, { recursive: true })
      bannerFixDirs.push(imgsDir)

      const iconFromList = typeof entry.icon === 'string' ? entry.icon : ''
      if (iconFromList) {
        const out = path.join(imgsDir, 'face-b.png')
        if (opts.forceAssets || !fs.existsSync(out)) {
          const url = `https://gi.yatta.moe/assets/UI/${iconFromList}.png`
          if (!assetOutDedup.has(out)) {
            assetOutDedup.add(out)
            assetJobs.push({ url, out, kind: 'img:face-b', id, name: existingName })
          }
        }
      }
    }

    if (!needGenerate) continue

    const detail = await opts.hakush.getGsCharacterDetail(id)
    if (!isRecord(detail)) {
      opts.log?.warn?.(`[meta-gen] (gs) character detail not an object: ${id}`)
      continue
    }

    const name = typeof detail.Name === 'string' ? detail.Name : undefined
    if (!name) continue

    added++
    opts.log?.info?.(`[meta-gen] (gs) character added: ${id} ${name}`)
    if (added % 10 === 0) {
      opts.log?.info?.(`[meta-gen] (gs) character progress: added=${added} (last=${id} ${name})`)
    }

    const weapon = weaponMap[String(detail.Weapon)] || ''
    const star = typeof detail.Rarity === 'string' ? (rarityMap[detail.Rarity] ?? 0) : 0
    const elem = typeof detail.Element === 'string' ? detail.Element.toLowerCase() : ''

    // Determine skill ordering (some characters have an extra sprint skill before Q).
    const skillsArr = Array.isArray(detail.Skills) ? (detail.Skills as Array<unknown>) : []
    const s2 = isRecord(skillsArr[2]) ? (skillsArr[2] as Record<string, unknown>) : undefined
    const qIdxRaw = s2 && typeof s2.Desc === 'string' && s2.Desc.includes('替代冲刺') ? 3 : 2
    const qIdx = qIdxRaw < skillsArr.length ? qIdxRaw : 2

    // Constellation talent boosts (C3/C5 may boost A/E/Q depending on character).
    const talentCons = inferGiTalentConsFromHakushDetail(detail, qIdx)

    // Generate full talent tables + talentData for new characters (static meta is fully automatable).
    const giTalent = buildGiTalent(skillsArr, qIdx)

    // Index entry.
    index[id] = {
      id: Number(id),
      name,
      abbr: name.length >= 5 ? name.slice(-2) : name,
      star,
      elem,
      weapon,
      talentId: giTalent?.talentId || {},
      talentCons
    }

    // Per-character detail file.
    const charDir = path.join(charRoot, name)
    const imgsDir = path.join(charDir, 'imgs')
    const iconsDir = path.join(charDir, 'icons')
    fs.mkdirSync(imgsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })

    const charInfo = isRecord(detail.CharaInfo) ? (detail.CharaInfo as Record<string, unknown>) : {}
    const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

    // Base/Grow attrs at Lv90 (using Hakush StatsModifier).
    const sm = isRecord(detail.StatsModifier) ? (detail.StatsModifier as Record<string, unknown>) : {}
    const ascArr = Array.isArray(sm.Ascension) ? (sm.Ascension as Array<unknown>) : []
    const asc5 = isRecord(ascArr[5]) ? (ascArr[5] as Record<string, unknown>) : {}
    const hpMul = isRecord(sm.HP) ? (sm.HP as Record<string, unknown>) : {}
    const atkMul = isRecord(sm.ATK) ? (sm.ATK as Record<string, unknown>) : {}
    const defMul = isRecord(sm.DEF) ? (sm.DEF as Record<string, unknown>) : {}

    const baseHP = typeof detail.BaseHP === 'number' ? detail.BaseHP : 0
    const baseATK = typeof detail.BaseATK === 'number' ? detail.BaseATK : 0
    const baseDEF = typeof detail.BaseDEF === 'number' ? detail.BaseDEF : 0

    const hp90 = baseHP * Number(hpMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_HP ?? 0)
    const atk90 = baseATK * Number(atkMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_ATTACK ?? 0)
    const def90 = baseDEF * Number(defMul['100'] ?? 0) + Number(asc5.FIGHT_PROP_BASE_DEFENSE ?? 0)

    // Growth stat (one per character).
    // Hakush encodes the ascension bonus as a single non-base prop inside StatsModifier.Ascension[5].
    // Most props are stored as a ratio (0.192 => 19.2%), except Elemental Mastery which is a flat number.
    const growCandidates = Object.entries(asc5)
      .filter(([k]) => !k.startsWith('FIGHT_PROP_BASE_'))
      .map(([k, v]) => ({ prop: k, value: typeof v === 'number' ? v : Number(v) }))
      .filter((x) => Number.isFinite(x.value) && x.value !== 0)

    const growPick = growCandidates.length
      ? growCandidates.reduce((a, b) => (Math.abs(b.value) > Math.abs(a.value) ? b : a))
      : undefined

    const growProp = growPick?.prop
    const growKey = growProp ? growKeyMap[growProp] : undefined
    const growRaw = growPick?.value ?? 0

    const growValue =
      growKey === 'mastery' ? growRaw : roundTo(growRaw >= 1 ? growRaw : growRaw * 100, 2)

    // Full milestone attr table used by miao-plugin profile/panel features.
    const ascRecords: Array<Record<string, unknown>> = []
    for (let i = 0; i < 6; i++) {
      ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
    }
    const attr = buildGiAttrTable({
      baseHP,
      baseATK,
      baseDEF,
      hpMul,
      atkMul,
      defMul,
      ascArr: ascRecords,
      growKey,
      growProp
    })

    // Materials (best-effort): use the highest ascension stage and a representative talent stage.
    const mats = isRecord(detail.Materials) ? (detail.Materials as Record<string, unknown>) : {}

    // Hakush GI character detail uses: Materials.Ascensions: Array<{ Mats: [...] }>
    // (NOT a map keyed by ascension stage).
    const ascensions = Array.isArray(mats.Ascensions) ? (mats.Ascensions as Array<unknown>) : []
    const ascLast = ascensions.length ? ascensions[ascensions.length - 1] : undefined
    const ascLastRec = isRecord(ascLast) ? (ascLast as Record<string, unknown>) : undefined
    const ascMatsArr = ascLastRec && Array.isArray(ascLastRec.Mats) ? (ascLastRec.Mats as Array<unknown>) : []
    const getMatName = (x: unknown): string => (isRecord(x) && typeof x.Name === 'string' ? x.Name : '')

    // Talent material: Talents[0][8].Mats[0] + weekly [2]
    let talentName = ''
    let weeklyName = ''
    const talents = Array.isArray(mats.Talents) ? (mats.Talents as Array<unknown>) : []
    const talent0 = Array.isArray(talents[0]) ? (talents[0] as Array<unknown>) : []
    const talent8 = isRecord(talent0[8]) ? (talent0[8] as Record<string, unknown>) : undefined
    const talentMatsArr = talent8 && Array.isArray(talent8.Mats) ? (talent8.Mats as Array<unknown>) : []
    talentName = getMatName(talentMatsArr[0])
    weeklyName = getMatName(talentMatsArr[2])

    // Constellations (命座).
    const consData: Record<string, unknown> = {}
    const consArr = Array.isArray(detail.Constellations) ? (detail.Constellations as Array<unknown>) : []
    for (let i = 0; i < 6; i++) {
      const c = isRecord(consArr[i]) ? (consArr[i] as Record<string, unknown>) : undefined
      if (!c) continue
      const cName = c && typeof c.Name === 'string' ? c.Name : ''
      if (!cName) continue
      consData[String(i + 1)] = { name: cName, desc: giPlainDescToLines(c.Desc) }
    }

    // Passive talents. Hakush order is usually [A4, A1, exploration].
    const passiveArr = Array.isArray(detail.Passives) ? (detail.Passives as Array<unknown>) : []
    const passiveData = passiveArr
      .map((p) => (isRecord(p) ? (p as Record<string, unknown>) : null))
      .filter(Boolean)
      .map((p) => {
        const pName = typeof p!.Name === 'string' ? (p!.Name as string) : ''
        return pName ? { name: pName, desc: giPlainDescToLines(p!.Desc) } : null
      })
      .filter(Boolean) as Array<{ name: string; desc: string[] }>

    // Put exploration passive first when detectable.
    const exploreIdx = passiveData.findIndex((p) => p.desc.some((line) => line.includes('探索派遣')))
    if (exploreIdx > 0) {
      const [explore] = passiveData.splice(exploreIdx, 1)
      passiveData.unshift(explore)
    }

    const costumeInfo = getCostumeInfo(charInfo)
    const costume = costumeInfo.ids.length ? costumeInfo.ids : false

    const detailData = {
      id: Number(id),
      name,
      abbr: name.length >= 5 ? name.slice(-2) : name,
      title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
      star,
      elem,
      allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
      weapon,
      birth: Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : '',
      astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
      desc: typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detail.Desc),
      cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
      jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
      costume,
      ver: 1,
      baseAttr: {
        hp: roundTo(hp90, 2),
        atk: roundTo(atk90, 2),
        def: roundTo(def90, 2)
      },
      growAttr: growKey ? { key: growKey, value: growValue } : { key: '', value: 0 },
      talentId: giTalent?.talentId || {},
      talentCons,
      materials: {
        gem: getMatName(ascMatsArr[0]),
        boss: getMatName(ascMatsArr[1]),
        specialty: getMatName(ascMatsArr[2]),
        normal: getMatName(ascMatsArr[3]),
        talent: talentName,
        weekly: weeklyName
      },
      ...(giTalent ? { talent: giTalent.talent, talentData: giTalent.talentData } : {}),
      cons: consData,
      passive: passiveData,
      attr
    }

    writeJsonFile(path.join(charDir, 'data.json'), detailData)
    const calcPath = path.join(charDir, 'calc.js')
    ensurePlaceholderCalcJs(calcPath, name)

    // If we still have a placeholder calc.js, try to generate a minimal usable one.
    // - When LLM is configured, it will try LLM first then fall back to heuristic.
    // - When LLM is disabled/unavailable, we still fall back to heuristic for better usability.
    if (giTalent && isPlaceholderCalc(calcPath)) {
      const aTables = Object.keys(giTalent.talentData.a || {}).filter((k) => !k.endsWith('2'))
      const eTables = Object.keys(giTalent.talentData.e || {}).filter((k) => !k.endsWith('2'))
      const qTables = Object.keys(giTalent.talentData.q || {}).filter((k) => !k.endsWith('2'))

      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(opts.llm, {
        game: 'gs',
        name,
        elem,
        weapon,
        star,
        tables: { a: aTables, e: eTables, q: qTables }
      }, { cacheRootAbs: llmCacheRootAbs, force: opts.forceCache })

      if (error) {
        opts.log?.warn?.(`[meta-gen] (gs) LLM calc plan failed (${name}), using heuristic: ${error}`)
      } else if (usedLlm) {
        opts.log?.info?.(`[meta-gen] (gs) LLM calc generated: ${name}`)
      }

      fs.writeFileSync(calcPath, js, 'utf8')
    }

    // Download core images used by miao-plugin.
    const icon = typeof detail.Icon === 'string' ? detail.Icon : ''
    const suffix = icon.startsWith('UI_AvatarIcon_') ? icon.replace('UI_AvatarIcon_', '') : icon.replace(/^UI_/, '')
    const uiBase = 'https://api.hakush.in/gi/UI/'

    const dlJobs: Array<{ url: string; out: string; kind: string }> = []

    const downloads: Array<{ url: string; out: string }> = [
      { url: `${uiBase}UI_Gacha_AvatarImg_${suffix}.webp`, out: path.join(imgsDir, 'splash.webp') },
      { url: `${uiBase}${icon}.webp`, out: path.join(imgsDir, 'face.webp') },
      // `face-b.png` is a png in baseline meta; use Yatta (Ambr mirror) as an independent source.
      { url: `https://gi.yatta.moe/assets/UI/${icon}.png`, out: path.join(imgsDir, 'face-b.png') },
      { url: `${uiBase}UI_AvatarIcon_Side_${suffix}.webp`, out: path.join(imgsDir, 'side.webp') },
      { url: `${uiBase}UI_Gacha_AvatarIcon_${suffix}.webp`, out: path.join(imgsDir, 'gacha.webp') },
      { url: `${uiBase}${icon}_Circle.webp`, out: path.join(imgsDir, 'face-q.webp') }
    ]

    const namecard = isRecord(charInfo.Namecard) ? (charInfo.Namecard as Record<string, unknown>) : {}
    if (typeof namecard.Icon === 'string' && namecard.Icon) {
      downloads.push({ url: `${uiBase}${namecard.Icon}.webp`, out: path.join(imgsDir, 'card.webp') })
    }

    // Alternate costume images (miao-plugin uses face2/side2/splash2 when costume is selected).
    if (costumeInfo.primaryIcon && costumeInfo.primarySuffix) {
      downloads.push({ url: `${uiBase}${costumeInfo.primaryIcon}.webp`, out: path.join(imgsDir, 'face2.webp') })
      downloads.push({
        url: `${uiBase}UI_AvatarIcon_Side_${costumeInfo.primarySuffix}.webp`,
        out: path.join(imgsDir, 'side2.webp')
      })
      downloads.push({
        url: `${uiBase}UI_Gacha_AvatarImg_${costumeInfo.primarySuffix}.webp`,
        out: path.join(imgsDir, 'splash2.webp')
      })
    }

    for (const d of downloads) {
      dlJobs.push({ url: d.url, out: d.out, kind: 'img' })
    }

    // Icons: constellation + passives + skill icons (e/q[/t]).
    const passives = Array.isArray(detail.Passives) ? (detail.Passives as Array<unknown>) : []
    const getIconName = (x: unknown): string | undefined => (isRecord(x) && typeof x.Icon === 'string' ? x.Icon : undefined)

    const passiveMap: Array<{ idx: number; out: string }> = [
      { idx: 2, out: path.join(iconsDir, 'passive-0.webp') },
      { idx: 0, out: path.join(iconsDir, 'passive-1.webp') },
      { idx: 1, out: path.join(iconsDir, 'passive-2.webp') },
      { idx: 3, out: path.join(iconsDir, 'passive-3.webp') }
    ]
    for (const p of passiveMap) {
      const iconName = getIconName(passives[p.idx])
      if (!iconName) continue
      dlJobs.push({ url: `${uiBase}${iconName}.webp`, out: p.out, kind: `passive:${p.idx}` })
    }

    const consts = Array.isArray(detail.Constellations) ? (detail.Constellations as Array<unknown>) : []
    for (let i = 0; i < 6; i++) {
      const iconName = getIconName(consts[i])
      if (!iconName) continue
      const out = path.join(iconsDir, `cons-${i + 1}.webp`)
      dlJobs.push({ url: `${uiBase}${iconName}.webp`, out, kind: `cons:${i + 1}` })
    }

    const skills = Array.isArray(detail.Skills) ? (detail.Skills as Array<unknown>) : []
    const skill1 = isRecord(skills[1]) ? (skills[1] as Record<string, unknown>) : undefined
    const skill2 = isRecord(skills[2]) ? (skills[2] as Record<string, unknown>) : undefined
    const skill3 = isRecord(skills[3]) ? (skills[3] as Record<string, unknown>) : undefined
    const qKey = skill2 && typeof skill2.Desc === 'string' && skill2.Desc.includes('替代冲刺') ? 3 : 2
    const qSkill = qKey === 3 ? skill3 : skill2

    const eIcon = getFirstPromoteIcon(skill1)
    if (eIcon) dlJobs.push({ url: `${uiBase}${eIcon}.webp`, out: path.join(iconsDir, 'talent-e.webp'), kind: 'talent-e' })
    const qIcon = getFirstPromoteIcon(qSkill)
    if (qIcon) dlJobs.push({ url: `${uiBase}${qIcon}.webp`, out: path.join(iconsDir, 'talent-q.webp'), kind: 'talent-q' })
    if (qKey === 3) {
      const tIcon = getFirstPromoteIcon(skill2)
      if (tIcon) {
        dlJobs.push({ url: `${uiBase}${tIcon}.webp`, out: path.join(iconsDir, 'talent-t.webp'), kind: 'talent-t' })
        // Alternate sprint icon:
        // - Some characters already have a 4th passive (e.g. 莫娜). Baseline stores sprint as passive-4.webp.
        // - Most characters store it as passive-3.webp (e.g. 神里绫华).
        const sprintPassiveOut = passives.length >= 4 ? 'passive-4.webp' : 'passive-3.webp'
        dlJobs.push({ url: `${uiBase}${tIcon}.webp`, out: path.join(iconsDir, sprintPassiveOut), kind: 'passive:sprint' })
      }
    }

    for (const job of dlJobs) {
      if (assetOutDedup.has(job.out)) continue
      assetOutDedup.add(job.out)
      assetJobs.push({ ...job, id, name })
    }

    bannerFixDirs.push(imgsDir)
  }

  await generateGsTravelerAndMannequinsFromVariants({
    metaGsRootAbs: opts.metaGsRootAbs,
    projectRootAbs: opts.projectRootAbs,
    repoRootAbs: opts.repoRootAbs,
    hakush: opts.hakush,
    forceAssets: opts.forceAssets,
    forceCache: opts.forceCache,
    variantGroups,
    index,
    assetJobs,
    assetOutDedup,
    bannerFixDirs,
    llm: opts.llm,
    log: opts.log
  })
  writeJsonFile(indexPath, sortRecordByKey(index))

  const ASSET_CONCURRENCY = 12
  let assetDone = 0
  await runPromisePool(assetJobs, ASSET_CONCURRENCY, async (job) => {
    const res = await downloadToFileOptional(job.url, job.out, { force: opts.forceAssets })
    if (!res.ok) {
      opts.log?.warn?.(`[meta-gen] (gs) char asset failed: ${job.id} ${job.name} ${job.kind} -> ${res.error}`)
    }
    if (!fs.existsSync(job.out)) {
      // Requirement: do NOT create placeholder images. Log and continue.
      logAssetError({
        game: 'gs',
        type: `character-asset:${job.kind}`,
        id: job.id,
        name: job.name,
        url: job.url,
        out: job.out,
        error: res.ok ? 'download did not produce file' : res.error
      })
    }
    assetDone++
    if (assetDone > 0 && assetDone % 500 === 0) {
      opts.log?.info?.(`[meta-gen] (gs) char asset progress: ${assetDone}/${assetJobs.length}`)
    }
  })

  // Extra fallbacks (when upstream/baseline are incomplete):
  // - Ensure traveler root/element has card/banner, and gacha when missing (Hakush may 404 on traveler gacha icon).
  {
    const travelerRoot = path.join(opts.metaGsRootAbs, 'character', '旅行者')
    const travelerRootImgs = path.join(travelerRoot, 'imgs')
    const travelerCard = path.join(travelerRootImgs, 'card.webp')
    const travelerBanner = path.join(travelerRootImgs, 'banner.webp')
    const travelerSplash = path.join(travelerRootImgs, 'splash.webp')
    const travelerGacha = path.join(travelerRootImgs, 'gacha.webp')
    const travelerFace = path.join(travelerRootImgs, 'face.webp')

    const aetherRootImgs = path.join(opts.metaGsRootAbs, 'character', '空', 'imgs')
    const lumineRootImgs = path.join(opts.metaGsRootAbs, 'character', '荧', 'imgs')

    if (!fs.existsSync(travelerCard) && fs.existsSync(travelerSplash)) {
      fs.copyFileSync(travelerSplash, travelerCard)
    }
    if (!fs.existsSync(travelerBanner) && fs.existsSync(travelerCard)) {
      fs.copyFileSync(travelerCard, travelerBanner)
    }
    if (!fs.existsSync(travelerGacha) && fs.existsSync(travelerFace)) {
      fs.copyFileSync(travelerFace, travelerGacha)
    }

    // 空/荧 may miss NameCard icon in upstream; fall back to traveler root card/banner.
    for (const rootImgs of [aetherRootImgs, lumineRootImgs]) {
      if (!fs.existsSync(rootImgs)) continue
      const card = path.join(rootImgs, 'card.webp')
      const banner = path.join(rootImgs, 'banner.webp')
      const splash = path.join(rootImgs, 'splash.webp')
      const face = path.join(rootImgs, 'face.webp')

      if (!fs.existsSync(card) && fs.existsSync(travelerCard)) {
        fs.copyFileSync(travelerCard, card)
      }
      if (!fs.existsSync(card) && fs.existsSync(splash)) {
        fs.copyFileSync(splash, card)
      }
      if (!fs.existsSync(banner) && fs.existsSync(card)) {
        fs.copyFileSync(card, banner)
      }
      // Ensure gacha exists for UI even if upstream 404s.
      const gacha = path.join(rootImgs, 'gacha.webp')
      if (!fs.existsSync(gacha) && fs.existsSync(face)) {
        fs.copyFileSync(face, gacha)
      }
    }

    const elems = ['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro']
    for (const elem of elems) {
      const elemImgs = path.join(travelerRoot, elem, 'imgs')
      if (!fs.existsSync(elemImgs)) continue
      const elemCard = path.join(elemImgs, 'card.webp')
      const elemBanner = path.join(elemImgs, 'banner.webp')
      if (!fs.existsSync(elemCard) && fs.existsSync(travelerCard)) {
        fs.copyFileSync(travelerCard, elemCard)
      }
      if (!fs.existsSync(elemBanner) && fs.existsSync(elemCard)) {
        fs.copyFileSync(elemCard, elemBanner)
      }
    }
  }

  // Banner fallback: copy card.webp when present (after downloads).
  for (const imgsDir of bannerFixDirs) {
    const bannerPath = path.join(imgsDir, 'banner.webp')
    const cardPath = path.join(imgsDir, 'card.webp')
    if (!fs.existsSync(bannerPath) && fs.existsSync(cardPath)) {
      fs.copyFileSync(cardPath, bannerPath)
    }

    // Compatibility: some metas include additional aliases like face0/splash0.
    const facePath = path.join(imgsDir, 'face.webp')
    const face0Path = path.join(imgsDir, 'face0.webp')
    if (!fs.existsSync(face0Path) && fs.existsSync(facePath)) {
      fs.copyFileSync(facePath, face0Path)
    }
    const splashPath = path.join(imgsDir, 'splash.webp')
    const splash0Path = path.join(imgsDir, 'splash0.webp')
    if (!fs.existsSync(splash0Path) && fs.existsSync(splashPath)) {
      fs.copyFileSync(splashPath, splash0Path)
    }

    // Ensure card/banner exist (best-effort) so UI can load even when upstream namecard/banner is missing.
    if (!fs.existsSync(cardPath)) {
      const src = fs.existsSync(splashPath) ? splashPath : fs.existsSync(facePath) ? facePath : ''
      if (src) {
        try {
          fs.copyFileSync(src, cardPath)
        } catch (e) {
          opts.log?.warn?.(`[meta-gen] (gs) card fallback copy failed: ${imgsDir} -> ${String(e)}`)
        }
      }
      if (!fs.existsSync(cardPath)) {
        logAssetError({
          game: 'gs',
          type: 'character-img:card',
          name: path.basename(path.dirname(imgsDir)),
          out: cardPath,
          error: 'missing (no placeholder allowed)'
        })
      }
    }

    if (!fs.existsSync(bannerPath)) {
      if (fs.existsSync(cardPath)) {
        try {
          fs.copyFileSync(cardPath, bannerPath)
        } catch (e) {
          opts.log?.warn?.(`[meta-gen] (gs) banner fallback copy failed: ${imgsDir} -> ${String(e)}`)
        }
      }
      if (!fs.existsSync(bannerPath)) {
        logAssetError({
          game: 'gs',
          type: 'character-img:banner',
          name: path.basename(path.dirname(imgsDir)),
          out: bannerPath,
          error: 'missing (no placeholder allowed)'
        })
      }
    }

    // Costume fallback: if face2 exists but splash2 is missing, copy splash.webp (still allows UI to load).
    const face2Path = path.join(imgsDir, 'face2.webp')
    const splash2Path = path.join(imgsDir, 'splash2.webp')
    if (fs.existsSync(face2Path) && !fs.existsSync(splash2Path) && fs.existsSync(splashPath)) {
      fs.copyFileSync(splashPath, splash2Path)
    }

    // Generic fallbacks for core images: keep file-set closer to baseline when some URLs 404.
    const gachaPath = path.join(imgsDir, 'gacha.webp')
    const sidePath = path.join(imgsDir, 'side.webp')
    if (!fs.existsSync(gachaPath) && fs.existsSync(facePath)) {
      fs.copyFileSync(facePath, gachaPath)
    }
    if (!fs.existsSync(sidePath) && fs.existsSync(facePath)) {
      fs.copyFileSync(facePath, sidePath)
    }
  }

  // Icons fallback: keep baseline-like file set when upstream lacks some passive icons (rare cases).
  if (fs.existsSync(charRoot)) {
    for (const ent of fs.readdirSync(charRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue
      const iconsDir = path.join(charRoot, ent.name, 'icons')
      if (!fs.existsSync(iconsDir)) continue

      const passive0 = path.join(iconsDir, 'passive-0.webp')
      const passive1 = path.join(iconsDir, 'passive-1.webp')
      const passive2 = path.join(iconsDir, 'passive-2.webp')
      const passive3 = path.join(iconsDir, 'passive-3.webp')
      const passive4 = path.join(iconsDir, 'passive-4.webp')
      const talentT = path.join(iconsDir, 'talent-t.webp')

      // If passive-0 is missing (e.g. 雷电将军 in some upstreams), copy a nearby passive icon to avoid broken UI.
      if (!fs.existsSync(passive0)) {
        const src = fs.existsSync(passive1) ? passive1 : fs.existsSync(passive2) ? passive2 : ''
        if (src) {
          try {
            fs.copyFileSync(src, passive0)
          } catch (e) {
            opts.log?.warn?.(`[meta-gen] (gs) passive-0 fallback copy failed: ${ent.name} -> ${String(e)}`)
          }
        }
      }

      // If we have a sprint talent icon and already have passive-3, also provide passive-4 for compatibility (e.g. 莫娜).
      if (fs.existsSync(talentT) && fs.existsSync(passive3) && !fs.existsSync(passive4)) {
        try {
          fs.copyFileSync(talentT, passive4)
        } catch (e) {
          opts.log?.warn?.(`[meta-gen] (gs) passive-4 fallback copy failed: ${ent.name} -> ${String(e)}`)
        }
      }
    }
  }
}
