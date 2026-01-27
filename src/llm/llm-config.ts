/**
 * LLM configuration for OpenAI-compatible APIs.
 *
 * `config/config.json` is gitignored, so users may choose to store API keys there.
 * However, never put secrets into committed files (docs/examples/code).
 */

import type { ToolConfig } from '../config/config.js'

export interface LlmConfig {
  enabled: boolean
  baseUrl: string
  chatCompletionsPath: string
  model: string
  timeoutMs: number
  retries: number
  /**
   * Maximum concurrent LLM requests.
   * Default: 1 (safe for most free-tier models).
   */
  maxConcurrency: number
  /**
   * API key for OpenAI-compatible APIs.
   *
   * Only present when enabled=true and key is resolved from:
   * - llm.apiKey (direct string), or
   * - process.env[llm.apiKeyEnv]
   */
  apiKey?: string
  /**
   * Env var name (when used).
   *
   * NOTE: Some users may mistakenly paste the API key into `apiKeyEnv`.
   * We treat a non-env-var-like `apiKeyEnv` value as a direct key for compatibility.
   */
  apiKeyEnv: string
}

function trimStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

function isEnvVarName(s: string): boolean {
  // Conservative check: treat common env var shapes as env var names.
  // This avoids accidentally logging or exposing user-provided secrets.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
}

export function loadLlmConfig(config: ToolConfig | undefined): LlmConfig {
  const llm = config?.llm
  const enabled = Boolean(llm?.enabled)
  const baseUrl = (llm?.baseUrl || 'https://api.openai.com').replace(/\/+$/, '')
  const chatCompletionsPath = llm?.chatCompletionsPath || '/v1/chat/completions'
  const model = llm?.model || ''
  const timeoutMs = Number.isFinite(llm?.timeoutMs) ? (llm?.timeoutMs as number) : 30_000
  const retries = Number.isFinite(llm?.retries) ? (llm?.retries as number) : 2
  const maxConcurrencyRaw = Number.isFinite(llm?.maxConcurrency) ? (llm?.maxConcurrency as number) : 1
  const maxConcurrency = Math.max(1, Math.floor(maxConcurrencyRaw))

  const directKey = trimStr(llm?.apiKey)
  const apiKeyEnvRaw = trimStr(llm?.apiKeyEnv) || 'META_LLM_API_KEY'
  const apiKeyEnv = isEnvVarName(apiKeyEnvRaw) ? apiKeyEnvRaw : 'META_LLM_API_KEY'

  // Resolve API key:
  // - Prefer direct key (config.json is gitignored).
  // - Else read from env var name.
  // - Compatibility: if apiKeyEnvRaw does NOT look like an env var name, treat it as a direct key.
  const apiKey =
    directKey || (isEnvVarName(apiKeyEnvRaw) ? process.env[apiKeyEnvRaw] : apiKeyEnvRaw)

  if (enabled) {
    if (!model) {
      throw new Error(`[meta-gen] LLM enabled but llm.model is empty`)
    }
    if (!apiKey) {
      // Avoid printing any user-provided value (it might be a secret).
      throw new Error(`[meta-gen] LLM enabled but api key is missing (set llm.apiKey or env ${apiKeyEnv})`)
    }
  }

  return {
    enabled,
    baseUrl,
    chatCompletionsPath,
    model,
    timeoutMs,
    retries,
    maxConcurrency,
    apiKey: enabled ? apiKey : undefined,
    apiKeyEnv
  }
}
