/**
 * Shared types used across the metaGenerator tool.
 */

export type Game = 'gs' | 'sr'
export type MetaType = 'artifact' | 'character' | 'material' | 'weapon'

export interface CommandContext {
  /** Absolute path: temp/metaGenerator */
  projectRoot: string
  /** Absolute path: repository root (Yunzai root) */
  repoRoot: string
  /** process.cwd() at runtime */
  cwd: string
  /** Timestamp for this run */
  now: Date
  /** Logger interface (console-like) */
  log: Pick<Console, 'log' | 'info' | 'warn' | 'error'>
}

export interface GenOptions {
  baselineRoot: string
  outputRoot: string
  games: Game[]
  types: MetaType[]
  /** When true, overwrite output directories if they exist. */
  force: boolean
  /** When true, refresh cached upstream JSON (Hakush client cache). */
  forceCache: boolean
  /** When true, re-download assets (images) even if they exist. */
  forceAssets: boolean
  /**
   * When true, use local baseline meta as an overlay during generation (for compatibility debugging).
   *
   * Default: false (pure API generation).
   */
  baselineOverlay: boolean
}

export interface ValidateOptions {
  baselineRoot: string
  outputRoot: string
  games: Game[]
  types: MetaType[]
  /** If true, require no extra files in output. */
  strictExtra: boolean
  /**
   * If true, require non-JSON files to be byte-identical (sha256 match).
   *
   * Default (false): non-JSON differences are reported as warnings and do NOT fail validation.
   * Rationale: images and derived JS files are often regenerated with different compression/formatting.
   */
  strictSha: boolean
  /**
   * When set, validate only a random subset of files (plus critical top-level files).
   * Use `seed` to make the sampling reproducible.
   *
   * Set to 0 to only validate top-level files.
   * Set to -1 to validate all files.
   */
  sampleFiles: number
  /** Optional seed for reproducible random sampling. */
  seed?: string
}

export interface ValidateReport {
  meta: {
    baselineRoot: string
    outputRoot: string
    games: Game[]
    types: MetaType[]
    generatedAt: string
    sampling: {
      mode: 'full' | 'sample'
      sampleFiles: number
      seed: string
      alwaysIncluded: number
    }
  }
  summary: {
    ok: boolean
    totalCompared: number
    missing: number
    different: number
    warnings: number
    extra: number
  }
  missingFiles: string[]
  differentFiles: Array<{ file: string; reason: string }>
  warningFiles: Array<{ file: string; reason: string }>
  extraFiles: string[]
}
