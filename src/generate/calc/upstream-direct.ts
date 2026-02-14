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

function applyGsRowScopedBuffParams(plan: CalcSuggestResult, upstreamBuffs: CalcSuggestBuff[]): void {
  if (!Array.isArray(plan.details) || plan.details.length === 0) return
  if (!Array.isArray(upstreamBuffs) || upstreamBuffs.length === 0) return

  type ApplyTo = { game?: string; talentKey?: string; table?: string; paramKey?: string }
  const patches: Array<Required<Pick<ApplyTo, 'talentKey' | 'table' | 'paramKey'>>> = []
  for (const b of upstreamBuffs) {
    if (!isRecord(b)) continue
    const apply = (b as any).__applyTo as ApplyTo | undefined
    if (!apply || typeof apply !== 'object') continue
    if (apply.game && String(apply.game).trim() !== 'gs') continue
    const talentKey = typeof apply.talentKey === 'string' ? apply.talentKey.trim() : ''
    const table = typeof apply.table === 'string' ? apply.table.trim() : ''
    const paramKey = typeof apply.paramKey === 'string' ? apply.paramKey.trim() : ''
    if (!talentKey || !table || !paramKey) continue
    patches.push({ talentKey, table, paramKey })
  }
  if (!patches.length) return

  for (const d of plan.details) {
    const talent = typeof d?.talent === 'string' ? String(d.talent).trim() : ''
    const table = typeof (d as any)?.table === 'string' ? String((d as any).table).trim() : ''
    if (!talent || !table) continue

    for (const p of patches) {
      if (talent !== p.talentKey) continue
      if (table !== p.table) continue
      const cur = (d as any).params
      const next = (cur && typeof cur === 'object' && !Array.isArray(cur)) ? ({ ...cur } as any) : {}
      next[p.paramKey] = true
      ;(d as any).params = next
    }
  }
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
  let base = Array.isArray(opts.base) ? opts.base : []
  const upstream = Array.isArray(opts.upstream) ? opts.upstream : []
  if (base.length === 0 && upstream.length === 0) return undefined

  // When following upstream directly, treat upstream as the authoritative source for any overlapping data keys.
  // This avoids double-counting and ensures we don't keep heuristic placeholders when upstream provides a deterministic formula.
  if (opts.preferUpstream && upstream.length) {
    const upstreamKeys = new Set<string>()
    for (const b of upstream) {
      if (!isRecord(b)) continue
      const data = (b as any).data
      if (!isRecord(data)) continue
      for (const k of Object.keys(data)) {
        const kk = String(k || '').trim()
        if (!kk || kk.startsWith('_')) continue
        upstreamKeys.add(kk)
      }
    }

    if (upstreamKeys.size) {
      const filtered: Array<CalcSuggestBuff | string> = []
      for (const b of base) {
        if (typeof b === 'string') {
          filtered.push(b)
          continue
        }
        if (!isRecord(b)) continue
        const data = (b as any).data
        if (!isRecord(data)) {
          filtered.push(b as CalcSuggestBuff)
          continue
        }
        const next: Record<string, unknown> = { ...(data as any) }
        let changed = false
        for (const k of Object.keys(next)) {
          const kk = String(k || '').trim()
          if (!kk || kk.startsWith('_')) continue
          if (!upstreamKeys.has(kk)) continue
          delete next[k]
          changed = true
        }
        if (!changed) {
          filtered.push(b as CalcSuggestBuff)
          continue
        }
        const effectKeys = Object.keys(next).filter((k) => {
          const kk = String(k || '').trim()
          return kk && !kk.startsWith('_')
        })
        if (effectKeys.length === 0) continue
        filtered.push({ ...(b as any), data: next } as CalcSuggestBuff)
      }
      base = filtered
    }
  }

  const baseDataKeys = (() => {
    const keys = new Set<string>()
    for (const b of base) {
      if (!isRecord(b)) continue
      const data = (b as any).data
      if (!isRecord(data)) continue
      for (const k of Object.keys(data)) {
        const kk = String(k || '').trim()
        if (!kk) continue
        keys.add(kk)
      }
    }
    return keys
  })()
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
    if (!shouldReplace) {
      // Upstream can legitimately emit duplicate semantic buffs (SR `x` + `x.m` dual namespace, or multi-element RES_PEN).
      // Do not drop them: merge by summing values so semantic totals stay aligned while keeping buff count stable.
      if (opts.preferUpstream && source === 'upstream' && existing.source === 'upstream') {
        const prev = out[existing.idx]
        if (isRecord(prev)) {
          const dataPrev = (prev as any).data
          const dataNext = (buffRaw as any).data
          if (isRecord(dataPrev) && isRecord(dataNext)) {
            const add = (a: unknown, b: unknown): number | string => {
              if (typeof a === 'number' && Number.isFinite(a) && typeof b === 'number' && Number.isFinite(b)) return a + b
              const sa =
                typeof a === 'number' && Number.isFinite(a) ? String(a) : typeof a === 'string' && a.trim() ? a.trim() : '0'
              const sb =
                typeof b === 'number' && Number.isFinite(b) ? String(b) : typeof b === 'string' && b.trim() ? b.trim() : '0'
              if (sa === '0') return sb
              if (sb === '0') return sa
              return `((${sa}) + (${sb}))`
            }
            for (const [k0, v] of Object.entries(dataNext)) {
              const k = String(k0 || '').trim()
              if (!k) continue
              if (Object.prototype.hasOwnProperty.call(dataPrev, k0)) (dataPrev as any)[k0] = add((dataPrev as any)[k0], v)
              else (dataPrev as any)[k0] = v as any
            }
            ;(prev as any).data = dataPrev
            out[existing.idx] = prev as any
          }
        }
      }
      return
    }

    out[existing.idx] = buffRaw as unknown as CalcSuggestBuff
    seenBuff.set(sig, { idx: existing.idx, source })
  }

  // Preserve string buff ids (e.g. GS reactions) regardless of upstream preference.
  for (const b of base) {
    if (typeof b === 'string') pushStr(b)
  }

  // Important: validatePlan() clamps to the first ~30 buff objects in order.
  // When preferring upstream, place upstream buffs first so they are not dropped by the clamp.
  if (opts.preferUpstream) {
    for (const b of upstream) pushBuff(b, 'upstream')
    for (const b of base) {
      if (typeof b === 'string') continue
      pushBuff(b, 'base')
    }
  } else {
    for (const b of base) {
      if (typeof b === 'string') continue
      pushBuff(b, 'base')
    }
    for (const b of upstream) {

    // Prefer heuristic when upstream is disabled: upstream total-stat nodes (e.g. Hu Tao's E: HP->ATK)
    // can duplicate heuristic buffs that already model the same conversion with proper params gating.
    // Treat upstream `(...total)` as a fallback: if base already defines the same data keys, drop those keys
    // from the upstream entry to avoid double counting.
    const filtered = (() => {
      if (!isRecord(b)) return null
      const title = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
      if (!/\(total\)\s*$/.test(title)) return b
      const data = (b as any).data
      if (!isRecord(data)) return b
      const next: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(data)) {
        const kk = String(k || '').trim()
        if (!kk) continue
        if (baseDataKeys.has(kk)) continue
        next[kk] = v
      }
      if (Object.keys(next).length === 0) return null
      return { ...(b as any), data: next } as CalcSuggestBuff
    })()
      if (filtered) pushBuff(filtered, 'upstream')
    }
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
    preferUpstreamDefaults?: boolean
    preferUpstream?: boolean
  }
}): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  const { input, createdBy } = opts
  input.upstreamDirect = true
  const preferUpstream = opts.upstream?.preferUpstream !== false

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
              includeTeamBuffs: opts.upstream?.includeTeamBuffs,
              preferUpstreamDefaults: opts.upstream?.preferUpstreamDefaults
            }
          })
        : buildGsUpstreamDirectBuffs({
            projectRootAbs: opts.projectRootAbs,
            id: input.id,
            elem: input.elem,
            input,
            upstream: {
              genshinOptimizerRoot: opts.upstream?.genshinOptimizerRoot,
              includeTeamBuffs: opts.upstream?.includeTeamBuffs
            }
          })
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
  // NOTE: validatePlan() postprocesses buff expressions (clamps, gating, etc.).
  // Re-merging raw upstream buffs after validation would re-introduce pre-validated variants and double-count.
  //
  // However, validatePlan() may also inject derived/heuristic buffs AFTER we merged upstream-direct,
  // which can create double-counting for certain keys. Treat upstream "(total)" buffs as a fallback:
  // if other buffs already define the same data keys, drop those keys from upstream total entries.
  try {
    const buffs = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as Array<CalcSuggestBuff | string>) : []
    if (buffs.length) {
      const isUpstreamTotal = (b: unknown): boolean => {
        if (!isRecord(b)) return false
        const t = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
        return /^upstream:.*\(\s*total\s*\)\s*$/i.test(t)
      }

      if (preferUpstream) {
        const upstreamKeys = new Set<string>()
        for (const b of buffs) {
          if (!isRecord(b)) continue
          const t = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
          if (!t.startsWith('upstream:')) continue
          const data = (b as any).data
          if (!isRecord(data)) continue
          for (const k of Object.keys(data)) {
            const kk = String(k || '').trim()
            if (kk && !kk.startsWith('_')) upstreamKeys.add(kk)
          }
        }

        if (upstreamKeys.size) {
          const next: Array<CalcSuggestBuff | string> = []
          for (const b of buffs) {
            if (typeof b === 'string') {
              next.push(b)
              continue
            }
            if (!isRecord(b)) continue
            const t = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
            if (t.startsWith('upstream:')) {
              next.push(b as CalcSuggestBuff)
              continue
            }
            const data = (b as any).data
            if (!isRecord(data)) {
              next.push(b as CalcSuggestBuff)
              continue
            }
            const filtered: Record<string, unknown> = { ...(data as any) }
            let changed = false
            for (const k of Object.keys(filtered)) {
              const kk = String(k || '').trim()
              if (!kk || kk.startsWith('_')) continue
              if (!upstreamKeys.has(kk)) continue
              delete filtered[k]
              changed = true
            }
            if (!changed) {
              next.push(b as CalcSuggestBuff)
              continue
            }
            const effectKeys = Object.keys(filtered).filter((k) => {
              const kk = String(k || '').trim()
              return kk && !kk.startsWith('_')
            })
            if (effectKeys.length) next.push({ ...(b as any), data: filtered } as CalcSuggestBuff)
          }
          ;(plan as any).buffs = next
        }
      } else {
        const otherKeys = new Set<string>()
        for (const b of buffs) {
          if (isUpstreamTotal(b)) continue
          if (!isRecord(b)) continue
          const data = (b as any).data
          if (!isRecord(data)) continue
          for (const k of Object.keys(data)) {
            const kk = String(k || '').trim()
            if (kk) otherKeys.add(kk)
          }
        }

        if (otherKeys.size) {
          const next: Array<CalcSuggestBuff | string> = []
          for (const b of buffs) {
            if (!isUpstreamTotal(b)) {
              next.push(b)
              continue
            }
            if (!isRecord(b)) continue
            const data = (b as any).data
            if (!isRecord(data)) continue
            const filtered: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(data)) {
              const kk = String(k || '').trim()
              if (!kk) continue
              if (otherKeys.has(kk)) continue
              filtered[kk] = v
            }
            if (Object.keys(filtered).length) next.push({ ...(b as any), data: filtered } as CalcSuggestBuff)
          }
          ;(plan as any).buffs = next
        }
      }
    }
  } catch {
    // best-effort
  }

  // Row-scoped upstream buffs (e.g. node-local premods in genshin-optimizer) require detail-level params gating.
  // Attach inferred params to matching details so miao-plugin applies the buff only for those rows.
  try {
    if (input.game === 'gs') applyGsRowScopedBuffParams(plan, upstreamBuffs)
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
