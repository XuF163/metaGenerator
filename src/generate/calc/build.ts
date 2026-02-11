import path from 'node:path'
import type { LlmDiskCacheOptions } from '../../llm/disk-cache.js'
import type { LlmService } from '../../llm/service.js'
import { buildCalcJsWithLlmOrHeuristic, calcCreatedBy, type CalcChannel, type CalcSuggestInput } from './llm-calc.js'
import { buildCalcUpstreamContext } from './upstream-follow/context.js'

export function normalizeCalcChannel(v: unknown): CalcChannel {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return t === 'upstream' ? 'upstream' : 'llm'
}

function resolveMaybeRelative(projectRootAbs: string, p: string | undefined): string | undefined {
  const t = typeof p === 'string' ? p.trim() : ''
  if (!t) return undefined
  return path.isAbsolute(t) ? t : path.resolve(projectRootAbs, t)
}

export async function buildCalcJsWithChannel(opts: {
  llm: LlmService | undefined
  input: CalcSuggestInput
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
  channel: CalcChannel
  projectRootAbs: string
  upstream?: {
    genshinOptimizerRoot?: string
    hsrOptimizerRoot?: string
    includeTeamBuffs?: boolean
  }
}): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  const createdBy = calcCreatedBy(opts.channel)

  if (opts.channel !== 'upstream') {
    return buildCalcJsWithLlmOrHeuristic(opts.llm, opts.input, opts.cache, createdBy)
  }

  const input: CalcSuggestInput = { ...opts.input }
  const upstreamCtx = buildCalcUpstreamContext({
    projectRootAbs: opts.projectRootAbs,
    game: input.game,
    id: input.id,
    name: input.name,
    genshinOptimizerRootAbs: resolveMaybeRelative(opts.projectRootAbs, opts.upstream?.genshinOptimizerRoot),
    hsrOptimizerRootAbs: resolveMaybeRelative(opts.projectRootAbs, opts.upstream?.hsrOptimizerRoot),
    includeTeamBuffs: opts.upstream?.includeTeamBuffs
  })
  if (upstreamCtx) input.upstream = upstreamCtx

  return buildCalcJsWithLlmOrHeuristic(opts.llm, input, opts.cache, createdBy)
}
