/**
 * SR character directory compat helpers.
 *
 * Some baseline metas ship per-character `calc_auto.js` for team damage calculation.
 * We generate a minimal shim that re-exports from `calc.js` (no baseline dependency).
 */

import fs from 'node:fs'
import path from 'node:path'

function ensureFile(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return
  fs.writeFileSync(filePath, content, 'utf8')
}

function ensureCalcAutoJs(charDirAbs: string): void {
  const calcPath = path.join(charDirAbs, 'calc.js')
  if (!fs.existsSync(calcPath)) return

  const filePath = path.join(charDirAbs, 'calc_auto.js')
  ensureFile(
    filePath,
    [
      '/**',
      ' * Auto-generated team-calc shim.',
      ' *',
      ' * When miao-plugin enables team damage calculation, it may prefer `calc_auto.js`.',
      ' * We re-export from `calc.js` to keep behaviour consistent by default.',
      ' */',
      "export { details, defDmgIdx, defDmgKey, mainAttr, defParams, buffs, createdBy } from './calc.js'",
      ''
    ].join('\n')
  )
}

function ensureRootAliasExports(charRootAbs: string): void {
  // `scaffold/meta-sr/character/index.js` imports `{ alias, abbr }` from `./alias.js`.
  // Older scaffold snapshots only exported `alias`, causing runtime import failures.
  const aliasPath = path.join(charRootAbs, 'alias.js')
  if (!fs.existsSync(aliasPath)) return
  let raw = ''
  try {
    raw = fs.readFileSync(aliasPath, 'utf8')
  } catch {
    return
  }
  if (raw.includes('export const abbr')) return
  try {
    const out = raw.trimEnd() + '\n\n// Required by `character/index.js`.\nexport const abbr = {}\n'
    fs.writeFileSync(aliasPath, out, 'utf8')
  } catch {
    // Ignore repair failures.
  }
}

export interface EnsureSrCharacterFilesOptions {
  /** Absolute path to `.../meta-sr` */
  metaSrRootAbs: string
}

export function ensureSrCharacterFiles(opts: EnsureSrCharacterFilesOptions): void {
  const charRoot = path.join(opts.metaSrRootAbs, 'character')
  if (!fs.existsSync(charRoot)) return

  ensureRootAliasExports(charRoot)

  const entries = fs.readdirSync(charRoot, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'common') continue
    if (ent.name.startsWith('.')) continue

    ensureCalcAutoJs(path.join(charRoot, ent.name))
  }
}

