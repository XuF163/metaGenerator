/**
 * Generation command (MVP).
 *
 * Design:
 * - Output is generated from structured upstream sources (currently Hakush + AnimeGameData).
 * - Baseline meta is used for validate/compare and gap finding; it is NOT a generation input by default.
 *   (Exception: `--baseline-overlay` enables a read-only overlay for compatibility debugging.)
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
import { generateGsArtifactArtisMarkJs } from '../generate/compat/gs-artis-mark.js'
import { generateSrArtifactArtisMarkJs } from '../generate/compat/sr-artis-mark.js'
import { applyHakushUpdates } from '../generate/hakush/index.js'
import { normalizeCalcChannel } from '../generate/calc/build.js'
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
  const { games, types, force, forceCache, forceAssets, baselineOverlay } = options
  const toolConfig = loadToolConfig(ctx.projectRoot) ?? undefined
  const calcChannel = normalizeCalcChannel(toolConfig?.calc?.channel)
  ctx.log.info(`[meta-gen] gen: outputRoot=${outputRoot}`)
  ctx.log.info(`[meta-gen] baselineRoot=${baselineRoot}`)
  ctx.log.info(
    `[meta-gen] games=${games.join(',')} types=${types.join(',')} force=${force} forceCache=${forceCache} forceAssets=${forceAssets} baselineOverlay=${baselineOverlay}`
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
    baselineRootAbs: baselineRoot,
    games,
    types,
    forceCache,
    forceAssets,
    baselineOverlay,
    calcChannel,
    calcUpstream: toolConfig?.calc?.upstream,
    llm
  })

  // Derived QoL files that depend on generated meta (no baseline dependency).
  // Generate after updates so type execution order does not matter.
  if (types.includes('artifact') && games.includes('gs')) {
    try {
      generateGsArtifactArtisMarkJs({ metaGsRootAbs: path.join(outputRoot, 'meta-gs'), log: ctx.log })
    } catch (e) {
      ctx.log.warn?.(`[meta-gen] (gs) artifact artis-mark.js generation failed: ${String(e)}`)
    }
  }
  if (types.includes('artifact') && games.includes('sr')) {
    try {
      generateSrArtifactArtisMarkJs({ metaSrRootAbs: path.join(outputRoot, 'meta-sr'), log: ctx.log })
    } catch (e) {
      ctx.log.warn?.(`[meta-gen] (sr) artifact artis-mark.js generation failed: ${String(e)}`)
    }
  }

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
