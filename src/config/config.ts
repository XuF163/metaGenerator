/**
 * Runtime configuration loader.
 *
 * - config file is optional
 * - CLI flags always override config defaults
 * - config.json is gitignored; only config.example.json is committed
 */

import fs from 'node:fs'
import path from 'node:path'
import type { Game, MetaType } from '../types.js'

export interface ToolConfig {
  baselineRoot?: string
  outputRoot?: string
  games?: Game[]
  types?: MetaType[]
  network?: {
    /**
     * Optional network proxy/mirror prefix/template for all HTTP(S) requests.
     *
     * Supported forms:
     * - Prefix: "https://ghproxy.com/"  -> proxy + url
     * - Template: "https://r.jina.ai/http://{urlNoProto}" or "https://ghproxy.com/{url}"
     *
     * Placeholders:
     * - {url}                 raw url (https://...)
     * - {encodedUrl}          encodeURIComponent(url)
     * - {urlNoProto}          url without leading scheme (example.com/...)
     * - {encodedUrlNoProto}   encodeURIComponent(urlNoProto)
     */
    proxy?: string
    /** Custom User-Agent header for upstream requests (default: "metaGenerator"). */
    userAgent?: string
  }
  gen?: {
    force?: boolean
    forceCache?: boolean
    forceAssets?: boolean
    /**
     * Whether `meta-gen gen` should use LLM (if configured) to generate `calc.js` for characters.
     *
     * Default: false (keep `gen` deterministic and fast).
     * Tip: Prefer running `meta-gen calc` to batch-upgrade placeholder calc.js files when using weak/slow models.
     */
    llmCalc?: boolean
  }
  validate?: {
    strictExtra?: boolean
    sampleFiles?: number
    seed?: string
  }
  llm?: {
    /** Enable LLM features (disabled by default). */
    enabled?: boolean
    /** OpenAI-compatible base URL. Example: https://api.openai.com */
    baseUrl?: string
    /**
     * OpenAI-compatible chat completions path.
     * Default: /v1/chat/completions
     *
     * Some providers use a non-standard prefix while keeping the OpenAI payload shape,
     * e.g. Zhipu/BigModel: /api/paas/v4/chat/completions
     */
    chatCompletionsPath?: string
    /**
     * Direct API key (recommended only in `config/config.json`, which is gitignored).
     *
     * DO NOT put secrets into any committed files.
     */
    apiKey?: string
    /** Env var name for API key (so we never store secrets in repo). */
    apiKeyEnv?: string
    /** Model name, user configurable. */
    model?: string
    /** Request timeout in ms. */
    timeoutMs?: number
    /** Retry count for transient errors. */
    retries?: number
    /**
     * Maximum concurrent LLM requests.
     * MUST be 1 for providers/models that do not allow concurrency (e.g. free-tier models).
     *
     * Default: 1
     */
    maxConcurrency?: number
  }
}

export function loadToolConfig(projectRoot: string): ToolConfig | null {
  const configPath = path.join(projectRoot, 'config', 'config.json')
  if (!fs.existsSync(configPath)) return null

  try {
    const raw = fs.readFileSync(configPath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== 'object') return null
    return parsed as ToolConfig
  } catch {
    // config is optional; on parse failure we ignore it and rely on CLI.
    return null
  }
}
