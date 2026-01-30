/**
 * CLI router / top-level composition root.
 *
 * This file is intentionally small: it wires argv -> command handlers.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { genCommand } from './commands/gen.js'
import { fetchCommand } from './commands/fetch.js'
import { validateCommand } from './commands/validate.js'
import { calcCommand } from './commands/calc.js'
import { loadToolConfig } from './config/config.js'
import { initNetworkDefaults } from './http/network.js'
import { initRunLog } from './log/run-log.js'
import { parseCliArgs } from './utils/cli-args.js'
import { formatError } from './utils/errors.js'
import type { CommandContext } from './types.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

function getProjectRoot(): string {
  // dist/ -> project root
  return path.resolve(__dirname, '..')
}

function getRepoRoot(): string {
  // Resolve repo root robustly:
  // - When metaGenerator lives under `temp/metaGenerator`, repo root is 2 levels up.
  // - When metaGenerator is a standalone repo, repo root is the project root.
  //
  // We use the nearest ancestor that contains a `.git` directory/file.
  // (This also works for worktrees where `.git` is a file.)
  const start = getProjectRoot()
  let cur = start

  while (true) {
    const gitPath = path.join(cur, '.git')
    if (fs.existsSync(gitPath)) return cur

    const parent = path.dirname(cur)
    if (!parent || parent === cur) break
    cur = parent
  }

  // Fallback: preserve previous behavior (two levels up) in non-git environments.
  return path.resolve(start, '..', '..')
}

/**
 * Entrypoint used by cli.ts.
 */
export async function runCli(argv: string[]): Promise<void> {
  const defaultsFromConfig = loadToolConfig(getProjectRoot()) ?? undefined
  initNetworkDefaults(defaultsFromConfig)
  const parsed = parseCliArgs(argv, defaultsFromConfig)
  if (!parsed.ok) {
    console.error(parsed.error)
    process.exitCode = 1
    return
  }

  const ctx: CommandContext = {
    projectRoot: getProjectRoot(),
    repoRoot: getRepoRoot(),
    cwd: process.cwd(),
    now: new Date(),
    log: console
  }

  if (parsed.data.command !== 'help') {
    initRunLog({ projectRoot: ctx.projectRoot, now: ctx.now, command: parsed.data.command })
  }

  try {
    switch (parsed.data.command) {
      case 'gen':
        await genCommand(ctx, parsed.data.options)
        return
      case 'fetch':
        await fetchCommand(ctx, parsed.data.options)
        return
      case 'validate':
        await validateCommand(ctx, parsed.data.options)
        return
      case 'calc':
        await calcCommand(ctx, parsed.data.options)
        return
      case 'help':
      default:
        console.log(parsed.data.helpText)
        return
    }
  } catch (err) {
    console.error(formatError(err))
    process.exitCode = 1
  }
}
