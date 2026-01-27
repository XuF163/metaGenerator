/**
 * CLI router / top-level composition root.
 *
 * This file is intentionally small: it wires argv -> command handlers.
 */

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
  // temp/metaGenerator -> repo root
  return path.resolve(getProjectRoot(), '..', '..')
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
