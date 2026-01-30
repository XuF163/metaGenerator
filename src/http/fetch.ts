/**
 * Shared fetch helpers with:
 * - global proxy/mirror support
 * - optional HTTP proxy support (CONNECT)
 * - User-Agent default
 * - retry + timeout
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici'
import { applyProxy, getHttpProxy, getUserAgent } from './network.js'

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

let cachedHttpProxy: string | undefined
let cachedProxyAgent: ProxyAgent | undefined

function normalizeHttpProxy(p: string): string {
  const t = p.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  // Allow "127.0.0.1:10809" style.
  return `http://${t}`
}

function getProxyAgent(): ProxyAgent | undefined {
  const pRaw = getHttpProxy()
  const p = pRaw ? normalizeHttpProxy(pRaw) : undefined
  if (!p) return undefined

  if (cachedProxyAgent && cachedHttpProxy === p) return cachedProxyAgent
  cachedHttpProxy = p
  cachedProxyAgent = new ProxyAgent(p)
  return cachedProxyAgent
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number
): Promise<Response> {
  const targetUrl = applyProxy(url)
  const proxyAgent = getProxyAgent()

  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res: Response = proxyAgent
        ? ((await (undiciFetch as unknown as (url: string, init?: any) => Promise<any>)(targetUrl, {
            ...withUserAgent(init),
            signal: controller.signal,
            dispatcher: proxyAgent
          })) as unknown as Response)
        : await fetch(targetUrl, { ...withUserAgent(init), signal: controller.signal })
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

