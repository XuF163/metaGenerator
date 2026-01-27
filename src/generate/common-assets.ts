/**
 * Low-frequency common assets (non-upstream).
 *
 * These files are required by miao-plugin runtime but are not tied to any
 * character/weapon/item upstream API response, so we generate them locally.
 *
 * Notes:
 * - This does NOT read/copy baseline meta files (baseline is validate-only).
 * - Images are deterministic and safe to regenerate on `--force-assets`.
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { ensureDir } from '../fs/ensure.js'
import { logAssetError } from '../log/run-log.js'
import type { Game, MetaType } from '../types.js'

type ImgSpec = {
  game: Game
  type: string
  width: number
  height: number
  outFileAbs: string
}

function buildGradientSvg(width: number, height: number, accent: string): string {
  // Keep it simple and deterministic: a dark gradient + subtle diagonal pattern.
  // Using SVG keeps us dependency-free (Sharp can render SVG natively).
  return [
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">`,
    '<defs>',
    '<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">',
    '<stop offset="0%" stop-color="#0f172a" stop-opacity="0.92"/>',
    `<stop offset="100%" stop-color="${accent}" stop-opacity="0.92"/>`,
    '</linearGradient>',
    '<pattern id="grid" width="24" height="24" patternUnits="userSpaceOnUse">',
    '<path d="M0 24 L24 0" stroke="#ffffff" stroke-opacity="0.06" stroke-width="1"/>',
    '</pattern>',
    '</defs>',
    `<rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="url(#bg)"/>`,
    `<rect x="0" y="0" width="${width}" height="${height}" rx="12" ry="12" fill="url(#grid)"/>`,
    '</svg>'
  ].join('')
}

async function ensureWebpFromSvg(spec: ImgSpec, svg: string, force: boolean): Promise<void> {
  if (!force && fs.existsSync(spec.outFileAbs)) return
  ensureDir(path.dirname(spec.outFileAbs))
  try {
    await sharp(Buffer.from(svg)).webp({ quality: 92, effort: 4 }).toFile(spec.outFileAbs)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    logAssetError({ game: spec.game, type: spec.type, out: spec.outFileAbs, error: msg })
  }
}

export interface EnsureCommonAssetsOptions {
  outputRootAbs: string
  games: Game[]
  types: MetaType[]
  /** When true, overwrite generated common images. */
  forceAssets: boolean
}

/**
 * Ensure common assets under `meta-{game}/character/common/imgs/` exist.
 */
export async function ensureCommonAssets(opts: EnsureCommonAssetsOptions): Promise<void> {
  if (!opts.types.includes('character')) return

  const jobs: ImgSpec[] = []

  for (const game of opts.games) {
    const metaRoot = path.join(opts.outputRootAbs, `meta-${game}`)
    if (!fs.existsSync(metaRoot)) continue

    const imgsDir = path.join(metaRoot, 'character', 'common', 'imgs')
    ensureDir(imgsDir)

    if (game === 'gs') {
      jobs.push({
        game,
        type: 'character-common:banner',
        width: 876,
        height: 140,
        outFileAbs: path.join(imgsDir, 'banner.webp')
      })
    } else if (game === 'sr') {
      jobs.push({
        game,
        type: 'character-common:banner',
        width: 869,
        height: 140,
        outFileAbs: path.join(imgsDir, 'banner.webp')
      })
      jobs.push({
        game,
        type: 'character-common:card',
        width: 840,
        height: 400,
        outFileAbs: path.join(imgsDir, 'card.webp')
      })
    }
  }

  for (const job of jobs) {
    const accent = job.game === 'gs' ? '#1f3b8a' : '#0f766e'
    const svg = buildGradientSvg(job.width, job.height, accent)
    await ensureWebpFromSvg(job, svg, opts.forceAssets)
  }
}

