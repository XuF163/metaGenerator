/**
 * Generation command (MVP).
 *
 * Design:
 * - Output is generated from structured upstream sources (currently Hakush + AnimeGameData).
 * - Baseline meta is only used for validate/compare and gap finding; it is NOT a generation input.
 * - Generation is idempotent:
 *   - default: only fills missing entries (keeps existing output files)
 *   - `--force`: wipes `meta-{game}` output dirs and regenerates everything
 */

import path from 'node:path'
import { scaffoldMeta } from '../generate/scaffold.js'
import { ensureCommonAssets } from '../generate/common-assets.js'
import { ensureGsCharacterFiles } from '../generate/compat/gs-character-files.js'
import { ensureSrCharacterFiles } from '../generate/compat/sr-character-files.js'
import { repairGsTalentTables } from '../generate/compat/gs-talent-repair.js'
import { applyHakushUpdates } from '../generate/hakush/index.js'
import { loadToolConfig } from '../config/config.js'
import { tryCreateLlmService } from '../llm/try-create.js'
import type { CommandContext, GenOptions } from '../types.js'
import { resolveRepoPath } from '../utils/resolve-path.js'

function metaGameDir(root: string, game: string): string {
  return path.join(root, `meta-${game}`)
}

export async function genCommand(ctx: CommandContext, options: GenOptions): Promise<void> {
  const baselineRoot = resolveRepoPath(ctx, options.baselineRoot)
  const outputRoot = resolveRepoPath(ctx, options.outputRoot)
  const { games, types, force, forceCache, forceAssets } = options
  const toolConfig = loadToolConfig(ctx.projectRoot) ?? undefined
  ctx.log.info(`[meta-gen] gen: outputRoot=${outputRoot}`)
  ctx.log.info(`[meta-gen] baselineRoot (validate only)=${baselineRoot}`)
  ctx.log.info(
    `[meta-gen] games=${games.join(',')} types=${types.join(',')} force=${force} forceCache=${forceCache} forceAssets=${forceAssets}`
  )

  // NOTE:
  // `gen` focuses on producing static meta (data.json + assets) deterministically from structured sources.
  // LLM-based calc generation is OPTIONAL and disabled by default (config: gen.llmCalc).
  // Use `meta-gen calc` for resumable batch upgrades when working with slow/limited models.

  // Ensure skeleton meta files exist in output so the generated meta can be loaded by miao-plugin.
  // This does NOT copy baseline data.json / per-entity dirs.
  scaffoldMeta({
    ctx,
    outputRootAbs: outputRoot,
    games,
    types,
    force
  })

  // Only initialize LLM when the selected generation types can actually use it.
  // (Avoid hard-failing `gen` for unrelated types when LLM is not configured.)
  const useLlmCalc = Boolean(toolConfig?.gen?.llmCalc) && types.includes('character')
  const llm = useLlmCalc ? tryCreateLlmService(ctx, toolConfig, { purpose: 'gen', required: true }) : undefined

  // Generate meta from Hakush (idempotent; only writes missing entries unless output is wiped by --force).
  await applyHakushUpdates({
    ctx,
    outputRootAbs: outputRoot,
    games,
    types,
    forceCache,
    forceAssets,
    llm
  })

  // Non-upstream common assets required by runtime UI.
  await ensureCommonAssets({ outputRootAbs: outputRoot, games, types, forceAssets })

  // Optional baseline-compat per-character helper files (generated locally; no baseline dependency).
  if (types.includes('character') && games.includes('gs')) {
    const metaGsRootAbs = path.join(outputRoot, 'meta-gs')
    ensureGsCharacterFiles({ metaGsRootAbs })
    await repairGsTalentTables(metaGsRootAbs, ctx.log)
  }
  if (types.includes('character') && games.includes('sr')) {
    ensureSrCharacterFiles({ metaSrRootAbs: path.join(outputRoot, 'meta-sr') })
  }

  for (const game of games) {
    for (const type of types) {
      const dstDir = path.join(metaGameDir(outputRoot, game), type)
      ctx.log.info(`[meta-gen] generated ${dstDir}`)
    }
  }

  ctx.log.info('[meta-gen] gen done')
}
