/**
 * Disk cache for LLM chat responses.
 *
 * Why:
 * - Weak/slow/free models are often rate-limited; caching avoids repeated calls.
 * - metaGenerator is designed to be reproducible; we store responses under `.cache/llm`.
 *
 * Security:
 * - Never store API keys.
 * - Cache content only includes prompt/response text and metadata.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../fs/ensure.js'
import type { ChatMessage } from './openai.js'
import type { LlmService, ChatOptions } from './service.js'

export interface LlmDiskCacheOptions {
  /** Absolute path to `.cache/llm` */
  cacheRootAbs: string
  /** Logical namespace to avoid cross-feature collisions. */
  purpose: string
  /** When true, bypass cache and overwrite. */
  force: boolean
}

function stableStringify(v: unknown): string {
  return JSON.stringify(v, (_k, val) => {
    if (!val || typeof val !== 'object' || Array.isArray(val)) return val
    const obj = val as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of Object.keys(obj).sort()) out[k] = obj[k]
    return out
  })
}

function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex')
}

function cachePath(opts: LlmDiskCacheOptions, hash: string): string {
  return path.join(opts.cacheRootAbs, opts.purpose, `${hash}.json`)
}

export async function chatWithDiskCache(
  llm: LlmService,
  messages: ChatMessage[],
  chatOpts: ChatOptions,
  cache: LlmDiskCacheOptions
): Promise<string> {
  const payload = {
    model: llm.model,
    messages,
    temperature: chatOpts.temperature ?? null,
    max_tokens: chatOpts.maxTokens ?? null
  }
  const hash = sha256(stableStringify(payload))
  const filePath = cachePath(cache, hash)

  if (!cache.force && fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (raw && typeof raw === 'object' && typeof (raw as any).text === 'string') {
        return (raw as any).text as string
      }
    } catch {
      // Corrupted cache: fall through to re-fetch.
    }
  }

  const text = await llm.chat(messages, chatOpts)
  try {
    ensureDir(path.dirname(filePath))
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          model: llm.model,
          text
        },
        null,
        2
      ) + '\n',
      'utf8'
    )
  } catch {
    // Ignore cache write failures.
  }
  return text
}

/**
 * Same as chatWithDiskCache, but only returns cached/new text when it passes validation.
 * Invalid cached responses are ignored, and invalid new responses are NOT written to disk.
 *
 * This avoids getting stuck with a bad cached response when the model outputs non-JSON / invalid JSON.
 */
export async function chatWithDiskCacheValidated(
  llm: LlmService,
  messages: ChatMessage[],
  chatOpts: ChatOptions,
  cache: LlmDiskCacheOptions,
  validateText: (text: string) => boolean
): Promise<string> {
  const payload = {
    model: llm.model,
    messages,
    temperature: chatOpts.temperature ?? null,
    max_tokens: chatOpts.maxTokens ?? null
  }
  const hash = sha256(stableStringify(payload))
  const filePath = cachePath(cache, hash)

  if (!cache.force && fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'))
      if (raw && typeof raw === 'object' && typeof (raw as any).text === 'string') {
        const text = (raw as any).text as string
        try {
          if (validateText(text)) return text
        } catch {
          // Invalid cached: ignore.
        }
      }
    } catch {
      // Corrupted cache: fall through to re-fetch.
    }
  }

  const text = await llm.chat(messages, chatOpts)
  let ok = false
  try {
    ok = validateText(text)
  } catch {
    ok = false
  }

  if (ok) {
    try {
      ensureDir(path.dirname(filePath))
      fs.writeFileSync(
        filePath,
        JSON.stringify(
          {
            createdAt: new Date().toISOString(),
            model: llm.model,
            text
          },
          null,
          2
        ) + '\n',
        'utf8'
      )
    } catch {
      // Ignore cache write failures.
    }
  }

  return text
}
