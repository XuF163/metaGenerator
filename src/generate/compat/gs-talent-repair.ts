/**
 * Repair/normalize GS talent tables in already-generated output.
 *
 * Why:
 * - `meta-gen gen` is incremental and may skip rewriting existing `data.json`.
 * - Some structure details are easy to normalize locally without re-fetching upstream.
 *
 * What:
 * - When a table has `isSame=true`, baseline meta stores a single value in `values`.
 * - Older outputs may have repeated identical values; we compact them.
 *
 * This does NOT change numeric meaning; it only normalizes representation.
 */

import fs from 'node:fs'
import path from 'node:path'
import { walkFiles } from '../../fs/walk.js'
import { writeJsonFile } from '../../fs/json.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function compactSameTableValues(block: unknown): boolean {
  if (!isRecord(block)) return false
  const tables = block.tables
  if (!Array.isArray(tables)) return false

  let changed = false
  for (const t of tables) {
    if (!isRecord(t)) continue
    if (t.isSame !== true) continue
    const values = t.values
    if (!Array.isArray(values) || values.length <= 1) continue

    const first = values[0]
    if (values.every((v) => v === first)) {
      ;(t as any).values = [first]
      changed = true
    }
  }
  return changed
}

function compactTalentTables(data: unknown): boolean {
  if (!isRecord(data)) return false
  const talent = data.talent
  if (!isRecord(talent)) return false

  let changed = false
  for (const v of Object.values(talent)) {
    if (compactSameTableValues(v)) changed = true
  }
  return changed
}

export async function repairGsTalentTables(metaGsRootAbs: string, log?: Pick<Console, 'info' | 'warn'>): Promise<void> {
  const charRoot = path.join(metaGsRootAbs, 'character')
  if (!fs.existsSync(charRoot)) return

  let scanned = 0
  let updated = 0

  for await (const filePath of walkFiles(charRoot, { ignoreNames: new Set(['.ace-tool']) })) {
    if (path.basename(filePath) !== 'data.json') continue
    // Skip top-level character/data.json index.
    if (path.dirname(filePath) === charRoot) continue

    scanned++
    let raw: unknown
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown
    } catch {
      continue
    }

    if (!compactTalentTables(raw)) continue

    writeJsonFile(filePath, raw)
    updated++
    if (updated === 1 || updated % 50 === 0) {
      log?.info?.(`[meta-gen] (gs) talent table repaired: ${updated}/${scanned}`)
    }
  }

  if (updated > 0) {
    log?.info?.(`[meta-gen] (gs) talent table repair done: updated=${updated} scanned=${scanned}`)
  }
}

