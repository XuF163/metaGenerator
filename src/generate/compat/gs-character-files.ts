/**
 * GS character directory compat helpers.
 *
 * Baseline meta commonly contains low-frequency per-character helper files:
 * - `artis.js`     (artifact scoring rule hook)
 * - `calc_auto.js` (team damage calc when enabled)
 *
 * This generator MUST NOT read/copy baseline meta as a fallback. Instead we create
 * minimal, generic stubs that keep runtime behaviour reasonable and the file-set
 * closer to baseline.
 */

import fs from 'node:fs'
import path from 'node:path'

function ensureFile(filePath: string, content: string): void {
  if (fs.existsSync(filePath)) return
  fs.writeFileSync(filePath, content, 'utf8')
}

function ensureArtisJs(charDirAbs: string): void {
  const filePath = path.join(charDirAbs, 'artis.js')
  ensureFile(
    filePath,
    [
      '/**',
      ' * Auto-generated default artifact scoring rule.',
      ' *',
      ' * This minimal rule delegates to `def()` so miao-plugin can apply',
      ' * its built-in usefulAttr-based weighting (meta-gs/artifact/artis-mark.js).',
      ' */',
      'export default function ({ def }) {',
      '  return def()',
      '}',
      ''
    ].join('\n')
  )
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
      ' * miao-plugin will prefer `calc_auto.js` when `teamCalc` is enabled.',
      ' * We re-export from `calc.js` to keep behaviour consistent by default.',
      ' */',
      "export { details, defDmgIdx, defDmgKey, mainAttr, defParams, buffs, createdBy } from './calc.js'",
      ''
    ].join('\n')
  )
}

export interface EnsureGsCharacterFilesOptions {
  /** Absolute path to `.../meta-gs` */
  metaGsRootAbs: string
}

export function ensureGsCharacterFiles(opts: EnsureGsCharacterFilesOptions): void {
  const charRoot = path.join(opts.metaGsRootAbs, 'character')
  if (!fs.existsSync(charRoot)) return

  const entries = fs.readdirSync(charRoot, { withFileTypes: true })
  for (const ent of entries) {
    if (!ent.isDirectory()) continue
    if (ent.name === 'common') continue
    if (ent.name.startsWith('.')) continue

    const charDir = path.join(charRoot, ent.name)
    ensureArtisJs(charDir)
    ensureCalcAutoJs(charDir)
  }
}

