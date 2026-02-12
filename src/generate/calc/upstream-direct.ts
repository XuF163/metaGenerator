import type { CalcSuggestBuff, CalcSuggestInput, CalcSuggestResult } from './llm-calc/types.js'
import { heuristicPlan } from './llm-calc/heuristic.js'
import { validatePlan } from './llm-calc/plan-validate.js'
import { renderCalcJs } from './llm-calc/render.js'
import { validateCalcJsRuntime, validateCalcJsText } from './llm-calc/js-validate.js'
import { buildGsUpstreamDirectBuffs } from './upstream-direct-gs.js'
import { buildSrUpstreamDirectBuffs } from './upstream-direct-sr.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function mergePlanBuffs(opts: {
  base: Array<CalcSuggestBuff | string> | undefined
  upstream: CalcSuggestBuff[]
  preferUpstream: boolean
}): Array<CalcSuggestBuff | string> | undefined {
  const base = Array.isArray(opts.base) ? opts.base : []
  const upstream = Array.isArray(opts.upstream) ? opts.upstream : []
  if (upstream.length === 0) return base.length ? base : undefined

  const baseKeys = new Set<string>()
  for (const b of base) {
    if (!isRecord(b)) continue
    const data = isRecord((b as any).data) ? ((b as any).data as Record<string, unknown>) : null
    if (!data) continue
    for (const k of Object.keys(data)) if (k) baseKeys.add(k)
  }
  const upstreamKeys = new Set<string>()
  for (const b of upstream) {
    if (!isRecord(b)) continue
    const data = isRecord((b as any).data) ? ((b as any).data as Record<string, unknown>) : null
    if (!data) continue
    for (const k of Object.keys(data)) if (k) upstreamKeys.add(k)
  }

  const dropFromBase = opts.preferUpstream ? upstreamKeys : new Set<string>()
  const dropFromUpstream = opts.preferUpstream ? new Set<string>() : baseKeys

  const seenStr = new Set<string>()
  const out: Array<CalcSuggestBuff | string> = []

  const pushStr = (s: string): void => {
    const t = s.trim()
    if (!t) return
    if (seenStr.has(t)) return
    seenStr.add(t)
    out.push(t)
  }

  const filterBuff = (buffRaw: unknown, drop: Set<string>): CalcSuggestBuff | null => {
    if (!isRecord(buffRaw)) return null
    const title = typeof (buffRaw as any).title === 'string' ? ((buffRaw as any).title as string).trim() : ''
    if (!title) return null

    const dataIn = isRecord((buffRaw as any).data) ? ((buffRaw as any).data as Record<string, unknown>) : null
    if (!dataIn) return buffRaw as unknown as CalcSuggestBuff

    const data: Record<string, number | string> = {}
    for (const [k, v] of Object.entries(dataIn)) {
      if (!k || drop.has(k)) continue
      if (typeof v === 'number' || typeof v === 'string') data[k] = v
    }
    if (Object.keys(data).length === 0) return null
    return { ...(buffRaw as unknown as CalcSuggestBuff), data }
  }

  for (const b of base) {
    if (typeof b === 'string') {
      pushStr(b)
      continue
    }
    const filtered = filterBuff(b, dropFromBase)
    if (filtered) out.push(filtered)
  }

  for (const b of upstream) {
    const filtered = filterBuff(b, dropFromUpstream)
    if (filtered) out.push(filtered)
  }

  return out.length ? out : undefined
}

export async function buildCalcJsWithUpstreamDirect(opts: {
  input: CalcSuggestInput
  createdBy: string
  projectRootAbs: string
  upstream?: {
    genshinOptimizerRoot?: string
    hsrOptimizerRoot?: string
    includeTeamBuffs?: boolean
    preferUpstream?: boolean
  }
}): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  const { input, createdBy } = opts

  let plan: CalcSuggestResult = heuristicPlan(input)
  let upstreamBuffs: CalcSuggestBuff[] = []
  try {
    upstreamBuffs =
      input.game === 'sr'
        ? buildSrUpstreamDirectBuffs({
            projectRootAbs: opts.projectRootAbs,
            id: input.id,
            input,
            upstream: {
              hsrOptimizerRoot: opts.upstream?.hsrOptimizerRoot,
              includeTeamBuffs: opts.upstream?.includeTeamBuffs
            }
          })
        : buildGsUpstreamDirectBuffs({
            projectRootAbs: opts.projectRootAbs,
            id: input.id,
            elem: input.elem,
            upstream: { genshinOptimizerRoot: opts.upstream?.genshinOptimizerRoot }
          })
    const preferUpstream = opts.upstream?.preferUpstream !== false
    const merged = mergePlanBuffs({
      base: Array.isArray(plan.buffs) ? plan.buffs : undefined,
      upstream: upstreamBuffs,
      preferUpstream
    })
    if (merged) (plan as any).buffs = merged
  } catch {
    // best-effort
  }
  try {
    plan = validatePlan(input, plan)
  } catch {
    // keep heuristic plan as-is
  }
  // validatePlan() may inject additional buffs (e.g. special mechanics) that can overlap with upstream-derived keys.
  // Re-merge once more to prevent double-counting and keep `preferUpstream` behavior stable.
  try {
    if (upstreamBuffs.length) {
      const preferUpstream = opts.upstream?.preferUpstream !== false
      const merged = mergePlanBuffs({
        base: Array.isArray(plan.buffs) ? plan.buffs : undefined,
        upstream: upstreamBuffs,
        preferUpstream
      })
      if (merged) (plan as any).buffs = merged
    }
  } catch {
    // best-effort
  }

  try {
    const js = renderCalcJs(input, plan, createdBy)
    validateCalcJsText(js)
    validateCalcJsRuntime(js, input)
    return { js, usedLlm: false }
  } catch (e) {
    const lastErr = e instanceof Error ? e.message : String(e)

    let fallbackPlan: CalcSuggestResult = heuristicPlan(input)
    try {
      fallbackPlan = validatePlan(input, fallbackPlan)
    } catch {
      // keep heuristic
    }

    const js = renderCalcJs(input, fallbackPlan, createdBy)
    try {
      validateCalcJsText(js)
      validateCalcJsRuntime(js, input)
    } catch {
      // best-effort: keep invalidity reason from upstream-derived attempt
    }
    return { js, usedLlm: false, error: lastErr }
  }
}
