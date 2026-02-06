/**
 * LLM service wrapper (OpenAI-compatible Chat Completions).
 *
 * - Enforces concurrency limits via AsyncQueue
 * - Returns only the assistant content text
 */

import type { ChatMessage } from './openai.js'
import { OpenAIClient } from './openai.js'
import type { LlmConfig } from './llm-config.js'
import { AsyncQueue } from './queue.js'
import { getHttpProxy, getUserAgent } from '../http/network.js'

export interface ChatOptions {
  temperature?: number
  maxTokens?: number
}

export class LlmService {
  private readonly client: OpenAIClient
  private readonly queue: AsyncQueue

  constructor(private readonly cfg: LlmConfig) {
    if (!cfg.enabled || !cfg.apiKey) {
      throw new Error(`[meta-gen] LlmService requires enabled config with apiKey`)
    }
    this.client = new OpenAIClient({
      baseUrl: cfg.baseUrl,
      chatCompletionsPath: cfg.chatCompletionsPath,
      apiKey: cfg.apiKey,
      timeoutMs: cfg.timeoutMs,
      retries: cfg.retries,
      httpProxy: getHttpProxy(),
      userAgent: getUserAgent()
    })
    this.queue = new AsyncQueue(cfg.maxConcurrency)
  }

  private static extractContent(res: unknown): string | null {
    const r: any = res as any
    const c0 = r?.choices?.[0]

    const direct = c0?.message?.content
    if (typeof direct === 'string') return direct

    // Some providers return `message.content` as an array of parts:
    // - [{ type: "text", text: "..." }, ...]
    // - ["...", ...]
    if (Array.isArray(direct)) {
      const parts: string[] = []
      for (const p of direct) {
        if (typeof p === 'string') {
          if (p) parts.push(p)
          continue
        }
        const t = typeof p?.text === 'string' ? p.text : ''
        if (t) parts.push(t)
      }
      const joined = parts.join('')
      if (joined) return joined
    }

    // Legacy/compat: some endpoints expose `choices[0].text`.
    const legacyText = c0?.text
    if (typeof legacyText === 'string') return legacyText

    return null
  }

  get model(): string {
    return this.cfg.model
  }

  get maxConcurrency(): number {
    return this.cfg.maxConcurrency
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    return this.queue.run(async () => {
      const res = await this.client.chatCompletions({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens
      })

      const content = LlmService.extractContent(res)
      if (typeof content === 'string') return content

      const r: any = res as any
      const errMsg = typeof r?.error?.message === 'string' ? String(r.error.message) : ''
      const preview = (() => {
        try {
          const raw = JSON.stringify(res)
          return raw ? raw.slice(0, 1200) : ''
        } catch {
          return ''
        }
      })()

      throw new Error(
        `[meta-gen] LLM response missing assistant content` +
          (errMsg ? ` (error=${errMsg})` : '') +
          (preview ? `: ${preview}` : '')
      )
    })
  }
}

