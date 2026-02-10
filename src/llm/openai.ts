/**
 * Minimal OpenAI-compatible client for Chat Completions.
 *
 * Compatibility notes:
 * - Targets the common "POST /v1/chat/completions" shape.
 * - Avoids newer OpenAI-only features by default (e.g. json_schema response_format),
 *   so it can work with compatible providers (OpenRouter, one-api, etc.).
 */

import { fetch as undiciFetch, ProxyAgent } from 'undici'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface ChatCompletionRequest {
  model: string
  messages: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

export interface ChatCompletionResponse {
  id?: string
  choices?: Array<{
    index?: number
    message?: { role?: string; content?: string }
    finish_reason?: string
  }>
}

export interface OpenAIClientOptions {
  baseUrl: string
  /** OpenAI-compatible path, e.g. /v1/chat/completions or /api/paas/v4/chat/completions */
  chatCompletionsPath?: string
  apiKey: string
  timeoutMs: number
  retries: number
  /**
   * Optional HTTP proxy (transport-level, CONNECT for HTTPS).
   *
   * NOTE: This is intentionally separate from "URL rewrite/mirror" style proxies.
   */
  httpProxy?: string
  /**
   * Optional User-Agent header for outgoing requests.
   * If omitted, the global fetch default is used.
   */
  userAgent?: string
}

function joinUrl(baseUrl: string, pathOrUrl: string): string {
  // Allow passing a full URL for maximum compatibility.
  if (/^https?:\/\//.test(pathOrUrl)) return pathOrUrl

  const base = baseUrl.replace(/\/+$/, '')
  const p = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
  return `${base}${p}`
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function withUserAgent(init: RequestInit, userAgent?: string): RequestInit {
  if (!userAgent) return init
  const headers = new Headers(init.headers || {})
  if (!headers.has('User-Agent')) {
    headers.set('User-Agent', userAgent)
  }
  return { ...init, headers }
}

function parseRetryAfterMs(res: Response): number | null {
  const raw = res.headers.get('retry-after')
  if (!raw) return null

  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(120_000, Math.floor(seconds * 1000))
  }

  const dateMs = Date.parse(raw)
  if (Number.isFinite(dateMs)) {
    const diff = dateMs - Date.now()
    if (diff > 0) return Math.min(120_000, diff)
  }

  return null
}

function backoffMs(attempt: number): number {
  // Exponential backoff with a small jitter.
  const exp = Math.min(6, Math.max(0, attempt))
  const base = 1000 * 2 ** exp
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(120_000, base + jitter)
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

function getProxyAgent(httpProxyRaw: string | undefined): ProxyAgent | undefined {
  const p = httpProxyRaw ? normalizeHttpProxy(httpProxyRaw) : undefined
  if (!p) return undefined
  if (cachedProxyAgent && cachedHttpProxy === p) return cachedProxyAgent
  cachedHttpProxy = p
  cachedProxyAgent = new ProxyAgent(p)
  return cachedProxyAgent
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number,
  opts: { httpProxy?: string; userAgent?: string } = {}
): Promise<Response> {
  const proxyAgent = getProxyAgent(opts.httpProxy)
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const initWithUa = withUserAgent(init, opts.userAgent)
      const res: Response = proxyAgent
        ? ((await (undiciFetch as unknown as (url: string, init?: any) => Promise<any>)(url, {
            ...initWithUa,
            signal: controller.signal,
            dispatcher: proxyAgent
          })) as unknown as Response)
        : await fetch(url, { ...initWithUa, signal: controller.signal })
      if (res.ok) return res
      // Retry on 429/5xx (and occasional transient 403 from CDNs/proxies).
      if ([403, 429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
        // Some providers return 403 for auth/config errors. Do NOT retry those.
        if (res.status === 403) {
          try {
            const preview = (await res.clone().text()).slice(0, 800)
            if (/invalid\s+api\s*key/i.test(preview) || /unauthorized/i.test(preview)) {
              return res
            }
          } catch {
            // Ignore preview failures; fall back to generic retry behavior.
          }
        }
        const retryAfter = parseRetryAfterMs(res)
        await sleep(retryAfter ?? backoffMs(attempt))
        continue
      }
      return res
    } catch (err) {
      lastErr = err
      if (attempt < retries) {
        await sleep(backoffMs(attempt))
        continue
      }
      throw err
    } finally {
      clearTimeout(timeoutId)
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr))
}

export class OpenAIClient {
  private readonly baseUrl: string
  private readonly chatCompletionsPath: string
  private readonly apiKey: string
  private readonly timeoutMs: number
  private readonly retries: number
  private readonly httpProxy?: string
  private readonly userAgent?: string

  constructor(opts: OpenAIClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.chatCompletionsPath = opts.chatCompletionsPath || '/v1/chat/completions'
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
    this.retries = opts.retries
    this.httpProxy = opts.httpProxy
    this.userAgent = opts.userAgent
  }

  /**
   * Call OpenAI-compatible chat completions endpoint and return raw response JSON.
   */
  async chatCompletions(body: ChatCompletionRequest): Promise<ChatCompletionResponse> {
    const url = joinUrl(this.baseUrl, this.chatCompletionsPath)
    const res = await fetchWithRetry(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(body)
      },
      this.retries,
      this.timeoutMs,
      { httpProxy: this.httpProxy, userAgent: this.userAgent }
    )

    const text = await res.text()
    let json: unknown
    try {
      json = text ? JSON.parse(text) : {}
    } catch (e) {
      throw new Error(`[meta-gen] LLM response is not JSON (status=${res.status}): ${text.slice(0, 2000)}`)
    }
    if (!res.ok) {
      throw new Error(`[meta-gen] LLM request failed (status=${res.status}): ${text.slice(0, 2000)}`)
    }
    return json as ChatCompletionResponse
  }
}
