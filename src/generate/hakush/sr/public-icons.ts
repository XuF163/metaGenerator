/**
 * SR public icon generator.
 *
 * Why this exists:
 * - `meta-sr/public` is mostly low-frequency static assets shipped by metaGenerator scaffold
 *   (`temp/metaGenerator/scaffold/meta-sr/public`).
 * - Some icons may be missing from that template as the game evolves (e.g. "欢愉 / Elation").
 * - We generate ONLY the missing ones from upstream sources so meta output is self-contained.
 */

import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { ensureDir } from '../../../fs/ensure.js'
import { fetchWithRetry } from '../../../http/fetch.js'
import { logAssetError } from '../../../log/run-log.js'
import type { TurnBasedGameDataClient } from '../../../source/turnBasedGameData/client.js'

export interface EnsureSrPublicElationIconsOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  turnBasedGameData: TurnBasedGameDataClient
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export interface EnsureSrPublicPathIconsOptions extends EnsureSrPublicElationIconsOptions {}

type RogueAeonDisplayRow = {
  DisplayID?: number
  AeonIcon?: string
}

type AvatarBaseTypeRow = {
  ID?: string
  BaseTypeIconSmall?: string
  FirstWordText?: string
}

function parseBasename(p: string): string {
  const clean = p.replace(/\\/g, '/')
  const parts = clean.split('/')
  return parts[parts.length - 1] || clean
}

async function fetchPng(url: string): Promise<Buffer> {
  const res = await fetchWithRetry(url, {}, 2, 60_000)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  return Buffer.from(await res.arrayBuffer())
}

async function writeWebpFromPngBuffer(
  buf: Buffer,
  outPath: string,
  size: { width: number; height: number },
  force: boolean
): Promise<'skipped' | 'written'> {
  if (!force && fs.existsSync(outPath)) return 'skipped'
  ensureDir(path.dirname(outPath))
  await sharp(buf)
    .resize(size.width, size.height, { fit: 'contain' })
    .webp({ lossless: true, effort: 4 })
    .toFile(outPath)
  return 'written'
}

/**
 * Ensure SR profession/path icons exist under `meta-sr/public/icons`.
 *
 * These icons are referenced by multiple panel templates. We prefer generating them at
 * build time (download + cache) instead of hardcoding a large binary scaffold snapshot.
 *
 * Current scope:
 * - `type-<命途>.webp` (612x612)
 * - `type-<命途>s.webp` (64x64)
 *
 * Also ensures the Elation icons via `ensureSrPublicElationIcons()`.
 */
export async function ensureSrPublicPathIcons(opts: EnsureSrPublicPathIconsOptions): Promise<void> {
  const iconsDir = path.join(opts.metaSrRootAbs, 'public', 'icons')
  ensureDir(iconsDir)

  // Resolve icon file names from game data to avoid hardcoding provider-specific names.
  const baseTypeRaw = await opts.turnBasedGameData.getSrAvatarBaseType()
  const rows: AvatarBaseTypeRow[] = Array.isArray(baseTypeRaw) ? (baseTypeRaw as AvatarBaseTypeRow[]) : []

  const cnByFirstWord: Record<string, string> = {
    Destruction: '毁灭',
    'The Hunt': '巡猎',
    Hunt: '巡猎',
    Erudition: '智识',
    Harmony: '同谐',
    Nihility: '虚无',
    Preservation: '存护',
    Abundance: '丰饶',
    Remembrance: '记忆'
  }

  for (const r of rows) {
    const firstWord = typeof r.FirstWordText === 'string' ? r.FirstWordText : ''
    const cn = cnByFirstWord[firstWord]
    if (!cn) continue

    const iconSmall = typeof r.BaseTypeIconSmall === 'string' ? r.BaseTypeIconSmall : ''
    const iconFile = iconSmall ? parseBasename(iconSmall) : ''
    if (!iconFile) continue

    const outType = path.join(iconsDir, `type-${cn}.webp`)
    const outTypeS = path.join(iconsDir, `type-${cn}s.webp`)

    const needAny = opts.forceAssets || !fs.existsSync(outType) || !fs.existsSync(outTypeS)
    if (!needAny) continue

    const srcUrl = `https://sr.yatta.moe/hsr/assets/UI/profession/${iconFile}`

    let buf: Buffer
    try {
      buf = await fetchPng(srcUrl)
    } catch (e) {
      opts.log?.warn?.(`[meta-gen] (sr) path icon download failed: ${cn} ${srcUrl} -> ${String(e)}`)
      for (const out of [outTypeS, outType]) {
        logAssetError({ game: 'sr', type: 'public-icons:path', out, url: srcUrl, error: String(e) })
      }
      continue
    }

    await Promise.all([
      writeWebpFromPngBuffer(buf, outTypeS, { width: 64, height: 64 }, opts.forceAssets),
      writeWebpFromPngBuffer(buf, outType, { width: 612, height: 612 }, opts.forceAssets)
    ])
  }

  // Elation is not a normal playable base type; ensure it separately.
  await ensureSrPublicElationIcons(opts)
}

/**
 * Ensure the SR "Elation" icons exist:
 * - public/icons/type-欢愉.webp   (612x612)
 * - public/icons/type-欢愉s.webp  (64x64)
 * - public/icons/tree-elation.webp (128x128, consistent with other tree icons)
 */
export async function ensureSrPublicElationIcons(opts: EnsureSrPublicElationIconsOptions): Promise<void> {
  const iconsDir = path.join(opts.metaSrRootAbs, 'public', 'icons')
  ensureDir(iconsDir)

  const outType = path.join(iconsDir, 'type-欢愉.webp')
  const outTypeS = path.join(iconsDir, 'type-欢愉s.webp')
  const outTree = path.join(iconsDir, 'tree-elation.webp')

  const needAny =
    opts.forceAssets || !fs.existsSync(outType) || !fs.existsSync(outTypeS) || !fs.existsSync(outTree)
  if (!needAny) return

  // Prefer resolving the icon file name from game data in case upstream changes.
  let iconFile = 'IconProfessionJoySmall.png'
  try {
    const raw = await opts.turnBasedGameData.getSrRogueAeonDisplay()
    const rows = Array.isArray(raw) ? (raw as RogueAeonDisplayRow[]) : []
    const joy = rows.find((r) => r && r.DisplayID === 7)
    if (joy && typeof joy.AeonIcon === 'string' && joy.AeonIcon) {
      iconFile = parseBasename(joy.AeonIcon)
    }
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) turnbasedgamedata RogueAeonDisplay unavailable, using default elation icon: ${String(e)}`)
  }

  // Yatta hosts the normalized profession icons under `.../assets/UI/profession/`.
  const srcUrl = `https://sr.yatta.moe/hsr/assets/UI/profession/${iconFile}`

  let buf: Buffer
  try {
    buf = await fetchPng(srcUrl)
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) elation icon download failed: ${srcUrl} -> ${String(e)}`)
    // Requirement: do NOT create placeholder images. Log and continue.
    for (const out of [outTypeS, outTree, outType]) {
      logAssetError({
        game: 'sr',
        type: 'public-icons:elation',
        out,
        url: srcUrl,
        error: String(e)
      })
    }
    return
  }

  await Promise.all([
    writeWebpFromPngBuffer(buf, outTypeS, { width: 64, height: 64 }, opts.forceAssets),
    writeWebpFromPngBuffer(buf, outTree, { width: 128, height: 128 }, opts.forceAssets),
    writeWebpFromPngBuffer(buf, outType, { width: 612, height: 612 }, opts.forceAssets)
  ])

  opts.log?.info?.('[meta-gen] (sr) ensured public elation icons')
}
