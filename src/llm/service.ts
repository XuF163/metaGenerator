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
      retries: cfg.retries
    })
    this.queue = new AsyncQueue(cfg.maxConcurrency)
  }

  get model(): string {
    return this.cfg.model
  }

  async chat(messages: ChatMessage[], opts: ChatOptions = {}): Promise<string> {
    return this.queue.run(async () => {
      const res = await this.client.chatCompletions({
        model: this.cfg.model,
        messages,
        temperature: opts.temperature,
        max_tokens: opts.maxTokens
      })
      const content = res.choices?.[0]?.message?.content
      if (typeof content !== 'string') {
        throw new Error(`[meta-gen] LLM response missing choices[0].message.content`)
      }
      return content
    })
  }
}

