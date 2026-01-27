import fs from 'node:fs'
import path from 'node:path'
import sharp from 'sharp'
import { ensureDir } from '../fs/ensure.js'
import type { DownloadOptionalOptions, DownloadOptionalResult } from '../http/download-optional.js'
import { fetchWithRetry } from '../http/fetch.js'

/**
 * Download a PNG (or any image buffer Sharp can decode) and encode it as WebP.
 *
 * - Treats HTTP 404 as a non-fatal "missing" result.
 * - Keeps output self-contained (no baseline dependency).
 */
export async function downloadPngToWebpOptional(
  url: string,
  filePath: string,
  opts: DownloadOptionalOptions
): Promise<DownloadOptionalResult> {
  if (!opts.force && fs.existsSync(filePath)) {
    return { ok: true, action: 'skipped', filePath }
  }

  ensureDir(path.dirname(filePath))

  try {
    const retries = Number.isFinite(opts.retries) ? (opts.retries as number) : 2
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : 60_000
    const res = await fetchWithRetry(url, {}, retries, timeoutMs)
    if (!res.ok) {
      if (res.status === 404) {
        return { ok: true, action: 'missing', filePath, status: 404 }
      }
      return {
        ok: false,
        filePath,
        status: res.status,
        error: `HTTP ${res.status} ${res.statusText}`
      }
    }

    const buf = Buffer.from(await res.arrayBuffer())
    await sharp(buf).webp({ lossless: true, effort: 4 }).toFile(filePath)
    return { ok: true, action: 'downloaded', filePath, bytes: buf.byteLength }
  } catch (err) {
    return {
      ok: false,
      filePath,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
