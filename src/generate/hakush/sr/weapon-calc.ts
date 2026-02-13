/**
 * Generate `meta-sr/weapon/<path>/calc.js` from generated lightcone skill descriptions.
 *
 * Goal:
 * - Keep scaffold lean (no pre-bundled per-lightcone buff tables).
 * - Provide a "best effort" weaponBuffs mapping for common, deterministic patterns.
 *
 * Scope (heuristic, no LLM):
 * - Parse `$k[i]` placeholders in `weapon/<type>/<name>/data.json` (skill.desc + skill.tables)
 * - Map simple stat/dmg patterns to miao-plugin keys (atkPct/cpct/dmg/qDmg/...).
 * - Only marks buffs as `isStatic` when the clause looks unconditional.
 *
 * NOTE:
 * - This is intentionally conservative. Unknown patterns are skipped.
 */

import fs from 'node:fs'
import path from 'node:path'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function stripHtml(s: string): string {
  return s.replace(/<[^>]+>/g, '')
}

function extractClause(text: string, pos: number): { clause: string; before: string } {
  const delims = ['，', '。', '；', ';', ',', '\n']
  let start = 0
  for (const d of delims) {
    const i = text.lastIndexOf(d, pos - 1)
    if (i >= 0) start = Math.max(start, i + 1)
  }
  let end = text.length
  for (const d of delims) {
    const i = text.indexOf(d, pos)
    if (i >= 0) end = Math.min(end, i)
  }
  const clause = text.slice(start, end).trim()
  const before = text.slice(start, pos).trim()
  return { clause, before }
}

const STATIC_ATTR_KEYS = new Set([
  // Base attrs / rates (supported by miao-plugin AttrData.addAttr)
  'atkPct',
  'hpPct',
  'defPct',
  'atkPlus',
  'hpPlus',
  'defPlus',
  'speedPct',
  'speed',
  'cpct',
  'cdmg',
  'recharge',
  'heal',
  'shield',
  'stance',
  'effPct',
  'effDef',
  // Generic dmg%
  'dmg'
])

type KeyIdxSpec = { kind: 'keyIdx'; title: string; key: string; idx: number } | { kind: 'keyIdxMap'; title: string; map: Record<string, number> }
type StaticSpec = { kind: 'staticIdx'; key: string; idx: number }
type BuffSpec = KeyIdxSpec | StaticSpec

function inferKeysFromText(text: string): string[] {
  const s = String(text || '').trim()
  if (!s) return []

  // Enemy DEF ignore (e.g. "无视目标50%的防御力"). Must be checked before the generic "防御力" stat branch.
  if ((s.includes('无视') || s.toLowerCase().includes('ignore')) && s.includes('防御')) {
    // DoT ignore (e.g. "造成的持续伤害无视目标X%防御力") must map to `dotIgnore` (not global `ignore`).
    if (/(持续伤害|\bdot\b)/i.test(s)) return ['dotIgnore']
    return ['ignore']
  }

  // Prefer the most local + specific signal.
  if (s.includes('暴击率')) return ['cpct']
  if (s.includes('暴击伤害')) return ['cdmg']
  if (s.includes('效果命中')) return ['effPct']
  if (s.includes('效果抵抗')) return ['effDef']
  if (s.includes('击破特攻')) return ['stance']
  if (s.includes('能量恢复') || s.includes('能量回复') || s.includes('点能量') || (s.includes('恢复') && s.includes('能量'))) {
    return ['recharge']
  }
  if (s.includes('速度')) return s.includes('%') ? ['speedPct'] : ['speed']
  if (s.includes('生命上限') || s.includes('生命值')) return ['hpPct']
  if (s.includes('防御力')) return ['defPct']
  if (s.includes('攻击力')) return ['atkPct']

  // Damage-related (SR: skill buckets are not valid static keys; must use keyIdx)
  const dmgLike = s.includes('伤害') || s.includes('增伤') || s.includes('造成的伤害')
  if (dmgLike) {
    const hasE = s.includes('战技')
    const hasQ = s.includes('终结技')
    const hasT = s.includes('追加攻击') || s.includes('追击')
    const hasA = s.includes('普攻') || s.includes('普通攻击')

    if ((hasE && hasQ) || s.includes('战技和终结技')) return ['eDmg', 'qDmg']
    if ((hasQ && hasT) || s.includes('终结技和追加攻击') || s.includes('终结技和追击')) return ['qDmg', 'tDmg']
    if ((hasE && hasT) || s.includes('战技和追加攻击') || s.includes('战技和追击')) return ['eDmg', 'tDmg']
    if (hasQ) return ['qDmg']
    if (hasE) return ['eDmg']
    if (hasT) return ['tDmg']
    if (hasA) return ['aDmg']
    return ['dmg']
  }

  // Fallback: generic dmg%
  if (s.includes('造成的伤害') || s.includes('伤害提高') || s.includes('伤害提升')) return ['dmg']

  return []
}

function defaultTitleForKeys(keys: string[]): string {
  const has = (k: string) => keys.includes(k)
  if (has('eDmg') && has('qDmg')) return '战技和终结技造成的伤害提高[eDmg]%'
  if (has('qDmg') && has('tDmg')) return '终结技和追加攻击造成的伤害提高[qDmg]%'
  if (has('eDmg') && has('tDmg')) return '战技和追加攻击造成的伤害提高[eDmg]%'
  const k = keys[0] || ''
  if (k === 'qDmg') return '终结技造成的伤害提高[qDmg]%'
  if (k === 'eDmg') return '战技造成的伤害提高[eDmg]%'
  if (k === 'tDmg') return '追加攻击造成的伤害提高[tDmg]%'
  if (k === 'aDmg') return '普攻造成的伤害提高[aDmg]%'
  if (k === 'dmg') return '造成的伤害提高[dmg]%'
  if (k === 'cpct') return '暴击率提高[cpct]%'
  if (k === 'cdmg') return '暴击伤害提高[cdmg]%'
  if (k === 'atkPct') return '攻击力提高[atkPct]%'
  if (k === 'hpPct') return '生命值上限提高[hpPct]%'
  if (k === 'defPct') return '防御力提高[defPct]%'
  if (k === 'speedPct') return '速度提高[speedPct]%'
  if (k === 'speed') return '速度提高[speed]点'
  if (k === 'recharge') return '能量恢复效率提高[recharge]%'
  if (k === 'effPct') return '效果命中提高[effPct]%'
  if (k === 'effDef') return '效果抵抗提高[effDef]%'
  if (k === 'stance') return '击破特攻提高[stance]%'
  if (k === 'ignore') return '无视目标[ignore]%的防御力'
  return `被动：${k || 'buff'}`
}

function buildSpecForPlaceholder(opts: { text: string; clause: string; before: string; idx: number; pos: number }): BuffSpec | null {
  const { text, clause, before, idx, pos } = opts
  // Prefer a tight window within the clause; avoid bleeding into previous sentences
  // (e.g. "$2" being misread as "暴击率" due to "$1" sentence nearby).
  const localPos = Math.max(0, before.length)
  const near = clause.slice(Math.max(0, localPos - 24), Math.min(clause.length, localPos + 24))
  const nearWide = clause.slice(Math.max(0, localPos - 48), Math.min(clause.length, localPos + 48))

  const ctx = text.slice(Math.max(0, pos - 96), Math.min(text.length, pos + 96))
  const ctxWide = text.slice(Math.max(0, pos - 160), Math.min(text.length, pos + 160))

  const scoreKeys = (keys: string[]): number => {
    const skillKeys = new Set(['aDmg', 'eDmg', 'qDmg', 'tDmg'])
    const skillCount = keys.filter((k) => skillKeys.has(k)).length
    // Strongly prefer skill-bucket mappings (eDmg/qDmg/...) over generic dmg.
    return skillCount * 100 + keys.length
  }

  let bestKeys: string[] = []
  let bestScore = -Infinity
  for (const cand of [near, nearWide, ctx, ctxWide]) {
    const keys = inferKeysFromText(cand)
    if (!keys.length) continue
    const score = scoreKeys(keys)
    if (score > bestScore) {
      bestScore = score
      bestKeys = keys
    }
  }
  if (!bestKeys.length) return null
  const keys = bestKeys

  // Static buffs are only meaningful for base attrs (AttrData does NOT support skill-bucket keys like qDmg/eDmg).
  const beforeCtx = text.slice(Math.max(0, pos - 96), pos)
  if (keys.length === 1 && STATIC_ATTR_KEYS.has(keys[0]!) && guessIsStatic(before, beforeCtx)) {
    return { kind: 'staticIdx', idx, key: keys[0]! }
  }

  const title = defaultTitleForKeys(keys)
  if (keys.length === 1) {
    return { kind: 'keyIdx', title, key: keys[0]!, idx }
  }

  const map: Record<string, number> = {}
  for (const k of keys) map[k] = idx
  return { kind: 'keyIdxMap', title, map }
}

function guessIsStatic(before: string, beforeCtx: string): boolean {
  // If the part before the variable looks like a plain stat statement without triggers,
  // treat it as static; otherwise make it a selectable buff.
  const hay = `${beforeCtx} ${before}`
  const triggerWords = [
    '当',
    '若',
    '每',
    '后',
    '时',
    '受到',
    '被',
    '施放',
    '释放',
    '使用',
    '入战',
    '战斗',
    '回合',
    '消耗',
    '损失',
    '获得',
    '进入',
    '解除',
    '击败',
    '消灭',
    '叠加',
    '持续'
  ]
  if (!hay.includes('提高') && !hay.includes('提升') && !hay.includes('增加')) return false
  for (const w of triggerWords) {
    if (hay.includes(w)) return false
  }
  return true
}

function tryBuildEnergyCapBuff(text: string): { expr: string; usedIdx: number } | null {
  // Example (Hakush):
  // - "根据装备者的能量上限，提高装备者造成的伤害：每点能量提高$1[i]%，最多计入160点。"
  // Baseline convention: model as dmg% = tables[idx] * min(attr.sp, cap)
  const mIdx = text.match(/每点能量提高\s*\$(\d+)\[(?:i|f1|f2)]\s*%/)
  if (!mIdx) return null
  const idx = Number(mIdx[1])
  if (!Number.isFinite(idx) || idx <= 0) return null

  const mCap = text.match(/最多计入\s*(\d{2,3})\s*点/)
  const cap = mCap ? Math.trunc(Number(mCap[1])) : 160
  if (!Number.isFinite(cap) || cap <= 0 || cap > 999) return null

  // Must be a damage bonus sentence (avoid misreading "受到伤害降低").
  if (!/伤害/.test(text) || /(受到|承受).{0,8}伤害/.test(text)) return null

  // Skill bucket (prefer Q when explicit).
  const key = /终结技/.test(text) ? 'qDmg' : 'dmg'
  const title = key === 'qDmg' ? '根据装备者的能量上限提高伤害[qDmg]%' : '根据能量上限提高伤害[dmg]%'
  const expr =
    `(tables) => ({ ` +
    `title: "${title}", ` +
    `data: { ${key}: ({ attr }) => (tables[${idx}] || 0) * Math.min(attr.sp || 0, ${cap}) } ` +
    `})`
  return { expr, usedIdx: idx }
}

function tryBuildStackCapBuff(text: string): { expr: string; usedIdx: number[] } | null {
  // Baseline convention: when a buff can stack up to N layers and each layer provides the same bonus,
  // weapon calc.js often models the showcase at max stacks: value = tables[idx] * N.
  //
  // Examples:
  // - "晚安与睡颜": "最多叠加3层" -> dmg = tables[1] * 3
  // - "重塑时光之忆": "最多叠加4层 ... 每层...攻击力提高$2% ... 持续伤害无视$3%防御" -> atkPct/dotIgnore = tables[*] * 4
  const mStack = text.match(/(?:最多叠加|至多叠加|最多拥有|至多拥有)\s*(\d{1,2})\s*层/)
  if (!mStack) return null
  const maxStacks = Math.trunc(Number(mStack[1]))
  if (!Number.isFinite(maxStacks) || maxStacks <= 1 || maxStacks > 20) return null

  const matches = Array.from(text.matchAll(/\$(\d+)\[(?:i|f1|f2)]/g))
  if (matches.length === 0) return null

  type Cand = { idx: number; pos: number; clause: string; before: string }
  const cands: Cand[] = []

  const extractSentence = (t: string, pos: number): { sentence: string; start: number } => {
    const delims = ['。', '；', ';', '\n']
    let start = 0
    for (const d of delims) {
      const i = t.lastIndexOf(d, pos - 1)
      if (i >= 0) start = Math.max(start, i + 1)
    }
    let end = t.length
    for (const d of delims) {
      const i = t.indexOf(d, pos)
      if (i >= 0) end = Math.min(end, i)
    }
    return { sentence: t.slice(start, end), start }
  }

  for (const m of matches) {
    const idx = Math.trunc(Number(m[1]))
    if (!Number.isFinite(idx) || idx <= 0) continue
    const pos = typeof m.index === 'number' ? m.index : -1
    if (pos < 0) continue

    const { sentence, start } = extractSentence(text, pos)
    if (!sentence) continue
    const localPos = pos - start
    const eachLayerPos = sentence.indexOf('每层')
    const capPos = sentence.search(/(?:最多叠加|至多叠加|最多拥有|至多拥有)\s*\d{1,2}\s*层/)
    const isPerLayer = eachLayerPos >= 0 ? localPos >= eachLayerPos : capPos >= 0 ? localPos < capPos : false
    if (!isPerLayer) continue

    const { clause, before } = extractClause(text, pos)
    if (!clause) continue
    cands.push({ idx, pos, clause, before })
  }

  if (cands.length === 0) return null

  const uniqByIdx = new Map<number, Cand>()
  for (const c of cands) if (!uniqByIdx.has(c.idx)) uniqByIdx.set(c.idx, c)

  const dataExpr: Record<string, string> = {}
  const usedIdx: number[] = []

  for (const c of uniqByIdx.values()) {
    const spec = buildSpecForPlaceholder({ text, clause: c.clause, before: c.before, idx: c.idx, pos: c.pos })
    if (!spec) continue

    const map: Record<string, number> =
      spec.kind === 'keyIdxMap'
        ? spec.map
        : spec.kind === 'keyIdx'
          ? { [spec.key]: spec.idx }
          : { [spec.key]: spec.idx }

    for (const [k, idx] of Object.entries(map)) {
      const key = String(k || '').trim()
      if (!key) continue
      if (key in dataExpr) continue
      dataExpr[key] = `tables[${idx}] * ${maxStacks}`
    }
    usedIdx.push(c.idx)
  }

  const keys = Object.keys(dataExpr)
  if (keys.length === 0) return null

  const title = (() => {
    const has = (k: string) => keys.includes(k)
    if (keys.length === 1 && has('dmg')) return `${maxStacks}层Buff提高伤害[dmg]%`
    if (keys.length === 1 && has('speedPct')) return `${maxStacks}层Buff提高速度[speedPct]%`
    if (keys.length === 1 && has('atkPct')) return `${maxStacks}层Buff提高攻击力[atkPct]%`
    if (has('atkPct') && has('dotIgnore')) return `${maxStacks}层Buff提高攻击力[atkPct]%，造成的持续伤害无视目标[dotIgnore]%的防御力`
    return `${maxStacks}层Buff`
  })()

  const dataPairs = Object.entries(dataExpr)
    .map(([k, v]) => `${k}: ${v}`)
    .join(', ')
  const expr = `(tables) => ({ title: ${JSON.stringify(title)}, data: { ${dataPairs} } })`
  return { expr, usedIdx }
}

function renderTypeCalcJs(entries: Array<{ name: string; expr: string }>): string {
  const lines: string[] = []
  lines.push('/**')
  lines.push(' * Auto-generated lightcone buff table (heuristic).')
  lines.push(' *')
  lines.push(' * Source: metaGenerator generated lightcone skill.desc + skill.tables')
  lines.push(' * Notes:')
  lines.push(' * - Only simple patterns are mapped; unknown patterns are skipped.')
  lines.push(' * - This file is overwritten by meta-gen; do not hand-edit.')
  lines.push(' */')
  lines.push('export default function (staticIdx, keyIdx) {')
  lines.push('  return {')
  for (const it of entries) {
    lines.push(`    ${JSON.stringify(it.name)}: ${it.expr},`)
  }
  lines.push('  }')
  lines.push('}')
  lines.push('')
  return lines.join('\n')
}

export async function generateSrWeaponCalcJs(opts: {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  log?: Pick<Console, 'info' | 'warn'>
}): Promise<void> {
  const weaponRoot = path.join(opts.metaSrRootAbs, 'weapon')
  if (!fs.existsSync(weaponRoot)) return

  const typeDirs = fs
    .readdirSync(weaponRoot, { withFileTypes: true })
    .filter((ent) => ent.isDirectory())
    .map((ent) => ent.name)

  let totalMapped = 0

  for (const typeDir of typeDirs) {
    const dirAbs = path.join(weaponRoot, typeDir)
    const entries: Array<{ name: string; expr: string }> = []

    const weaponDirs = fs
      .readdirSync(dirAbs, { withFileTypes: true })
      .filter((ent) => ent.isDirectory())
      .map((ent) => ent.name)

    for (const weaponName of weaponDirs) {
      const dataPath = path.join(dirAbs, weaponName, 'data.json')
      if (!fs.existsSync(dataPath)) continue

      let json: unknown
      try {
        json = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      } catch {
        continue
      }
      if (!isRecord(json)) continue
      const skill = isRecord(json.skill) ? (json.skill as Record<string, unknown>) : undefined
      const descRaw = typeof skill?.desc === 'string' ? (skill.desc as string) : ''
      if (!descRaw) continue

      const text = stripHtml(descRaw)

      // Special deterministic patterns (must come before generic placeholder mapping).
      // These are used to match baseline-style dynamic buffs.
      const specialEnergy = tryBuildEnergyCapBuff(text)
      const specialStack = tryBuildStackCapBuff(text)

      const matches = Array.from(text.matchAll(/\$(\d+)\[(?:i|f1|f2)]/g))
      if (!specialEnergy && !specialStack && matches.length === 0) continue

      const parts: string[] = []
      const specialParts: string[] = []
      const usedIdx = new Set<number>()
      if (specialEnergy) {
        specialParts.push(specialEnergy.expr)
        usedIdx.add(specialEnergy.usedIdx)
      }
      if (specialStack) {
        specialParts.push(specialStack.expr)
        for (const idx of specialStack.usedIdx) usedIdx.add(idx)
      }
      for (const m of matches) {
        const idxStr = m[1]
        const idx = Number(idxStr)
        if (!Number.isFinite(idx) || idx <= 0) continue
        if (usedIdx.has(idx)) continue
        const pos = typeof m.index === 'number' ? m.index : -1
        if (pos < 0) continue

        const { clause, before } = extractClause(text, pos)
        const spec = buildSpecForPlaceholder({ text, clause, before, idx, pos })
        if (!spec) continue
        if (spec.kind === 'staticIdx') {
          parts.push(`staticIdx(${idx}, ${JSON.stringify(spec.key)})`)
          continue
        }
        if (spec.kind === 'keyIdx') {
          parts.push(`keyIdx(${JSON.stringify(spec.title)}, ${JSON.stringify(spec.key)}, ${idx})`)
          continue
        }
        parts.push(`keyIdx(${JSON.stringify(spec.title)}, ${JSON.stringify(spec.map)})`)
      }

      parts.push(...specialParts)

      if (parts.length === 0) continue
      totalMapped++

      const expr = parts.length === 1 ? parts[0]! : `[${parts.join(', ')}]`
      entries.push({ name: weaponName, expr })
    }

    // Always write a file to overwrite scaffold tables (even if empty).
    const outFile = path.join(dirAbs, 'calc.js')
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, renderTypeCalcJs(entries), 'utf8')
  }

  opts.log?.info?.(`[meta-gen] (sr) weapon calc.js generated (heuristic): ${totalMapped}`)
}
