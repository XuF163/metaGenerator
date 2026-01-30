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
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import { runPromisePool } from '../../../utils/promise-pool.js'
import { roundTo, sortRecordByKey } from '../utils.js'
import type { AgdAvatarAttrContext } from './attr-agd.js'
import { buildGiAttrTable } from './attr.js'
import { buildGiAttrTableFromAgd, tryCreateAgdAvatarAttrContext } from './attr-agd.js'
import { buildGiTalent, buildGiTablesFromPromote, normalizePromoteList } from './talent.js'
import type { GiSkillDescOptions } from './talent.js'
import { inferGiTalentConsFromHakushDetail, inferGiTalentConsFromMetaJson } from './talent-cons.js'
import type { LlmService } from '../../../llm/service.js'
import { buildCalcJsWithLlmOrHeuristic } from '../../calc/llm-calc.js'
import type { GiTalentCons } from './talent-cons.js'

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
  return text
    .replace(/\{LINK#[^}]*\}/g, '')
    .replace(/\{\/LINK\}/g, '')
    .replace(/<[^>]+>/g, '')
    .replaceAll('\\n', ' ')
    .replaceAll('\n', ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function giPlainDescToLines(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  const text = raw
    .replace(/\{LINK#[^}]*\}/g, '')
    .replace(/\{\/LINK\}/g, '')
    .replaceAll('{TIMEZONE}', 'GMT+8')
    .replaceAll('\\n', '\n')
    .replaceAll('\r\n', '\n')
    .trim()

  const out: string[] = []
  let italicOpen = false
  for (const rawLine of text.split('\n')) {
    let line = rawLine.trim()
    if (!line) continue
    // Hakush sometimes prepends markdown-ish markers.
    line = line.replace(/^#+\s*/, '').trim()
    if (!line) continue

    const headingMatch = line.match(/^<color=#FFD780FF>(.*?)<\/color>$/)
    if (headingMatch) {
      const heading = headingMatch[1].replace(/<[^>]+>/g, '').trim().replace(/\s*\/\s*/g, '/')
      out.push(`<h3>${heading}</h3>`)
      continue
    }

    line = line.replace(/<color=[^>]+>/g, '').replace(/<\/color>/g, '')
    // Keep <i>...</i> (baseline uses it for flavor lines), strip other tags.
    line = line.replace(/<i[^>]*>/g, '<i>').replace(/<\/i>/g, '</i>')
    line = line
      .replace(/<(?!\/?i\b)[^>]+>/g, '')
      .trim()
      .replace(/\s*\/\s*/g, '/')
      .replace(/\s+([：:])/g, '$1')
    if (!line) continue

    // Baseline-compat: split multi-line <i>...</i> blocks into per-line "<i>...</i>" entries.
    const startedItalic = line.includes('<i>')
    const endedItalic = line.includes('</i>')

    if (!startedItalic && endedItalic) {
      line = `<i>${line}`
    } else if (italicOpen && !startedItalic) {
      line = `<i>${line}`
    }

    if ((italicOpen || startedItalic) && !line.includes('</i>')) {
      line = `${line}</i>`
    }

    out.push(line)

    if (endedItalic) italicOpen = false
    else if (startedItalic) italicOpen = true
  }

  return out
}

function preferSpecialDesc(obj: Record<string, unknown>): unknown {
  const s = obj.SpecialDesc
  const d = obj.Desc

  const score = (raw: unknown): number => {
    if (typeof raw !== 'string') return 0
    return raw
      .replace(/\{LINK#[^}]*\}/g, '')
      .replace(/\{\/LINK\}/g, '')
      .replaceAll('\\n', '\n')
      .replaceAll('\r\n', '\n')
      .replace(/<[^>]+>/g, '')
      .trim().length
  }

  const sScore = score(s)
  const dScore = score(d)
  if (!sScore) return d
  if (!dScore) return s
  return sScore >= dScore ? s : d
}

function passiveUnlockRank(unlock: number): { group: number; order: number } {
  if (!Number.isFinite(unlock)) return { group: 99, order: 999 }
  // Baseline prefers special system passives (unlock>=1,000,000) first.
  if (unlock >= 1_000_000) return { group: 0, order: unlock }
  // Then exploration (0), then A1/A4/etc by unlock asc.
  if (unlock === 0) return { group: 1, order: 0 }
  return { group: 2, order: unlock }
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
  // Baseline meta keeps at most one non-default costume id (even if upstream lists multiple).
  alts.sort((a, b) => a.id - b.id)
  const primary = alts[0]
  const ids = primary ? [primary.id] : []
  const primaryIcon = primary?.icon || ''
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

// Abbreviation overrides (baseline-compatible):
// - index (`character/data.json`) uses stable short-hands to avoid collisions.
// - per-character (`character/<name>/data.json`) may keep full names for some characters.
const gsAbbrIndexOverrideByName: Record<string, string> = {
  阿蕾奇诺: '仆人',
  艾尔海森: '海森',
  艾梅莉埃: '艾梅',
  八重神子: '八重',
  达达利亚: '公子',
  枫原万叶: '万叶',
  哥伦比娅: '少女',
  荒泷一斗: '一斗',
  九条裟罗: '九条',
  克洛琳德: '琳德',
  莱欧斯利: '莱欧',
  雷电将军: '雷神',
  鹿野院平藏: '平藏',
  罗莎莉亚: '罗莎',
  梦见月瑞希: '瑞希',
  那维莱特: '那维',
  '奇偶·男性': '男偶',
  '奇偶·女性': '女偶',
  茜特菈莉: '茜特',
  珊瑚宫心海: '心海',
  神里绫华: '绫华',
  神里绫人: '绫人'
}

const gsAbbrDetailOverrideByName: Record<string, string> = {
  阿蕾奇诺: '仆人',
  艾尔海森: '海森',
  八重神子: '神子',
  达达利亚: '公子',
  枫原万叶: '万叶',
  哥伦比娅: '少女',
  荒泷一斗: '一斗',
  九条裟罗: '九条',
  克洛琳德: '琳德',
  雷电将军: '雷神',
  鹿野院平藏: '平藏',
  罗莎莉亚: '罗莎',
  梦见月瑞希: '瑞希',
  '奇偶·男性': '男偶',
  '奇偶·女性': '女偶',
  茜特菈莉: '茜特',
  珊瑚宫心海: '心海',
  神里绫华: '绫华',
  神里绫人: '绫人'
}

function gsIndexAbbr(name: string): string {
  return gsAbbrIndexOverrideByName[name] ?? (name.length >= 5 ? name.slice(-2) : name)
}

function gsDetailAbbr(name: string): string {
  return gsAbbrDetailOverrideByName[name] ?? (name.length >= 5 ? name.slice(-2) : name)
}

const gsTalentConsOverrideById: Record<string, GiTalentCons> = {
  // Hakush text for these two does not match the C3/C5 pattern; enforce baseline-compatible values.
  '10000046': { a: 0, e: 3, q: 5 }, // 胡桃
  // Baseline index expects the default C3/C5 pattern for 埃洛伊 (even though per-character data.json keeps all zeros).
  '10000062': { a: 0, e: 5, q: 3 }
}

const gsCncvOverrideById: Record<string, string> = {
  // Hakush swapped these two CN voice actors; keep baseline-compatible output.
  '10000126': '昱头', // 兹白
  '10000127': 'Mace' // 叶洛亚
}

const gsEtaCompatById: Record<string, number> = {
  '10000061': 1684893600000,
  '10000070': 1665712800000,
  '10000073': 1667354400000,
  '10000074': 1667354400000,
  '10000075': 1670378400000,
  '10000076': 1670378400000,
  '10000077': 1674007200000,
  '10000078': 1674007200000,
  '10000079': 1677636000000,
  '10000080': 1679364000000,
  '10000081': 1682992800000,
  '10000082': 1682992800000,
  '10000083': 1692151200000,
  '10000084': 1692151200000,
  '10000085': 1692151200000,
  '10000086': 1697508000000,
  '10000087': 1695780000000,
  '10000088': 1699408800000,
  '10000089': 1699408800000,
  '10000090': 1703037600000,
  '10000091': 1703037600000
}

function travelerTalentCons(elem: string): { a: number; e: number; q: number } {
  // miao-plugin special-cases traveler talent cons by element.
  // Keep data.json aligned with runtime behavior.
  if (['dendro', 'hydro', 'pyro'].includes(elem)) return { a: 0, e: 3, q: 5 }
  return { a: 0, e: 5, q: 3 }
}

const travelerMaterialsBaseline = {
  gem: '璀璨原钻',
  specialty: '风车菊',
  normal: '不祥的面具',
  talent: '「诗文」的哲学',
  weekly: '东风的吐息'
}

async function generateGsTravelerAndMannequinsFromVariants(opts: {
  metaGsRootAbs: string
  /** Absolute path to metaGenerator project root (temp/metaGenerator). */
  projectRootAbs: string
  repoRootAbs: string
  hakush: HakushClient
  agdAttr?: AgdAvatarAttrContext | null
  giSkillDescOpts?: GiSkillDescOptions
  /** Optional: AvatarExcelConfigData.descTextMapHash resolved to plain text. */
  gsAvatarDescById?: Map<number, string>
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
  const { metaGsRootAbs, projectRootAbs, repoRootAbs, hakush, agdAttr, giSkillDescOpts, variantGroups, index, assetJobs, assetOutDedup, bannerFixDirs, llm, log } = opts
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
    const travelerElems = ['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro']
    const hasAllTravelerElems = travelerElems.every((e) => fs.existsSync(path.join(outTravelerRoot, e, 'data.json')))
    const shouldGenerateTraveler =
      !index['20000000'] ||
      !hasAllTravelerElems ||
      !fs.existsSync(path.join(outTravelerRoot, 'data.json')) ||
      !fs.existsSync(path.join(outAetherRoot, 'data.json')) ||
      !fs.existsSync(path.join(outLumineRoot, 'data.json'))

    // In incremental mode, traveler variants are skipped once all elements exist.
    // Still repair attr tables when AnimeGameData curves/promotes are available.
    if (!shouldGenerateTraveler && agdAttr) {
      try {
        const travelerAgdId = agdAttr.avatarById.has(10000005) ? 10000005 : 10000007
        const agdRes = buildGiAttrTableFromAgd(agdAttr, travelerAgdId)
        if (agdRes) {
          for (const elem of travelerElems) {
            const elemDataPath = path.join(outTravelerRoot, elem, 'data.json')
            if (!fs.existsSync(elemDataPath)) continue
            try {
              const ds = JSON.parse(fs.readFileSync(elemDataPath, 'utf8'))
              if (!isRecord(ds)) continue
              const dsRec = ds as Record<string, unknown>
              const curAttr = dsRec.attr
              if (!isRecord(curAttr) || JSON.stringify(curAttr) !== JSON.stringify(agdRes.attr)) {
                dsRec.attr = agdRes.attr
                dsRec.baseAttr = agdRes.baseAttr
                dsRec.growAttr = agdRes.growAttr
                writeJsonFile(elemDataPath, dsRec)
              }
            } catch {
              // ignore per-element repair errors
            }
          }
        }
      } catch {
        // ignore traveler repair errors
      }
    }

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

        const giTalent = buildGiTalent(skillsArr, qIdx, giSkillDescOpts)
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
        if (fs.existsSync(elemDataPath)) {
          try {
            const existing = JSON.parse(fs.readFileSync(elemDataPath, 'utf8'))
            const hasCons = isRecord(existing) && isRecord((existing as Record<string, unknown>).cons)
            const hasPassive = isRecord(existing) && Array.isArray((existing as Record<string, unknown>).passive)
            const hasAttr = isRecord(existing) && isRecord((existing as Record<string, unknown>).attr)

            // If AnimeGameData is available, also refresh when attr differs (fixes 0.01 drift).
            const travelerAgdId = agdAttr?.avatarById.has(10000005) ? 10000005 : 10000007
            const agdRes = agdAttr ? buildGiAttrTableFromAgd(agdAttr, travelerAgdId) : null
            const sameAttr =
              agdRes &&
              isRecord((existing as Record<string, unknown>).attr) &&
              JSON.stringify((existing as Record<string, unknown>).attr) === JSON.stringify(agdRes.attr)

            if (hasCons && hasPassive && hasAttr && (!agdRes || sameAttr)) continue
          } catch {
            // fallthrough: regenerate
          }
        }

        const elemDir = path.join(outTravelerRoot, elem)
        const imgsDir = path.join(elemDir, 'imgs')
        const iconsDir = path.join(elemDir, 'icons')
        fs.mkdirSync(imgsDir, { recursive: true })
        fs.mkdirSync(iconsDir, { recursive: true })

        const charInfo = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
        const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

        // Attr table (prefer AnimeGameData curves/promotes for baseline precision).
        let baseAttr: { hp: number; atk: number; def: number }
        let growAttr: { key: string; value: number }
        let attr: ReturnType<typeof buildGiAttrTable>

        const travelerAgdId = agdAttr?.avatarById.has(10000005) ? 10000005 : 10000007
        const agdRes = agdAttr ? buildGiAttrTableFromAgd(agdAttr, travelerAgdId) : null
        if (agdRes) {
          baseAttr = agdRes.baseAttr
          growAttr = agdRes.growAttr
          attr = agdRes.attr
        } else {
          // Fallback: use Hakush StatsModifier (may have 0.01 drift vs baseline).
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

          const ascRecords: Array<Record<string, unknown>> = []
          for (let i = 0; i < 6; i++) {
            ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
          }
          attr = buildGiAttrTable({
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

          baseAttr = { hp: roundTo(hp90, 2), atk: roundTo(atk90, 2), def: roundTo(def90, 2) }
          growAttr = growKey ? { key: growKey, value: growValue } : { key: '', value: 0 }
        }

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

        const title = typeof charInfo.Title === 'string' && charInfo.Title.trim() ? charInfo.Title : '异界的旅人'
        const birth = elem === 'pyro' ? '1-1' : '-'

        const talentElem = (eId || qId
          ? ({
              ...(eId ? { [String(eId)]: elem } : {}),
              ...(qId ? { [String(qId)]: elem } : {})
            } as Record<string, string>)
          : {}) as Record<string, string>

        // Baseline meta uses legacy ids for Pyro traveler skills.
        if (elem === 'pyro') {
          talentElem['10027'] = 'pyro'
          talentElem['10028'] = 'pyro'
        }

        // Constellations.
        const consData: Record<string, unknown> = {}
        const consArr = Array.isArray(detailRaw.Constellations) ? (detailRaw.Constellations as Array<unknown>) : []
        for (let i = 0; i < 6; i++) {
          const c = isRecord(consArr[i]) ? (consArr[i] as Record<string, unknown>) : undefined
          if (!c) continue
          const cName = typeof c.Name === 'string' ? (c.Name as string) : ''
          if (!cName) continue
          consData[String(i + 1)] = { name: cName, desc: giPlainDescToLines(preferSpecialDesc(c)) }
        }

        // Passive talents (unlock asc).
        const passiveArr = Array.isArray(detailRaw.Passives) ? (detailRaw.Passives as Array<unknown>) : []
        const passiveData = passiveArr
          .map((p, idx) => (isRecord(p) ? { idx, rec: p as Record<string, unknown> } : null))
          .filter(Boolean)
          .map((p) => {
            const pName = typeof p!.rec.Name === 'string' ? (p!.rec.Name as string) : ''
            const unlock = typeof p!.rec.Unlock === 'number' ? (p!.rec.Unlock as number) : Number(p!.rec.Unlock)
            return pName
              ? {
                  idx: p!.idx,
                  id: toInt(p!.rec.Id),
                  name: pName,
                  desc: giPlainDescToLines(preferSpecialDesc(p!.rec)),
                  unlock: Number.isFinite(unlock) ? unlock : 999
                }
              : null
          })
          .filter(Boolean) as Array<{ idx: number; id: number | null; name: string; desc: string[]; unlock: number }>
        passiveData.sort((a, b) => {
          const ra = passiveUnlockRank(a.unlock)
          const rb = passiveUnlockRank(b.unlock)
          if (ra.group !== rb.group) return ra.group - rb.group
          if (ra.order !== rb.order) return ra.order - rb.order
          const aid = a.id ?? -1
          const bid = b.id ?? -1
          if (aid !== bid) return bid - aid
          return a.idx - b.idx
        })
        const passiveOut = passiveData.map(({ name, desc }) => ({ name, desc }))

        const agdDesc = opts.gsAvatarDescById?.get(10000005) || opts.gsAvatarDescById?.get(10000007)
        const desc = agdDesc || (typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detailRaw.Desc))

        const detailData = {
          id: 7,
          name,
          abbr: name,
          title,
          star,
          elem,
          allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
          weapon,
          birth,
          astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
          desc,
          cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
          jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
          costume: false,
          ver: 1,
          baseAttr,
          growAttr,
          talentId: giTalent?.talentId || {},
          talentElem,
          talentCons,
          materials: travelerMaterialsBaseline,
          ...(giTalent ? { talent: giTalent.talent, talentData: giTalent.talentData } : {}),
          cons: consData,
          passive: passiveOut,
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
          const getDesc = (k: 'a' | 'e' | 'q'): string => {
            const blk = (giTalent.talent as any)?.[k]
            return blk && typeof blk.desc === 'string' ? (blk.desc as string) : ''
          }
          const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(llm, {
            game: 'gs',
            name: `旅行者/${elem}`,
            elem,
            weapon,
            star,
            tables: { a: aTables, e: eTables, q: qTables },
            talentDesc: { a: getDesc('a'), e: getDesc('e'), q: getDesc('q') }
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

      // Compatibility: some clients expect traveler normal-attack ids in 10055x space.
      for (const tid of Object.keys(unionTalentId)) {
        if (!tid.startsWith('10054')) continue
        const num = Number(tid)
        const alias = Number.isFinite(num) ? String(num + 10) : null
        if (alias && !unionTalentId[alias]) {
          unionTalentId[alias] = unionTalentId[tid]!
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

      const applyTravelerTalentIdAlias = (rec: unknown): void => {
        if (!isRecord(rec)) return
        const tid = rec.talentId
        if (!isRecord(tid)) return
        for (const [key, val] of Object.entries(tid)) {
          const num = Number(key)
          if (!Number.isFinite(num) || !key.startsWith('10054')) continue
          const alias = String(num + 10)
          if (!(alias in tid)) {
            ;(tid as Record<string, unknown>)[alias] = val
          }
        }
      }

      applyTravelerTalentIdAlias(index['20000000'])
      applyTravelerTalentIdAlias(index['10000005'])
      applyTravelerTalentIdAlias(index['10000007'])

      const writeTravelerRootData = async (baseId: string, outName: string, outDir: string): Promise<void> => {
        const variants = baseId === '20000000' ? sharedVariantIds : variantGroups.get(baseId) || []
        const sampleId = variants[0]
        if (!sampleId) return

        const detailRaw = await hakush.getGsCharacterDetail(sampleId)
        if (!isRecord(detailRaw)) return

        const charInfo = isRecord(detailRaw.CharaInfo) ? (detailRaw.CharaInfo as Record<string, unknown>) : {}
        const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

        const idNum = baseId === '20000000' ? 20000000 : Number(baseId)

        // Traveler roots are special-cased in baseline meta (stats/materials/VA formatting).
        const sm = isRecord(detailRaw.StatsModifier) ? (detailRaw.StatsModifier as Record<string, unknown>) : {}
        const ascArr = Array.isArray(sm.Ascension) ? (sm.Ascension as Array<unknown>) : []
        const asc6 = isRecord(ascArr[5]) ? (ascArr[5] as Record<string, unknown>) : {}
        const hpMul = isRecord(sm.HP) ? (sm.HP as Record<string, unknown>) : {}
        const atkMul = isRecord(sm.ATK) ? (sm.ATK as Record<string, unknown>) : {}
        const defMul = isRecord(sm.DEF) ? (sm.DEF as Record<string, unknown>) : {}

        const baseHP = typeof detailRaw.BaseHP === 'number' ? detailRaw.BaseHP : 0
        const baseATK = typeof detailRaw.BaseATK === 'number' ? detailRaw.BaseATK : 0
        const baseDEF = typeof detailRaw.BaseDEF === 'number' ? detailRaw.BaseDEF : 0

        const promoHp = Number(asc6.FIGHT_PROP_BASE_HP ?? 0)
        const promoAtk = Number(asc6.FIGHT_PROP_BASE_ATTACK ?? 0)
        const promoDef = Number(asc6.FIGHT_PROP_BASE_DEFENSE ?? 0)

        const title = typeof charInfo.Title === 'string' && charInfo.Title.trim() ? charInfo.Title : '异界的旅人'

        const cncv =
          baseId === '20000000'
            ? '宴宁/鹿喑'
            : typeof va.Chinese === 'string'
              ? va.Chinese
              : ''
        const jpcv =
          baseId === '20000000'
            ? '悠木碧/堀江瞬'
            : typeof va.Japanese === 'string'
              ? va.Japanese
              : ''

        const baseAttr =
          baseId === '20000000'
            ? {
                // Baseline uses lv90-ish numbers for the multi-element root traveler.
                hp: roundTo(baseHP * Number(hpMul['90'] ?? 0) + promoHp, 0),
                atk: roundTo(baseATK * Number(atkMul['90'] ?? 0) + promoAtk, 1),
                def: roundTo(baseDEF * Number(defMul['90'] ?? 0) + promoDef, 2)
              }
            : {
                // Baseline uses lv100 milestone for gendered traveler roots, but ATK follows the HP curve.
                hp: roundTo(baseHP * Number(hpMul['100'] ?? 0) + promoHp, 2),
                atk: roundTo(baseATK * Number(hpMul['100'] ?? 0) + promoAtk, 2),
                def: roundTo(baseDEF * Number(defMul['100'] ?? 0) + promoDef, 2)
              }

        const growAttr = { key: 'atkPct', value: 24 }

        const agdDesc = opts.gsAvatarDescById?.get(10000005) || opts.gsAvatarDescById?.get(10000007)
        const desc = agdDesc || (typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline((detailRaw as Record<string, unknown>).Desc))

        const data = {
          id: idNum,
          name: outName,
          abbr: outName,
          title,
          star: 5,
          elem: 'multi',
          allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
          weapon: weaponMap[String((detailRaw as Record<string, unknown>).Weapon)] || 'sword',
          birth: '-',
          astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
          desc,
          cncv,
          jpcv,
          costume: false,
          ver: 1,
          baseAttr,
          growAttr,
          talentId: unionTalentId,
          talentElem: unionTalentElem,
          talentCons: { e: 5, q: 3 },
          materials: travelerMaterialsBaseline
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

    const giTalent = buildGiTalent(skillsArr, qIdx, giSkillDescOpts)
    const talentId = giTalent?.talentId || {}
    // Compatibility: baseline includes extra Q ids for mannequins.
    const qCompat = ['111752', '111753', '111755', '111756', '111757']
    if (talentId['111751'] === 'q') {
      for (const k of qCompat) {
        if (!talentId[k]) talentId[k] = 'q'
      }
    }

    index[baseId] = {
      id: Number(baseId),
      name,
      abbr: gsIndexAbbr(name),
      star,
      elem,
      weapon,
      talentId,
      talentCons: { a: 0, e: 0, q: 0 }
    }

    const charDir = path.join(charRoot, name)
    const imgsDir = path.join(charDir, 'imgs')
    const iconsDir = path.join(charDir, 'icons')
    fs.mkdirSync(imgsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })

    const charInfo = isRecord(detail.CharaInfo) ? (detail.CharaInfo as Record<string, unknown>) : {}
    const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

    // Attr table (prefer AnimeGameData curves/promotes for baseline precision).
    let baseAttr: { hp: number; atk: number; def: number }
    let growAttr: { key: string; value: number }
    let attr: ReturnType<typeof buildGiAttrTable>

    const mannequinAgdId = Number(baseId)
    const agdRes = agdAttr ? buildGiAttrTableFromAgd(agdAttr, mannequinAgdId) : null
    if (agdRes) {
      baseAttr = agdRes.baseAttr
      growAttr = agdRes.growAttr
      attr = agdRes.attr
    } else {
      // Fallback: use Hakush StatsModifier (may have 0.01 drift vs baseline).
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
      const growValue =
        growKey === 'mastery' ? growRaw : roundTo(growRaw >= 1 ? growRaw : growRaw * 100, 2)

      const ascRecords: Array<Record<string, unknown>> = []
      for (let i = 0; i < 6; i++) {
        ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
      }
      attr = buildGiAttrTable({
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

      baseAttr = { hp: roundTo(hp90, 2), atk: roundTo(atk90, 2), def: roundTo(def90, 2) }
      growAttr = growKey ? { key: growKey, value: growValue } : { key: '', value: 0 }
    }

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

    // Constellations.
    const consData: Record<string, unknown> = {}
    const consArr = Array.isArray(detail.Constellations) ? (detail.Constellations as Array<unknown>) : []
    for (let i = 0; i < 6; i++) {
      const c = isRecord(consArr[i]) ? (consArr[i] as Record<string, unknown>) : undefined
      if (!c) continue
      const cName = typeof c.Name === 'string' ? (c.Name as string) : ''
      if (!cName) continue
      consData[String(i + 1)] = { name: cName, desc: giPlainDescToLines(preferSpecialDesc(c)) }
    }
    if (!Object.keys(consData).length) {
      // Hakush mannequin variants do not ship constellations; baseline uses placeholders.
      for (let i = 1; i <= 6; i++) {
        consData[String(i)] = { name: '？？？', desc: ['？？？'] }
      }
    }

    // Passive talents (unlock asc).
    const passiveArr = Array.isArray(detail.Passives) ? (detail.Passives as Array<unknown>) : []
    const passiveData = passiveArr
      .map((p, idx) => (isRecord(p) ? { idx, rec: p as Record<string, unknown> } : null))
      .filter(Boolean)
      .map((p) => {
        const pName = typeof p!.rec.Name === 'string' ? (p!.rec.Name as string) : ''
        const unlock = typeof p!.rec.Unlock === 'number' ? (p!.rec.Unlock as number) : Number(p!.rec.Unlock)
        return pName
          ? {
              idx: p!.idx,
              id: toInt(p!.rec.Id),
              name: pName,
              desc: giPlainDescToLines(preferSpecialDesc(p!.rec)),
              unlock: Number.isFinite(unlock) ? unlock : 999
            }
          : null
      })
      .filter(Boolean) as Array<{ idx: number; id: number | null; name: string; desc: string[]; unlock: number }>
    passiveData.sort((a, b) => {
      const ra = passiveUnlockRank(a.unlock)
      const rb = passiveUnlockRank(b.unlock)
      if (ra.group !== rb.group) return ra.group - rb.group
      if (ra.order !== rb.order) return ra.order - rb.order
      const aid = a.id ?? -1
      const bid = b.id ?? -1
      if (aid !== bid) return bid - aid
      return a.idx - b.idx
    })
    const passiveOut = passiveData.map(({ name, desc }) => ({ name, desc }))

    const birthRaw = Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : ''
    const birth = birthRaw && birthRaw !== '0-0' ? birthRaw : '1-1'

    const agdDesc = opts.gsAvatarDescById?.get(Number(baseId))
    const desc = agdDesc || (typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detail.Desc))

    const detailData = {
      id: Number(baseId),
      name,
      abbr: gsDetailAbbr(name),
      title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
      star,
      elem,
      allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
      weapon,
      birth,
      astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
      desc,
      cncv: typeof va.Chinese === 'string' ? va.Chinese : '',
      jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
      costume: false,
      ver: 1,
      baseAttr,
      growAttr,
      talentId,
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
      cons: consData,
      passive: passiveOut,
      attr
    }

    writeJsonFile(path.join(charDir, 'data.json'), detailData)
    const calcPath = path.join(charDir, 'calc.js')
    ensurePlaceholderCalcJs(calcPath, name)

    if (giTalent && isPlaceholderCalc(calcPath)) {
      const aTables = Object.keys(giTalent.talentData.a || {}).filter((k) => !k.endsWith('2'))
      const eTables = Object.keys(giTalent.talentData.e || {}).filter((k) => !k.endsWith('2'))
      const qTables = Object.keys(giTalent.talentData.q || {}).filter((k) => !k.endsWith('2'))
      const getDesc = (k: 'a' | 'e' | 'q'): string => {
        const blk = (giTalent.talent as any)?.[k]
        return blk && typeof blk.desc === 'string' ? (blk.desc as string) : ''
      }
      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(llm, {
        game: 'gs',
        name,
        elem,
        weapon,
        star,
        tables: { a: aTables, e: eTables, q: qTables },
        talentDesc: { a: getDesc('a'), e: getDesc('e'), q: getDesc('q') }
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
  animeGameData: AnimeGameDataClient
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

  const agdAttrCtx = await tryCreateAgdAvatarAttrContext({ animeGameData: opts.animeGameData, log: opts.log })
  let gsTextMap: Record<string, string> | undefined
  try {
    const raw = await opts.animeGameData.getGsTextMapCHS()
    if (isRecord(raw)) gsTextMap = raw as Record<string, string>
  } catch {
    // keep running: LINK expansion is optional
  }
  let gsProudSkillParamMap: Map<number, number[]> | undefined
  if (gsTextMap) {
    try {
      const proudRaw = await opts.animeGameData.getGsProudSkillExcelConfigData()
      if (Array.isArray(proudRaw)) {
        const m = new Map<number, number[]>()
        for (const row of proudRaw) {
          if (!isRecord(row)) continue
          const pid = toInt(row.proudSkillId)
          const paramListRaw = row.paramList
          const paramList = Array.isArray(paramListRaw)
            ? (paramListRaw as Array<unknown>)
                .map((x) => (typeof x === 'number' ? x : Number(x)))
                .filter((n) => Number.isFinite(n))
            : []
          if (!pid || paramList.length === 0) continue
          m.set(pid, paramList as number[])
        }
        if (m.size) gsProudSkillParamMap = m
      }
    } catch {
      // Optional: only needed to resolve TextMap `{PARAM#P...}` placeholders in LINK expansion.
    }
  }
  const giSkillDescOpts: GiSkillDescOptions | undefined = gsTextMap
    ? { textMap: gsTextMap, ...(gsProudSkillParamMap ? { proudSkillParamMap: gsProudSkillParamMap } : {}) }
    : undefined

  // Used for sprint-skill passive id compatibility (e.g. Ayaka/Mona use proudSkillGroupId in baseline meta).
  let gsProudSkillGroupByAvatarSkillId: Map<number, number> | undefined
  try {
    const raw = await opts.animeGameData.getGsAvatarSkillExcelConfigData()
    if (Array.isArray(raw)) {
      const m = new Map<number, number>()
      for (const row of raw) {
        if (!isRecord(row)) continue
        const sid = toInt(row.id)
        const gid = toInt(row.proudSkillGroupId)
        if (!sid || !gid) continue
        m.set(sid, gid)
      }
      if (m.size) gsProudSkillGroupByAvatarSkillId = m
    }
  } catch {
    // Optional: only needed for the "替代冲刺" passive id.
  }
  let gsAvatarDescById: Map<number, string> | undefined
  if (gsTextMap) {
    try {
      const avatarRaw = await opts.animeGameData.getGsAvatarExcelConfigData()
      const m = new Map<number, string>()
      if (Array.isArray(avatarRaw)) {
        for (const row of avatarRaw) {
          if (!isRecord(row)) continue
          const rid = toInt(row.id)
          const hash = toInt(row.descTextMapHash)
          if (!rid || !hash) continue
          const desc = normalizeTextInline(gsTextMap[String(hash)] ?? '')
          if (desc) m.set(rid, desc)
        }
      }
      if (m.size) gsAvatarDescById = m
    } catch {
      // Optional: when missing, fallback to Hakush desc fields.
    }
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
    const parsedEta = Date.parse(`${release}T02:00:00Z`)
    const etaMs = Number.isFinite(parsedEta) ? parsedEta : gsEtaCompatById[id]

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
            const isAloy = id === '10000062'
            if (!isAloy && inferred && !sameTalentCons(dsRec.talentCons, inferred)) {
              dsRec.talentCons = inferred
              writeJsonFile(dataPath, dsRec)
              if (existingRec) existingRec.talentCons = inferred
            }
            const overrideTc = gsTalentConsOverrideById[id]
            if (overrideTc) {
              if (isAloy) {
                // Baseline quirk: top-level index uses the default C3/C5 pattern, but per-character keeps all zeros.
                const zeroTc: GiTalentCons = { a: 0, e: 0, q: 0 }
                if (!sameTalentCons(dsRec.talentCons, zeroTc)) {
                  dsRec.talentCons = zeroTc
                  writeJsonFile(dataPath, dsRec)
                }
                if (existingRec && !sameTalentCons(existingRec.talentCons, overrideTc)) {
                  existingRec.talentCons = overrideTc
                }
              } else if (!sameTalentCons(dsRec.talentCons, overrideTc)) {
                dsRec.talentCons = overrideTc
                writeJsonFile(dataPath, dsRec)
                if (existingRec) existingRec.talentCons = overrideTc
              }
            }

            // Repair attr/baseAttr/growAttr using AnimeGameData when available (fixes 0.01 drift vs baseline).
            if (agdAttrCtx) {
              const agdRes = buildGiAttrTableFromAgd(agdAttrCtx, Number(id))
              if (agdRes) {
                const curAttr = dsRec.attr
                if (!isRecord(curAttr) || JSON.stringify(curAttr) !== JSON.stringify(agdRes.attr)) {
                  dsRec.attr = agdRes.attr
                  dsRec.baseAttr = agdRes.baseAttr
                  dsRec.growAttr = agdRes.growAttr
                  writeJsonFile(dataPath, dsRec)
                }
              }
            }

            // Repair talent tables/talentData using Hakush promote templates (keeps existing desc lines).
            try {
              const talentRaw = dsRec.talent
              const talentDataRaw = dsRec.talentData
              if (isRecord(talentRaw) && isRecord(talentDataRaw)) {
                const detailRaw = await loadDetailForRepair()
                if (detailRaw) {
                  const skillsArr = Array.isArray(detailRaw.Skills) ? (detailRaw.Skills as Array<unknown>) : []
                  const s2 = isRecord(skillsArr[2]) ? (skillsArr[2] as Record<string, unknown>) : undefined
                  const qIdxRaw = s2 && typeof s2.Desc === 'string' && s2.Desc.includes('替代冲刺') ? 3 : 2
                  const qIdx = qIdxRaw < skillsArr.length ? qIdxRaw : 2

                  const giTalent = buildGiTalent(skillsArr, qIdx, giSkillDescOpts)
                  if (giTalent) {
                    let changed = false

                    // Update a/e/q tables, and append missing desc sections when we can do so safely.
                    for (const key of ['a', 'e', 'q'] as const) {
                      const curBlk = (talentRaw as Record<string, unknown>)[key]
                      const nextBlk = giTalent.talent[key]
                      if (isRecord(curBlk)) {
                        const curRec = curBlk as Record<string, unknown>
                        const before = JSON.stringify(curRec.tables)
                        const after = JSON.stringify(nextBlk.tables)
                        if (before !== after) {
                          curRec.tables = nextBlk.tables
                          changed = true
                        }

                         // Keep manual edits intact: only update when the existing desc is a strict prefix
                         // of the newly generated desc (i.e. we are only appending extra sections like LINK expansions).
                         const curDescRaw = curRec.desc
                         const isCurDescStringArray =
                           Array.isArray(curDescRaw) && (curDescRaw as Array<unknown>).every((x) => typeof x === 'string')
                         if (!isCurDescStringArray) {
                           curRec.desc = nextBlk.desc
                           changed = true
                         } else {
                           const curDesc = curDescRaw as string[]
                           const stripH3 = (s: string): string => {
                             const m = s.match(/^<h3>(.*?)<\/h3>$/)
                             return m ? m[1] : s
                           }
                           const curNorm = curDesc.map(stripH3)
                           const nextNorm = nextBlk.desc.map(stripH3)
                           // Safe reformat: only heading markup differs.
                           if (JSON.stringify(curNorm) === JSON.stringify(nextNorm)) {
                             const dBefore = JSON.stringify(curDesc)
                             const dAfter = JSON.stringify(nextBlk.desc)
                             if (dBefore !== dAfter) {
                               curRec.desc = nextBlk.desc
                               changed = true
                             }
                             continue
                           }

                           let isPrefix = curDesc.length <= nextBlk.desc.length
                           if (isPrefix) {
                             for (let i = 0; i < curDesc.length; i++) {
                               if (curDesc[i] !== nextBlk.desc[i]) {
                                 isPrefix = false
                                break
                              }
                            }
                          }
                          if (isPrefix) {
                            const dBefore = JSON.stringify(curDesc)
                            const dAfter = JSON.stringify(nextBlk.desc)
                            if (dBefore !== dAfter) {
                              curRec.desc = nextBlk.desc
                              changed = true
                            }
                          }
                        }
                      } else {
                        ;(talentRaw as Record<string, unknown>)[key] = nextBlk
                        changed = true
                      }
                    }

                    // Ensure talentData stays in sync with templates (handles + / *N correctly).
                    const tdRec = talentDataRaw as Record<string, unknown>
                    for (const key of ['a', 'e', 'q'] as const) {
                      const before = JSON.stringify(tdRec[key])
                      const after = JSON.stringify(giTalent.talentData[key])
                      if (before !== after) {
                        tdRec[key] = giTalent.talentData[key]
                        changed = true
                      }
                    }

                    // Keep talentId compatible with current template-derived ids.
                    const tidBefore = JSON.stringify(dsRec.talentId)
                    const tidAfter = JSON.stringify(giTalent.talentId)
                    if (tidBefore !== tidAfter) {
                      dsRec.talentId = giTalent.talentId
                      changed = true
                      if (existingRec) existingRec.talentId = giTalent.talentId
                    }

                    if (changed) {
                      writeJsonFile(dataPath, dsRec)
                    }
                  }
                }
              }
            } catch {
              // ignore per-character talent repair errors
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

    if (!needGenerate) {
      const rec = existingRec
      const existingNameResolved = typeof existingName === 'string' ? existingName : undefined
      if (rec && existingNameResolved) {
        const abbr = gsIndexAbbr(existingNameResolved)
        const recObj = rec as Record<string, unknown>
        const currentAbbr = typeof recObj.abbr === 'string' ? recObj.abbr : ''
        if (abbr && currentAbbr !== abbr) recObj.abbr = abbr
        if (etaMs != null && recObj.eta !== etaMs) {
          recObj.eta = etaMs
        }
      }
      continue
    }

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
    let talentCons = inferGiTalentConsFromHakushDetail(detail, qIdx)
    if (gsTalentConsOverrideById[id]) {
      talentCons = gsTalentConsOverrideById[id]!
    }
    // Baseline quirk: 埃洛伊 keeps all zeros in per-character `data.json` but not in the top-level index.
    const talentConsDetail = id === '10000062' ? { a: 0, e: 0, q: 0 } : talentCons

    // Generate full talent tables + talentData for new characters (static meta is fully automatable).
    const giTalent = buildGiTalent(skillsArr, qIdx, giSkillDescOpts)

    // Index entry.
    index[id] = {
      id: Number(id),
      name,
      abbr: gsIndexAbbr(name),
      star,
      elem,
      weapon,
      talentId: giTalent?.talentId || {},
      talentCons,
      ...(etaMs != null ? { eta: etaMs } : {})
    }

    // Per-character detail file.
    const charDir = path.join(charRoot, name)
    const imgsDir = path.join(charDir, 'imgs')
    const iconsDir = path.join(charDir, 'icons')
    fs.mkdirSync(imgsDir, { recursive: true })
    fs.mkdirSync(iconsDir, { recursive: true })

    const charInfo = isRecord(detail.CharaInfo) ? (detail.CharaInfo as Record<string, unknown>) : {}
    const va = isRecord(charInfo.VA) ? (charInfo.VA as Record<string, unknown>) : {}

    // Attr table (prefer AnimeGameData curves/promotes for baseline precision).
    let baseAttr: { hp: number; atk: number; def: number }
    let growAttr: { key: string; value: number }
    let attr: ReturnType<typeof buildGiAttrTable>

    const agdRes = agdAttrCtx ? buildGiAttrTableFromAgd(agdAttrCtx, Number(id)) : null
    if (agdRes) {
      baseAttr = agdRes.baseAttr
      growAttr = agdRes.growAttr
      attr = agdRes.attr
    } else {
      // Fallback: use Hakush StatsModifier (may have 0.01 drift vs baseline).
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

      const growValue =
        growKey === 'mastery' ? growRaw : roundTo(growRaw >= 1 ? growRaw : growRaw * 100, 2)

      const ascRecords: Array<Record<string, unknown>> = []
      for (let i = 0; i < 6; i++) {
        ascRecords.push(isRecord(ascArr[i]) ? (ascArr[i] as Record<string, unknown>) : {})
      }
      attr = buildGiAttrTable({
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

      baseAttr = { hp: roundTo(hp90, 2), atk: roundTo(atk90, 2), def: roundTo(def90, 2) }
      growAttr = growKey ? { key: growKey, value: growValue } : { key: '', value: 0 }
    }

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
      consData[String(i + 1)] = { name: cName, desc: giPlainDescToLines(preferSpecialDesc(c)) }
    }

    // Passive talents. Hakush order is usually [A1/A4..., utility], baseline prefers Unlock asc (0/1/4).
    const passiveArr = Array.isArray(detail.Passives) ? (detail.Passives as Array<unknown>) : []
    const passiveData = passiveArr
      .map((p, idx) => (isRecord(p) ? { idx, rec: p as Record<string, unknown> } : null))
      .filter(Boolean)
      .map((p) => {
        const pName = typeof p!.rec.Name === 'string' ? (p!.rec.Name as string) : ''
        const unlock = typeof p!.rec.Unlock === 'number' ? (p!.rec.Unlock as number) : Number(p!.rec.Unlock)
        return pName
          ? {
              idx: p!.idx,
              id: toInt(p!.rec.Id),
              name: pName,
              desc: giPlainDescToLines(preferSpecialDesc(p!.rec)),
              unlock: Number.isFinite(unlock) ? unlock : 999
            }
          : null
      })
      .filter(Boolean) as Array<{ idx: number; id: number | null; name: string; desc: string[]; unlock: number }>

    passiveData.sort((a, b) => {
      const ra = passiveUnlockRank(a.unlock)
      const rb = passiveUnlockRank(b.unlock)
      if (ra.group !== rb.group) return ra.group - rb.group
      if (ra.order !== rb.order) return ra.order - rb.order
      const aid = a.id ?? -1
      const bid = b.id ?? -1
      if (aid !== bid) return bid - aid
      return a.idx - b.idx
    })
    const passiveOut = passiveData.map(({ name, desc }) => ({ name, desc }))

    // Baseline adds the "替代冲刺" skill block into passive list (as the last item) for Mona/Ayaka.
    const sprintSkill = s2 && typeof s2.Desc === 'string' && s2.Desc.includes('替代冲刺') ? s2 : undefined
    if (sprintSkill) {
      const sprintSkillId = toInt(sprintSkill.Id)
      const sprintId = sprintSkillId ? (gsProudSkillGroupByAvatarSkillId?.get(sprintSkillId) ?? sprintSkillId) : null
      const sprintName = typeof sprintSkill.Name === 'string' ? (sprintSkill.Name as string) : ''
      if (sprintId && sprintName) {
        const sprintDesc = giPlainDescToLines(preferSpecialDesc(sprintSkill))
        const sprintTables = buildGiTablesFromPromote(normalizePromoteList(sprintSkill.Promote))
        ;(passiveOut as Array<Record<string, unknown>>).push({
          id: sprintId,
          name: sprintName,
          desc: sprintDesc,
          tables: sprintTables
        })
      }
    }

    const costumeInfo = getCostumeInfo(charInfo)
    const costume = costumeInfo.ids.length ? costumeInfo.ids : false

    const agdDesc = gsAvatarDescById?.get(Number(id))
    const desc = agdDesc || (typeof charInfo.Detail === 'string' ? charInfo.Detail : normalizeTextInline(detail.Desc))
    const cncv = gsCncvOverrideById[id] ?? (typeof va.Chinese === 'string' ? va.Chinese : '')

    const detailData = {
      id: Number(id),
      name,
      abbr: gsDetailAbbr(name),
      title: typeof charInfo.Title === 'string' ? charInfo.Title : '',
      star,
      elem,
      allegiance: typeof charInfo.Native === 'string' ? charInfo.Native : '',
      weapon,
      birth: Array.isArray(charInfo.Birth) ? `${charInfo.Birth[0]}-${charInfo.Birth[1]}` : '',
      astro: typeof charInfo.Constellation === 'string' ? charInfo.Constellation : '',
      desc,
      cncv,
      jpcv: typeof va.Japanese === 'string' ? va.Japanese : '',
      costume,
      ver: 1,
      baseAttr,
      growAttr,
      talentId: giTalent?.talentId || {},
      talentCons: talentConsDetail,
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
      passive: passiveOut,
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
      const getDesc = (k: 'a' | 'e' | 'q'): string => {
        const blk = (giTalent.talent as any)?.[k]
        return blk && typeof blk.desc === 'string' ? (blk.desc as string) : ''
      }

      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(opts.llm, {
        game: 'gs',
        name,
        elem,
        weapon,
        star,
        tables: { a: aTables, e: eTables, q: qTables },
        talentDesc: { a: getDesc('a'), e: getDesc('e'), q: getDesc('q') }
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
    agdAttr: agdAttrCtx,
    giSkillDescOpts,
    gsAvatarDescById,
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

  const travelerIndexIds = ['20000000', '10000005', '10000007']
  for (const tid of travelerIndexIds) {
    const rec = index[tid]
    if (!isRecord(rec)) continue
    const talentId = rec.talentId
    if (!isRecord(talentId)) continue
    for (const [k, v] of Object.entries(talentId)) {
      const num = Number(k)
      if (!Number.isFinite(num) || !k.startsWith('10054')) continue
      const alias = String(num + 10)
      if (!(alias in talentId)) {
        ;(talentId as Record<string, unknown>)[alias] = v
      }
    }
  }
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
