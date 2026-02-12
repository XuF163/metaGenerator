/**
 * LLM-assisted calc.js generation.
 *
 * Strategy (safe for weak/slow models):
 * - Ask the model to output a small JSON plan (no JS code).
 * - Validate the plan locally.
 * - Render deterministic JS from the plan.
 *
 * If LLM is unavailable or returns invalid output, we fall back to a heuristic plan.
 */

import type { LlmService } from '../../llm/service.js'
import type { ChatMessage } from '../../llm/openai.js'
import { parseJsonFromLlmText } from '../../llm/json.js'
import type { LlmDiskCacheOptions } from '../../llm/disk-cache.js'
import { chatWithDiskCacheValidated } from '../../llm/disk-cache.js'

import type { CalcSuggestInput, CalcSuggestResult } from './llm-calc/types.js'
import { clampBuffs, clampDetails, shortenText } from './llm-calc/utils.js'
import { heuristicPlan } from './llm-calc/heuristic.js'
import { buildMessages } from './llm-calc/prompt.js'
import { applySrDerivedFromBuffHints, validatePlan } from './llm-calc/plan-validate.js'
import { renderCalcJs } from './llm-calc/render.js'
import { validateCalcJsRuntime, validateCalcJsText } from './llm-calc/js-validate.js'

export type {
  CalcDetailKind,
  CalcScaleStat,
  CalcSuggestBuff,
  CalcSuggestDetail,
  CalcSuggestInput,
  CalcSuggestResult
} from './llm-calc/types.js'

export type CalcChannel = 'llm' | 'upstream' | 'upstream-direct'

export const CALC_CREATED_BY_LLM = 'awesome-gpt5.2-xhigh.llm-calc.v28'
export const CALC_CREATED_BY_UPSTREAM = 'awesome-gpt5.2-xhigh.upstream-follow.v6'
export const CALC_CREATED_BY_UPSTREAM_DIRECT = 'awesome-gpt5.2-xhigh.upstream-direct.v13'

// Back-compat: old callsites treat this as the single expected signature.
export const CALC_CREATED_BY = CALC_CREATED_BY_LLM

export function calcCreatedBy(channel: CalcChannel): string {
  if (channel === 'upstream') return CALC_CREATED_BY_UPSTREAM
  if (channel === 'upstream-direct') return CALC_CREATED_BY_UPSTREAM_DIRECT
  return CALC_CREATED_BY_LLM
}

// Requirement: generated calc.js should have a consistent signature.
const DEFAULT_CREATED_BY = CALC_CREATED_BY_LLM

export async function suggestCalcPlan(
  llm: LlmService,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>,
  retryHint?: string
): Promise<CalcSuggestResult> {
  const messagesBase = buildMessages(input)
  const messagesHint =
    retryHint && retryHint.trim()
      ? messagesBase.concat({
          role: 'user',
          content: '上一次输出未通过本地校验（请修正而不是复述规则）：\n' + shortenText(String(retryHint), 700)
        })
      : messagesBase
  const attempts: Array<{ temperature: number; messages: ChatMessage[] }> = [
    { temperature: 0.2, messages: messagesHint },
    {
      temperature: 0,
      messages: messagesHint.concat({
        role: 'user',
        content:
          '上一次输出可能不是严格 JSON。请重新输出：\n' +
          '- 只能输出一个 JSON 对象\n' +
          '- 所有 key 必须使用双引号\n' +
          '- 禁止尾随逗号\n' +
          '- 禁止输出任何 JSON 之外的文字'
      })
    }
  ]

  let lastErr: string | undefined
  for (let i = 0; i < attempts.length; i++) {
    const { temperature, messages } = attempts[i]!

    const text = cache
      ? await chatWithDiskCacheValidated(
          llm,
          messages,
          { temperature },
          { ...cache, purpose: `calc-plan.v3.${i}` },
          (t) => {
            try {
              const json = parseJsonFromLlmText(t)
              if (!json || typeof json !== 'object') return false
              const plan = json as Partial<CalcSuggestResult>
              const parsed: CalcSuggestResult = {
                mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
                defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
                details: Array.isArray(plan.details) ? (plan.details as any) : [],
                buffs: Array.isArray((plan as any).buffs) ? ((plan as any).buffs as any) : []
              }
              validatePlan(input, parsed)
              return true
            } catch {
              return false
            }
          }
        )
      : await llm.chat(messages, { temperature })

    try {
      const json = parseJsonFromLlmText(text)
      if (!json || typeof json !== 'object') {
        throw new Error(`[meta-gen] LLM output is not an object`)
      }

      const plan = json as Partial<CalcSuggestResult>
      const parsed: CalcSuggestResult = {
        mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
        defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
        details: Array.isArray(plan.details) ? clampDetails(plan.details as any) : [],
        buffs: Array.isArray((plan as any).buffs) ? (clampBuffs((plan as any).buffs as any) as any) : []
      }
      return validatePlan(input, parsed)
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  throw new Error(lastErr || `[meta-gen] LLM calc plan failed`)
}

export { renderCalcJs }

export async function buildCalcJsWithLlmOrHeuristic(
  llm: LlmService | undefined,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>,
  createdBy = DEFAULT_CREATED_BY
): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  if (!llm) {
    let plan = heuristicPlan(input)
    // Best-effort post-processing for heuristic plans.
    try {
      plan = validatePlan(input, plan)
    } catch {
      // Keep heuristic plan as-is.
    }
    applySrDerivedFromBuffHints(input, plan)
    const js = renderCalcJs(input, plan, createdBy)
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input)
    return { js, usedLlm: false }
  }

  // Stronger retry: even if the JSON plan is valid, it may still render into invalid JS
  // (e.g. unbalanced expressions). We validate the final JS and retry a few times.
  const MAX_TRIES = 3
  let lastErr: string | undefined
  for (let i = 0; i < MAX_TRIES; i++) {
    try {
      const cacheTry = cache ? { ...cache, force: i > 0 ? true : cache.force } : undefined
      const plan = await suggestCalcPlan(llm, input, cacheTry, lastErr)
      applySrDerivedFromBuffHints(input, plan)
      const js = renderCalcJs(input, plan, createdBy)
      validateCalcJsText(js)
      validateCalcJsRuntime(js, input)
      return { js, usedLlm: true }
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  let plan = heuristicPlan(input)
  try {
    plan = validatePlan(input, plan)
  } catch {
    // Keep heuristic plan as-is.
  }
  applySrDerivedFromBuffHints(input, plan)
  const js = renderCalcJs(input, plan, createdBy)
  // Heuristic output should always be valid; if not, still return it (caller logs error).
  try {
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input)
  } catch (e) {
    // Keep lastErr as the primary reason; avoid overriding with a secondary validation msg.
    if (!lastErr) lastErr = e instanceof Error ? e.message : String(e)
  }
  return { js, usedLlm: false, error: lastErr || `[meta-gen] LLM calc plan failed` }
}
