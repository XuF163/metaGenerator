import fs from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { ensureDir } from '../fs/ensure.js'
import { fetchWithRetry } from './fetch.js'

export interface DownloadOptions {
  force: boolean
  /** Retry count for transient network errors (default: 2). */
  retries?: number
  /** Request timeout in ms (default: 60_000). */
  timeoutMs?: number
}

export type DownloadResult =
  | { ok: true; action: 'skipped'; filePath: string }
  | { ok: true; action: 'downloaded'; filePath: string; bytes: number }
  | { ok: false; filePath: string; status?: number; error: string }

/**
 * Download a URL and save to `filePath`.
 *
 * Notes:
 * - For MVP we buffer in memory (files we fetch are JSON, usually < a few MB).
 * - We avoid storing secrets; caller controls URL.
 */
export async function downloadToFile(url: string, filePath: string, opts: DownloadOptions): Promise<DownloadResult> {
  if (!opts.force && fs.existsSync(filePath)) {
    return { ok: true, action: 'skipped', filePath }
  }

  ensureDir(path.dirname(filePath))

  try {
    const retries = Number.isFinite(opts.retries) ? (opts.retries as number) : 2
    const timeoutMs = Number.isFinite(opts.timeoutMs) ? (opts.timeoutMs as number) : 60_000

    const res = await fetchWithRetry(url, {}, retries, timeoutMs)
    if (!res.ok) {
      return {
        ok: false,
        filePath,
        status: res.status,
        error: `HTTP ${res.status} ${res.statusText}`
      }
    }

    // Stream to disk to reduce peak memory usage and avoid rare native crashes
    // observed with repeated `arrayBuffer()` usage on some Windows+Node builds.
    if (!res.body) {
      return { ok: false, filePath, error: 'empty response body' }
    }
    await pipeline(Readable.fromWeb(res.body as any), fs.createWriteStream(filePath))
    const bytes = fs.statSync(filePath).size
    return { ok: true, action: 'downloaded', filePath, bytes }
  } catch (err) {
    return {
      ok: false,
      filePath,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
