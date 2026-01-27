/**
 * SR lightcone generator (Hakush -> meta-sr/weapon/*).
 *
 * Hakush provides lightcone stats + refinements, but `Desc` (story flavor text)
 * is often missing. We generate a compatible structure; for missing story text,
 * we keep `desc` empty.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { logAssetError } from '../../../log/run-log.js'
import type { HakushClient } from '../../../source/hakush/client.js'
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
    .trim()
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

function refinementDescAndTables(ref: Record<string, unknown>): { desc: string; tables: Record<string, number[]> } {
  const rawDesc = typeof ref.Desc === 'string' ? ref.Desc : ''
  const levels = isRecord(ref.Level) ? (ref.Level as Record<string, unknown>) : {}

  // Gather param lists for levels 1..5.
  const lvKeys = Object.keys(levels)
    .map((k) => Number(k))
    .filter((n) => Number.isFinite(n))
    .sort((a, b) => a - b)
    .map((n) => String(n))

  const paramLists: number[][] = []
  for (const k of lvKeys) {
    const v = levels[k]
    if (!isRecord(v) || !Array.isArray(v.ParamList)) continue
    const nums = (v.ParamList as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x)))
    if (nums.every((n) => Number.isFinite(n))) {
      paramLists.push(nums as number[])
    }
  }

  if (paramLists.length === 0) {
    return { desc: normalizeSrRichText(rawDesc.replaceAll('#', '$')), tables: {} }
  }

  const paramCount = Math.max(...paramLists.map((a) => a.length))
  const isPercentParam = (idx: number): boolean => rawDesc.includes(`#${idx + 1}[i]%`)

  // Determine constant vs variable params.
  const isConstant: boolean[] = []
  for (let i = 0; i < paramCount; i++) {
    const vals = paramLists.map((arr) => arr[i]).filter((v) => typeof v === 'number') as number[]
    const first = vals[0]
    isConstant[i] = vals.length > 0 && vals.every((v) => v === first)
  }

  // Assign variable placeholders.
  const varMap = new Map<number, number>()
  let varIdx = 0
  for (let i = 0; i < paramCount; i++) {
    if (!isConstant[i]) {
      varIdx++
      varMap.set(i, varIdx)
    }
  }

  const tables: Record<string, number[]> = {}
  for (const [origIdx, outIdx] of varMap.entries()) {
    // HSR ParamList stores percentages as decimals (e.g. 0.2 => 20%).
    // miao-plugin uses "percent number" semantics (divide by 100 during calc),
    // so we scale percent params by *100 here to match baseline meta.
    const scale = isPercentParam(origIdx) ? 100 : 1
    const vals = paramLists.map((arr) => {
      const v = arr[origIdx] ?? 0
      const out = v * scale
      return Number.isFinite(out) ? Math.round(out * 10000) / 10000 : 0
    })
    tables[String(outIdx)] = vals
  }

  // Replace placeholders in desc:
  // - remove <color> tags
  // - convert <unbreak> to <nobr>
  // - #n[i] => $k[i] (variable) or constant literal (constant)
  const desc = normalizeSrRichText(
    rawDesc.replace(/#(\d+)\[i]/g, (_m, nStr: string) => {
      const origIdx = Number(nStr) - 1
      if (!Number.isFinite(origIdx) || origIdx < 0) return _m
      if (isConstant[origIdx]) {
        const v = paramLists[0]?.[origIdx]
        if (typeof v !== 'number' || !Number.isFinite(v)) return _m
        if (isPercentParam(origIdx)) return (v * 100).toFixed(1)
        if (Number.isInteger(v)) return String(v)
        return String(v)
      }
      const mapped = varMap.get(origIdx)
      return mapped ? `$${mapped}[i]` : _m
    })
  )

  return { desc, tables }
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
    const needsDetail = !fs.existsSync(lcDataPath)
    const needsIndex = !weaponIndex[id]

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

        const baseAttr = {
          atk: baseAtk + growAtk * (maxLevel - 1),
          hp: baseHp + growHp * (maxLevel - 1),
          def: baseDef + growDef * (maxLevel - 1)
        }

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
        const { desc: skillDesc, tables } = refinementDescAndTables(refinements)

        const lcData = {
          id: String(task.id),
          name: typeof detail.Name === 'string' ? detail.Name : task.name,
          star: task.star,
          desc: normalizeSrRichText(detail.Desc),
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
      weaponIndex[task.id] = { id: String(task.id), name: task.name, type: task.baseType, star: task.star }
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

