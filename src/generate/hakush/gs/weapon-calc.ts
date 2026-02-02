/**
 * Generate `meta-gs/weapon/<type>/calc.js` from upstream structured data.
 *
 * Sources:
 * - AnimeGameData EquipAffixExcelConfigData.addProps (unconditional addProps)
 * - meta-gs weapon `data.json` affixData (text + placeholder arrays)
 *
 * Strategy (deterministic):
 * - Always emit unconditional addProps as `isStatic` buffs.
 * - Additionally, parse a small set of common affix text patterns into numeric buff keys
 *   (e.g. "造成的伤害提高$[1]" => dmg).
 *
 * Notes:
 * - We intentionally do NOT aim to cover every complex conditional weapon mechanic here.
 * - For stackable passives, we default to "max stacks" when the stack hint appears in the same sentence.
 */

import fs from 'node:fs'
import path from 'node:path'
import type { AnimeGameDataClient } from '../../../source/animeGameData/client.js'

type WeaponTypeDir = 'sword' | 'claymore' | 'polearm' | 'catalyst' | 'bow'

const weaponTypeMap: Record<string, WeaponTypeDir | undefined> = {
  WEAPON_SWORD_ONE_HAND: 'sword',
  WEAPON_CLAYMORE: 'claymore',
  WEAPON_POLE: 'polearm',
  WEAPON_CATALYST: 'catalyst',
  WEAPON_BOW: 'bow'
}

type PropRule = { key: string; scale: number }
const propToBuffKey: Record<string, PropRule | undefined> = {
  // Base attrs
  FIGHT_PROP_ATTACK: { key: 'atkPlus', scale: 1 },
  FIGHT_PROP_HP: { key: 'hpPlus', scale: 1 },
  FIGHT_PROP_DEFENSE: { key: 'defPlus', scale: 1 },

  // Percent attrs
  FIGHT_PROP_ATTACK_PERCENT: { key: 'atkPct', scale: 100 },
  FIGHT_PROP_HP_PERCENT: { key: 'hpPct', scale: 100 },
  FIGHT_PROP_DEFENSE_PERCENT: { key: 'defPct', scale: 100 },
  FIGHT_PROP_CRITICAL: { key: 'cpct', scale: 100 },
  FIGHT_PROP_CRITICAL_HURT: { key: 'cdmg', scale: 100 },
  FIGHT_PROP_CHARGE_EFFICIENCY: { key: 'recharge', scale: 100 },
  FIGHT_PROP_HEAL_ADD: { key: 'heal', scale: 100 },
  FIGHT_PROP_ADD_HURT: { key: 'dmg', scale: 100 },
  FIGHT_PROP_SHIELD_COST_MINUS_RATIO: { key: 'shield', scale: 100 },

  // Element / physical dmg bonus
  FIGHT_PROP_PHYSICAL_ADD_HURT: { key: 'phy', scale: 100 },
  FIGHT_PROP_FIRE_ADD_HURT: { key: 'pyro', scale: 100 },
  FIGHT_PROP_WATER_ADD_HURT: { key: 'hydro', scale: 100 },
  FIGHT_PROP_ELEC_ADD_HURT: { key: 'electro', scale: 100 },
  FIGHT_PROP_ICE_ADD_HURT: { key: 'cryo', scale: 100 },
  FIGHT_PROP_WIND_ADD_HURT: { key: 'anemo', scale: 100 },
  FIGHT_PROP_ROCK_ADD_HURT: { key: 'geo', scale: 100 },
  FIGHT_PROP_GRASS_ADD_HURT: { key: 'dendro', scale: 100 },

  // Flat mastery
  FIGHT_PROP_ELEMENT_MASTERY: { key: 'mastery', scale: 1 }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNumber(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function firstNonZeroNumber(arr: unknown): number | null {
  if (!Array.isArray(arr)) return null
  for (const v of arr) {
    const n = toNumber(v)
    if (n != null && n > 0) return n
  }
  return null
}

type EquipAffixRow = {
  id: number
  level: number
  addProps: Array<{ propType: string; value: number }>
}

function parseEquipAffixRows(raw: unknown): EquipAffixRow[] {
  const rows: EquipAffixRow[] = []
  if (!Array.isArray(raw)) return rows
  for (const it of raw) {
    if (!isRecord(it)) continue
    const id = toNumber(it.id)
    const level = toNumber(it.level)
    const addPropsRaw = Array.isArray(it.addProps) ? (it.addProps as unknown[]) : []
    if (id == null || level == null) continue
    const addProps: Array<{ propType: string; value: number }> = []
    for (const p of addPropsRaw) {
      if (!isRecord(p)) continue
      const propType = typeof p.propType === 'string' ? (p.propType as string) : ''
      const value = toNumber(p.value)
      if (!propType || value == null) continue
      addProps.push({ propType, value })
    }
    rows.push({ id, level, addProps })
  }
  return rows
}

type WeaponAffixSeed = {
  id: number
  name: string
  typeDir: WeaponTypeDir
  skillAffixId: number
}

type ExtraRefineBuff = { title: string; refine: Record<string, number[]> }
type WeaponBuffOut = { staticRefine: Record<string, number[]>; extras: ExtraRefineBuff[] }

function buildStaticRefineFromAddProps(rows: EquipAffixRow[]): Record<string, number[]> {
  // Map: buffKey -> [r1..r5]
  const out: Record<string, number[]> = {}
  if (!rows.length) return out

  const sorted = rows.slice().sort((a, b) => a.level - b.level)
  const hasZeroBased = sorted.some((r) => r.level === 0)
  const hasOneBased = !hasZeroBased && sorted.some((r) => r.level === 1)

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i]!
    const idx = hasZeroBased ? row.level : hasOneBased ? row.level - 1 : i
    if (idx < 0 || idx > 4) continue

    for (const p of row.addProps) {
      const rule = propToBuffKey[p.propType]
      if (!rule) continue
      if (!p.value || !Number.isFinite(p.value)) continue
      const v = round2(p.value * rule.scale)
      if (!v) continue
      if (!out[rule.key]) out[rule.key] = [0, 0, 0, 0, 0]
      out[rule.key]![idx] = v
    }
  }

  // Remove all-zero keys.
  for (const [k, arr] of Object.entries(out)) {
    if (!arr.some((v) => v !== 0)) delete out[k]
  }
  return out
}

function parseAffixNumber(vRaw: unknown): number | null {
  const s = typeof vRaw === 'string' ? vRaw : String(vRaw ?? '')
  const t = s.trim()
  if (!t) return null
  const m = t.match(/-?\d+(?:\.\d+)?/)
  if (!m) return null
  const n = Number(m[0])
  return Number.isFinite(n) ? n : null
}

function parseAffixNumberList(valuesRaw: unknown): number[] | null {
  if (!Array.isArray(valuesRaw) || valuesRaw.length < 5) return null
  const out: number[] = []
  for (const v of valuesRaw.slice(0, 5)) {
    const n = parseAffixNumber(v)
    out.push(n == null ? 0 : n)
  }
  // Some affix placeholders are empty for all refine ranks; ignore them.
  if (!out.some((n) => n !== 0)) return null
  return out
}

function readWeaponAffixData(opts: { weaponDataPath: string }): { text: string; datas: Record<string, string[]> } | null {
  let raw: unknown
  try {
    raw = JSON.parse(fs.readFileSync(opts.weaponDataPath, 'utf8'))
  } catch {
    return null
  }
  if (!isRecord(raw)) return null
  const affix = (raw as any).affixData
  if (!isRecord(affix)) return null
  const text = typeof affix.text === 'string' ? affix.text : ''
  const datasRaw = affix.datas
  if (!text || !isRecord(datasRaw)) return null

  const datas: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(datasRaw as Record<string, unknown>)) {
    if (!k) continue
    if (!Array.isArray(v)) continue
    datas[k] = v.map((x) => String(x ?? ''))
  }
  if (Object.keys(datas).length === 0) return null
  return { text, datas }
}

function localMaxStacks(hint: string): number {
  const m = hint.match(/(?:至多|最多)叠加(\d+)(?:层|次)/)
  if (!m) return 1
  const n = Number(m[1])
  if (!Number.isFinite(n)) return 1
  const nn = Math.max(1, Math.floor(n))
  return nn > 10 ? 10 : nn
}

function titleForKey(key: string, text: string): string {
  if (key === 'dmg' && /燃烧/.test(text)) return '对处于燃烧状态的敌人造成伤害提升[dmg]%'
  if (key === 'dmg') return '造成的伤害提升[dmg]%'
  if (key === 'atkPct') return '攻击力提升[atkPct]%'
  if (key === 'hpPct') return '生命值提升[hpPct]%'
  if (key === 'defPct') return '防御力提升[defPct]%'
  if (key === 'recharge') return '元素充能效率提升[recharge]%'
  if (key === 'cpct') return '暴击率提升[cpct]%'
  if (key === 'eCpct') return '元素战技暴击率提升[eCpct]%'
  if (key === 'qCpct') return '元素爆发暴击率提升[qCpct]%'
  if (key === 'cdmg') return '暴击伤害提升[cdmg]%'
  if (key === 'mastery') return '元素精通提升[mastery]'
  if (key === 'aDmg') return '普通攻击造成的伤害提升[aDmg]%'
  if (key === 'a2Dmg') return '重击造成的伤害提升[a2Dmg]%'
  if (key === 'a3Dmg') return '下落攻击造成的伤害提升[a3Dmg]%'
  if (key === 'eDmg') return '元素战技造成的伤害提升[eDmg]%'
  if (key === 'qDmg') return '元素爆发造成的伤害提升[qDmg]%'
  return `${key}提升[${key}]%`
}

function inferExtraBuffsFromAffix(opts: {
  weaponName: string
  affixText: string
  affixDatas: Record<string, string[]>
}): ExtraRefineBuff[] {
  const out: ExtraRefineBuff[] = []
  const text = opts.affixText
  const datas = opts.affixDatas

  // HP-scaling elemental damage bonus with an explicit cap.
  //
  // Example (seen on some catalysts): "释放元素爆发后...元素伤害加成提高$[x]，每1000点生命值上限提高$[y]，至多提高$[z]"
  //
  // Baseline often treats this as an always-on showcase buff. We approximate by taking the capped placeholder
  // directly (i.e. assume HP is high enough to reach the cap), which matches most real panels for these weapons.
  if (
    /生命值上限/.test(text) &&
    /每\s*1000\s*点/.test(text) &&
    /元素伤害/.test(text) &&
    /(至多|最多|上限|最大)[^$]{0,80}?\$\[(\d+)\]/.test(text)
  ) {
    // Prefer explicit cap hints ("至多/最多") over generic words like "生命值上限".
    const mCap =
      text.match(/(?:至多|最多)[^$]{0,80}?\$\[(\d+)\]/) ||
      text.match(/(?:上限|最大)[^$]{0,80}?\$\[(\d+)\]/)
    const capPlaceholder = mCap ? mCap[1] : ''
    const capNums = capPlaceholder ? parseAffixNumberList(datas[capPlaceholder]) : null
    if (capNums) {
      const title = /(?:释放|施放)元素爆发/.test(text)
        ? '释放元素爆发后基于生命值提高元素伤害[dmg]%'
        : '基于生命值提高元素伤害[dmg]%'
      return [{ title, refine: { dmg: capNums } }]
    }
  }

  // Some affixes say multiple effects "同时存在/同时生效时…分别提升50%".
  // Baseline commonly assumes the "both active" showcase state, so we apply the boost to parsed extra buffs.
  const synergyMult =
    /(同时存在|同时生效)/.test(text) && /(分别)?(?:提高|提升)\s*50\s*[%％]/.test(text) ? 1.5 : 1

  const add = (key: string, placeholder: string, stackMult: number): void => {
    const nums = parseAffixNumberList(datas[placeholder])
    if (!nums) return
    const scaled0 = stackMult > 1 ? nums.map((n) => round2(n * stackMult)) : nums
    const scaled = synergyMult !== 1 ? scaled0.map((n) => round2(n * synergyMult)) : scaled0
    out.push({ title: titleForKey(key, text), refine: { [key]: scaled } })
  }

  const patterns: Array<{ key: string; re: RegExp }> = [
    // Stat buffs (commonly modelled by baseline as always-on/max-state for showcase)
    // Context-aware crit: prefer binding to skill/burst when the same clause mentions it.
    { key: 'eCpct', re: /元素战技[^。；;]{0,80}?暴击率[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'qCpct', re: /元素爆发[^。；;]{0,80}?暴击率[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'cpct', re: /暴击率[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    // Lunar reaction crit dmg (special key in miao-plugin weapon calc: fycdmg)
    { key: 'fycdmg', re: /月曜反应[^。；;]{0,80}?暴击伤害[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'cdmg', re: /暴击伤害[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'mastery', re: /元素精通[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'atkPct', re: /攻击力[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'atkPct', re: /\$\[(\d+)\]\s*攻击力(?:提高|提升|增加)/g },
    { key: 'hpPct', re: /(?:生命值上限|生命值)[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'hpPct', re: /\$\[(\d+)\]\s*(?:生命值上限|生命值)(?:提高|提升|增加)/g },
    { key: 'defPct', re: /防御力[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'defPct', re: /\$\[(\d+)\]\s*防御力(?:提高|提升|增加)/g },
    { key: 'recharge', re: /元素充能效率[^$]{0,12}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'aDmg', re: /普通攻击[^。；;]{0,80}?(?:伤害|造成的伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'a2Dmg', re: /重击[^。；;]{0,80}?(?:伤害|造成的伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'a3Dmg', re: /下落攻击[^。；;]{0,80}?(?:伤害|造成的伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'eDmg', re: /元素战技[^。；;]{0,80}?(?:伤害|造成的伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    { key: 'qDmg', re: /元素爆发[^。；;]{0,80}?(?:伤害|造成的伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g },
    // Generic "damage +" (keep last to avoid stealing more specific matches).
    { key: 'dmg', re: /(?:造成的伤害|造成的所有伤害|造成的元素伤害)[^$]{0,15}?(?:提高|提升|增加)\$\[(\d+)\]/g }
  ]

  type Cand = { key: string; placeholder: string; stackMult: number; nearby: string; capHint: boolean }

  const scan = (seg: string): Cand[] => {
    const cands: Cand[] = []
    const seen = new Set<string>()
    const usedPlaceholder = new Set<string>()
    for (const { key, re } of patterns) {
      re.lastIndex = 0
      let m: RegExpExecArray | null
      while ((m = re.exec(seg))) {
        const placeholder = m[1]
        if (!placeholder) continue
        const tag = `${key}:${placeholder}`
        if (seen.has(tag)) continue
        // Prefer a single semantic mapping per placeholder id (baseline weapon buffs are usually 1:1).
        if (usedPlaceholder.has(placeholder)) continue

        // Prefer stack hints that are in the same "effect clause".
        // Semicolons often separate unrelated effects, so stop scanning at the next semicolon.
        const semi1 = seg.indexOf('；', m.index)
        const semi2 = seg.indexOf(';', m.index)
        let end = m.index + 260
        const semi = [semi1, semi2].filter((n) => n >= 0).sort((a, b) => a - b)[0]
        if (typeof semi === 'number' && Number.isFinite(semi)) end = Math.min(end, semi)
        const nearby = seg.slice(m.index, Math.min(seg.length, end))
        // Only treat this placeholder as the "cap" value when the matched phrase itself contains cap hints
        // (e.g. "...至多提高$[x]" / "...上限$[x]"), not just because a later clause mentions a cap.
        const capHint = /(至多|最多|上限|最大)/.test(m[0] || '')
        const stackMult = localMaxStacks(nearby)
        cands.push({ key, placeholder, stackMult, nearby, capHint })
        seen.add(tag)
        usedPlaceholder.add(placeholder)
      }
    }
    return cands
  }

  const isAlternative = (raw: string): boolean => {
    if (!raw.includes('；') && !raw.includes(';')) return false
    const parts = raw
      .split(/[；;]/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (parts.length !== 2) return false
    if (!/时/.test(parts[0]) || !/时/.test(parts[1])) return false
    return /(至少|少于|大于|小于|高于|低于|超过|不足|以上|以下|存在|不存在)/.test(raw)
  }

  const weights: Record<string, number> = {
    dmg: 3,
    aDmg: 3,
    a2Dmg: 3,
    a3Dmg: 3,
    eDmg: 3,
    qDmg: 3,
    cpct: 2.5,
    cdmg: 2.5,
    mastery: 1.2,
    atkPct: 1.5,
    hpPct: 1.0,
    // Keep DEF weight very low: baseline usually defaults to damage-oriented showcase states.
    defPct: 0.1,
    recharge: 0.5
  }

  const score = (cands: Cand[]): number => {
    let s = 0
    for (const c of cands) {
      const nums = parseAffixNumberList(datas[c.placeholder])
      if (!nums) continue
      const max = Math.max(...nums)
      const w = weights[c.key] ?? 1
      s += w * max * (c.stackMult > 1 ? c.stackMult : 1)
    }
    return s
  }

  const segs = isAlternative(text)
    ? (() => {
        const parts = text
          .split(/[；;]/)
          .map((s) => s.trim())
          .filter(Boolean)
        const scored = parts.map((p) => ({ p, cands: scan(p) }))
        scored.sort((a, b) => score(b.cands) - score(a.cands))
        return scored.length ? [scored[0]!.p] : [text]
      })()
    : [text]

  const all = segs.flatMap((s) => scan(s))

  // If a key has a "max cap" hint (e.g. "至多提高$[x]" / "上限$[x]"), prefer the capped placeholder.
  const byKey = new Map<string, Cand[]>()
  for (const c of all) {
    const arr = byKey.get(c.key) || []
    arr.push(c)
    byKey.set(c.key, arr)
  }

  for (const [key, arr] of byKey) {
    const hasCap = arr.some((c) => c.capHint)
    const picked = hasCap ? arr.filter((c) => c.capHint) : arr
    for (const c of picked) add(key, c.placeholder, c.stackMult)
  }

  return out
}

function renderCalcJs(buffByName: Record<string, WeaponBuffOut>): string {
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * Auto-generated weapon buff table (deterministic).')
  lines.push(' *')
  lines.push(' * Sources:')
  lines.push(' * - AnimeGameData EquipAffixExcelConfigData.addProps')
  lines.push(' * - Weapon affix text placeholders (meta weapon data.json -> affixData)')
  lines.push(' * Notes:')
  lines.push(' * - Unconditional addProps are emitted as isStatic buffs.')
  lines.push(' * - Some common affix patterns (dmg/aDmg/eDmg/qDmg...) are parsed into refine buffs.')
  lines.push(' * - Complex conditional mechanics may still be absent.')
  lines.push(' */')
  lines.push('export default function (step, staticStep) {')
  lines.push('  return {')
  const names = Object.keys(buffByName).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))
  for (const name of names) {
    const buff = buffByName[name]!
    const staticRefine = buff.staticRefine
    const staticKeys = Object.keys(staticRefine).sort()
    const extras = Array.isArray(buff.extras) ? buff.extras : []

    const hasStatic = staticKeys.length > 0
    const hasExtras = extras.length > 0
    if (!hasStatic && !hasExtras) continue

    if (!hasExtras) {
      lines.push(`    ${JSON.stringify(name)}: {`)
      lines.push('      isStatic: true,')
      lines.push('      refine: {')
      for (const k of staticKeys) {
        lines.push(`        ${k}: ${JSON.stringify(staticRefine[k])},`)
      }
      lines.push('      }')
      lines.push('    },')
      continue
    }

    lines.push(`    ${JSON.stringify(name)}: [`)
    if (hasStatic) {
      lines.push('      {')
      lines.push('        isStatic: true,')
      lines.push('        refine: {')
      for (const k of staticKeys) {
        lines.push(`          ${k}: ${JSON.stringify(staticRefine[k])},`)
      }
      lines.push('        }')
      lines.push('      },')
    }

    for (let i = 0; i < extras.length; i++) {
      const ex = extras[i]!
      const refine = ex.refine || {}
      const keys = Object.keys(refine).sort()
      if (!keys.length) continue
      lines.push('      {')
      lines.push(`        title: ${JSON.stringify(ex.title)},`)
      lines.push('        refine: {')
      for (const k of keys) {
        lines.push(`          ${k}: ${JSON.stringify(refine[k])},`)
      }
      lines.push('        }')
      lines.push(i === extras.length - 1 ? '      }' : '      },')
    }
    lines.push('    ],')
  }
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

export async function generateGsWeaponCalcJs(opts: {
  /** Absolute path to `.../.output/meta-gs` */
  metaGsRootAbs: string
  animeGameData: AnimeGameDataClient
  log?: Pick<Console, 'info' | 'warn'>
}): Promise<void> {
  const weaponRoot = path.join(opts.metaGsRootAbs, 'weapon')

  // Load AGD weapon config to map (weaponId -> name/typeDir/skillAffixId).
  const weaponExcelRaw = await opts.animeGameData.getGsWeaponExcelConfigData()
  const weaponRows: Array<Record<string, unknown>> = Array.isArray(weaponExcelRaw)
    ? ((weaponExcelRaw as unknown[]).filter(isRecord) as Array<Record<string, unknown>>)
    : []

  const textMapRaw = await opts.animeGameData.getGsTextMapCHS()
  const textMap: Record<string, string> = isRecord(textMapRaw) ? (textMapRaw as Record<string, string>) : {}
  const textMapGet = (hash: unknown): string => {
    const key = String(hash ?? '')
    return typeof textMap[key] === 'string' ? textMap[key]! : ''
  }

  const equipAffixRaw = await opts.animeGameData.getGsEquipAffixExcelConfigData()
  const equipAffixRows = parseEquipAffixRows(equipAffixRaw)

  const seeds: WeaponAffixSeed[] = []
  for (const row of weaponRows) {
    const id = toNumber(row.id)
    if (id == null) continue
    const weaponType = typeof row.weaponType === 'string' ? (row.weaponType as string) : ''
    const typeDir = weaponType ? weaponTypeMap[weaponType] : undefined
    if (!typeDir) continue

    const name = textMapGet(row.nameTextMapHash)
    if (!name) continue

    const skillAffixId = firstNonZeroNumber((row as any).skillAffix)
    if (!skillAffixId) continue

    seeds.push({ id, name, typeDir, skillAffixId })
  }

  const byType: Record<WeaponTypeDir, Record<string, WeaponBuffOut>> = {
    sword: {},
    claymore: {},
    polearm: {},
    catalyst: {},
    bow: {}
  }

  for (const s of seeds) {
    const rows = equipAffixRows.filter((r) => r.id === s.skillAffixId)
    const staticRefine = buildStaticRefineFromAddProps(rows)

    const weaponDataPath = path.join(weaponRoot, s.typeDir, s.name, 'data.json')
    const affix = fs.existsSync(weaponDataPath) ? readWeaponAffixData({ weaponDataPath }) : null
    const extrasRaw = affix
      ? inferExtraBuffsFromAffix({ weaponName: s.name, affixText: affix.text, affixDatas: affix.datas })
      : []
    // Avoid double-emitting keys that already exist in unconditional addProps *only when values are identical*.
    // Some weapons have a base addProp and an additional conditional affix using the same buff key (e.g. hpPct).
    const staticKeys = new Set(Object.keys(staticRefine))
    const extras = extrasRaw.filter((b) => {
      const refine = b.refine || {}
      const keys = Object.keys(refine)
      if (keys.length === 0) return false
      for (const k of keys) {
        if (!staticKeys.has(k)) return true
        const sv = staticRefine[k]
        const ev = refine[k]
        if (JSON.stringify(sv) !== JSON.stringify(ev)) return true
      }
      return false
    })

    if (Object.keys(staticRefine).length === 0 && extras.length === 0) continue
    byType[s.typeDir][s.name] = { staticRefine, extras }
  }

  // Write per-type calc.js (always overwrite; derived file).
  for (const [typeDir, buffByName] of Object.entries(byType) as Array<[WeaponTypeDir, Record<string, WeaponBuffOut>]>) {
    const outFile = path.join(weaponRoot, typeDir, 'calc.js')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, renderCalcJs(buffByName), 'utf8')
  }

  const total = Object.values(byType).reduce((acc, m) => acc + Object.keys(m).length, 0)
  opts.log?.info?.(`[meta-gen] (gs) weapon calc.js generated: ${total}`)
}
