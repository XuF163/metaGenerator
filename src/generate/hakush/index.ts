/**
 * Hakush-based generator.
 *
 * This layer is responsible for:
 * - reading the current output directory state
 * - filling missing meta entries by pulling structured data from Hakush.in (and other sources when needed)
 *
 * Notes:
 * - By default we only create files that are missing (idempotent, safe for incremental updates).
 * - When `gen --force` is used, the output `meta-{game}` dirs are wiped first, so this module
 *   effectively generates the full dataset from scratch.
 */

import path from 'node:path'
import type { CommandContext, Game, GenOptions, MetaType } from '../../types.js'
import { AnimeGameDataClient } from '../../source/animeGameData/client.js'
import { HakushClient } from '../../source/hakush/client.js'
import { TurnBasedGameDataClient } from '../../source/turnBasedGameData/client.js'
import { HoYoWikiClient } from '../../source/hoyoWiki/client.js'
import { YattaClient } from '../../source/yatta/client.js'
import type { LlmService } from '../../llm/service.js'
import { generateGsWeapons } from './gs/weapon.js'
import { generateGsArtifacts } from './gs/artifact.js'
import { generateGsCharacters } from './gs/character.js'
import { generateGsMaterials } from './gs/material.js'
import { generateSrWeapons } from './sr/weapon.js'
import { generateSrArtifacts } from './sr/artifact.js'
import { generateSrCharacters } from './sr/character.js'
import { generateSrMaterials } from './sr/material.js'
import { ensureSrPublicPathIcons } from './sr/public-icons.js'

function metaGameDir(outputRootAbs: string, game: Game): string {
  return path.join(outputRootAbs, `meta-${game}`)
}

export interface HakushUpdateOptions {
  ctx: CommandContext
  outputRootAbs: string
  /** Absolute path to baseline root (contains meta-gs/meta-sr). */
  baselineRootAbs: string
  games: Game[]
  types: MetaType[]
  /** Whether to refresh cached JSON files. */
  forceCache: boolean
  /** Whether to overwrite downloaded assets (images) if they exist. */
  forceAssets: boolean
  /** Whether generation is allowed to read baseline meta as an overlay (debug). */
  baselineOverlay: boolean
  /** Optional LLM service used to generate calc.js for new characters. */
  llm?: LlmService
}

export async function applyHakushUpdates(opts: HakushUpdateOptions): Promise<void> {
  const cacheRootAbs = path.join(opts.ctx.projectRoot, '.cache', 'hakush')
  const hakush = new HakushClient({ cacheRootAbs, force: opts.forceCache, log: opts.ctx.log })

  // Secondary source used to fill gaps (e.g. GS artifact real item IDs).
  const animeGameData = new AnimeGameDataClient({
    cacheRootAbs: path.join(opts.ctx.projectRoot, '.cache', 'animeGameData'),
    force: opts.forceCache,
    log: opts.ctx.log
  })

  const turnBasedGameData = new TurnBasedGameDataClient({
    cacheRootAbs: path.join(opts.ctx.projectRoot, '.cache', 'turnBasedGameData'),
    force: opts.forceCache,
    log: opts.ctx.log
  })

  const hoyoWiki = new HoYoWikiClient({
    cacheRootAbs: path.join(opts.ctx.projectRoot, '.cache', 'hoyoWiki'),
    force: opts.forceCache,
    log: opts.ctx.log
  })

  const yatta = new YattaClient({
    cacheRootAbs: path.join(opts.ctx.projectRoot, '.cache', 'yatta'),
    force: opts.forceCache,
    log: opts.ctx.log
  })

  // Some generation steps depend on outputs produced by other types:
  // - character costs need material name->id mapping, so material must run before character
  const typePriority: Record<MetaType, number> = { material: 0, weapon: 1, artifact: 2, character: 3 }

  for (const game of opts.games) {
    const metaRoot = metaGameDir(opts.outputRootAbs, game)
    const orderedTypes = Array.from(new Set(opts.types)).sort((a, b) => (typePriority[a] ?? 99) - (typePriority[b] ?? 99))
    for (const type of orderedTypes) {
      if (game === 'gs') {
        if (type === 'weapon') {
          await generateGsWeapons({
            metaGsRootAbs: metaRoot,
            hakush,
            animeGameData,
            forceAssets: opts.forceAssets,
            log: opts.ctx.log
          })
        } else if (type === 'material') {
          await generateGsMaterials({
            metaGsRootAbs: metaRoot,
            hakush,
            animeGameData,
            forceAssets: opts.forceAssets,
            log: opts.ctx.log
          })
        } else if (type === 'artifact') {
          await generateGsArtifacts({
            metaGsRootAbs: metaRoot,
            hakush,
            animeGameData,
            forceAssets: opts.forceAssets,
            log: opts.ctx.log
          })
        } else if (type === 'character') {
          await generateGsCharacters({
            metaGsRootAbs: metaRoot,
            projectRootAbs: opts.ctx.projectRoot,
            repoRootAbs: opts.ctx.repoRoot,
            hakush,
            animeGameData,
            forceAssets: opts.forceAssets,
            forceCache: opts.forceCache,
            llm: opts.llm,
            log: opts.ctx.log
          })
        }
      } else if (game === 'sr') {
        if (type === 'weapon') {
          await generateSrWeapons({
            metaSrRootAbs: metaRoot,
            hakush,
            yatta,
            turnBasedGameData,
            forceAssets: opts.forceAssets,
            log: opts.ctx.log
          })
        } else if (type === 'material') {
          await generateSrMaterials({
            metaSrRootAbs: metaRoot,
            hakush,
            forceAssets: opts.forceAssets,
            hoyoWiki,
            log: opts.ctx.log
          })
        } else if (type === 'artifact') {
          await generateSrArtifacts({
            metaSrRootAbs: metaRoot,
            hakush,
            yatta,
            turnBasedGameData,
            forceAssets: opts.forceAssets,
            log: opts.ctx.log
          })
        } else if (type === 'character') {
          await generateSrCharacters({
            metaSrRootAbs: metaRoot,
            projectRootAbs: opts.ctx.projectRoot,
            repoRootAbs: opts.ctx.repoRoot,
            baselineRootAbs: opts.baselineRootAbs,
            baselineOverlay: opts.baselineOverlay,
            hakush,
            yatta,
            forceAssets: opts.forceAssets,
            forceCache: opts.forceCache,
            llm: opts.llm,
            log: opts.ctx.log
          })
        }
      }
    }

    // Ensure low-frequency SR public icons that might be missing from the repo template snapshot.
    if (game === 'sr') {
      await ensureSrPublicPathIcons({
        metaSrRootAbs: metaRoot,
        turnBasedGameData,
        forceAssets: opts.forceAssets,
        log: opts.ctx.log
      })
    }
  }
}
