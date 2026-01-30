/**
 * Minimal CLI argument parser.
 *
 * We intentionally avoid adding commander/yargs for MVP to keep the tool lightweight.
 * If the CLI grows complex later, we can replace this module while keeping command APIs stable.
 */

import path from 'node:path'
import type { Game, GenOptions, MetaType, ValidateOptions } from '../types.js'
import type { ToolConfig } from '../config/config.js'

type ParsedOk = {
  ok: true
  data: {
    command: 'gen' | 'validate' | 'fetch' | 'calc' | 'help'
    options: GenOptions & ValidateOptions
    helpText: string
  }
}

type ParsedErr = { ok: false; error: string }

function splitCsv(value: string): string[] {
  return value
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function parseGames(value: string | undefined): Game[] {
  if (!value || value === 'all') return ['gs', 'sr']
  const list = splitCsv(value)
  const games = new Set<Game>()
  for (const v of list) {
    if (v === 'gs' || v === 'sr') games.add(v)
  }
  return Array.from(games)
}

function parseTypes(value: string | undefined): MetaType[] {
  if (!value || value === 'all') return ['artifact', 'character', 'material', 'weapon']
  const list = splitCsv(value)
  const types = new Set<MetaType>()
  for (const v of list) {
    if (v === 'artifact' || v === 'character' || v === 'material' || v === 'weapon') {
      types.add(v)
    }
  }
  return Array.from(types)
}

function getHelpText(): string {
  return [
    'meta-gen (temp/metaGenerator)',
    '',
    'Usage:',
    '  meta-gen gen [options]',
    '  meta-gen fetch [options]',
    '  meta-gen validate [options]',
    '  meta-gen calc [options]',
    '',
    'Options:',
    '  --baseline-root <path>   validate: baseline root for compare (default: plugins/miao-plugin/resources)',
    '  --output-root <path>     output root (default: temp/metaGenerator/.output)',
    '  --games <gs|sr|all|csv>  default: all',
    '  --types <type|all|csv>   artifact,character,material,weapon (default: all)',
    '  --force                  gen: wipe output meta-{game} before generating',
    '  --force-cache            gen: refresh cached upstream JSON (Hakush)',
    '  --force-assets           gen: re-download assets (images) if they exist',
    '  --baseline-overlay       gen: overlay baseline meta while generating (debug; default: false)',
    '  --sample-files <n>       validate: random sample file count (default from config or 800)',
    '  --sample <n>             alias of --sample-files',
    '  --full                   validate: compare all files (ignore sampling)',
    '  --seed <seed>            validate: reproducible sampling seed',
    '  --strict-extra           validate: fail if output has extra files',
    '  --strict-sha             validate: fail if non-JSON sha256 differs',
    '  -h, --help               show help',
    ''
  ].join('\n')
}

/**
 * Parse process.argv into a command + strongly-typed options.
 */
export function parseCliArgs(argv: string[], config?: ToolConfig): ParsedOk | ParsedErr {
  const helpText = getHelpText()
  const defaults = getDefaultOptions(config)
  const args = argv.slice(2)
  const command = (args.shift() || 'help') as string

  if (command === '-h' || command === '--help') {
    return { ok: true, data: { command: 'help', options: defaults, helpText } }
  }

  if (!['gen', 'fetch', 'validate', 'calc', 'help'].includes(command)) {
    return { ok: false, error: `Unknown command: ${command}\n\n${helpText}` }
  }

  const optsRaw: Record<string, string | boolean> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-h' || a === '--help') {
      return { ok: true, data: { command: 'help', options: defaults, helpText } }
    }
    if (!a.startsWith('--')) {
      return { ok: false, error: `Unexpected arg: ${a}\n\n${helpText}` }
    }
    const key = a.slice(2)
    if (
      key === 'force' ||
      key === 'force-cache' ||
      key === 'force-assets' ||
      key === 'baseline-overlay' ||
      key === 'strict-extra' ||
      key === 'strict-sha' ||
      key === 'full'
    ) {
      optsRaw[key] = true
      continue
    }
    const next = args[i + 1]
    if (!next || next.startsWith('--')) {
      return { ok: false, error: `Missing value for --${key}\n\n${helpText}` }
    }
    optsRaw[key] = next
    i++
  }

  const baselineRoot = (optsRaw['baseline-root'] as string | undefined) || defaults.baselineRoot
  const outputRoot = (optsRaw['output-root'] as string | undefined) || defaults.outputRoot

  const games = optsRaw['games'] ? parseGames(optsRaw['games'] as string) : defaults.games
  const types = optsRaw['types'] ? parseTypes(optsRaw['types'] as string) : defaults.types

  let sampleFiles = defaults.sampleFiles
  if (optsRaw['full']) {
    sampleFiles = -1
  } else if (optsRaw['sample-files'] || optsRaw['sample']) {
    const raw = (optsRaw['sample-files'] || optsRaw['sample']) as string
    const n = Number.parseInt(raw, 10)
    if (!Number.isFinite(n)) {
      return { ok: false, error: `Invalid --sample-files value: ${raw}\n\n${helpText}` }
    }
    sampleFiles = n
  }

  const seed = (optsRaw['seed'] as string | undefined) || defaults.seed

  if (games.length === 0) {
    return { ok: false, error: `Invalid --games value\n\n${helpText}` }
  }
  if (types.length === 0) {
    return { ok: false, error: `Invalid --types value\n\n${helpText}` }
  }

  const options = {
    baselineRoot: path.normalize(baselineRoot),
    outputRoot: path.normalize(outputRoot),
    games,
    types,
    force: Boolean(optsRaw['force']) || defaults.force,
    forceCache: Boolean(optsRaw['force-cache']) || defaults.forceCache,
    forceAssets: Boolean(optsRaw['force-assets']) || defaults.forceAssets,
    baselineOverlay: Boolean(optsRaw['baseline-overlay']) || defaults.baselineOverlay,
    strictExtra: Boolean(optsRaw['strict-extra']) || defaults.strictExtra,
    strictSha: Boolean(optsRaw['strict-sha']) || defaults.strictSha,
    sampleFiles,
    seed
  }

  return {
    ok: true,
    data: {
      command: command as 'gen' | 'fetch' | 'validate' | 'calc' | 'help',
      options: options as unknown as GenOptions & ValidateOptions,
      helpText
    }
  }
}

function getDefaultOptions(config?: ToolConfig): GenOptions & ValidateOptions {
  return {
    baselineRoot: config?.baselineRoot || 'plugins/miao-plugin/resources',
    outputRoot: config?.outputRoot || 'temp/metaGenerator/.output',
    games: (config?.games?.length ? config.games : ['gs', 'sr']) as Game[],
    types: (config?.types?.length
      ? config.types
      : ['artifact', 'character', 'material', 'weapon']) as MetaType[],
    force: Boolean(config?.gen?.force),
    forceCache: Boolean(config?.gen?.forceCache),
    forceAssets: Boolean(config?.gen?.forceAssets),
    baselineOverlay: Boolean(config?.gen?.baselineOverlay),
    strictExtra: Boolean(config?.validate?.strictExtra),
    strictSha: Boolean(config?.validate?.strictSha),
    sampleFiles: Number.isFinite(config?.validate?.sampleFiles) ? (config?.validate?.sampleFiles as number) : 800,
    seed: config?.validate?.seed || undefined
  }
}
