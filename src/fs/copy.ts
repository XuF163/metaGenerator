import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './ensure.js'

export interface CopyDirOptions {
  /** Basename set to ignore while copying. */
  ignoreNames?: Set<string>
}

/**
 * Recursively copy directory `srcDir` -> `dstDir`.
 *
 * Notes:
 * - This is implemented manually instead of fs.cp for better control and
 *   compatibility with older Node (though we currently run Node 24).
 * - Copy is best-effort and will throw on any IO error (caller can decide rollback).
 */
export async function copyDir(srcDir: string, dstDir: string, opts: CopyDirOptions = {}): Promise<void> {
  const ignoreNames = opts.ignoreNames ?? new Set<string>()

  ensureDir(dstDir)
  const entries = fs.readdirSync(srcDir, { withFileTypes: true })
  for (const ent of entries) {
    if (ignoreNames.has(ent.name)) continue

    const src = path.join(srcDir, ent.name)
    const dst = path.join(dstDir, ent.name)

    if (ent.isDirectory()) {
      await copyDir(src, dst, opts)
      continue
    }
    if (ent.isSymbolicLink()) {
      // We intentionally do not preserve symlinks in MVP to avoid surprising behavior.
      // If meta repo introduces symlinks later, we'll add explicit support.
      continue
    }
    if (ent.isFile()) {
      ensureDir(path.dirname(dst))
      fs.copyFileSync(src, dst)
    }
  }
}

