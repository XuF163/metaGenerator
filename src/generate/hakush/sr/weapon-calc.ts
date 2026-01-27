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

function mapKeyFromClause(clause: string): string | null {
  // Damage-specific first (avoid mapping to generic dmg too early)
  if (clause.includes('终结技')) return 'qDmg'
  if (clause.includes('战技')) return 'eDmg'
  if (clause.includes('追加攻击')) return 'tDmg'
  if (clause.includes('普攻') || clause.includes('普通攻击')) return 'aDmg'

  // Generic damage
  if (clause.includes('造成的伤害') || clause.includes('伤害提高') || clause.includes('伤害提升')) return 'dmg'

  // Base stats / rates
  if (clause.includes('攻击力')) return 'atkPct'
  if (clause.includes('生命值') || clause.includes('生命上限')) return 'hpPct'
  if (clause.includes('防御力')) return 'defPct'
  if (clause.includes('速度')) return clause.includes('%') ? 'speedPct' : 'speed'
  if (clause.includes('暴击率')) return 'cpct'
  if (clause.includes('暴击伤害')) return 'cdmg'
  if (clause.includes('效果命中')) return 'effPct'
  if (clause.includes('效果抵抗')) return 'effDef'
  if (clause.includes('击破特攻')) return 'stance'
  if (clause.includes('能量恢复') || clause.includes('能量回复')) return 'recharge'

  return null
}

function guessIsStatic(before: string): boolean {
  // If the part before the variable looks like a plain stat statement without triggers,
  // treat it as static; otherwise make it a selectable buff.
  const triggerWords = ['当', '若', '每', '后', '时', '受到', '施放', '使用', '消灭', '击败', '进入', '解除', '获得']
  if (!before.includes('提高') && !before.includes('提升') && !before.includes('增加')) return false
  for (const w of triggerWords) {
    if (before.includes(w)) return false
  }
  return true
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
      const matches = Array.from(text.matchAll(/\$(\d+)\[i]/g))
      if (matches.length === 0) continue

      const parts: string[] = []
      for (const m of matches) {
        const idxStr = m[1]
        const idx = Number(idxStr)
        if (!Number.isFinite(idx) || idx <= 0) continue
        const pos = typeof m.index === 'number' ? m.index : -1
        if (pos < 0) continue

        const { clause, before } = extractClause(text, pos)
        const key = mapKeyFromClause(clause)
        if (!key) continue

        const isStatic = guessIsStatic(before)
        if (isStatic) {
          parts.push(`staticIdx(${idx}, ${JSON.stringify(key)})`)
        } else {
          // Keep title short to fit weak/slow renderers; the full desc is still in data.json.
          const title = `被动：${key}`
          parts.push(`keyIdx(${JSON.stringify(title)}, ${JSON.stringify(key)}, ${idx})`)
        }
      }

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
