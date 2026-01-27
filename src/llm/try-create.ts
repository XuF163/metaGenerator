/**
 * Shared helper for creating an LlmService from tool config.
 *
 * Why:
 * - Keep command modules small and consistent (gen/calc/etc.).
 * - Avoid duplicating config parsing + logging logic in each command.
 */

import type { ToolConfig } from '../config/config.js'
import type { CommandContext } from '../types.js'
import { loadLlmConfig } from './llm-config.js'
import { LlmService } from './service.js'

export function tryCreateLlmService(
  ctx: CommandContext,
  toolConfig: ToolConfig | undefined,
  opts: { purpose: string; required?: boolean }
): LlmService | undefined {
  try {
    const llmCfg = loadLlmConfig(toolConfig)
    if (!llmCfg.enabled) {
      if (opts.required) {
        ctx.log.warn(`[meta-gen] ${opts.purpose}: LLM requested but llm.enabled=false, using heuristic calc`)
      }
      return undefined
    }

    ctx.log.info(
      `[meta-gen] LLM enabled (${opts.purpose}): model=${llmCfg.model} maxConcurrency=${llmCfg.maxConcurrency}`
    )
    return new LlmService(llmCfg)
  } catch (e) {
    ctx.log.warn(`[meta-gen] LLM disabled (${opts.purpose}): ${String(e)}`)
    return undefined
  }
}

