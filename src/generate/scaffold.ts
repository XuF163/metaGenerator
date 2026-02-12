/**
 * Meta scaffolding (skeleton files).
 *
 * Goal:
 * - `gen` should NOT depend on baseline meta repo content.
 * - But miao-plugin meta dirs still need low-frequency "skeleton" JS files
 *   (index.js/alias.js/extra.js/...) to be loadable.
 *
 * Strategy:
 * - Copy skeleton files from metaGenerator's own scaffold snapshot:
 *   `<projectRoot>/scaffold/meta-{gs|sr}`
 * - The snapshot must only contain low-frequency skeleton files required by runtime
 *   (typically `.js` and a few static `.json` like SR artifact meta.json).
 * - Do NOT copy high-frequency generated outputs:
 *   - any `data.json` under artifact/character/material/weapon
 *   - any per-entity directories (character/<name>, weapon/<type>/<name>, artifact/<setName>, ...)
 *
 * This keeps generation source-of-truth in upstream structured data (Hakush, etc.),
 * while still providing a runnable meta directory.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../fs/ensure.js'
import type { CommandContext, Game, MetaType } from '../types.js'

const IGNORE_NAMES = new Set(['.git', '.gitignore', '.DS_Store', 'Thumbs.db', '.ace-tool'])

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function copyFile(srcFile: string, dstFile: string, overwrite: boolean): void {
  if (!overwrite && fs.existsSync(dstFile)) return
  ensureDir(path.dirname(dstFile))
  fs.copyFileSync(srcFile, dstFile)
}

function copyDirSkeleton(srcDir: string, dstDir: string, overwrite: boolean): void {
  ensureDir(dstDir)
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const ent of entries) {
    if (IGNORE_NAMES.has(ent.name)) continue
    // Safety belt: scaffold snapshot must not ship dynamic outputs.
    if (ent.isFile() && ent.name === 'data.json') continue

    const src = path.join(srcDir, ent.name)
    const dst = path.join(dstDir, ent.name)

    if (ent.isDirectory()) {
      copyDirSkeleton(src, dst, overwrite)
      continue
    }
    if (ent.isFile()) {
      copyFile(src, dst, overwrite)
    }
  }
}

function scaffoldTemplateRoot(ctx: CommandContext, game: Game): string {
  // Hard rule: generation must not depend on:
  // - baseline meta (`plugins/miao-plugin/resources/meta-*`)
  // - optional template snapshot under miao-plugin (`resources/fuck_qsyhh/...`)
  //
  // Those dirs may be absent or replaced by git operations in some environments.
  // We ship our own snapshot inside metaGenerator.
  const template = path.join(ctx.projectRoot, 'scaffold', `meta-${game}`)
  if (isDir(template)) return template
  throw new Error(`[meta-gen] Missing scaffold template directory: ${template}`)
}

export interface ScaffoldMetaOptions {
  ctx: CommandContext
  outputRootAbs: string
  games: Game[]
  types: MetaType[]
  /**
   * When true, removes output dirs before scaffolding.
   *
   * NOTE:
   * - We ONLY wipe the selected `types` dirs (artifact/character/material/weapon) so
   *   `gen --force --types character` won't accidentally delete weapon/artifact meta
   *   that is required by runtime panel regression.
   * - To fully reset a game output, pass all types (default config uses all types).
   */
  force: boolean
}

/**
 * Ensure output meta directories contain required skeleton files so they can be loaded by miao-plugin.
 */
export function scaffoldMeta(opts: ScaffoldMetaOptions): void {
  for (const game of opts.games) {
    const templateRoot = scaffoldTemplateRoot(opts.ctx, game)
    const outMetaDir = path.join(opts.outputRootAbs, `meta-${game}`)

    if (opts.force) {
      for (const type of opts.types) {
        const dstTypeDir = path.join(outMetaDir, type)
        if (fs.existsSync(dstTypeDir)) {
          fs.rmSync(dstTypeDir, { recursive: true, force: true })
        }
      }
    }

    ensureDir(outMetaDir)

    // Root-level low-frequency dirs (non-generated, stable).
    const infoDir = path.join(templateRoot, 'info')
    if (isDir(infoDir)) {
      copyDirSkeleton(infoDir, path.join(outMetaDir, 'info'), true)
    }

    // SR public icons are low-frequency runtime assets. Prefer scaffold snapshot when present.
    if (game === 'sr') {
      const publicDir = path.join(templateRoot, 'public')
      if (isDir(publicDir)) {
        copyDirSkeleton(publicDir, path.join(outMetaDir, 'public'), true)
      } else {
        ensureDir(path.join(outMetaDir, 'public', 'icons'))
      }
    }

    // Type-level skeleton files (index.js/alias.js/extra.js/... and weapon type calc.js).
    for (const type of opts.types) {
      const src = path.join(templateRoot, type)
      const dst = path.join(outMetaDir, type)
      if (!isDir(src)) {
        opts.ctx.log?.warn?.(`[meta-gen] scaffold missing: ${src}`)
        continue
      }
      copyDirSkeleton(src, dst, true)
    }

    // Root-level .gitignore is harmless and helps local tooling; keep it if present.
    const tmplGitignore = path.join(templateRoot, '.gitignore')
    const outGitignore = path.join(outMetaDir, '.gitignore')
    if (isFile(tmplGitignore)) copyFile(tmplGitignore, outGitignore, true)
  }
}
