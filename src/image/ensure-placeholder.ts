import fs from 'node:fs'
import path from 'node:path'
import { writePlaceholderPng, writePlaceholderWebp } from './placeholder.js'

function inferSizeFromBasename(baseName: string): { width: number; height: number } {
  const name = baseName.toLowerCase()

  if (name.includes('splash')) return { width: 512, height: 1024 }
  if (name.includes('gacha')) return { width: 256, height: 768 }
  if (name.includes('banner')) return { width: 1024, height: 512 }
  if (name.includes('card')) return { width: 1024, height: 512 }
  if (name.includes('preview')) return { width: 512, height: 512 }
  if (name.includes('face-q')) return { width: 128, height: 128 }
  if (name.includes('tree-')) return { width: 128, height: 128 }
  if (name.includes('talent-') || name.includes('cons-') || name.includes('passive-')) return { width: 128, height: 128 }
  if (name.includes('icon-s') || /(^|[-_])s\.webp$/.test(name) || /(^|[-_])s\.png$/.test(name)) return { width: 64, height: 64 }

  return { width: 256, height: 256 }
}

/**
 * Create a placeholder image when an expected asset cannot be downloaded.
 *
 * This keeps the meta output "loadable" even if some upstream endpoints are missing or blocked.
 */
export async function ensurePlaceholderImage(
  filePath: string,
  opts: { title: string; subtitle?: string }
): Promise<void> {
  if (fs.existsSync(filePath)) return

  const { width, height } = inferSizeFromBasename(path.basename(filePath))

  if (filePath.toLowerCase().endsWith('.webp')) {
    await writePlaceholderWebp(filePath, { width, height, title: opts.title, subtitle: opts.subtitle, force: false })
    return
  }

  if (filePath.toLowerCase().endsWith('.png')) {
    await writePlaceholderPng(filePath, { width, height, title: opts.title, subtitle: opts.subtitle, force: false })
  }
}

