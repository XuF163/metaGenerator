/**
 * Fetch source data into local cache.
 *
 * This does not generate meta files yet; it prepares stable, repeatable inputs
 * for later generation stages.
 */

import path from 'node:path'
import fs from 'node:fs'
import type { CommandContext, GenOptions } from '../types.js'
import { downloadToFile } from '../http/download.js'

type HakushGame = 'gi' | 'hsr'

function gameToHakush(game: 'gs' | 'sr'): HakushGame {
  return game === 'gs' ? 'gi' : 'hsr'
}

function itemLang(game: 'gs' | 'sr'): string {
  return game === 'gs' ? 'zh' : 'cn'
}

function hakushUrls(game: 'gs' | 'sr'): Array<{ name: string; url: string; relPath: string }> {
  const hg = gameToHakush(game)
  const base = `https://api.hakush.in/${hg}`

  if (game === 'gs') {
    return [
      { name: 'new', url: `${base}/new.json`, relPath: `${hg}/new.json` },
      { name: 'character', url: `${base}/data/character.json`, relPath: `${hg}/data/character.json` },
      { name: 'weapon', url: `${base}/data/weapon.json`, relPath: `${hg}/data/weapon.json` },
      { name: 'artifact', url: `${base}/data/artifact.json`, relPath: `${hg}/data/artifact.json` },
      {
        name: 'item_all',
        url: `${base}/data/${itemLang(game)}/item_all.json`,
        relPath: `${hg}/data/${itemLang(game)}/item_all.json`
      }
    ]
  }

  return [
    { name: 'new', url: `${base}/new.json`, relPath: `${hg}/new.json` },
    { name: 'character', url: `${base}/data/character.json`, relPath: `${hg}/data/character.json` },
    { name: 'lightcone', url: `${base}/data/lightcone.json`, relPath: `${hg}/data/lightcone.json` },
    { name: 'relicset', url: `${base}/data/relicset.json`, relPath: `${hg}/data/relicset.json` },
    {
      name: 'item_all',
      url: `${base}/data/${itemLang(game)}/item_all.json`,
      relPath: `${hg}/data/${itemLang(game)}/item_all.json`
    }
  ]
}

export async function fetchCommand(ctx: CommandContext, options: GenOptions): Promise<void> {
  const cacheRoot = path.join(ctx.projectRoot, '.cache', 'hakush')
  const { games, force } = options

  ctx.log.info(`[meta-gen] fetch: cacheRoot=${cacheRoot} games=${games.join(',')} force=${force}`)

  const results: Array<{ name: string; filePath: string; ok: boolean; action?: string; error?: string }> = []

  for (const game of games) {
    for (const target of hakushUrls(game)) {
      const filePath = path.join(cacheRoot, target.relPath.split('/').join(path.sep))
      ctx.log.info(`[meta-gen] fetching ${target.name}: ${target.url}`)
      const res = await downloadToFile(target.url, filePath, { force })
      if (res.ok) {
        results.push({ name: target.name, filePath: res.filePath, ok: true, action: res.action })
        if (res.action === 'downloaded') {
          ctx.log.info(`[meta-gen] saved ${res.bytes} bytes -> ${res.filePath}`)
        } else {
          ctx.log.info(`[meta-gen] skipped (exists) -> ${res.filePath}`)
        }
      } else {
        results.push({ name: target.name, filePath: res.filePath, ok: false, error: res.error })
        ctx.log.warn(`[meta-gen] fetch failed: ${target.url} -> ${res.error}`)
      }
    }
  }

  // Write a lightweight manifest for reproducibility.
  const manifestPath = path.join(cacheRoot, `manifest-${ctx.now.toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true })
  fs.writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        generatedAt: ctx.now.toISOString(),
        games,
        results
      },
      null,
      2
    ),
    'utf8'
  )
  ctx.log.info(`[meta-gen] fetch manifest written: ${manifestPath}`)
}

