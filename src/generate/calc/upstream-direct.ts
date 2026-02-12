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

function normalizeSpace(text: string): string {
  return String(text || '')
    .trim()
    .replace(/\s+/g, ' ')
}

function parseNumberLiteral(text: string): number | null {
  const t = String(text || '').trim()
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(t)) return null
  const n = Number(t)
  return Number.isFinite(n) ? n : null
}

function canonicalizeBuffDataPairs(dataRaw: unknown): Array<[string, number | string]> {
  if (!isRecord(dataRaw)) return []
  const out: Array<[string, number | string]> = []
  const keys = Object.keys(dataRaw)
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .sort()
  for (const k of keys) {
    const vRaw = (dataRaw as Record<string, unknown>)[k]
    if (typeof vRaw === 'number') {
      if (!Number.isFinite(vRaw)) continue
      out.push([k, vRaw])
      continue
    }
    if (typeof vRaw === 'string') {
      const n = parseNumberLiteral(vRaw)
      if (n != null) out.push([k, n])
      else {
        const t = normalizeSpace(vRaw)
        if (t) out.push([k, t])
      }
      continue
    }
  }
  return out
}

function buffSemanticSignature(buffRaw: unknown): string | null {
  if (!isRecord(buffRaw)) return null
  const title = typeof (buffRaw as any).title === 'string' ? String((buffRaw as any).title).trim() : ''
  if (!title) return null

  const cons = typeof (buffRaw as any).cons === 'number' && Number.isFinite((buffRaw as any).cons) ? Math.trunc((buffRaw as any).cons) : 0
  const tree = typeof (buffRaw as any).tree === 'number' && Number.isFinite((buffRaw as any).tree) ? Math.trunc((buffRaw as any).tree) : 0
  const check = typeof (buffRaw as any).check === 'string' ? normalizeSpace((buffRaw as any).check) : ''
  const dataPairs = canonicalizeBuffDataPairs((buffRaw as any).data)

  // Prefer a title-free signature so we can deduplicate across different sources/titles.
  // If a buff has no usable `data`, we fall back to including title to avoid collapsing unrelated placeholders.
  const canon: Record<string, unknown> = { cons, tree, check, data: dataPairs }
  if (dataPairs.length === 0) canon.title = title
  return JSON.stringify(canon)
}

function mergePlanBuffs(opts: {
  base: Array<CalcSuggestBuff | string> | undefined
  upstream: CalcSuggestBuff[]
  preferUpstream: boolean
}): Array<CalcSuggestBuff | string> | undefined {
  const base = Array.isArray(opts.base) ? opts.base : []
  const upstream = Array.isArray(opts.upstream) ? opts.upstream : []
  if (base.length === 0 && upstream.length === 0) return undefined
  const seenStr = new Set<string>()
  const seenBuff = new Map<string, { idx: number; source: 'base' | 'upstream' }>()
  const out: Array<CalcSuggestBuff | string> = []

  const pushStr = (s: string): void => {
    const t = s.trim()
    if (!t) return
    if (seenStr.has(t)) return
    seenStr.add(t)
    out.push(t)
  }

  const pushBuff = (buffRaw: unknown, source: 'base' | 'upstream'): void => {
    if (!isRecord(buffRaw)) return
    const sig = buffSemanticSignature(buffRaw)
    if (!sig) return

    const existing = seenBuff.get(sig)
    if (!existing) {
      out.push(buffRaw as unknown as CalcSuggestBuff)
      seenBuff.set(sig, { idx: out.length - 1, source })
      return
    }

    const shouldReplace =
      (opts.preferUpstream && source === 'upstream' && existing.source === 'base') ||
      (!opts.preferUpstream && source === 'base' && existing.source === 'upstream')
    if (!shouldReplace) return

    out[existing.idx] = buffRaw as unknown as CalcSuggestBuff
    seenBuff.set(sig, { idx: existing.idx, source })
  }

  for (const b of base) {
    if (typeof b === 'string') {
      pushStr(b)
      continue
    }
    pushBuff(b, 'base')
  }

  for (const b of upstream) {
    pushBuff(b, 'upstream')
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
            upstream: {
              genshinOptimizerRoot: opts.upstream?.genshinOptimizerRoot,
              includeTeamBuffs: opts.upstream?.includeTeamBuffs
            }
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
