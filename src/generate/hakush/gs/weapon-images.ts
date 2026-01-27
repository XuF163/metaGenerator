import fs from 'node:fs'
import path from 'node:path'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import { downloadPngToWebpOptional } from '../../../image/download-png-to-webp.js'
import { logAssetError } from '../../../log/run-log.js'

export interface EnsureGsWeaponImagesOptions {
  weaponDirAbs: string
  /** Weapon id (numeric string). Used for HoneyHunter fallback URLs when UI asset names don't match. */
  weaponId?: string | number
  iconName: string
  forceAssets: boolean
  label?: string
  log?: Pick<Console, 'info' | 'warn'>
}

const HAKUSH_GI_UI_BASE = 'https://api.hakush.in/gi/UI/'
const YATTA_GI_UI_BASE = 'https://gi.yatta.moe/assets/UI/'
const ENKA_UI_BASE = 'https://enka.network/ui/'
const HONEY_GI_IMG_BASE = 'https://gensh.honeyhunterworld.com/img/'

async function ensureWeaponWebpAsset(opts: {
  outPath: string
  kind: 'icon' | 'gacha' | 'awaken'
  assetName: string
  force: boolean
  label: string
  log?: Pick<Console, 'warn'>
  copyFrom?: string
  honeyId?: string
}): Promise<void> {
  if (!opts.force && fs.existsSync(opts.outPath)) return

  // 1) Hakush webp (fast path for most assets).
  const webpUrl = `${HAKUSH_GI_UI_BASE}${opts.assetName}.webp`
  const webpRes = await downloadToFileOptional(webpUrl, opts.outPath, { force: opts.force })
  if (webpRes.ok && webpRes.action !== 'missing') return

  // 2) PNG hosts (convert to webp).
  const pngUrls = [`${YATTA_GI_UI_BASE}${opts.assetName}.png`, `${ENKA_UI_BASE}${opts.assetName}.png`]
  for (const url of pngUrls) {
    const res = await downloadPngToWebpOptional(url, opts.outPath, { force: opts.force })
    if (res.ok && res.action !== 'missing') return
  }

  // 3) HoneyHunter webp (fallback by weapon id; matches baseline meta assets for some legacy/unlisted weapons).
  if (opts.honeyId) {
    const suffix =
      opts.kind === 'icon'
        ? `i_n${opts.honeyId}.webp`
        : opts.kind === 'gacha'
          ? `i_n${opts.honeyId}_gacha_icon.webp`
          : `i_n${opts.honeyId}_awaken_icon.webp`
    const url = `${HONEY_GI_IMG_BASE}${suffix}`
    const res = await downloadToFileOptional(url, opts.outPath, { force: opts.force })
    if (res.ok && res.action !== 'missing') return
  }

  // 4) Cheap fallback: copy from another already-present asset (e.g. awaken==icon for some weapons).
  if (opts.copyFrom && fs.existsSync(opts.copyFrom)) {
    try {
      fs.copyFileSync(opts.copyFrom, opts.outPath)
      return
    } catch (e) {
      opts.log?.warn?.(`[meta-gen] (gs) weapon ${opts.kind} copy fallback failed: ${opts.label} -> ${String(e)}`)
    }
  }

  // 5) Requirement: do NOT create placeholder images. Log and continue.
  logAssetError({
    game: 'gs',
    type: `weapon-img:${opts.kind}`,
    name: opts.label,
    out: opts.outPath,
    url: webpUrl,
    error: `missing from all sources (hakush/yatta/enka)`
  })
}

/**
 * Ensure GS weapon images exist (baseline-compatible file names):
 * - icon.webp
 * - gacha.webp
 * - awaken.webp
 *
 * Notes:
 * - We do NOT use baseline assets as a generator input.
 * - For rare weapons where upstream does not host images, we log an error and keep the file missing.
 */
export async function ensureGsWeaponImages(opts: EnsureGsWeaponImagesOptions): Promise<void> {
  const iconPath = path.join(opts.weaponDirAbs, 'icon.webp')
  const gachaPath = path.join(opts.weaponDirAbs, 'gacha.webp')
  const awakenPath = path.join(opts.weaponDirAbs, 'awaken.webp')

  const label = opts.label || opts.iconName
  const gachaName = opts.iconName.replace(/^UI_/, 'UI_Gacha_')
  const honeyId = opts.weaponId !== undefined && opts.weaponId !== null ? String(opts.weaponId) : undefined

  await ensureWeaponWebpAsset({
    outPath: iconPath,
    kind: 'icon',
    assetName: opts.iconName,
    force: opts.forceAssets,
    label,
    log: opts.log,
    honeyId
  })

  await ensureWeaponWebpAsset({
    outPath: gachaPath,
    kind: 'gacha',
    assetName: gachaName,
    force: opts.forceAssets,
    label,
    log: opts.log,
    honeyId
  })

  await ensureWeaponWebpAsset({
    outPath: awakenPath,
    kind: 'awaken',
    assetName: `${opts.iconName}_Awaken`,
    force: opts.forceAssets,
    label,
    log: opts.log,
    // Many weapons use the same image for icon/awaken; copy icon as a cheap fallback.
    copyFrom: iconPath,
    honeyId
  })
}
