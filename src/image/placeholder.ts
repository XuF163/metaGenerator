import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { ensureDir } from '../fs/ensure.js'

export interface PlaceholderWebpOptions {
  width: number
  height: number
  title: string
  subtitle?: string
  /** When true, overwrite if destination exists. */
  force: boolean
}

export interface PlaceholderPngOptions {
  width: number
  height: number
  title: string
  subtitle?: string
  /** When true, overwrite if destination exists. */
  force: boolean
}

function escapeXml(input: string): string {
  return input
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

/**
 * Create a lightweight placeholder WebP image so required asset files always exist.
 *
 * This is the last-resort fallback when upstream does not host an asset (404).
 */
export async function writePlaceholderWebp(filePath: string, opts: PlaceholderWebpOptions): Promise<'skipped' | 'written'> {
  if (!opts.force && fs.existsSync(filePath)) return 'skipped'
  ensureDir(path.dirname(filePath))

  const title = escapeXml(opts.title || 'Missing')
  const subtitle = opts.subtitle ? escapeXml(opts.subtitle) : ''

  const w = Math.max(8, Math.floor(opts.width))
  const h = Math.max(8, Math.floor(opts.height))
  const pad = Math.max(8, Math.floor(Math.min(w, h) * 0.08))
  const titleFont = Math.max(14, Math.floor(h * 0.12))
  const subFont = Math.max(12, Math.floor(h * 0.07))
  const splitTitle = title.length > 28 ? `${title.slice(0, 28)}…` : title

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" rx="${Math.max(8, Math.floor(Math.min(w, h) * 0.06))}" fill="url(#bg)"/>
  <rect x="${pad}" y="${pad}" width="${w - pad * 2}" height="${h - pad * 2}" rx="${Math.max(
    6,
    Math.floor(Math.min(w, h) * 0.04)
  )}" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)"/>
  <text x="${w / 2}" y="${h / 2 - (subtitle ? subFont : 0)}" text-anchor="middle" font-family="sans-serif" font-size="${titleFont}" fill="rgba(255,255,255,0.92)">${splitTitle}</text>
  ${
    subtitle
      ? `<text x="${w / 2}" y="${h / 2 + titleFont * 0.9}" text-anchor="middle" font-family="sans-serif" font-size="${subFont}" fill="rgba(255,255,255,0.7)">${subtitle}</text>`
      : ''
  }
</svg>`

  await sharp(Buffer.from(svg)).webp({ lossless: true, effort: 4 }).toFile(filePath)
  return 'written'
}

export async function writePlaceholderPng(filePath: string, opts: PlaceholderPngOptions): Promise<'skipped' | 'written'> {
  if (!opts.force && fs.existsSync(filePath)) return 'skipped'
  ensureDir(path.dirname(filePath))

  const title = escapeXml(opts.title || 'Missing')
  const subtitle = opts.subtitle ? escapeXml(opts.subtitle) : ''

  const w = Math.max(8, Math.floor(opts.width))
  const h = Math.max(8, Math.floor(opts.height))
  const pad = Math.max(8, Math.floor(Math.min(w, h) * 0.08))
  const titleFont = Math.max(14, Math.floor(h * 0.12))
  const subFont = Math.max(12, Math.floor(h * 0.07))
  const splitTitle = title.length > 28 ? `${title.slice(0, 28)}…` : title

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#1f2937"/>
      <stop offset="100%" stop-color="#0b1220"/>
    </linearGradient>
  </defs>
  <rect x="0" y="0" width="${w}" height="${h}" rx="${Math.max(8, Math.floor(Math.min(w, h) * 0.06))}" fill="url(#bg)"/>
  <rect x="${pad}" y="${pad}" width="${w - pad * 2}" height="${h - pad * 2}" rx="${Math.max(
    6,
    Math.floor(Math.min(w, h) * 0.04)
  )}" fill="rgba(255,255,255,0.06)" stroke="rgba(255,255,255,0.15)"/>
  <text x="${w / 2}" y="${h / 2 - (subtitle ? subFont : 0)}" text-anchor="middle" font-family="sans-serif" font-size="${titleFont}" fill="rgba(255,255,255,0.92)">${splitTitle}</text>
  ${
    subtitle
      ? `<text x="${w / 2}" y="${h / 2 + titleFont * 0.9}" text-anchor="middle" font-family="sans-serif" font-size="${subFont}" fill="rgba(255,255,255,0.7)">${subtitle}</text>`
      : ''
  }
</svg>`

  await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toFile(filePath)
  return 'written'
}
