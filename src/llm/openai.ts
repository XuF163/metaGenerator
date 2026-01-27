/**
 * Minimal OpenAI-compatible client for Chat Completions.
 *
 * Compatibility notes:
 * - Targets the common "POST /v1/chat/completions" shape.
 * - Avoids newer OpenAI-only features by default (e.g. json_schema response_format),
 *   so it can work with compatible providers (OpenRouter, one-api, etc.).
 */

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

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries: number,
  timeoutMs: number
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const res = await fetch(url, { ...init, signal: controller.signal })
      if (res.ok) return res
      // Retry on 429/5xx
      if ([429, 500, 502, 503, 504].includes(res.status) && attempt < retries) {
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

  constructor(opts: OpenAIClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '')
    this.chatCompletionsPath = opts.chatCompletionsPath || '/v1/chat/completions'
    this.apiKey = opts.apiKey
    this.timeoutMs = opts.timeoutMs
    this.retries = opts.retries
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
      this.timeoutMs
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
