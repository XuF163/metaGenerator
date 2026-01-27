import path from 'node:path'
import type { CommandContext } from '../types.js'

/**
 * Resolve a path relative to the repo root.
 *
 * Rationale:
 * - Users may run the CLI from repo root or from temp/metaGenerator.
 * - We want defaults like "plugins/miao-plugin/resources" to work in both cases.
 */
export function resolveRepoPath(ctx: CommandContext, inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.join(ctx.repoRoot, inputPath)
}

