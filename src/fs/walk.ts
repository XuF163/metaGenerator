import fs from 'node:fs'
import path from 'node:path'

export interface WalkFilesOptions {
  /** Basename set to ignore. */
  ignoreNames?: Set<string>
}

/**
 * Async generator yielding absolute file paths under `rootDir` (depth-first).
 */
export async function* walkFiles(rootDir: string, opts: WalkFilesOptions = {}): AsyncGenerator<string> {
  const ignoreNames = opts.ignoreNames ?? new Set<string>()

  const entries = fs.readdirSync(rootDir, { withFileTypes: true })
  for (const ent of entries) {
    if (ignoreNames.has(ent.name)) continue

    const full = path.join(rootDir, ent.name)
    if (ent.isDirectory()) {
      yield* walkFiles(full, opts)
      continue
    }
    if (ent.isFile()) {
      yield full
    }
  }
}

