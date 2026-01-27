/**
 * Shared fetch helpers with:
 * - global proxy/mirror support
 * - User-Agent default
 * - retry + timeout
 */

import { applyProxy, getUserAgent } from './network.js'

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withUserAgent(init: RequestInit): RequestInit {
  const headers = new Headers(init.headers || {})
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', getUserAgent())
  }
  return { ...init, headers }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number
): Promise<Response> {
  const targetUrl = applyProxy(url)

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(targetUrl, { ...withUserAgent(init), signal: controller.signal })
      if (res.ok) return res
      // Retry on 429/5xx (and occasional transient 403 from CDNs).
      if ([403, 429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        await sleep(250 * (attempt + 1))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await sleep(250 * (attempt + 1))
        continue
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export async function fetchJsonWithRetry(url: string, init: RequestInit, retries: number, timeoutMs: number): Promise<unknown> {
  const res = await fetchWithRetry(url, init, retries, timeoutMs)
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`)
  }
  return res.json()
}

