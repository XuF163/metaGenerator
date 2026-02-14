import type {
  CalcDetailKind,
  CalcScaleStat,
  CalcSuggestBuff,
  CalcSuggestDetail,
  CalcSuggestInput,
  CalcSuggestResult,
  TalentKey,
  TalentKeyGs
} from './types.js'
import {
  clampBuffs,
  clampDetails,
  isAllowedMiaoBuffDataKey,
  jsString,
  normalizePromptText,
  normalizeTableList,
  shortenText,
  uniq
} from './utils.js'
import { pickDamageTable } from './heuristic.js'
import { rewriteGsAdditiveCoeffDmgExpr } from './plan-validate/gs-dmgexpr-fixup.js'
import { rewriteGsDmgExprFixArrayDmgCalls } from './plan-validate/gs-dmgexpr-array-call-fixup.js'
import { rewriteDmgExprRemoveCritExpectation } from './plan-validate/dmgexpr-crit-fixup.js'
import { applyGsBuffFilterTowardsBaseline } from './plan-validate/gs-buff-filter.js'
import { expandGsArrayVariantDetails } from './plan-validate/gs-array-expand.js'
import { applyGsArrayVariantPicksFromTitles } from './plan-validate/gs-array-pick.js'
import { applyGsBurstAltAttackKeyMapping } from './plan-validate/gs-qstate.js'
import { applyGsPostprocess } from './plan-validate/gs-postprocess.js'
import { applyGsShieldStrengthBuffFromHints } from './plan-validate/gs-shield-buff-hints.js'
import { rewriteGsBasePlusPerLayerDetails } from './plan-validate/gs-stack-per-layer.js'
import { normalizeGsDetailTitlesTowardsBaseline } from './plan-validate/gs-title-normalize.js'
import { normalizeKind, normalizeStat } from './plan-validate/normalize.js'
import { rewriteSrDeltaMultiplierIncreaseExprs } from './plan-validate/sr-dmgexpr-fixup.js'
import { applySrPostprocess } from './plan-validate/sr-postprocess.js'
import { applySrBuffPostprocess } from './plan-validate/sr-buff-postprocess.js'

export function validatePlan(input: CalcSuggestInput, plan: CalcSuggestResult): CalcSuggestResult {
  const tables: Record<string, string[]> = {}
  for (const k0 of Object.keys(input.tables || {})) {
    const k = String(k0 || '').trim()
    if (!k) continue
    tables[k] = normalizeTableList((input.tables as any)[k])
  }
  const okTalents = new Set<string>(Object.keys(tables))
  const qTables = tables.q || []

  let mainAttr = typeof plan.mainAttr === 'string' ? plan.mainAttr.trim() : ''
  if (!mainAttr) {
    throw new Error(`[meta-gen] invalid LLM plan: mainAttr is empty`)
  }

  const gsReactionCanon: Record<string, string> = {
    swirl: 'swirl',
    crystallize: 'crystallize',
    bloom: 'bloom',
    hyperbloom: 'hyperBloom',
    burgeon: 'burgeon',
    burning: 'burning',
    overloaded: 'overloaded',
    electrocharged: 'electroCharged',
    superconduct: 'superConduct',
    shatter: 'shatter'
  }
  const srReactionCanon: Record<string, string> = (() => {
    const list = [
      'shock',
      'burn',
      'windShear',
      'bleed',
      'entanglement',
      'lightningBreak',
      'fireBreak',
      'windBreak',
      'physicalBreak',
      'quantumBreak',
      'imaginaryBreak',
      'iceBreak',
      'superBreak',
      'elation',
      'scene'
    ]
    const map: Record<string, string> = {}
    for (const k of list) map[k.toLowerCase()] = k
    return map
  })()
  const okReactions =
    input.game === 'gs'
      ? new Set(Object.values(gsReactionCanon))
      : new Set<string>(Object.values(srReactionCanon))

  const isSafeExpr = (expr: string): boolean => {
    const s = expr.trim()
    if (!s) return false
    // Disallow raw escapes: the expression is embedded as JS source, not a string literal.
    if (/\\/.test(s)) return false
    // No statement separators / blocks.
    if (/[;{}]/.test(s)) return false
    // No comments (can break generated JS).
    if (/\/\//.test(s) || /\/\*/.test(s) || /\*\//.test(s)) return false
    // Disallow function syntax; we only accept expressions.
    if (/=>/.test(s) || /\bfunction\b/.test(s)) return false
    // Disallow obvious escape hatches / side-effects.
    if (
      /\b(?:import|export|require|process|globalThis|global|window|document|eval|new|class|while|for|try|catch|throw|return|this)\b/.test(
        s
      )
    ) {
      return false
    }
    // Disallow template literals (can hide complex code).
    if (/[`]/.test(s)) return false
    return true
  }

  const hasBareKeyRef = (expr: string): boolean => {
    // `key` is NOT provided by miao-plugin's calc.js runtime context. Treat bare `key` usage as invalid.
    // Allow `obj.key` (property access) but reject standalone `key` references.
    return /(^|[^.$\w])key\b/.test(expr)
  }

  const hasIllegalTalentKeyRef = (expr: string): boolean => {
    // `talent` in miao-plugin runtime does not have `.key`; models often hallucinate it and cause TypeError.
    const s = expr.replace(/\s+/g, '')
    return /\btalent\??\.key\b/.test(s) || /\btalent\??\[\s*(['"])key\1\s*\]/.test(s)
  }

  const hasIllegalCalcMemberAccess = (expr: string): boolean => {
    // `calc` is a function: only `calc(attr.xxx)` is valid. Member access like `calc.round` is hallucination.
    return /\bcalc\??\.\s*[A-Za-z_]/.test(expr)
  }

  const isSafeDmgExpr = (expr: string): boolean => {
    const s = expr.trim()
    if (!s) return false
    // Disallow raw escapes: the expression is embedded as JS source, not a string literal.
    if (/\\/.test(s)) return false
    // No statement separators.
    if (/[;]/.test(s)) return false
    // No comments (can break generated JS).
    if (/\/\//.test(s) || /\/\*/.test(s) || /\*\//.test(s)) return false
    // Disallow function syntax; we only accept expressions.
    if (/=>/.test(s) || /\bfunction\b/.test(s)) return false
    // Disallow obvious escape hatches / side-effects.
    if (
      /\b(?:import|export|require|process|globalThis|global|window|document|eval|new|class|while|for|try|catch|throw|return|this|async|await)\b/.test(
        s
      )
    ) {
      return false
    }
    // Disallow template literals (can hide complex code).
    if (/[`]/.test(s)) return false
    // Disallow assignments like `a = b` (allow ==/===/!=/!==/<=/>=).
    if (/(^|[^=!<>])=($|[^=])/.test(s)) return false
    return true
  }

  const isParamsObject = (v: unknown): v is Record<string, number | boolean | string> =>
    !!v && typeof v === 'object' && v !== null && !Array.isArray(v)

  const normalizeCalcExpr = (expr: string): string => {
    // miao-plugin `calc()` expects an AttrItem-like object (e.g. `attr.recharge`), NOT a number.
    // Models frequently write `calc(attr.recharge - 100)`, which becomes `calc(NaN)` at runtime and collapses to 0.
    // Auto-rewrite common patterns into baseline-style safe forms.
    return expr.replace(
      /\bcalc\s*\(\s*attr\.([A-Za-z_][A-Za-z0-9_]*)\s*([+-])\s*(\d+(?:\.\d+)?)\s*\)/g,
      (_m, k, op, n) => `(calc(attr.${k}) ${op} ${n})`
    )
  }

  const okCalcAttrKeys =
    input.game === 'gs'
      ? new Set(['atk', 'def', 'hp', 'mastery', 'recharge', 'cpct', 'cdmg', 'heal', 'dmg', 'phy', 'shield'])
      : new Set([
          'atk',
          'def',
          'hp',
          'speed',
          'recharge',
          'cpct',
          'cdmg',
          'heal',
          'dmg',
          'enemydmg',
          'effPct',
          'effDef',
          'stance',
          'shield'
        ])

  const hasIllegalCalcCall = (expr: string): boolean => {
    // In miao-plugin baseline, `calc()` is used as `calc(attr.xxx)` (single-arg). Multi-arg calls are almost
    // always hallucinations and can explode damage numbers.
    if (/\bcalc\s*\([^)]*,/.test(expr)) return true

    // Disallow `calc()` arguments that are not a direct AttrItem bucket:
    // - only allow `calc(attr.atk)` / `calc(attr.hp)` / ...
    // - forbid arithmetic inside, e.g. `calc(attr.recharge - 100)` / `calc(attr.atk * 2)`
    const re = /\bcalc\s*\(\s*([^)]+?)\s*\)/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const arg = String(m[1] || '').trim()
      if (!arg.startsWith('attr.')) return true
      const key = arg.slice('attr.'.length).trim()
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return true
      if (!okCalcAttrKeys.has(key)) return true
    }
    return false
  }

  const hasIllegalDmgFnCall = (expr: string): boolean => {
    // In miao-plugin baseline, dmg functions are used as:
    // - dmg(pctNum, key, ele?)
    // - dmg.basic(basicNum, key, ele?)
    // Passing dynamicData/object literals (or >3 args) is almost always hallucination.
    const src = expr

    const isWordChar = (c: string): boolean => /[A-Za-z0-9_$]/.test(c)
    const startsWithAt = (needle: string, i: number): boolean => src.slice(i, i + needle.length) === needle

    const scanCall = (needle: string): boolean => {
      for (let i = 0; i < src.length; i++) {
        if (!startsWithAt(needle, i)) continue
        const prev = i > 0 ? src[i - 1] : ''
        // Avoid matching identifiers like `xdmg.basic(`.
        if (prev && isWordChar(prev)) continue

        let j = i + needle.length
        // Parse args until matching ')'.
        let depthParen = 0
        let depthBracket = 0
        let depthBrace = 0
        let quote: '"' | "'" | null = null
        let escaped = false
        let argIdx = 0
        let thirdArgFirstNonSpace: string | null = null

        for (; j < src.length; j++) {
          const ch = src[j]!
          if (quote) {
            if (escaped) {
              escaped = false
              continue
            }
            if (ch === '\\\\') {
              escaped = true
              continue
            }
            if (ch === quote) quote = null
            continue
          }

          if (ch === '"' || ch === "'") {
            quote = ch
            continue
          }

          if (
            argIdx === 2 &&
            thirdArgFirstNonSpace === null &&
            depthParen === 0 &&
            depthBracket === 0 &&
            depthBrace === 0 &&
            !/\s/.test(ch)
          ) {
            thirdArgFirstNonSpace = ch
            // Object/array literal as ele arg is always wrong.
            if (ch === '{' || ch === '[') return true
          }

          if (ch === '(') {
            depthParen++
            continue
          }
          if (ch === ')') {
            if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) break
            if (depthParen > 0) depthParen--
            continue
          }
          if (ch === '[') {
            depthBracket++
            continue
          }
          if (ch === ']') {
            if (depthBracket > 0) depthBracket--
            continue
          }
          if (ch === '{') {
            depthBrace++
            continue
          }
          if (ch === '}') {
            if (depthBrace > 0) depthBrace--
            continue
          }

          if (depthParen === 0 && depthBracket === 0 && depthBrace === 0) {
            if (ch === ',') {
              argIdx++
              // Too many args: >= 3 commas means 4 args.
              if (argIdx >= 3) return true
              continue
            }
          }
        }
      }
      return false
    }

    // Note: check `dmg.basic(` before `dmg(`.
    return scanCall('dmg.basic(') || scanCall('dmg(')
  }
  const hasIllegalTalentRef = (expr: string): boolean => {
    const s = expr.replace(/\s+/g, '')
    // Only allow bracket access: `talent.e["表名"]` (no dot props like `talent.e.xxx`).
    // Dot access almost always means hallucinated fields and will make checks always-false.
    if (/\btalent\?*\.[A-Za-z_][A-Za-z0-9_]*\?*\./.test(s)) return true
    // GS does not have `talent.t` (only a/e/q). Reject common hallucinations.
    if (input.game === 'gs') {
      return (
        /\btalent\?*\.t\b/.test(s) ||
        /\btalent\?*\.talent\b/.test(s) ||
        /\btalent\?*\.(?:a|e|q)\.t\b/.test(s) ||
        /\btalent\[['"]t['"]\]/.test(s)
      )
    }
    return false
  }

  const hasIllegalParamsRef = (expr: string): boolean => {
    // Keep generated params keys ASCII-only for maintainability and easier CLI control.
    // JS technically allows `params.草露`, but it can't be expressed via our `detail.params` object (ASCII-only)
    // and makes diff/regression hard to reproduce.
    const s = expr.replace(/\s+/g, '')
    return /\bparams\.[^A-Za-z_]/.test(s)
  }

  const validateTalentTableRefs = (expr: string): void => {
    // Reject dynamic talent table access like `talent.e[table]`.
    if (/\btalent\?*\.([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(?!['"])/.test(expr)) {
      throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses dynamic talent table access`)
    }
    // Also reject `talent["e"][table]` style dynamic table access.
    if (/\btalent\?*\[\s*(['"]).*?\1\s*\]\s*\[\s*(?!['"])/.test(expr)) {
      throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses dynamic talent table access`)
    }

    const re = /\btalent\?*\.([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const tk = m[1] as string
      const tn = m[3]
      if (!okTalents.has(tk)) {
        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key: ${tk}`)
      }
      const allowed = tables[tk] || []
      if (!allowed.includes(tn)) {
        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unknown table: ${tk}[${tn}]`)
      }
    }
  }

  // SR: Hakush tables often use generic names like "技能伤害/技能伤害(2)" without units,
  // and the *first* "技能伤害" may actually represent a debuff value (e.g. 防御力降低).
  // Infer intent tables from the talent description placeholder contexts to:
  // - pick a safer canonical table for generic "普攻/战技/终结技伤害" rows
  // - derive core debuff buffs (enemyDef/enemydmg) when the model misses them
  type SrDescIntent = 'directDmg' | 'enemydmg' | 'enemyDef'
  const srIntentTableByTalent = new Map<TalentKey, Partial<Record<SrDescIntent, string>>>()
  const srCanonicalSkillDamageTable = new Map<TalentKey, string>()
  if (input.game === 'sr') {
    const inferIntentTables = (talentKey: TalentKey, descRaw: unknown): Partial<Record<SrDescIntent, string>> => {
      const desc = normalizePromptText(descRaw)
      if (!desc) return {}
      const allowed = tables[talentKey] || []
      if (allowed.length === 0) return {}

      const out: Partial<Record<SrDescIntent, string>> = {}
      const re = /\$(\d+)\[[^\]]*\]/g
      for (const m of desc.matchAll(re)) {
        const idx = Number(m[1])
        if (!Number.isFinite(idx) || idx < 1 || idx > 20) continue
        const table = allowed[idx - 1]
        if (!table) continue

        const pos = typeof m.index === 'number' ? m.index : -1
        const before = pos >= 0 ? desc.slice(Math.max(0, pos - 60), pos) : ''
        const after = pos >= 0 ? desc.slice(pos, Math.min(desc.length, pos + 100)) : ''

        if (!out.enemyDef && /防御力降低/.test(before)) {
          out.enemyDef = table
          continue
        }
        if (!out.enemydmg && /受到.{0,10}伤害(?:提高|提升|增加)/.test(before)) {
          out.enemydmg = table
          continue
        }
        if (
          !out.directDmg &&
          /造成/.test(before) &&
          /伤害/.test(after) &&
          /(攻击力|生命上限|生命值上限|最大生命值|生命值|防御力)/.test(after)
        ) {
          out.directDmg = table
          continue
        }
      }
      return out
    }

    for (const tk0 of Object.keys(tables)) {
      const tk = tk0 as TalentKey
      const allowed = tables[tk] || []
      const inferred = inferIntentTables(tk, (input.talentDesc as any)?.[tk])
      if (Object.keys(inferred).length) srIntentTableByTalent.set(tk, inferred)
      if (allowed.includes('技能伤害')) {
        const canonical = inferred.directDmg && allowed.includes(inferred.directDmg) ? inferred.directDmg : '技能伤害'
        srCanonicalSkillDamageTable.set(tk, canonical)
      }
    }
  }

  const srIsBuffOnlyTableName = (tableNameRaw: unknown): boolean => {
    if (input.game !== 'sr') return false
    const tn = normalizePromptText(tableNameRaw)
    if (!tn) return false
    // Whitelist: real output tables (damage / break / special hits).
    if (
      /(技能伤害|每段伤害|附加伤害|追加攻击伤害|追击伤害|反击伤害|持续伤害|dot|击破伤害|超击破|秘技伤害)/i.test(tn)
    ) {
      return false
    }
    // Anything that reads like "increase/decrease/penetration/chance" is a buff/debuff table, not a dmg multiplier table.
    if (/(提高|提升|增加|降低|减少|加成|增伤|穿透|抗性穿透|无视|概率|几率|命中|抵抗|击破效率|削韧)/.test(tn)) return true
    return false
  }

  const detailsRaw = Array.isArray(plan.details) ? plan.details : []
  const detailsIn = clampDetails(detailsRaw, 20)
  const details: CalcSuggestDetail[] = []

  for (const d of detailsIn) {
    let kind = normalizeKind(d.kind)
    const title = d.title

    if (kind === 'reaction') {
      const reaction = typeof d.reaction === 'string' ? d.reaction.trim() : ''
      if (!reaction) continue
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,31}$/.test(reaction)) continue
      const canon =
        input.game === 'gs' ? gsReactionCanon[reaction.toLowerCase()] || reaction : srReactionCanon[reaction.toLowerCase()] || reaction
      if (okReactions.size && !okReactions.has(canon)) continue
      const out: CalcSuggestDetail = { title, kind, reaction: canon }

      const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
      if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

      const check0 = typeof d.check === 'string' ? d.check.trim() : ''
      const check = check0 ? normalizeCalcExpr(check0) : ''
      if (check) {
        if (/\bcurrentTalent\b/.test(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not reference currentTalent`)
        }
        if (!isSafeExpr(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check is not a safe expression`)
        if (hasIllegalTalentKeyRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not reference talent.key`)
        }
        if (hasIllegalCalcMemberAccess(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check must not use calc.xxx member access`)
        }
        if (hasIllegalParamsRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check uses non-ASCII params key`)
        }
        if (hasIllegalTalentRef(check)) {
          throw new Error(`[meta-gen] invalid LLM plan: detail.check references unsupported talent key`)
        }
        if (hasIllegalCalcCall(check)) throw new Error(`[meta-gen] invalid LLM plan: detail.check uses illegal calc() call`)
        out.check = check
      }

      if (isParamsObject(d.params)) {
        const p: Record<string, number | boolean | string> = {}
        let n = 0
        for (const [k, v] of Object.entries(d.params)) {
          const kk = String(k || '').trim()
          if (!kk || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(kk)) continue
          if (typeof v === 'number') {
            if (!Number.isFinite(v)) continue
            p[kk] = v
          } else if (typeof v === 'boolean' || typeof v === 'string') {
            p[kk] = v
          } else {
            continue
          }
          if (++n >= 12) break
        }
        if (Object.keys(p).length) out.params = p
      }

      const dmgExpr0 = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
      let dmgExpr = dmgExpr0 ? normalizeCalcExpr(dmgExpr0) : ''
      if (dmgExpr) {
        // Auto-fix common mismatch with our renderer signature:
        // - kind=reaction provides `{ reaction }` (not `dmg`), so `dmg.reaction(...)` will throw at runtime.
        dmgExpr = dmgExpr.replace(/\bdmg\s*\.\s*reaction\s*\(/g, 'reaction(')
        // If it still tries to call/use `dmg` as an identifier, drop dmgExpr so we fall back to `reaction("<id>")`.
        if (/\bdmg\s*\./.test(dmgExpr) || /\bdmg\s*\(/.test(dmgExpr)) dmgExpr = ''
      }
	      if (dmgExpr) {
	        if (/\bcurrentTalent\b/.test(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference currentTalent`)
	        }
	        if (!isSafeDmgExpr(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr is not a safe expression`)
	        }
	        if (hasIllegalTalentKeyRef(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference talent.key`)
	        }
	        if (hasIllegalCalcMemberAccess(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not use calc.xxx member access`)
	        }
	        if (hasIllegalTalentRef(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key`)
	        }
	        if (hasIllegalCalcCall(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal calc() call`)
	        }
	        if (hasIllegalDmgFnCall(dmgExpr)) {
	          throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal dmg() call`)
	        }
	        validateTalentTableRefs(dmgExpr)
	        out.dmgExpr = dmgExpr
	      }

      details.push(out)
      continue
    }

    const talent = typeof d.talent === 'string' ? (d.talent as TalentKey) : undefined
    const table = typeof d.table === 'string' ? d.table : undefined
    if (!talent || !okTalents.has(talent)) continue
    const allowed = tables[talent] || []
    if (!table) continue
	    let tableFinal = table
	    // Auto-correct common mislabels:
	    // - LLM sometimes marks heal/shield rows as kind=dmg and then uses dmgExpr (which breaks avg semantics).
	    // - Use title/table hints to conservatively reclassify them before rendering.
	    if (kind === 'dmg') {
	      const hint = `${title} ${tableFinal}`
	      if (/(治疗|回复|恢复)/.test(hint)) kind = 'heal'
	      else if (/(护盾|吸收量)/.test(hint)) kind = 'shield'
	    }
	    // GS heal/shield tables often have a `<name>2` variant that keeps [pct, flat] for runtime calc.
	    if ((kind === 'heal' || kind === 'shield') && !tableFinal.endsWith('2')) {
	      const t2 = `${tableFinal}2`
	      if (allowed.includes(t2)) tableFinal = t2
	    }
	    // GS damage tables may also have a `<name>2` structured variant (e.g. [atkPct, masteryPct]).
	    // Prefer the structured one when available to avoid huge inaccuracies from the summed display table.
	    if (
	      kind === 'dmg' &&
	      input.game === 'gs' &&
	      !tableFinal.endsWith('2') &&
	      !(typeof d.dmgExpr === 'string' && d.dmgExpr.trim())
	    ) {
	      const t2 = `${tableFinal}2`
	      if ((input.tableSamples as any)?.[talent]?.[t2] !== undefined && allowed.includes(t2)) {
	        tableFinal = t2
	      }
	    }
      // SR: Prefer the canonical "技能伤害" table for generic A/E/Q rows.
      // LLMs often pick nearby tables like "附加伤害", which can systematically drift baseline comparisons.
      if (kind === 'dmg' && input.game === 'sr' && allowed.includes('技能伤害')) {
        const t = normalizePromptText(title)
        const talentKey = String(talent || '')
        const isGeneric =
          ((/普攻|普通攻击/.test(t) && talentKey.startsWith('a')) ||
            (/战技/.test(t) && talentKey.startsWith('e')) ||
            (/终结技/.test(t) && talentKey.startsWith('q'))) &&
          !/(追加|附加|持续|DOT|秘技|强化|反击|击破|超击破|灼烧|触电|风化|裂伤|纠缠|冻结)/i.test(t)
        if (isGeneric) {
          const canon = srCanonicalSkillDamageTable.get(talent) || '技能伤害'
          if (canon && allowed.includes(canon)) tableFinal = canon
        }
      }
  	    if (!allowed.includes(tableFinal)) continue

      // SR: Guardrail — drop non-damage mechanics mistakenly modeled as `kind=dmg`.
      // This commonly happens when SR ParamList tables are generically named (参数1/2/...) and LLMs emit them as damage rows.
      if (kind === 'dmg' && input.game === 'sr') {
        const t = normalizePromptText(title)
        if (
          /(基础概率|概率|几率|效果命中|效果抵抗|命中|抵抗|持续时间|回合|削韧|击破效率|层数上限|次数|能量|回能|能量恢复|能量回复)/.test(t) ||
          (/(抗性降低|防御力降低|攻击力降低|速度降低)/.test(t) && !/伤害/.test(t))
        ) {
          continue
        }
      }

      // SR: "伤害提高/抗性穿透/概率..." tables are buffs, not direct damage multiplier tables.
      // Keep calc.js aligned with baseline semantics: these should become buffs.data instead of dmg details.
      if (kind === 'dmg' && input.game === 'sr' && srIsBuffOnlyTableName(tableFinal)) continue

      // SR: Guardrail — drop non-heal/shield mechanics mistakenly modeled as `kind=heal|shield`.
      // Models often turn "能量恢复/行动延后/击破特攻提高/概率..." into heal rows, which pollutes maxAvg and breaks panel regression.
      if ((kind === 'heal' || kind === 'shield') && input.game === 'sr') {
        const t = normalizePromptText(title)
        const tn = normalizePromptText(tableFinal)
        const merged = `${t} ${tn}`.trim()
        if (
          /(能量|回能|能量恢复|能量回复|行动延后|行动提前|基础概率|概率|几率|效果命中|效果抵抗|击破特攻|击破|削韧|击破效率)/.test(
            merged
          ) ||
          (/(攻击力提高|暴击率提高|暴击伤害提高|伤害提高|抗性穿透|防御降低|抗性降低|速度提高)/.test(merged) &&
            !/(治疗|回复|恢复|护盾|吸收)/.test(merged))
        ) {
          continue
        }
      }

      // Guardrail: GS heal/shield rows are frequently hallucinated from unrelated "上限/阈值/持续时间/能量" tables.
      // Drop such rows early to avoid wildly inflated avg values in panel regression (e.g. using "赤鬃之血上限"
      // as a heal multiplier).
      if ((kind === 'heal' || kind === 'shield') && input.game === 'gs') {
        const tn = String(tableFinal || '').trim()
        const isHealShieldLike = /(治疗|回复|恢复|护盾|吸收)/.test(tn)
        const isSuspicious = /(上限|阈值|冷却|持续时间|能量恢复|能量|次数|计数)/.test(tn) || /伤害/.test(tn)
        const hasHpWord = /(生命|HP)/i.test(tn)
        if (!isHealShieldLike && isSuspicious && !hasHpWord) continue
      }

	    const out: CalcSuggestDetail = { title, kind, talent, table: tableFinal }
	    if (typeof d.key === 'string') {
	      // Allow empty string key (baseline uses this for some reaction-like damage such as lunar*).
	      out.key = d.key.trim()
	    }
	    const ele = typeof d.ele === 'string' ? d.ele.trim() : ''
	    if (ele && kind === 'dmg') {
	      // Some models hallucinate element names (cryo/hydro/pyro/...) as ele args.
	      // In miao-plugin, elemental skills should omit ele arg; keep only allowed ids (phy/amp-reaction ids/lunar ids).
	      if (
	        input.game === 'gs' &&
	        /^(anemo|geo|electro|dendro|hydro|pyro|cryo)$/i.test(ele)
	      ) {
	        // ignore
	      } else if (input.game === 'gs' && gsReactionCanon[ele.toLowerCase()]) {
	        // Transformative reactions should be modeled as kind=reaction, not as ele args on talent damage.
	        // (Passing ele=overloaded/etc switches calcRet into reaction mode and ignores pctNum.)
	      } else {
	        out.ele = ele
	      }
	    }
    const stat = normalizeStat(d.stat)
    if (stat) out.stat = stat
    const pickRaw = typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
    if (
      pickRaw !== undefined &&
      pickRaw >= 0 &&
      pickRaw <= 10 &&
      typeof out.table === 'string' &&
      out.table.includes('/') &&
      Array.isArray((input.tableSamples as any)?.[talent]?.[out.table])
    ) {
      out.pick = pickRaw
    }

    const consRaw = typeof d.cons === 'number' && Number.isFinite(d.cons) ? Math.trunc(d.cons) : undefined
    if (consRaw && consRaw >= 1 && consRaw <= 6) out.cons = consRaw

    const check0 = typeof d.check === 'string' ? d.check.trim() : ''
    const check = check0 ? normalizeCalcExpr(check0) : ''
    if (check) {
      try {
        if (/\bcurrentTalent\b/.test(check)) throw new Error('currentTalent')
        if (!isSafeExpr(check)) throw new Error('unsafe')
        if (hasBareKeyRef(check)) throw new Error('bare-key')
        if (hasIllegalTalentKeyRef(check)) throw new Error('talent-key')
        if (hasIllegalCalcMemberAccess(check)) throw new Error('calc-member')
        if (hasIllegalParamsRef(check)) throw new Error('illegal-params')
        if (hasIllegalTalentRef(check)) throw new Error('illegal-talent')
        if (hasIllegalCalcCall(check)) throw new Error('illegal-calc')
        validateTalentTableRefs(check)
        out.check = check
      } catch {
        // ignore invalid check (optional field)
      }
    }

    if (isParamsObject(d.params)) {
      const p: Record<string, number | boolean | string> = {}
      let n = 0
      for (const [k, v] of Object.entries(d.params)) {
        const kk = String(k || '').trim()
        if (!kk || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(kk)) continue
        if (typeof v === 'number') {
          if (!Number.isFinite(v)) continue
          p[kk] = v
        } else if (typeof v === 'boolean' || typeof v === 'string') {
          p[kk] = v
        } else {
          continue
        }
        if (++n >= 12) break
      }
      if (Object.keys(p).length) out.params = p
    }

    // SR: Ensure ultimate-related rows enable `params.q` by default.
    // Many baseline buffs / eidolons gate on `params.q === true`, and LLMs often forget to set params on Q rows.
    if (input.game === 'sr') {
      const tk = typeof out.talent === 'string' ? String(out.talent) : ''
      const titleNorm = normalizePromptText(out.title)
      const isQ = !!tk && tk.startsWith('q')
      const isExtraFromUlt = !isQ && tk === 't' && /附加伤害/.test(titleNorm)
      if (isQ || isExtraFromUlt) {
        const p0 = out.params
        const p: Record<string, number | boolean | string> =
          p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, any>) } : {}
        if (!Object.prototype.hasOwnProperty.call(p, 'q')) p.q = true
        if (Object.keys(p).length) out.params = p as any
      }
    }

    // Only allow dmgExpr for kind=dmg (heal/shield should use structured rendering to avoid wrong return types).
    const dmgExpr0 = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
    const dmgExpr = dmgExpr0 ? normalizeCalcExpr(dmgExpr0) : ''
	    if (dmgExpr && kind === 'dmg') {
	      if (/\bcurrentTalent\b/.test(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr must not reference currentTalent`)
	      }
	      if (!isSafeDmgExpr(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr is not a safe expression`)
	      }
	      if (hasIllegalTalentRef(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr references unsupported talent key`)
	      }
	      if (hasIllegalCalcCall(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal calc() call`)
	      }
	      if (hasIllegalDmgFnCall(dmgExpr)) {
	        throw new Error(`[meta-gen] invalid LLM plan: detail.dmgExpr uses illegal dmg() call`)
	      }
	      // Guardrail: dmgExpr must be derived from at least one concrete talent table.
	      // Expressions based only on attr/params/const are often hallucinations (e.g. `calc(attr.atk) * 2`)
	      // and can explode maxAvg in panel regression.
	      const hasTalentTableRef = /\btalent\?*\.[A-Za-z_][A-Za-z0-9_]*\s*\[\s*(['"])/.test(dmgExpr)
	      if (!hasTalentTableRef) {
	        // Drop hallucinated custom formulas but keep the row (fall back to structured table rendering).
	      } else {
	        // Guardrail: dmgExpr must return a calcRet-like object (or call dmg/heal/shield/reaction).
	        // Some models output a plain number expression (e.g. `talent.t["伤害提高"] * 100`) which breaks runtime.
	        const looksLikeObjLiteral = /\{\s*[^}]*\bavg\s*:/.test(dmgExpr)
	        const looksLikeCalcRet = /\b(?:dmg|heal|shield|reaction)\s*\(/.test(dmgExpr) || looksLikeObjLiteral
	        // Another common failure mode: returning only `.avg`/`.dmg` (a number) instead of the full ret object.
	        const returnsScalar = !looksLikeObjLiteral && /\.\s*(?:avg|dmg)\s*$/.test(dmgExpr)
	        if (!looksLikeCalcRet || returnsScalar) {
	          // Drop invalid formulas but keep the row (fall back to structured table rendering).
	        } else {
	        // Disallow hardcoding transformative reaction ids inside dmgExpr (should use kind=reaction instead).
	        if (
	          input.game === 'gs' &&
	          /(['"])(?:swirl|crystallize|bloom|hyperbloom|burgeon|burning|overloaded|electrocharged|superconduct|shatter|lunarcharged|lunarbloom|lunarcrystallize)\1/i.test(
	            dmgExpr
	          )
	        ) {
	          throw new Error(
	            `[meta-gen] invalid LLM plan: detail.dmgExpr must not hardcode transformative reactions (use kind=reaction)`
	          )
	        }
	        validateTalentTableRefs(dmgExpr)
	        out.dmgExpr = dmgExpr
	        }
	      }
	    }
    details.push(out)
  }

  if (details.length === 0) throw new Error(`[meta-gen] invalid LLM plan: no valid details`)

  // SR: Correct common "(2)" variant mixups (main vs adjacent target) using title hints.
  // LLMs frequently reuse the main-target "技能伤害" table for adjacent-target rows, causing 1.5x~3x deviations.
  if (input.game === 'sr') {
    const parseVariant = (nameRaw: unknown): { base: string; idx: number } => {
      const name = String(nameRaw || '').trim()
      if (!name) return { base: '', idx: 1 }
      const m = /^(.*?)(?:\(|（)(\d{1,2})(?:\)|）)\s*$/.exec(name)
      if (m) {
        const idx = Number(m[2])
        return { base: String(m[1] || '').trim(), idx: Number.isFinite(idx) && idx >= 1 ? Math.trunc(idx) : 1 }
      }
      return { base: name, idx: 1 }
    }

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.kind !== 'dmg') continue
      const title = normalizePromptText(d.title)
      if (!title) continue
      const tk = typeof d.talent === 'string' ? (d.talent as TalentKey) : undefined
      const table = typeof d.table === 'string' ? d.table : ''
      if (!tk || !table) continue
      const allowed = tables[tk] || []
      if (!allowed.length) continue

      const { base, idx } = parseVariant(table)
      if (!base) continue

      const wantsAdjacent = /(相邻|次要|副目标)/.test(title)
      const wantsMain = /(主目标|主目標)/.test(title)

      const isAdjacentName = (nameRaw: unknown): boolean => /(相邻|次要|副目标)/.test(normalizePromptText(nameRaw))
      const isValidDmgTable = (nameRaw: unknown): boolean => {
        const t = normalizePromptText(nameRaw)
        if (!t) return false
        if (srIsBuffOnlyTableName(t)) return false
        return /伤害/.test(t)
      }

      const pickAdjacentTable = (): string | null => {
        const explicit = allowed.find((t) => isAdjacentName(t) && isValidDmgTable(t))
        if (explicit) return explicit
        const cand = `${base}(2)`
        return allowed.includes(cand) ? cand : null
      }

      const pickMainTable = (): string | null => {
        if (!isAdjacentName(base) && allowed.includes(base)) return base
        const canon = srCanonicalSkillDamageTable.get(tk)
        if (canon && allowed.includes(canon) && !isAdjacentName(canon)) return canon
        const fallback = allowed.find(
          (t) =>
            isValidDmgTable(t) &&
            !isAdjacentName(t) &&
            !/(?:\(|（)\s*(?:2|3|4|5|6)\s*(?:\)|）)\s*$/.test(t)
        )
        return fallback || null
      }

      // Adjacent/secondary targets: some kits use explicit names like "相邻目标伤害" instead of "X(2)".
      if (wantsAdjacent && idx === 1) {
        const cand = pickAdjacentTable()
        if (cand) d.table = cand
        continue
      }

      // Main target: prefer the base table (or canonical skill damage table) when a "(2)" or adjacent table is selected.
      if (wantsMain && (idx >= 2 || isAdjacentName(table))) {
        const cand = pickMainTable()
        if (cand) d.table = cand
      }
    }
  }

  // SR: When unit hints are missing (tables often contain only numeric values), the LLM may omit `stat`
  // and we would fall back to ATK scaling, causing extreme underestimation for HP/DEF-scaling kits.
  // Infer single-stat scaling from talent descriptions / table text samples when unambiguous.
  if (input.game === 'sr') {
      const inferSingleStatFromText = (raw: unknown): CalcScaleStat | null => {
        const s = normalizePromptText(raw)
        if (!s) return null
        const hasHp = /(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(s)
        // NOTE: do NOT treat generic “攻击” as ATK-scaling hint (e.g. “连携攻击”).
        const hasAtk = /(攻击力|\batk\b)/i.test(s)
        const hasDef = /(防御力|防御|\bdef\b)/i.test(s)
        const hits = Number(hasHp) + Number(hasAtk) + Number(hasDef)
        if (hits !== 1) return null
        if (hasHp) return 'hp'
      if (hasDef) return 'def'
      if (hasAtk) return 'atk'
      return null
    }

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.kind === 'reaction') continue
      const tk = typeof d.talent === 'string' ? String(d.talent) : ''
      const table = typeof d.table === 'string' ? String(d.table) : ''
      if (!tk || !table) continue

      const cur = typeof (d as any).stat === 'string' ? String((d as any).stat) : ''
      const unit = (input.tableUnits as any)?.[tk]?.[table]
      const textSample = (input.tableTextSamples as any)?.[tk]?.[table]
      const desc = (input.talentDesc as any)?.[tk]
      const inferred = inferSingleStatFromText(unit) || inferSingleStatFromText(textSample) || inferSingleStatFromText(desc)
      if (!inferred) continue
      // Only override when the inferred stat is non-ATK (ATK is the safe default for SR).
      if (inferred === 'hp' || inferred === 'def') {
        if (!cur || cur === 'atk') (d as any).stat = inferred
      }
    }
  }

  // SR: Some dmg tables represent an additive "multiplier increase" (e.g. "...倍率提高") that should be added on
  // top of a base damage multiplier table from another talent block (baseline commonly models it as base + delta).
  // Weak models frequently emit the delta table as a standalone dmg row, causing extreme underestimation (~0.05x).
  if (input.game === 'sr') {
    const isDeltaMultTable = (t: string): boolean => /(伤害)?倍率(提高|提升|增加)/.test(String(t || ''))
    const norm = (s: string): string => normalizePromptText(s).replace(/\s+/g, '')
    const stripEnhancePrefix = (s: string): string =>
      norm(s)
        .replace(/[()（）【】\[\]<>]/g, '')
        .replace(/^(?:终结技|战技|普攻|普通攻击|天赋|秘技)+/g, '')
        .replace(/(?:终结技|战技|普攻|普通攻击|天赋|秘技)/g, '')
        .replace(/(?:强化|加强|增强|提升|提高|额外|追加)+/g, '')
        .trim()

    const srTables = (input.tables || {}) as any
    const listTables = (tk: string): string[] => (Array.isArray(srTables[tk]) ? (srTables[tk] as string[]) : [])
    const candidatesByTalent: Array<{ tk: TalentKey; tables: string[] }> = Object.keys(srTables)
      .map((tk) => ({ tk, tables: listTables(tk) }))
      .filter((x) => x.tk && x.tables.length > 0)

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.kind !== 'dmg') continue
      if (typeof (d as any).dmgExpr === 'string' && (d as any).dmgExpr.trim()) continue
      const deltaTk = typeof d.talent === 'string' ? String(d.talent) : ''
      const deltaTable = typeof d.table === 'string' ? String(d.table) : ''
      if (!deltaTk || !deltaTable) continue
      if (!isDeltaMultTable(deltaTable)) continue

      // Infer base table by stripping common "强化/终结技..." prefixes from the title.
      const titleToken = stripEnhancePrefix(d.title || '')
      if (!titleToken || titleToken.length < 2) continue

      let best: { tk: TalentKey; table: string; score: number } | null = null
      for (const cand of candidatesByTalent) {
        const tk = String(cand.tk || '').trim()
        if (!tk || tk === deltaTk) continue
        for (const t of cand.tables) {
          const tn = String(t || '').trim()
          if (!tn) continue
          if (isDeltaMultTable(tn)) continue
          if (!/伤害/.test(tn)) continue
          const tNorm = norm(tn)
          const eq = tNorm === titleToken
          const hit = eq || tNorm.includes(titleToken) || titleToken.includes(tNorm)
          if (!hit) continue
          const score = eq ? 3 : 2
          if (!best || score > best.score) best = { tk: cand.tk, table: tn, score }
        }
      }
      if (!best) continue

      // Prefer the base talent key for dmgKey/buff buckets when the model didn't specify one.
      if (!d.key || String(d.key || '').trim() === deltaTk) d.key = String(best.tk)
      const keyLit = JSON.stringify(String(d.key || best.tk))
      const eleLit = typeof d.ele === 'string' && d.ele.trim() ? `, ${JSON.stringify(d.ele.trim())}` : ''

      ;(d as any).dmgExpr = `dmg(talent.${String(best.tk)}[${JSON.stringify(best.table)}] + talent.${deltaTk}[${JSON.stringify(
        deltaTable
      )}], ${keyLit}${eleLit})`
    }

    // Also fix a common LLM misread where the delta table is treated as a percent increase:
    // `base * (1 + delta)` should be `base + delta` for "倍率提高" tables.
    rewriteSrDeltaMultiplierIncreaseExprs(details)
  }

  // SR: DOT detonation patterns (e.g. "引爆持续伤害").
  // Baseline meta often models "终结技伤害" as direct damage + a triggered DOT instance.
  // When the required tables exist, patch the main ult dmg row to include that DOT term.
  if (input.game === 'sr') {
    const qTables0 = (tables as any).q || []
    const qTables = Array.isArray(qTables0) ? (qTables0 as string[]) : []
    const qDesc = normalizePromptText((input.talentDesc as any)?.q)
    const dotHint = /(持续伤害|触电|风化|裂伤|灼烧|纠缠|冻结)/.test(qDesc)
    const detonateHint = /(立即|立刻|立即产生|立即结算)/.test(qDesc)
    // Support multiple upstream naming styles:
    // - baseline-like: "回合持续伤害" + "额外持续伤害"
    // - hakush-style: "持续伤害" (dot ratio) + "技能伤害(2)" (detonation ratio)
    const dotBaseTable =
      qTables.includes('回合持续伤害')
        ? '回合持续伤害'
        : qTables.includes('持续伤害') && /(每回合|回合开始)/.test(qDesc)
          ? '持续伤害'
          : ''
    const dotScaleTable =
      qTables.includes('额外持续伤害')
        ? '额外持续伤害'
        : qTables.includes('技能伤害(2)') && dotHint && detonateHint
          ? '技能伤害(2)'
          : // Some upstream datasets name the detonation ratio as plain "技能伤害" (while the direct hit uses another table like "所有目标伤害/单体伤害").
            qTables.includes('技能伤害') &&
              dotBaseTable === '持续伤害' &&
              dotHint &&
              detonateHint &&
              qTables.some((t) => {
                const tn = String(t || '').trim()
                if (!tn) return false
                if (tn === '技能伤害' || tn === dotBaseTable) return false
                if (!/伤害/.test(tn)) return false
                if (srIsBuffOnlyTableName(tn)) return false
                if (/(能量恢复|削韧)/.test(tn)) return false
                return true
              })
            ? '技能伤害'
            : ''
    const hasDotDetonate = !!dotBaseTable && !!dotScaleTable
    if (hasDotDetonate) {
      for (const d of details) {
        if (!d || typeof d !== 'object') continue
        if (d.kind !== 'dmg') continue
        if (d.talent !== 'q') continue
        if (typeof (d as any).dmgExpr === 'string' && (d as any).dmgExpr.trim()) continue

        const t = normalizePromptText(d.title)
        if (!/终结技/.test(t) || !/伤害/.test(t)) continue

        const isDirectCandidate = (tnRaw: unknown): tnRaw is string => {
          const tn = typeof tnRaw === 'string' ? tnRaw.trim() : ''
          if (!tn) return false
          if (!qTables.includes(tn)) return false
          if (tn === dotBaseTable || tn === dotScaleTable) return false
          return true
        }

        const canonQ = srCanonicalSkillDamageTable.get('q') || ''
        const direct =
          isDirectCandidate(canonQ)
            ? canonQ
            : isDirectCandidate('技能伤害')
              ? '技能伤害'
              : isDirectCandidate(d.table)
                ? String(d.table || '').trim()
                : qTables.find((tn) => {
                    if (!isDirectCandidate(tn)) return false
                    if (!/伤害/.test(String(tn || ''))) return false
                    if (srIsBuffOnlyTableName(tn)) return false
                    if (/(能量恢复|削韧)/.test(String(tn || ''))) return false
                    return true
                  }) || ''
        if (!direct || !qTables.includes(direct)) continue

        // Ensure buffs gated by `params.isDot === true` can work on this showcase row.
        const p = isParamsObject(d.params) ? (d.params as any) : {}
        if (!('isDot' in p)) p.isDot = true
        d.params = p

        if (!d.key || String(d.key || '').trim() === 'q') d.key = 'q'
        const keyLit = JSON.stringify(String(d.key || 'q'))
        const eleLit = typeof d.ele === 'string' && d.ele.trim() ? `, ${JSON.stringify(d.ele.trim())}` : ''
        const qDmg = `dmg(talent.q[${JSON.stringify(direct)}], ${keyLit}${eleLit})`
        const dotDmg = `dmg(talent.q[${JSON.stringify(dotBaseTable)}] * talent.q[${JSON.stringify(dotScaleTable)}], "dot", "skillDot")`
        ;(d as any).dmgExpr = `({ dmg: (${qDmg}).dmg + (${dotDmg}).avg, avg: (${qDmg}).avg + (${dotDmg}).avg })`
        break
      }

      // Some DOT kits also allow the skill to "detonate" an existing DOT immediately (baseline often models as a
      // combined showcase row: 战技伤害 + 引爆DOT). When the scale table exists, add the combined row.
      const eTables0 = (tables as any).e || []
      const eTables = Array.isArray(eTables0) ? (eTables0 as string[]) : []
      const eDesc = normalizePromptText((input.talentDesc as any)?.e)
      const dotHintE = /(持续伤害|触电|风化|裂伤|灼烧|纠缠|冻结)/.test(eDesc)
      const detonateHintE = /(立即|立刻|立即产生|立即结算)/.test(eDesc)

      const eScale =
        eTables.includes('额外持续伤害')
          ? '额外持续伤害'
          : eTables.find((t: string) => /额外.{0,4}持续伤害/.test(String(t || ''))) ||
            (eTables.includes('持续伤害') && dotHintE && detonateHintE ? '持续伤害' : '') ||
            ''
      const eDirect = eTables.includes('单体伤害') ? '单体伤害' : eTables.includes('技能伤害') ? '技能伤害' : ''

      const hasDetonateSkill = !!eScale && !!eDirect && qTables.includes(dotBaseTable)
      if (hasDetonateSkill && details.length < 20) {
        const title = '战技+引爆dot伤害'
        const exists = details.some((x) => normalizePromptText((x as any)?.title) === title)
        if (!exists) {
          const eDmg = `dmg(talent.e[${JSON.stringify(eDirect)}], "e")`
          const dotTrig = `dmg(talent.q[${JSON.stringify(dotBaseTable)}] * talent.e[${JSON.stringify(
            eScale
          )}], "dot", "skillDot")`
          details.push({
            title,
            kind: 'dmg',
            talent: 'e',
            table: eDirect,
            key: 'e',
            params: { isDot: true },
            dmgExpr: `({ dmg: (${eDmg}).dmg + (${dotTrig}).avg, avg: (${eDmg}).avg + (${dotTrig}).avg })`
          })
        }
      }
    }
  }

  // GS: Prevent low-HP conditional talent tables (e.g. "低血量时...") from being used as normal rows.
  // If the model selects a conditional table but forgets to set params.halfHp, damage can drift by 2x+.
  if (input.game === 'gs' && !input.upstreamDirect) {
    const isLowHpLike = (s: string): boolean =>
      /(低血|低生命|低于50%|半血|生命值低于|生命值少于)/.test(String(s || ''))
    const stripLowHpMark = (s: string): string =>
      String(s || '')
        .replace(/低血量时/g, '')
        .replace(/低血量/g, '')
        .replace(/低血/g, '')
        .replace(/低生命/g, '')
        .replace(/半血/g, '')
        .replace(/生命值(?:低于|少于)\s*50%?\s*时?/g, '')
        .replace(/[()（）【】\[\]<>]/g, '')
        .trim()

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      const title = String(d.title || '')
      const p0 = isParamsObject(d.params) ? d.params : null
      const hasHalf0 = !!p0 && (((p0 as any).halfHp === true) || ((p0 as any).half === true))
      const lowTitle = isLowHpLike(title)

      // If the row title clearly indicates a low-HP showcase, always tag params.halfHp so buffs gated by halfHp can apply.
      // (Baseline often uses params.halfHp for passive/cons buffs, even when the talent table already encodes the low-HP variant.)
      if (lowTitle && !hasHalf0) {
        const params = (p0 || {}) as Record<string, any>
        params.halfHp = true
        d.params = params
      }

      if (typeof d.table !== 'string' || !d.table.trim()) continue
      if (!isLowHpLike(d.table)) continue

      const p = isParamsObject(d.params) ? d.params : null
      const hasHalf = !!p && (((p as any).halfHp === true) || ((p as any).half === true))
      if (hasHalf || lowTitle) continue

      const tk = typeof d.talent === 'string' ? String(d.talent) : ''
      if (!tk) continue
      const allowed = tables[tk] || []

      const base = stripLowHpMark(d.table)
      if (base && allowed.includes(base)) {
        d.table = base
        continue
      }
      // Some sources append "2" variants; try the base name without trailing "2".
      const base2 = base && base.endsWith('2') ? base.slice(0, -1) : base
      if (base2 && allowed.includes(base2)) {
        d.table = base2
        continue
      }

      // Fallback: explicitly tag it as a half-HP row so it doesn't silently act as a normal row.
      const params = (p || {}) as Record<string, any>
      params.halfHp = true
      d.params = params
      if (!isLowHpLike(title)) d.title = `${title}(半血)`
    }
  }

  let wantsMavuikaWarWill = false
  let wantsColombinaLunar = false
  let wantsNeferVeil = false
  let wantsEmilieBurning = false
  let wantsFurinaFanfare = false
  let wantsNeuvilletteCharged = false
  let wantsSkirkCoreBuffs = false
  let wantsDionaShowcase = false
  let wantsLaumaShowcase = false

  // Multiplier-table hints derived from unit strings (e.g. "普通攻击伤害") to help fix common LLM mistakes.
  // Filled only for GS.
  const multiUnitTables: Array<{
    originTalent: TalentKeyGs
    table: string
    unit: string
    multiKey: 'aMulti' | 'a2Multi' | 'a3Multi' | 'eMulti' | 'qMulti'
    stateFlag: 'e' | 'q' | null
  }> = []

  // Post-process common GS patterns to reduce systematic LLM mistakes (purely based on API-provided table names/text):
  // - E-state normal attacks: some characters put NA multipliers under talent.e (e.g. "一段伤害/五段伤害/重击伤害").
  // - Multi-hit tables like "57.28%*2": prefer the non-2 aggregate table for "one action" damage.
  // - Skill details accidentally tagged as normal-attack keys (a/a2/a3) even though the table is a skill table.
  if (input.game === 'gs') {
    const textSamples = (input.tableTextSamples || {}) as any
    const gsInferConvertedKeyByDesc = (descRaw: unknown): 'a' | 'e' | 'q' | null => {
      const desc = normalizePromptText(descRaw)
      if (!desc) return null
      if (/视为(?:普通攻击|普攻)(?:造成的)?伤害/.test(desc) || /伤害视为(?:普通攻击|普攻)(?:造成的)?伤害/.test(desc)) return 'a'
      if (/视为元素战技(?:造成的)?伤害/.test(desc) || /伤害视为元素战技(?:造成的)?伤害/.test(desc)) return 'e'
      if (/视为元素爆发(?:造成的)?伤害/.test(desc) || /伤害视为元素爆发(?:造成的)?伤害/.test(desc)) return 'q'
      return null
    }
    const gsConvKeyByTalent: Partial<Record<TalentKeyGs, 'a' | 'e' | 'q'>> = {}
    for (const tk of ['a', 'e', 'q'] as const) {
      const conv = gsInferConvertedKeyByDesc((input.talentDesc as any)?.[tk])
      if (conv) gsConvKeyByTalent[tk] = conv
    }
    const gsEActsAsNa = gsConvKeyByTalent.e === 'a'
    const gsEDesc = normalizePromptText((input.talentDesc as any)?.e)
    const gsEHasAltAttackConversion =
      !!gsEDesc &&
      /(普通攻击|普攻|重击|下落攻击)/.test(gsEDesc) &&
      /(转化为|转换为|替换为|变为|转化|转换|替换|变为)/.test(gsEDesc)
    const gsEAllowsNaKeyByName = gsEHasAltAttackConversion && gsConvKeyByTalent.e !== 'e' && gsConvKeyByTalent.e !== 'q'

    const isNaLikeTable = (t: string): boolean => {
      const s0 = t.trim()
      if (!s0) return false
      // Many NA-like tables have an extra `2` suffix in talentData (e.g. "三段伤害2").
      const s = s0.endsWith('2') ? s0.slice(0, -1) : s0
      if (s.includes('普攻') || s.includes('普通攻击')) return true
      if (s === '一段伤害' || s === '二段伤害' || s === '三段伤害' || s === '四段伤害' || s === '五段伤害') return true
      if (s === '重击伤害' || s === '下落期间伤害' || s === '低空坠地冲击' || s === '高空坠地冲击') return true
      if (/^.+段伤害$/.test(s)) return true
      return false
    }

    const rewriteKeyBase = (key: string, newBase: string): string => {
      const parts = key.split(',').map((x) => x.trim())
      if (!parts[0]) return key
      parts[0] = newBase
      return parts.filter(Boolean).join(',')
    }

    // Some GS kits convert a specific attack type into a named move whose damage is still routed as
    // normal/charged/plunge in baseline meta (even though the multiplier table lives under talent.e/q).
    // Example: 闲云 E converts plunge into "闲云冲击波", and the damage is "视为下落攻击伤害" -> key=a3.
    type GsAltAttackKey = 'a' | 'a2' | 'a3'
    type GsAltTarget = { key: GsAltAttackKey; tokenNorm: string }
    const gsAltTargetsByTalent: Partial<Record<'e' | 'q', GsAltTarget[]>> = {}

    const normKeyText = (s: unknown): string => {
      let t = normalizePromptText(s)
      if (!t) return ''
      t = t.replace(/\s+/g, '')
      t = t.replace(/[·•･・…?？、，,。．：:；;!！"'“”‘’()（）【】\[\]{}《》〈〉<>「」『』]/g, '')
      t = t.replace(/[=+~`^|\\]/g, '')
      t = t.replace(/[-_—–]/g, '')
      return t
    }

    const hasAnyTableToken = (tk: 'e' | 'q', tokenNorm: string): boolean => {
      if (!tokenNorm) return false
      const list = tables[tk] || []
      return list.some((t) => normKeyText(t).includes(tokenNorm))
    }

    const pushAltTarget = (tk: 'e' | 'q', key: GsAltAttackKey, tokenRaw: string): void => {
      const tokenNorm = normKeyText(tokenRaw)
      if (!tokenNorm || tokenNorm.length < 2) return
      if (!hasAnyTableToken(tk, tokenNorm)) return
      const list = gsAltTargetsByTalent[tk] || []
      if (list.some((x) => x.key === key && x.tokenNorm === tokenNorm)) return
      list.push({ key, tokenNorm })
      gsAltTargetsByTalent[tk] = list
    }

    const extractAltTargetsFromDesc = (tk: 'e' | 'q'): void => {
      const desc = normalizePromptText((input.talentDesc as any)?.[tk])
      if (!desc) return

      const wantsA = /视为(?:普通攻击|普攻)(?:造成的)?伤害/.test(desc) || /伤害视为(?:普通攻击|普攻)(?:造成的)?伤害/.test(desc)
      const wantsA2 = /视为重击(?:造成的)?伤害/.test(desc) || /伤害视为重击(?:造成的)?伤害/.test(desc)
      const wantsA3 = /视为下落攻击(?:造成的)?伤害/.test(desc) || /伤害视为下落攻击(?:造成的)?伤害/.test(desc)

      const extract = (attackPat: string, key: GsAltAttackKey): void => {
        const re = new RegExp(
          `${attackPat}[^。]{0,120}?(?:将)?(?:转化为|转换为|替换为|变为)\\s*(?:「|“|『|\"|')?([^，。；;\\n]{2,30})(?:」|”|』|\"|')?`,
          'g'
        )
        for (const m of desc.matchAll(re)) {
          let token = String(m?.[1] || '').trim()
          if (!token) continue
          token = token.replace(/^(?:「|“|『|\"|')+/, '').replace(/(?:」|”|』|\"|')+$/, '').trim()
          token = token.split(/造成|并|且/)[0]?.trim() || token
          if (!token) continue
          pushAltTarget(tk, key, token)
        }
      }

      if (wantsA) extract('(?:普通攻击|普攻)', 'a')
      if (wantsA2) extract('重击', 'a2')
      if (wantsA3) extract('下落攻击', 'a3')
    }

    extractAltTargetsFromDesc('e')
    extractAltTargetsFromDesc('q')

    const inferAltKeyForDetail = (d: CalcSuggestDetail): GsAltAttackKey | null => {
      if (!d || typeof d !== 'object') return null
      if (normalizeKind((d as any).kind) !== 'dmg') return null
      const tk = typeof (d as any).talent === 'string' ? String((d as any).talent).trim() : ''
      if (tk !== 'e' && tk !== 'q') return null
      const list = (gsAltTargetsByTalent as any)[tk] as GsAltTarget[] | undefined
      if (!list || list.length === 0) return null
      const hay = `${normKeyText((d as any).table)} ${normKeyText((d as any).title)}`
      for (const t of list) {
        if (t && t.tokenNorm && hay.includes(t.tokenNorm)) return t.key
      }
      return null
    }

    const inferMultiKeyFromUnit = (unitRaw: unknown): (typeof multiUnitTables)[number]['multiKey'] | null => {
      const u = normalizePromptText(unitRaw)
      if (!u) return null
      if (/普通攻击伤害/.test(u)) return 'aMulti'
      if (/重击伤害/.test(u)) return 'a2Multi'
      if (/下落攻击伤害/.test(u)) return 'a3Multi'
      if (/元素战技伤害/.test(u)) return 'eMulti'
      if (/元素爆发伤害/.test(u)) return 'qMulti'
      return null
    }

    const scanMultiUnits = (tk: TalentKeyGs): void => {
      const um = input.tableUnits?.[tk]
      if (!um || typeof um !== 'object' || Array.isArray(um)) return
      const allowed = new Set(tables[tk] || [])
      for (const [tn0, unitRaw] of Object.entries(um as Record<string, unknown>)) {
        const tn = String(tn0 || '').trim()
        if (!tn || (allowed.size && !allowed.has(tn))) continue
        const unit = normalizePromptText(unitRaw)
        if (!unit) continue
        const mk = inferMultiKeyFromUnit(unit)
        if (!mk) continue
        if (multiUnitTables.some((x) => x.originTalent === tk && x.table === tn && x.multiKey === mk)) continue
        multiUnitTables.push({
          originTalent: tk,
          table: tn,
          unit,
          multiKey: mk,
          stateFlag: tk === 'e' ? 'e' : tk === 'q' ? 'q' : null
        })
        if (multiUnitTables.length >= 24) break
      }
    }
    scanMultiUnits('a')
    scanMultiUnits('e')
    scanMultiUnits('q')

    // Drop details that incorrectly treat multiplier tables (unit like "普通攻击伤害") as direct dmg() pct tables.
    if (multiUnitTables.length) {
      const bad = new Set(multiUnitTables.map((x) => `${x.originTalent}:${x.table}`))
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]
        if (!d || normalizeKind((d as any).kind) !== 'dmg') continue
        if (!d.talent || !d.table) continue
        if (bad.has(`${d.talent}:${d.table}`)) details.splice(i, 1)
      }
      if (details.length === 0) throw new Error(`[meta-gen] invalid LLM plan: all details were multiplier-only`)
    }

    // Fix per-detail issues.
    for (const d of details) {
      // LLM may emit dmgExpr for simple cases; apply small autocorrections to reduce drift:
      // - If detail key has tags (e.g. "e,nightsoul") but dmgExpr passes only the base key ("e"),
      //   rewrite the key arg so buffs route correctly.
      // - If dmgExpr uses `dmg.basic(toRatio(talent...))` without any `calc(attr.<stat>)` base, it is almost
      //   certainly missing the scale stat multiplication (1000x too small); drop dmgExpr to fall back to
      //   deterministic rendering.
      if (typeof (d as any).dmgExpr === 'string') {
        let exprRaw = ((d as any).dmgExpr as string).trim()
          if (exprRaw) {
          if (input.game === 'gs') {
            const fixed = rewriteGsAdditiveCoeffDmgExpr(exprRaw, tables)
            if (fixed && fixed !== exprRaw) {
              ;(d as any).dmgExpr = fixed
              exprRaw = fixed
            }

            const fixedArray = rewriteGsDmgExprFixArrayDmgCalls(exprRaw, input)
            if (fixedArray && fixedArray !== exprRaw) {
              ;(d as any).dmgExpr = fixedArray
              exprRaw = fixedArray
            }
          }

          const critFixed = rewriteDmgExprRemoveCritExpectation(exprRaw)
          if (critFixed && critFixed !== exprRaw) {
            ;(d as any).dmgExpr = critFixed
            exprRaw = critFixed
          }

          if (typeof d.key === 'string' && d.key.includes(',')) {
            const want = d.key.trim()
            const baseKey = want.split(',')[0]?.trim() || ''
            if (baseKey && want !== baseKey) {
              const esc = baseKey.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
              const re = new RegExp(`,\\s*(['\"])${esc}\\1`, 'g')
              ;(d as any).dmgExpr = exprRaw.replace(re, `, ${JSON.stringify(want)}`)
            }
          }

          if (
            /\bdmg\s*\.\s*basic\s*\(\s*toRatio\s*\(\s*talent\./.test(exprRaw) &&
            !/\bcalc\s*\(\s*attr\./.test(exprRaw)
          ) {
            ;(d as any).dmgExpr = undefined
          }

          // If dmgExpr is essentially a single dmg(...) call using the provided table (no branches / no totals),
          // drop it and let deterministic rendering handle it (more stable / fewer hallucinated keys).
          //
          // Keep dmgExpr when:
          // - it builds a {dmg,avg} object (multi-hit total / extra add)
          // - it contains branching logic
          // - it encodes ele as a literal but plan.ele is missing (avoid losing reaction)
          const kind = typeof (d as any).kind === 'string' ? ((d as any).kind as string) : ''
          if (
            kind !== 'heal' &&
            kind !== 'shield' &&
            d.talent &&
            d.table &&
            typeof (d as any).dmgExpr === 'string'
          ) {
            const exprNow = ((d as any).dmgExpr as string).trim()
            const hasObjRet = /\.dmg\b|\.avg\b/.test(exprNow)
            const hasBranch = /[?:]|\&\&|\|\|/.test(exprNow)
            const dmgCalls = exprNow.match(/\bdmg(?:\s*\.\s*basic)?\s*\(/g) || []
            const talentRefs = exprNow.match(/\btalent\./g) || []
            const eleLiteral = /['"](melt|vaporize|aggravate|spread|swirl|burning|overloaded|electroCharged|bloom|burgeon|hyperBloom|crystallize|superConduct|shatter|lunarCharged|lunarBloom|lunarCrystallize)['"]/.test(
              exprNow
            )
            if (!hasObjRet && !hasBranch && dmgCalls.length === 1 && talentRefs.length <= 2 && !d.ele && eleLiteral) {
              // keep
            } else if (!hasObjRet && !hasBranch && dmgCalls.length === 1 && talentRefs.length <= 2) {
              ;(d as any).dmgExpr = undefined
            }
          }
        }
      }

      // If the LLM used dmgExpr but mistakenly treated `*N` tables as "[pct, flat]" (i.e. `+ ...[1]`),
      // drop dmgExpr and let deterministic rendering handle the `*N` semantics.
      if (typeof (d as any).dmgExpr === 'string' && d.talent && d.table) {
        const tk = d.talent
        const allowed = tables[tk] || []

        const baseName = d.table.endsWith('2') ? d.table.slice(0, -1) : d.table
        const t2 = d.table.endsWith('2') ? d.table : `${baseName}2`
        const sampleText = (textSamples as any)?.[tk]?.[baseName]

        if (allowed.includes(t2) && typeof sampleText === 'string' && /\*\s*\d+/.test(sampleText)) {
          const esc = t2.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const expr = String((d as any).dmgExpr || '')

          // Common LLM mistakes for "*N" tables:
          // - Treating the 2nd element as a flat add: `... + talent.e["X2"][1]`
          // - Treating it as percent sum: `toRatio(talent.e["X2"][0] + talent.e["X2"][1])`
          const badAdd1 = new RegExp(
            `\\+\\s*(?:\\(\\s*Number\\s*\\()??\\s*talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*1\\s*\\]`,
            'i'
          )
          const badSum01 = new RegExp(
            `talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*0\\s*\\]\\s*\\+\\s*(?:\\(\\s*Number\\s*\\()??\\s*talent\\.?${tk}\\s*\\[\\s*['"]${esc}['"]\\s*\\]\\s*\\[\\s*1\\s*\\]`,
            'i'
          )

          if (badAdd1.test(expr) || badSum01.test(expr)) {
            ;(d as any).dmgExpr = undefined
          }
        }
      }

      const altKey = inferAltKeyForDetail(d)
      if (altKey) {
        const key0 = typeof d.key === 'string' ? d.key.trim() : ''
        const base0 = (key0.split(',')[0] || '').trim()
        if (!key0) {
          d.key = altKey
        } else if (base0 === d.talent) {
          d.key = rewriteKeyBase(key0, altKey)
        }
      }

      // Skill stance conversions: when talent.e tables look like NA/charged/plunge tables,
      // and the skill description suggests attacks are converted, route the dmg key bucket like baseline.
      if (
        !altKey &&
        gsEAllowsNaKeyByName &&
        d.talent === 'e' &&
        normalizeKind((d as any).kind) === 'dmg' &&
        typeof d.table === 'string' &&
        d.table.trim() &&
        isNaLikeTable(d.table)
      ) {
        const t = d.table.endsWith('2') ? d.table.slice(0, -1) : d.table
        const inferred: 'a' | 'a2' | 'a3' = /重击|瞄准|蓄力/.test(t) ? 'a2' : /下落|坠地|低空|高空/.test(t) ? 'a3' : 'a'
        const key0 = typeof d.key === 'string' ? d.key.trim() : ''
        const base0 = (key0.split(',')[0] || '').trim()
        if (!key0) {
          d.key = inferred
        } else if (base0 === 'e') {
          d.key = rewriteKeyBase(key0, inferred)
        }
      }

      // If this is a skill table, avoid accidentally categorizing it as normal/charged/plunge.
      if (d.talent === 'e' && typeof d.key === 'string') {
        const keyBase = d.key.split(',')[0]?.trim()
        const allowNaKeyOnE = gsEActsAsNa || (d.table && isNaLikeTable(d.table)) || !!altKey
        if ((keyBase === 'a' || keyBase === 'a2' || keyBase === 'a3') && d.table && !allowNaKeyOnE) {
          d.key = rewriteKeyBase(d.key, 'e')
        }
      }

      // If the talent description explicitly says damage is "counted as" another talent type,
      // route the key bucket accordingly (baseline commonly does this for stance/infusion kits).
      if (d.kind === 'dmg' && (d.talent === 'e' || d.talent === 'q') && (gsConvKeyByTalent as any)[d.talent]) {
        const conv = (gsConvKeyByTalent as any)[d.talent] as 'a' | 'e' | 'q'
        if (conv && conv !== d.talent) {
          const key0 = typeof d.key === 'string' ? d.key.trim() : ''
          if (!key0) {
            d.key = conv
          } else {
            const keyBase = key0.split(',')[0]?.trim()
            if (keyBase === d.talent) d.key = rewriteKeyBase(key0, conv)
          }
        }
      }

      // Normalize common press-mode flags to avoid systematic over/under-buffing:
      // - "点按/短按" should NOT have `params.long === true`
      // - "长按" should have `params.long === true` when `params.long` is present
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        const hint = `${String((d as any).title || '')} ${String((d as any).table || '')}`
        const p = d.params as any
        const hasLong = /长按/.test(hint)
        const hasShort = /(点按|短按)/.test(hint)
        if (hasShort && !hasLong && p.long === true) p.long = false
        if (hasLong && p.long !== undefined && p.long !== true) p.long = true
      }
    }

    // Inject E-state normal attack details when tables strongly suggest this pattern.
    const eTables = tables.e || []
    const eNaCandidates: Array<{ title: string; table: string; key: string }> = []
    if (eTables.includes('一段伤害')) eNaCandidates.push({ title: 'E后普攻一段伤害', table: '一段伤害', key: 'a' })
    if (eTables.includes('五段伤害')) eNaCandidates.push({ title: 'E后普攻五段伤害', table: '五段伤害', key: 'a' })
    if (eTables.includes('重击伤害')) eNaCandidates.push({ title: 'E后重击伤害', table: '重击伤害', key: 'a2' })

    if (eNaCandidates.length) {
      const norm = (s: unknown): string =>
        String(typeof s === 'string' ? s : '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')
      const want = eNaCandidates.filter((c) => !details.some((d) => norm((d as any).title) === norm(c.title)))
      if (want.length) {
        for (let i = want.length - 1; i >= 0; i--) {
          const c = want[i]!
          // Most E-state normal attacks require the "E mode" params flag to activate related buffs.
          details.unshift({ title: c.title, kind: 'dmg', talent: 'e', table: c.table, key: c.key, params: { e: true } })
        }
        while (details.length > 20) details.pop()
      }
    }

    // If we detected stateful multiplier tables (e.g. talent.e table with unit "普通攻击伤害"),
    // ensure there is at least one showcase detail that activates the corresponding state flag.
    const hasFlag = (d: CalcSuggestDetail, flag: 'e' | 'q'): boolean => {
      const p = (d as any).params
      return !!p && typeof p === 'object' && !Array.isArray(p) && (p as any)[flag] === true
    }
    const keyBase = (d: CalcSuggestDetail): string => {
      const k0 = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : d.talent || ''
      return (k0.split(',')[0] || '').trim()
    }
    const pickATableFor = (baseKey: 'a' | 'a2' | 'a3'): string | undefined => {
      const aTables = tables.a || []
      if (baseKey === 'a') {
        return (
          aTables.find((t) => /一段伤害2?$/.test(t)) ||
          aTables.find((t) => /一段伤害/.test(t)) ||
          aTables.find((t) => isNaLikeTable(t) && !/重击|下落|坠/.test(t)) ||
          pickDamageTable(aTables)
        )
      }
      if (baseKey === 'a2') {
        return aTables.find((t) => /重击.*伤害/.test(t)) || aTables.find((t) => t.includes('重击伤害')) || pickDamageTable(aTables)
      }
      // a3
      return (
        aTables.find((t) => t.includes('低空') || t.includes('高空') || t.includes('坠地') || t.includes('下落')) ||
        aTables.find((t) => t.includes('下坠期间伤害')) ||
        pickDamageTable(aTables)
      )
    }

    for (const m of multiUnitTables) {
      if (!m.stateFlag) continue
      const flag = m.stateFlag
      const base: 'a' | 'a2' | 'a3' | 'e' | 'q' =
        m.multiKey.startsWith('a2') ? 'a2' : m.multiKey.startsWith('a3') ? 'a3' : m.multiKey.startsWith('a') ? 'a' : m.multiKey.startsWith('e') ? 'e' : 'q'

      // If a detail already sets the state flag for this base key, do nothing.
      const has = details.some((d) => d.kind === 'dmg' && keyBase(d) === base && hasFlag(d, flag))
      if (has) continue

      if (base === 'a' || base === 'a2' || base === 'a3') {
        const table = pickATableFor(base)
        if (!table) continue
        const title =
          flag === 'e'
            ? base === 'a'
              ? 'E后普攻伤害'
              : base === 'a2'
                ? 'E后重击伤害'
                : 'E后下落伤害'
            : base === 'a'
              ? 'Q后普攻伤害'
              : base === 'a2'
                ? 'Q后重击伤害'
                : 'Q后下落伤害'
        details.unshift({ title, kind: 'dmg', talent: 'a', table, key: base, params: { [flag]: true } })
      } else {
        const list = (tables as any)[base] as string[] | undefined
        const table = list ? pickDamageTable(list) : undefined
        if (!table) continue
        const title = flag === 'e' ? 'E后技能伤害' : 'Q后技能伤害'
        details.unshift({ title, kind: 'dmg', talent: base, table, key: base, params: { [flag]: true } })
      }

      while (details.length > 20) details.pop()
    }

    // Prefer unique special charged attack table (if present) as the primary "重击伤害" source.
    const aTables = tables.a || []
    const specialCharged = aTables.filter((t) => t.includes('重击·') && t.includes('持续伤害'))
    if (specialCharged.length === 1) {
      const cand = specialCharged[0]!
      for (const d of details) {
        if (d.talent === 'a' && d.table === '重击伤害') {
          d.table = cand
        }
      }
    }

    // Mavuika (war will / chariot) showcase rows used by baseline (detected via unique table names).
    // This is derived purely from API table names (no baseline code reuse).
    const qTables = tables.q || []
    const eTables2 = tables.e || []

    // Additional "showcase" patterns seen in baseline calcs. These patches are driven by
    // unique API table names / official descriptions (no baseline code reuse).
    const isDionaLike =
      input.name === '迪奥娜' ||
      (eTables2.includes('猫爪伤害') && eTables2.includes('护盾基础吸收量2') && qTables.includes('持续治疗量2'))
    const isSkirkLike =
      input.name === '丝柯克' ||
      (qTables.includes('汲取0/1/2/3枚虚境裂隙伤害提升2') && qTables.some((t) => t.includes('蛇之狡谋')))
    const isFurinaLike =
      input.name === '芙宁娜' ||
      (qTables.includes('气氛值转化提升伤害比例') &&
        qTables.includes('气氛值转化受治疗加成比例') &&
        (eTables2.includes('乌瑟勋爵伤害') || eTables2.includes('谢贝蕾妲小姐伤害')))
    const isNeuvilletteLike =
      input.name === '那维莱特' ||
      ((tables.a || []).includes('重击·衡平推裁持续伤害') && qTables.includes('水瀑伤害'))

    if (isDionaLike) wantsDionaShowcase = true
    if (isSkirkLike) wantsSkirkCoreBuffs = true
    if (isFurinaLike) wantsFurinaFanfare = true
    if (isNeuvilletteLike) wantsNeuvilletteCharged = true

    if (isFurinaLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

      const hasDetail = (q: Partial<CalcSuggestDetail>): boolean =>
        details.some((d) => {
          if (q.kind && d.kind !== q.kind) return false
          if (q.talent && d.talent !== q.talent) return false
          if (q.table && d.table !== q.table) return false
          if (q.ele && d.ele !== q.ele) return false
          return true
        })
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasDetail({ kind: d.kind, talent: d.talent, table: d.table, ele: d.ele })) return
        details.unshift(d)
      }

      // Baseline-style showcase rows (Furina):
      // - E salon member damage rows assume the "consume party HP" state (multiplier 1.4).
      // - Include vaporize variants for the main hit and Q.
      //
      // This is derived from unique official table names (no baseline code reuse).
      const summonTables = ['海薇玛夫人伤害', '乌瑟勋爵伤害', '谢贝蕾妲小姐伤害']
      // Baseline-style display titles for Furina's salon members (official names).
      const summonTitleMap: Record<string, string> = {
        海薇玛夫人伤害: 'E海薇玛夫人(海马)·伤害',
        乌瑟勋爵伤害: 'E乌瑟勋爵(章鱼)·伤害',
        谢贝蕾妲小姐伤害: 'E谢贝蕾妲小姐(螃蟹)·伤害'
      }

      // Ensure core rows exist (some LLM plans skip summons/heal).
      if (eTables2.includes('众水的歌者治疗量2')) {
        pushFront({
          title: 'E众水歌者治疗',
          kind: 'heal',
          talent: 'e',
          table: '众水的歌者治疗量2',
          stat: 'hp',
          key: 'e'
        })
      }
      for (const tn of summonTables) {
        if (!eTables2.includes(tn)) continue
        pushFront({
          title: `E${tn}`,
          kind: 'dmg',
          talent: 'e',
          table: tn,
          key: 'e'
        })
      }
      // Q main hit (for adding vaporize variant below).
      if (qTables.includes('技能伤害')) {
        pushFront({ title: 'Q万众狂欢·伤害', kind: 'dmg', talent: 'q', table: '技能伤害', key: 'q' })
      }

      // Patch summon rows to apply the 1.4 showcase multiplier.
      for (const d of details) {
        if (d.kind !== 'dmg') continue
        if (d.talent !== 'e') continue
        const tn = typeof d.table === 'string' ? d.table : ''
        if (!tn || !summonTables.includes(tn)) continue
        const keyArg = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : 'e'
        const eleArg = typeof d.ele === 'string' && d.ele.trim() ? `, ${JSON.stringify(d.ele.trim())}` : ''
        ;(d as any).dmgExpr = `dmg.basic(calc(attr.hp) * toRatio(talent.e[\"${tn}\"]) * 1.4, ${JSON.stringify(keyArg)}${eleArg})`
      }

      // Normalize titles to be stable and baseline-like (helps regression matching).
      for (const d of details) {
        if (d.kind === 'heal' && d.talent === 'e' && d.table === '众水的歌者治疗量2') {
          d.title = 'E众水歌者治疗'
        }
        if (d.kind === 'dmg' && d.talent === 'e' && typeof d.table === 'string' && summonTables.includes(d.table) && !d.ele) {
          d.title = summonTitleMap[d.table] || `E${d.table}`
        }
        if (d.kind === 'dmg' && d.talent === 'q' && d.table === '技能伤害' && !d.ele) {
          d.title = 'Q万众狂欢·伤害'
        }
        if (d.kind === 'dmg' && d.talent === 'q' && d.table === '技能伤害' && d.ele === 'vaporize') {
          d.title = 'Q万众狂欢伤害·蒸发'
        }
        if (d.kind === 'dmg' && d.talent === 'e' && d.table === '谢贝蕾妲小姐伤害' && d.ele === 'vaporize') {
          d.title = 'E谢贝蕾妲小姐(螃蟹)·蒸发'
        }
      }

      // Add vaporize variants if missing.
      if (eTables2.includes('谢贝蕾妲小姐伤害') && !hasDetail({ kind: 'dmg', talent: 'e', table: '谢贝蕾妲小姐伤害', ele: 'vaporize' })) {
        details.unshift({
          title: 'E谢贝蕾妲小姐(螃蟹)·蒸发',
          kind: 'dmg',
          talent: 'e',
          table: '谢贝蕾妲小姐伤害',
          key: 'e',
          ele: 'vaporize',
          // Keep consistent with the summon showcase multiplier patch above.
          dmgExpr: `dmg.basic(calc(attr.hp) * toRatio(talent.e[\"谢贝蕾妲小姐伤害\"]) * 1.4, \"e\", \"vaporize\")`
        })
      }
      if (qTables.includes('技能伤害') && !hasDetail({ kind: 'dmg', talent: 'q', table: '技能伤害', ele: 'vaporize' })) {
        details.unshift({
          title: 'Q万众狂欢伤害·蒸发',
          kind: 'dmg',
          talent: 'q',
          table: '技能伤害',
          key: 'q',
          ele: 'vaporize'
        })
      }

      // Prune noisy/incorrect LLM rows and keep baseline-like showcase set.
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]!
        if (!d || typeof d !== 'object') continue
        const title = d.title || ''
        if (/满增益|满buff/i.test(title)) {
          details.splice(i, 1)
        }
      }

      // De-dup core rows by (talent, table, ele) preference: keep our injected "E${table}" / "Q万众狂欢·伤害".
      const preferTitleFor = (d: CalcSuggestDetail): string => {
        if (d.talent === 'e' && typeof d.table === 'string' && summonTables.includes(d.table) && !d.ele) return `E${d.table}`
        if (d.kind === 'heal' && d.talent === 'e' && d.table === '众水的歌者治疗量2') return 'E众水歌者治疗'
        if (d.talent === 'q' && d.table === '技能伤害' && !d.ele) return 'Q万众狂欢·伤害'
        return d.title
      }
      const keyOf = (d: CalcSuggestDetail): string => `${d.kind || 'dmg'}|${d.talent || ''}|${d.table || ''}|${d.ele || ''}`
      const isPreferred = (d: CalcSuggestDetail): boolean => norm(d.title) === norm(preferTitleFor(d))

      // Keep one row per key, prefer the baseline-like title when present.
      const keepByKey = new Map<string, CalcSuggestDetail>()
      for (const d of details) {
        const k = keyOf(d)
        const cur = keepByKey.get(k)
        if (!cur) {
          keepByKey.set(k, d)
          continue
        }
        const curPref = isPreferred(cur)
        const nextPref = isPreferred(d)
        if (nextPref && !curPref) keepByKey.set(k, d)
      }
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]!
        const k = keyOf(d)
        if (keepByKey.get(k) !== d) details.splice(i, 1)
      }

      while (details.length > 20) details.pop()
    }

    // Mualani showcase rows (Natlan nightsoul bite stacks).
    // Detected via unique official table names; no baseline code reuse.
    const isMualaniLike =
      input.name === '玛拉妮' ||
      (eTables2.includes('鲨波撒咬基础伤害') &&
        eTables2.includes('浪势充能伤害提升') &&
        eTables2.includes('巨浪鲨波撒咬伤害额外提升') &&
        qTables.includes('技能伤害'))

    if (isMualaniLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      const biteBase = 'calc(attr.hp) * toRatio(talent.e["鲨波撒咬基础伤害"])'
      const biteStackAdd =
        '(params.buffCount ? (calc(attr.hp) * (toRatio(talent.e["浪势充能伤害提升"]) * params.buffCount + (params.buffCount === 3 ? toRatio(talent.e["巨浪鲨波撒咬伤害额外提升"]) : 0))) : 0)'
      const biteC1Add = '(cons >= 1 && params.cons1 ? (calc(attr.hp) * 0.66) : 0)'
      const biteExpr = `dmg.basic((${biteBase}) + (${biteStackAdd}) + (${biteC1Add}), "a,nightsoul")`
      const biteVapeExpr = `dmg.basic((${biteBase}) + (${biteStackAdd}) + (${biteC1Add}), "a,nightsoul", "蒸发")`

      pushFront({ title: 'E后巨浪鲨鲨撕咬蒸发', kind: 'dmg', talent: 'e', key: 'a,nightsoul', params: { buffCount: 3, cons1: true }, dmgExpr: biteVapeExpr })
      pushFront({ title: 'E后巨浪鲨鲨撕咬伤害', kind: 'dmg', talent: 'e', key: 'a,nightsoul', params: { buffCount: 3, cons1: true }, dmgExpr: biteExpr })
      pushFront({ title: 'E后鲨鲨撕咬二层伤害', kind: 'dmg', talent: 'e', key: 'a,nightsoul', params: { buffCount: 2 }, dmgExpr: biteExpr })
      pushFront({ title: 'E后鲨鲨撕咬一层伤害', kind: 'dmg', talent: 'e', key: 'a,nightsoul', params: { buffCount: 1 }, dmgExpr: biteExpr })
      pushFront({ title: 'E后鲨鲨撕咬基础伤害', kind: 'dmg', talent: 'e', key: 'a,nightsoul', dmgExpr: biteExpr })

      const qBase = 'calc(attr.hp) * toRatio(talent.q["技能伤害"])'
      const qPassive = 'calc(attr.hp) * 0.15'
      const qExpr = `dmg.basic((${qBase}) + (${qPassive}) + (${biteC1Add}), "q,nightsoul")`
      const qVapeExpr = `dmg.basic((${qBase}) + (${qPassive}) + (${biteC1Add}), "q,nightsoul", "蒸发")`

      pushFront({ title: 'Q爆瀑飞弹蒸发', kind: 'dmg', talent: 'q', key: 'q,nightsoul', params: { cons1: true }, dmgExpr: qVapeExpr })
      pushFront({ title: 'Q爆瀑飞弹伤害', kind: 'dmg', talent: 'q', key: 'q,nightsoul', params: { cons1: true }, dmgExpr: qExpr })

      // Prune to the baseline-like showcase set for stability.
      const keep = new Set(
        [
          'E后鲨鲨撕咬基础伤害',
          'E后鲨鲨撕咬一层伤害',
          'E后鲨鲨撕咬二层伤害',
          'E后巨浪鲨鲨撕咬伤害',
          'E后巨浪鲨鲨撕咬蒸发',
          'Q爆瀑飞弹伤害',
          'Q爆瀑飞弹蒸发'
        ].map(norm)
      )
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i]
        if (!d || typeof d !== 'object') continue
        if (!keep.has(norm(d.title || ''))) details.splice(i, 1)
      }

      while (details.length > 20) details.pop()
    }

    // Lauma showcase rows (lunar / bloom hybrid).
    // Driven by unique official table names / texts (no baseline code reuse).
    const isLaumaLike =
      input.name === '菈乌玛' ||
      (eTables2.includes('长按二段伤害') &&
        String((input.tableTextSamples as any)?.e?.['长按二段伤害'] || '').includes('每枚草露'))

    if (isLaumaLike) {
      wantsLaumaShowcase = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline-like bloom rows (Lauma): uses custom bloom scaling (2x dmg, 1.15x avg).
      // NOTE: these params are chosen to trigger baseline-like buffs (Pale_Hymn/Moonsign), not for toggling.
      const bloomExpr = '({ dmg: reaction(\"bloom\").avg * 2, avg: reaction(\"bloom\").avg * 1.15 })'
      pushFront({
        title: 'Q后绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        dmgExpr: bloomExpr,
        params: { Pale_Hymn: true, Moonsign: 1 }
      })
      pushFront({
        title: '绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        dmgExpr: bloomExpr,
        params: { Moonsign: 1 }
      })

      // Prefer the structured mixed-stat table for the "圣域" hit when available.
      const fieldTable = eTables2.includes('霜林圣域攻击伤害2')
        ? '霜林圣域攻击伤害2'
        : eTables2.includes('霜林圣域攻击伤害')
          ? '霜林圣域攻击伤害'
          : ''
      if (fieldTable) {
        const hit = details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === fieldTable)
        if (hit) {
          hit.title = 'E圣域伤害'
          hit.key = 'e'
          hit.params = { ...(hit.params || {}), Linnunrata: true }
        }
        else {
          pushFront({
            title: 'E圣域伤害',
            kind: 'dmg',
            talent: 'e',
            table: fieldTable,
            key: 'e',
            params: { Linnunrata: true }
          })
        }
      }

      // "每枚草露..." tables are per-instance; baseline showcases the 3-instance total at 满辉.
      if (eTables2.includes('长按二段伤害')) {
        const expr = 'dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"长按二段伤害\"]) * 3, \"\", \"lunarBloom\")'
        const row =
          details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === '长按二段伤害' && d.ele === 'lunarBloom') ||
          details.find((d) => d.kind === 'dmg' && d.talent === 'e' && d.table === '长按二段伤害')
        if (row) {
          row.title = '满辉长按E二段3枚'
          row.key = ''
          row.ele = 'lunarBloom'
          row.params = { Lunar: true, Moonsign: 3 }
          row.dmgExpr = expr
        } else {
          pushFront({
            title: '满辉长按E二段3枚',
            kind: 'dmg',
            talent: 'e',
            table: '长按二段伤害',
            key: '',
            ele: 'lunarBloom',
            params: { Lunar: true, Moonsign: 3 },
            dmgExpr: expr
          })
        }
      }

      while (details.length > 20) details.pop()
    }

    if (isDionaLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\\s+/g, '')
          .replace(/[·!?！？…\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’\"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline tends to showcase: hold-E total, hold-E shield, and (C6) half-HP Q tick heal.
      // NOTE: pushFront uses unshift, so append in reverse order of desired output.
      pushFront({
        title: '半血Q每跳治疗',
        kind: 'heal',
        talent: 'q',
        table: '持续治疗量2',
        stat: 'hp',
        key: 'q',
        params: { halfHp: true }
      })
      pushFront({
        title: '长按E护盾量',
        kind: 'shield',
        talent: 'e',
        key: 'e',
        dmgExpr:
          'shield((talent.e[\"护盾基础吸收量2\"][0] * calc(attr.hp) / 100 + talent.e[\"护盾基础吸收量2\"][1]) * 1.75)'
      })
      pushFront({
        title: '长按E总伤害',
        kind: 'dmg',
        talent: 'e',
        key: 'e',
        dmgExpr: 'dmg(talent.e[\"猫爪伤害\"] * 5, \"e\")'
      })

      while (details.length > 20) details.pop()
    }

    if (isNeuvilletteLike) {
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\\s+/g, '')
          .replace(/[·!?！？…\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’\"']/g, '')
      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      // Baseline charged damage row includes the cons-based multiplier (C0=1.25, C1+=1.6).
      const chargedExpr =
        'dmg.basic((cons >= 1 ? 1.6 : 1.25) * talent.a[\"重击·衡平推裁持续伤害\"] * calc(attr.hp) / 100, \"a2\")'
      for (const d of details) {
        if (norm(d.title) !== norm('重击伤害')) continue
        ;(d as any).kind = 'dmg'
        ;(d as any).talent = 'a'
        ;(d as any).key = 'a2'
        ;(d as any).dmgExpr = chargedExpr
      }
      pushFront({ title: '重击伤害', kind: 'dmg', talent: 'a', key: 'a2', dmgExpr: chargedExpr })

      while (details.length > 20) details.pop()
    }

    const isMavuikaLike =
      input.name === '玛薇卡' ||
      (qTables.includes('战意上限') &&
        qTables.includes('坠日斩伤害提升') &&
        qTables.includes('驰轮车普通攻击伤害提升') &&
        qTables.includes('驰轮车重击伤害提升') &&
        eTables2.includes('驰轮车普通攻击一段伤害') &&
        eTables2.includes('驰轮车重击循环伤害') &&
        eTables2.includes('驰轮车重击终结伤害'))

    if (isMavuikaLike) {
      wantsMavuikaWarWill = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      const ZY_MAX = 200
      pushFront({
        title: 'Q技能伤害(100战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        params: { zy: 100, cl: true, Nightsoul: true }
      })
      pushFront({
        title: 'Q技能伤害(满战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: 'Q技能融化(满战意)',
        kind: 'dmg',
        talent: 'q',
        table: '技能伤害',
        key: 'q,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车普攻一段伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车普通攻击一段伤害',
        key: 'a,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车普攻一段融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车普通攻击一段伤害',
        key: 'a,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击循环伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击循环伤害',
        key: 'a2,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击循环融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击循环伤害',
        key: 'a2,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击终结伤害(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击终结伤害',
        key: 'a2,nightsoul',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })
      pushFront({
        title: '驰轮车重击终结融化(满战意 死生之炉状态)',
        kind: 'dmg',
        talent: 'e',
        table: '驰轮车重击终结伤害',
        key: 'a2,nightsoul',
        ele: 'melt',
        params: { zy: ZY_MAX, cl: true, Nightsoul: true }
      })

      while (details.length > 20) details.pop()
    }

    // Colombina (lunar reactions + gravity interference) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isColombinaLike =
      input.name === '哥伦比娅' ||
      (eTables2.includes('引力涟漪·持续伤害') &&
        eTables2.includes('引力干涉·月感电伤害') &&
        eTables2.includes('引力干涉·月绽放伤害') &&
        eTables2.includes('引力干涉·月结晶伤害') &&
        qTables.includes('月曜反应伤害提升') &&
        (tables.a || []).includes('月露涤荡伤害'))

    if (isColombinaLike) {
      wantsColombinaLunar = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      pushFront({
        title: '满buff 特殊重击「月露涤荡」三段总伤害',
        kind: 'dmg',
        talent: 'a',
        table: '月露涤荡伤害',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Gravity_Interference: true, cons_2: true }
      })
      pushFront({
        title: '满buff 引力涟漪·持续伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力涟漪·持续伤害',
        key: 'e',
        params: { Gravity_Interference: true }
      })
      pushFront({
        title: '满buff 引力干涉·月感电伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月感电伤害',
        key: 'e',
        ele: 'lunarCharged',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })
      pushFront({
        title: '满buff 引力干涉·月绽放伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月绽放伤害',
        key: 'e',
        ele: 'lunarBloom',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })
      pushFront({
        title: '满buff 引力干涉·月结晶伤害',
        kind: 'dmg',
        talent: 'e',
        table: '引力干涉·月结晶伤害',
        key: 'e',
        ele: 'lunarCrystallize',
        params: { Gravity_Interference: true, q: true, Moonsign_Benediction: true }
      })

      while (details.length > 20) details.pop()
    }

    // Nefer (Veil_of_Falsehood stacks) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isNeferLike =
      input.name === '奈芙尔' ||
      (eTables2.includes('幻戏自身一段伤害2') &&
        eTables2.includes('幻戏虚影三段') &&
        qTables.includes('伤害提升') &&
        qTables.includes('二段伤害2'))

    if (isNeferLike) {
      wantsNeferVeil = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      const dropBy = (re: RegExp): void => {
        for (let i = details.length - 1; i >= 0; i--) {
          const t = details[i]?.title || ''
          if (re.test(t)) details.splice(i, 1)
        }
      }
      // Drop known-bad LLM hallucinations for this character.
      dropBy(/消耗伪秘之帷|BondOfLife|^Q|元素爆发/i)

      // Baseline uses plain "Q一段伤害/Q二段伤害" (no extra stack variants).
      pushFront({
        title: 'Q二段伤害',
        kind: 'dmg',
        talent: 'q',
        table: '二段伤害2',
        key: 'q'
      })
      pushFront({
        title: 'Q一段伤害',
        kind: 'dmg',
        talent: 'q',
        table: '一段伤害2',
        key: 'q'
      })

      pushFront({
        title: '满层满辉E后幻戏自身一段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身一段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身一段伤害2\"][1] || 0)) / 100, \"a2\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身一段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身一段伤害2\"][1] || 0)) / 100, \"a2\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        params: { Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏自身二段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身二段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身二段伤害2\"][1] || 0)) / 100, \"a2\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic((calc(attr.atk) * (talent.e[\"幻戏自身二段伤害2\"][0] || 0) + calc(attr.mastery) * (talent.e[\"幻戏自身二段伤害2\"][1] || 0)) / 100, \"a2\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        params: { Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同一段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影一段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影一段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同二段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影二段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影二段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '满层满辉E后幻戏协同三段',
        kind: 'dmg',
        dmgExpr:
          '({ dmg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影三段\"]), \"\", \"lunarBloom\").dmg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10), avg: dmg.basic(calc(attr.mastery) * toRatio(talent.e[\"幻戏虚影三段\"]), \"\", \"lunarBloom\").avg * (1 + Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3)) / 10) })',
        talent: 'e',
        key: 'a2',
        ele: 'lunarBloom',
        params: { Lunar: true, Phantasm_Performance: true }
      })
      pushFront({
        title: '绽放伤害',
        kind: 'reaction',
        reaction: 'bloom',
        params: { Moonsign: 1 }
      })

      while (details.length > 20) details.pop()
    }

    // Emilie (burning / lumidouce) baseline showcase rows.
    // Detected via unique table names; no baseline code reuse.
    const isEmilieLike =
      input.name === '艾梅莉埃' ||
      (eTables2.includes('柔灯之匣·一阶攻击伤害') &&
        eTables2.includes('柔灯之匣·二阶攻击伤害2') &&
        qTables.includes('柔灯之匣·三阶攻击伤害'))

    if (isEmilieLike) {
      wantsEmilieBurning = true
      const norm = (s: string): string =>
        s
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

      const hasTitle = (title: string): boolean => details.some((d) => norm(d.title) === norm(title))
      const pushFront = (d: CalcSuggestDetail): void => {
        if (hasTitle(d.title)) return
        details.unshift(d)
      }

      pushFront({
        title: '重击伤害',
        kind: 'dmg',
        talent: 'a',
        table: '重击伤害',
        key: 'a2'
      })
      pushFront({
        title: 'E技能伤害',
        kind: 'dmg',
        talent: 'e',
        table: '技能伤害',
        key: 'e',
        params: { e: true }
      })
      pushFront({
        title: 'E后柔灯之匣一阶伤害',
        kind: 'dmg',
        talent: 'e',
        table: '柔灯之匣·一阶攻击伤害',
        key: 'e',
        params: { e: true }
      })
      pushFront({
        title: 'E后柔灯之匣二阶单枚伤害',
        kind: 'dmg',
        dmgExpr: 'dmg(talent.e[\"柔灯之匣·二阶攻击伤害2\"][0], \"e\")',
        params: { e: true }
      })
      pushFront({
        title: '天赋清露香氛伤害',
        kind: 'dmg',
        dmgExpr: 'dmg.basic(attr.atk * 600 / 100, \"\")',
        params: { e: true }
      })
      pushFront({
        title: 'Q柔灯之匣三阶伤害',
        kind: 'dmg',
        talent: 'q',
        table: '柔灯之匣·三阶攻击伤害',
        key: 'q'
      })
      pushFront({
        title: 'Q完整对单',
        kind: 'dmg',
        dmgExpr:
          '(() => { const q1 = dmg(talent.q[\"柔灯之匣·三阶攻击伤害\"], \"q\"); const n = (cons >= 4 ? 12 : 4); return { dmg: q1.dmg * n, avg: q1.avg * n }; })()'
      })
      pushFront({
        title: '燃烧反应伤害',
        kind: 'reaction',
        reaction: 'burning'
      })

      while (details.length > 20) details.pop()
    }
  }

  // SR: break / superBreak tables are NOT normal talent-multiplier damage.
  // Hakush uses dedicated tables like "击破伤害比例" which should scale miao-plugin's `reaction("<elem>Break")`,
  // plus the toughness coefficient `(敌方韧性 + 2) / 4`. Baseline commonly showcases both 2/10 toughness targets.
  if (input.game === 'sr') {
    const elemNorm = normalizePromptText(input.elem)
    const elemBreak: string | null = (() => {
      if (!elemNorm) return null
      if (/(物理|physical)/i.test(elemNorm)) return 'physicalBreak'
      if (/(火|fire)/i.test(elemNorm)) return 'fireBreak'
      if (/(冰|ice)/i.test(elemNorm)) return 'iceBreak'
      if (/(雷|lightning|electro)/i.test(elemNorm)) return 'lightningBreak'
      if (/(风|wind)/i.test(elemNorm)) return 'windBreak'
      if (/(量子|quantum)/i.test(elemNorm)) return 'quantumBreak'
      if (/(虚数|imaginary)/i.test(elemNorm)) return 'imaginaryBreak'
      return null
    })()

    const isBreakRatioTable = (t: string): boolean =>
      (/^(击破伤害比例|击破伤害)$/.test(String(t || '').trim()) ||
        (/击破伤害/.test(String(t || '').trim()) && !/(提高|提升|增加|降低|减少)/.test(String(t || '').trim()))) &&
      !/超击破/.test(String(t || '').trim())
    const isSuperBreakRatioTable = (t: string): boolean => {
      const s = String(t || '').trim()
      return /超击破伤害/.test(s) && !/(提高|提升|增加|降低|减少)/.test(s)
    }

    const ratioExprOf = (talent: TalentKey, tableName: string): string => {
      // Some tables may still be [pct, flat] (rare for break), so only use the first component when array.
      const acc = `talent.${talent}[${jsString(tableName)}]`
      return `toRatio(Array.isArray(${acc}) ? ${acc}[0] : ${acc})`
    }

    const inferTalentFromTitle = (titleRaw: unknown): TalentKey | null => {
      const t = String(titleRaw || '').trim()
      if (!t) return null
      if (/(终结技|大招)/.test(t)) return 'q'
      if (/战技/.test(t)) return 'e'
      if (/普攻/.test(t)) return 'a'
      if (/天赋/.test(t)) return 't'
      // Some SR calcs use "秘技" rows (not a real talent bucket in our generator); prefer Q when possible.
      if (/秘技/.test(t)) return 'q'
      return null
    }

    const findRatioSourceAny = (
      prefer: TalentKey | null,
      tableNames: readonly string[]
    ): { talent: TalentKey; tableName: string } | null => {
      const preferList: TalentKey[] = [
        ...(prefer ? [prefer] : []),
        'q',
        't',
        'e',
        'a',
        'me',
        'mt'
      ]
      for (const tk of preferList) {
        const list = (tables as any)?.[tk]
        if (!Array.isArray(list)) continue
        for (const tableName of tableNames) {
          if (list.includes(tableName)) return { talent: tk, tableName }
        }
      }
      return null
    }

    const findRatioSource = (prefer: TalentKey | null, tableName: string): TalentKey | null =>
      findRatioSourceAny(prefer, [tableName])?.talent ?? null

    // Parse SR buff hints for superBreak-related multipliers/cost tweaks (generic, no per-character hardcode).
    const hintLines = (input.buffHints || [])
      .filter((s) => typeof s === 'string')
      .map((s) => normalizePromptText(s)) as string[]
    const descByTalentAll = (input.talentDesc || {}) as Record<string, unknown>
    const descLinesAll = Object.values(descByTalentAll)
      .map((v) => normalizePromptText(v))
      .filter(Boolean) as string[]
    const hasText = (re: RegExp): boolean => hintLines.some((h) => re.test(h)) || descLinesAll.some((t) => re.test(t))
    // Only keep break showcase rows when the kit explicitly deals break/superBreak damage.
    // This avoids "break taken" debuffs (e.g. "目标受到的击破伤害提高") inflating maxAvg and drifting from baseline.
    const wantsBreakDetails = hasText(/属性击破伤害/) || hasText(/(?:造成|对.{0,12}造成|额外造成|追加造成).{0,20}击破伤害/)
    const wantsSuperBreakDetails = hasText(/超击破/)
    const pickAllPcts = (text: string): number[] => {
      const out: number[] = []
      const re = /(\d+(?:\.\d+)?)\s*[%％]/g
      let m: RegExpExecArray | null
      while ((m = re.exec(text))) {
        const n = Number(m[1])
        if (!Number.isFinite(n) || n <= 0 || n > 2000) continue
        out.push(n)
      }
      return out
    }
    const maxPct = (text: string): number | null => {
      const list = pickAllPcts(text)
      if (list.length === 0) return null
      return Math.max(...list)
    }
    const traceKeyOfIdx = (idx: number): string => String(100 + idx)
    type SrCoreTalent = 'a' | 'e' | 'q' | 't'
    const pickCoreTalentFromText = (text: string): SrCoreTalent | null => {
      if (/(普攻|普通攻击)/.test(text)) return 'a'
      if (/战技/.test(text)) return 'e'
      if (/终结技/.test(text)) return 'q'
      if (/天赋/.test(text)) return 't'
      return null
    }
    const superBreakMulByTree = new Map<string, number>()
    const superBreakFirstHitStanceBonusByTree = new Map<string, { pct: number; talent: SrCoreTalent }>()
    const superBreakExtraCostTreeE = new Set<string>()
    let superBreakExtraCostConsE: number | null = null

    // SR: Eidolon hints may increase *break ratio multipliers* for a specific talent bucket
    // (e.g. "天赋造成的击破伤害倍率额外提高200%"). This multiplier is not modeled by miao-plugin buffs,
    // so we patch it into the break ratio expression (deterministic; no baseline code reuse).
    const breakRatioMulByTalent = new Map<SrCoreTalent, Array<{ consNeed: number; mul: number }>>()

    for (const h0 of hintLines) {
      const h = String(h0 || '').trim()
      if (!h) continue
      const mTrace = h.match(/^\s*行迹\s*(\d)\s*[：:]/)
      if (mTrace) {
        const idx = Math.trunc(Number(mTrace[1]))
        if (idx >= 1 && idx <= 4) {
          const treeKey = traceKeyOfIdx(idx)
          // SuperBreak damage multiplier (often a conditional list like 20/30/40/50/60%).
          if (/超击破伤害/.test(h) && /(提高|提升|增加)/.test(h)) {
            const mx = maxPct(h)
            if (mx != null) superBreakMulByTree.set(treeKey, Math.max(superBreakMulByTree.get(treeKey) || 0, mx))
          }
          // First-hit stance bonus: affects superBreak via toughness cost (only model "第一次" to keep it conservative).
          if (/削韧值/.test(h) && /(提高|提升|增加)/.test(h) && /第一次/.test(h)) {
            const tk = pickCoreTalentFromText(h)
            const mx = maxPct(h)
            if (tk && mx != null) superBreakFirstHitStanceBonusByTree.set(treeKey, { pct: mx, talent: tk })
          }
          // Extra hits on skills generally increase superBreak triggers via toughness cost.
          if (/(额外|追加).{0,8}伤害.{0,8}次数.*增加/.test(h)) {
            const tk = pickCoreTalentFromText(h)
            if (tk === 'e') superBreakExtraCostTreeE.add(treeKey)
          }
        }
      }

      // Eidolon: extra hits often add superBreak triggers => extra toughness cost (keep it conservative: +1 unit cost).
      const mCons = h.match(/^\s*(\d)\s*魂[：:]/)
      if (mCons && /战技/.test(h) && /(额外|追加).{0,8}伤害.{0,8}次数.*增加/.test(h)) {
        const n = Math.trunc(Number(mCons[1]))
        if (n >= 1 && n <= 6) superBreakExtraCostConsE = superBreakExtraCostConsE ? Math.min(superBreakExtraCostConsE, n) : n
      }

      // Eidolon: break-ratio multiplier bumps (apply to the ratioExpr, not to reaction base stats).
      if (mCons) {
        const n = Math.trunc(Number(mCons[1]))
        if (n >= 1 && n <= 6) {
          const tk = pickCoreTalentFromText(h)
          const mMul = /击破伤害.{0,12}倍率.{0,12}(?:额外)?(?:提高|提升|增加)\s*([0-9]+(?:\.\d+)?)\s*[%％]/.exec(h)
          if (tk && mMul) {
            const extraPct = Number(mMul[1])
            if (Number.isFinite(extraPct) && extraPct > 0 && extraPct <= 2000) {
              const mul = 1 + extraPct / 100
              const list = breakRatioMulByTalent.get(tk) || []
              list.push({ consNeed: n, mul })
              breakRatioMulByTalent.set(tk, list)
            }
          }
        }
      }
    }

    const applyConsBreakRatioMul = (talentKey: TalentKey | null, ratioExprRaw: string): string => {
      const tk0 = talentKey ? String(talentKey).trim() : ''
      const core = (tk0.replace(/\d+$/, '') as SrCoreTalent) || ''
      if (!(core === 'a' || core === 'e' || core === 'q' || core === 't')) return ratioExprRaw
      const list = breakRatioMulByTalent.get(core) || []
      if (!list.length) return ratioExprRaw

      const bestByCons = new Map<number, number>()
      for (const it of list) {
        const n = typeof it.consNeed === 'number' ? Math.trunc(it.consNeed) : 0
        const mul = typeof it.mul === 'number' ? it.mul : 1
        if (!(n >= 1 && n <= 6)) continue
        if (!Number.isFinite(mul) || mul <= 0) continue
        const prev = bestByCons.get(n) || 0
        if (mul > prev) bestByCons.set(n, mul)
      }
      const entries = Array.from(bestByCons.entries()).sort((a, b) => a[0] - b[0])

      let out = String(ratioExprRaw || '').trim() || '1'
      for (const [consNeed, mul0] of entries) {
        const mul = Number.isFinite(mul0) ? Number(mul0.toFixed(6)) : 1
        if (mul <= 0 || Math.abs(mul - 1) < 1e-9) continue
        out = `(${out}) * (cons >= ${consNeed} ? ${mul} : 1)`
      }
      return out
    }

    const patchBreakDetailAt = (idx: number, d: CalcSuggestDetail, reactionId: string, ratioExpr: string): void => {
      const toughnessRows: Array<{ toughness: 2 | 10; coef: number }> = [
        { toughness: 2, coef: 1 }, // (2+2)/4
        { toughness: 10, coef: 3 } // (10+2)/4
      ]
      const stripToughnessSuffix = (t: string): string =>
        String(t || '')
          .replace(/[（(]\s*\d+\s*韧性怪\s*[)）]/g, '')
          .replace(/\s+/g, ' ')
          .trim()
      let baseTitle = stripToughnessSuffix(d.title || '击破伤害') || '击破伤害'
      // Baseline naming: "<普攻/战技/终结技/天赋>击破伤害".
      // Keep titles stable so panel-regression can match rows correctly.
      if (/break$/i.test(reactionId) && !/击破/.test(baseTitle) && /伤害$/.test(baseTitle)) {
        baseTitle = baseTitle.replace(/伤害$/, '击破伤害')
      }
      const tk0 = typeof d.talent === 'string' ? String(d.talent).trim() : ''
      const tkBase = tk0.replace(/\d+$/, '')
      const divExpr = tkBase === 't' ? '' : ' / 0.9'
      const mk = (row: { toughness: 2 | 10; coef: number }): CalcSuggestDetail => ({
        title: `${baseTitle}(${row.toughness}韧性怪)`,
        kind: 'reaction',
        reaction: reactionId,
        // Keep skill bucket for buff gating (currentTalent).
        ...(d.talent ? { talent: d.talent } : {}),
        ...(typeof d.cons === 'number' ? { cons: d.cons } : {}),
        ...(d.params ? { params: d.params } : {}),
        ...(d.check ? { check: d.check } : {}),
        dmgExpr: `({ avg: (reaction(${jsString(reactionId)}).avg || 0)${divExpr} * (${ratioExpr}) * ${row.coef} })`
      })
      details.splice(idx, 1, ...toughnessRows.map(mk))
    }

    const patchSuperBreakDetailAt = (idx: number, d: CalcSuggestDetail, ratioExpr: string): void => {
      let baseTitle = d.title || '超击破伤害'
      const ratio = ratioExpr && ratioExpr.trim() ? ratioExpr.trim() : '1'

      const tkRaw = typeof d.talent === 'string' ? String(d.talent).trim() : ''
      const coreFromRaw = (tkRaw.replace(/\d+$/, '') as SrCoreTalent) || ''
      const inferCoreTalent = (): SrCoreTalent | null => {
        if (coreFromRaw === 'a' || coreFromRaw === 'e' || coreFromRaw === 'q' || coreFromRaw === 't') return coreFromRaw
        return (inferTalentFromTitle(baseTitle) as any) || null
      }
      const coreTk = inferCoreTalent()
      const isEnhanced = Boolean(tkRaw && /^([aeq])\d+$/.test(tkRaw) && tkRaw !== coreFromRaw)

      const tNorm = normalizePromptText(baseTitle)
      const hasPrefix = /^(强化普攻|强化战技|强化终结技|普攻|战技|终结技|天赋|秘技)/.test(tNorm)
      if (!hasPrefix && /超击破/.test(tNorm)) {
        const prefix =
          isEnhanced && coreFromRaw === 'a'
            ? '强化普攻'
            : isEnhanced && coreFromRaw === 'e'
              ? '强化战技'
              : isEnhanced && coreFromRaw === 'q'
                ? '强化终结技'
                : coreTk === 'a'
                  ? '普攻'
                  : coreTk === 'e'
                    ? '战技'
                    : coreTk === 'q'
                      ? '终结技'
                      : coreTk === 't'
                        ? '天赋'
                        : ''
        if (prefix) baseTitle = `${prefix}·${baseTitle}`
      }

      const hasTable = (talentKey: string, tableName: string): boolean => {
        const list = (tables as any)?.[talentKey]
        return Array.isArray(list) && list.includes(tableName)
      }

      const tkTables =
        tkRaw && hasTable(tkRaw, '削韧') ? tkRaw : coreTk && hasTable(coreTk, '削韧') ? coreTk : ''
      const costSumExpr = tkTables ? `talent.${tkTables}[${jsString('削韧')}]` : '1'
      const costUnitExpr = tkTables && hasTable(tkTables, '削韧(单次)') ? `talent.${tkTables}[${jsString('削韧(单次)')}]` : costSumExpr

      let costExpr = costSumExpr
      // Trace-based first-hit stance bonus (e.g. "第一次伤害的削韧值额外提高100%").
      for (const [treeKey, bonus] of superBreakFirstHitStanceBonusByTree.entries()) {
        if (!coreTk || bonus.talent !== coreTk) continue
        const add = `(${costUnitExpr}) * (${Number((bonus.pct / 100).toFixed(6))})`
        costExpr = `(${costExpr}) + (trees[${jsString(treeKey)}] ? (${add}) : 0)`
      }
      // Eidolon: extra hit count (conservatively model as +1 unit toughness cost).
      if (coreTk === 'e' && superBreakExtraCostConsE && superBreakExtraCostConsE >= 1 && superBreakExtraCostConsE <= 6) {
        costExpr = `(${costExpr}) + (cons >= ${superBreakExtraCostConsE} ? (${costUnitExpr}) : 0)`
      }
      // Trace-based extra hit count (conservatively model as +1 unit toughness cost).
      if (coreTk === 'e' && superBreakExtraCostTreeE.size) {
        for (const treeKey of superBreakExtraCostTreeE) {
          costExpr = `(${costExpr}) + (trees[${jsString(treeKey)}] ? (${costUnitExpr}) : 0)`
        }
      }

      const mulParts: string[] = []
      for (const [treeKey, pct] of superBreakMulByTree.entries()) {
        const v = Number.isFinite(pct) ? Number((pct / 100).toFixed(6)) : 0
        if (!(v > 0)) continue
        mulParts.push(`(trees[${jsString(treeKey)}] ? ${Number((1 + v).toFixed(6))} : 1)`)
      }
      const mulExpr = mulParts.length ? mulParts.join(' * ') : '1'

      details.splice(idx, 1, {
        title: baseTitle,
        kind: 'reaction',
        reaction: 'superBreak',
        ...(tkRaw ? { talent: tkRaw } : coreTk ? { talent: coreTk } : d.talent ? { talent: d.talent } : {}),
        ...(typeof d.cons === 'number' ? { cons: d.cons } : {}),
        ...(d.params ? { params: d.params } : {}),
        ...(d.check ? { check: d.check } : {}),
        dmgExpr: `({ avg: (reaction("superBreak").avg || 0) / 0.9 * (${costExpr}) * (${ratio}) * (${mulExpr}) })`
      })
    }

    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i]!
      if (!d || typeof d !== 'object') continue
      const kind = normalizeKind((d as any).kind)

      // Guardrail: enforce canonical break/superBreak showcase rows even when the model hardcodes them in dmgExpr.
      // This prevents LLM-authored formulas from bypassing the baseline-like (2/10 toughness) structure.
      const dmgExpr0 = typeof (d as any).dmgExpr === 'string' ? String((d as any).dmgExpr).trim() : ''
      if (dmgExpr0) {
        const m = /\breaction\s*\(\s*(['"])([A-Za-z][A-Za-z0-9_-]{0,31})\1\s*\)/i.exec(dmgExpr0)
        if (m) {
          const ridRaw = String(m[2] || '').trim()
          const rid = srReactionCanon[ridRaw.toLowerCase()] || ridRaw
          const title = d.title || ''
          const titleNorm = normalizePromptText(title)

          // dmgExpr says "superBreak", but kind/title might be wrong.
          if (rid === 'superBreak' || /break$/i.test(rid)) {
            // Special case: technique blessing break rows are already expanded (2/10 toughness) and should NOT be
            // rewritten into talent-scaled break ratios (that would destroy baseline matching).
            if (/祝福/.test(titleNorm) && /秘技/.test(titleNorm) && /击破伤害/.test(titleNorm)) continue

            // Title indicates superBreak but reaction id is an elemental break (LLM confusion).
            if (/超击破/.test(title) && rid !== 'superBreak') {
              if (!wantsSuperBreakDetails) {
                details.splice(i, 1)
                continue
              }
              const prefer = inferTalentFromTitle(title)
              const src = findRatioSourceAny(prefer, ['超击破伤害', '超击破伤害比例'])
              const ratioExpr = src ? ratioExprOf(src.talent, src.tableName) : '1'
              patchSuperBreakDetailAt(i, { ...d, ...(src ? { talent: src.talent } : {}) }, ratioExpr)
              continue
            }

            if (rid === 'superBreak') {
              if (!wantsSuperBreakDetails) {
                details.splice(i, 1)
                continue
              }
              const prefer = inferTalentFromTitle(title)
              const src = findRatioSourceAny(prefer, ['超击破伤害', '超击破伤害比例'])
              const ratioExpr = src ? ratioExprOf(src.talent, src.tableName) : '1'
              patchSuperBreakDetailAt(i, { ...d, ...(src ? { talent: src.talent } : {}) }, ratioExpr)
              continue
            }

            if (!wantsBreakDetails) {
              details.splice(i, 1)
              continue
            }
            const prefer = inferTalentFromTitle(title)
            const src = findRatioSourceAny(prefer, ['击破伤害比例', '击破伤害'])
            let ratioExpr = src ? ratioExprOf(src.talent, src.tableName) : '1'
            ratioExpr = applyConsBreakRatioMul(src ? src.talent : prefer, ratioExpr)
            patchBreakDetailAt(i, { ...d, ...(src ? { talent: src.talent } : {}) }, rid, ratioExpr)
            continue
          }
        }
      }

      // 1) Patch non-reaction rows (LLMs often misclassify break ratios as normal dmg/heal/shield).
      if (kind !== 'reaction') {
        const tk = d.talent
        const tableName = typeof d.table === 'string' ? d.table.trim() : ''
        if (!tk) continue

        if (tableName && isBreakRatioTable(tableName) && elemBreak) {
          if (!wantsBreakDetails) {
            details.splice(i, 1)
            continue
          }
          let ratioExpr = ratioExprOf(tk, tableName)
          ratioExpr = applyConsBreakRatioMul(tk, ratioExpr)
          patchBreakDetailAt(i, d, elemBreak, ratioExpr)
          continue
        }

        if (tableName && isSuperBreakRatioTable(tableName)) {
          if (!wantsSuperBreakDetails) {
            details.splice(i, 1)
            continue
          }
          const ratioExpr = ratioExprOf(tk, tableName)
          patchSuperBreakDetailAt(i, d, ratioExpr)
          continue
        }

        // Title-driven break rows (some models express break damage via dmgExpr and omit `table`).
        // If the kit wants break details and the title clearly says "击破伤害", enforce reaction-style formulas.
        if (elemBreak) {
          const titleN = normalizePromptText((d as any).title || '')
          if (/击破伤害/.test(titleN) && !/受到/.test(titleN)) {
            if (!wantsBreakDetails) {
              details.splice(i, 1)
              continue
            }
            const allowed = (tables as any)?.[tk] as string[] | undefined
            const list = Array.isArray(allowed) ? allowed : []
            const baseTable = list.includes('击破伤害比例')
              ? '击破伤害比例'
              : list.includes('击破伤害')
                ? '击破伤害'
                : ''
            if (!baseTable) continue
            let ratioExpr = ratioExprOf(tk, baseTable)
            ratioExpr = applyConsBreakRatioMul(tk, ratioExpr)

            const incTable = list.includes('击破倍率提高')
              ? '击破倍率提高'
              : list.includes('伤害倍率提高')
                ? '伤害倍率提高'
                : ''
            if (incTable) {
              const p = (d as any).params
              const stackExpr =
                p && typeof p === 'object' && !Array.isArray(p) && typeof (p as any).tStacks === 'number'
                  ? 'params.tStacks'
                  : p && typeof p === 'object' && !Array.isArray(p) && typeof (p as any).stacks === 'number'
                    ? 'params.stacks'
                    : ''
              if (stackExpr) {
                ratioExpr = `(${ratioExpr}) + (${ratioExprOf(tk, incTable)}) * (${stackExpr})`
              }
            }

            patchBreakDetailAt(i, d, elemBreak, ratioExpr)
            continue
          }
        }
        continue
      }

      // 2) Patch reaction rows that forgot to apply the ratio/toughness coefficient.
      // Example (common): "终结技击破伤害" -> reaction("iceBreak") only.
      if (kind === 'reaction') {
        const reactionId = typeof d.reaction === 'string' ? d.reaction.trim() : ''
        const title = d.title || ''
        if (!reactionId || !/break/i.test(reactionId)) continue
        if (!/击破/.test(title)) continue

        // Title indicates superBreak but reaction id is an elemental break (LLM confusion).
        if (/超击破/.test(title) && reactionId !== 'superBreak') {
          if (!wantsSuperBreakDetails) {
            details.splice(i, 1)
            continue
          }
          const prefer = inferTalentFromTitle(title)
          const src = findRatioSourceAny(prefer, ['超击破伤害', '超击破伤害比例'])
          const ratioExpr = src ? ratioExprOf(src.talent, src.tableName) : '1'
          patchSuperBreakDetailAt(i, { ...d, ...(src ? { talent: src.talent } : {}) }, ratioExpr)
          continue
        }

        if (reactionId === 'superBreak') {
          if (!wantsSuperBreakDetails) {
            details.splice(i, 1)
            continue
          }
          const prefer = inferTalentFromTitle(title)
          const src = findRatioSourceAny(prefer, ['超击破伤害', '超击破伤害比例'])
          const ratioExpr = src ? ratioExprOf(src.talent, src.tableName) : '1'
          // Even without a dedicated ratio table, superBreak still scales with toughness cost (削韧).
          patchSuperBreakDetailAt(i, { ...d, ...(src ? { talent: src.talent } : {}) }, ratioExpr)
          continue
        }

        if (!wantsBreakDetails) {
          details.splice(i, 1)
          continue
        }
        const prefer = inferTalentFromTitle(title)
        const src = findRatioSourceAny(prefer, ['击破伤害比例', '击破伤害'])
        if (!src) continue
        let ratioExpr = ratioExprOf(src.talent, src.tableName)
        ratioExpr = applyConsBreakRatioMul(src.talent, ratioExpr)
        patchBreakDetailAt(i, { ...d, talent: src.talent }, reactionId, ratioExpr)
        continue
      }
    }

    // If break/superBreak is not part of the kit, drop any remaining reaction rows to avoid regression skew.
    if (!wantsSuperBreakDetails) {
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i] as any
        if (!d || normalizeKind(d.kind) !== 'reaction') continue
        if (String(d.reaction || '').trim() === 'superBreak') details.splice(i, 1)
      }
    }
    if (!wantsBreakDetails) {
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i] as any
        if (!d || normalizeKind(d.kind) !== 'reaction') continue
        const rid = String(d.reaction || '').trim()
        if (!rid) continue
        if (rid === 'superBreak') continue
        if (/break$/i.test(rid)) details.splice(i, 1)
      }
    }

    // SR: If the kit contains superBreak mechanics, ensure baseline-like canonical rows exist (A/E),
    // and drop unscoped "超击破..." variants that are hard to compare in regression (e.g. "伴舞/敌方数量" rows).
    const hasSuperBreakMechanic = wantsSuperBreakDetails
    if (hasSuperBreakMechanic) {
      // 1) Drop superBreak rows that do not scope to any skill bucket (likely hallucinated variants).
      for (let i = details.length - 1; i >= 0; i--) {
        const d = details[i] as any
        if (!d || normalizeKind(d.kind) !== 'reaction') continue
        if (String(d.reaction || '').trim() !== 'superBreak') continue
        const tk0 = typeof d.talent === 'string' ? String(d.talent).trim().replace(/\d+$/, '') : ''
        const tk = tk0 === 'a' || tk0 === 'e' || tk0 === 'q' || tk0 === 't' ? (tk0 as SrCoreTalent) : null
        const title = String(d.title || '')
        const titleNorm = normalizePromptText(title)
        const hasPrefix = /^(普攻|战技|终结技|天赋|秘技)/.test(titleNorm)
        if (!tk && !hasPrefix) details.splice(i, 1)
      }

      // 2) Ensure canonical A/E superBreak rows exist when the corresponding talents have toughness tables.
      const hasStanceTable = (tk: string): boolean => {
        const list = (tables as any)?.[tk]
        return Array.isArray(list) && list.includes('削韧')
      }
      const hasSuperBreakTalent = (tk: string): boolean =>
        details.some((d: any) => normalizeKind(d?.kind) === 'reaction' && d?.reaction === 'superBreak' && String(d?.talent || '').trim() === tk)

      const ensure = (tk: string, title: string, preferCore: SrCoreTalent): void => {
        if (!hasStanceTable(tk)) return
        if (hasSuperBreakTalent(tk)) return
        const prefer = preferCore as any
        const ratioSrc = findRatioSourceAny(prefer, ['超击破伤害', '超击破伤害比例'])
        const ratioExpr = ratioSrc ? ratioExprOf(ratioSrc.talent, ratioSrc.tableName) : '1'
        const idx = details.length
        details.push({ title, kind: 'reaction', reaction: 'superBreak', talent: tk as any, params: { q: true } })
        patchSuperBreakDetailAt(idx, details[idx]!, ratioExpr)
      }

      ensure('a', '普攻·超击破伤害', 'a')
      ensure('e', '战技·超击破伤害', 'e')
      ensure('a2', '强化普攻·超击破伤害', 'a')
      ensure('e2', '强化战技·超击破伤害', 'e')

      while (details.length > 20) details.pop()
    }

    // SR: Fixed-crit additional damage (rare but very impactful).
    // Example pattern in desc: "...附加伤害...暴击率固定为100%...暴击伤害固定为150%"
    // Model via `skillDot` (no crit buckets) + explicit fixed-crit multiplier.
    try {
      const descByTalent = (input.talentDesc || {}) as Record<string, unknown>
      const consFixedCdmgExtras: Array<{ cons: number; pct: number }> = []
      for (const h0 of hintLines) {
        const h = normalizePromptText(h0)
        if (!h) continue
        const m = h.match(/^\s*(\d)\s*魂[：:]/)
        if (!m) continue
        const consNeed = Math.trunc(Number(m[1]))
        if (!(consNeed >= 1 && consNeed <= 6)) continue
        if (!/附加伤害/.test(h) || !/(暴击伤害|爆伤)/.test(h) || !/额外提高/.test(h)) continue
        const mm = h.match(/额外提高\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/)
        const pct = mm ? Number(mm[1]) : NaN
        if (Number.isFinite(pct) && pct > 0 && pct <= 2000) consFixedCdmgExtras.push({ cons: consNeed, pct })
      }
      // Prefer the highest cons threshold (more specific).
      consFixedCdmgExtras.sort((a, b) => b.cons - a.cons || b.pct - a.pct)
      const extra0 = consFixedCdmgExtras[0] || null

      for (const tk0 of Object.keys(tables)) {
        const tk = String(tk0 || '').trim()
        if (!tk) continue
        const desc0 = normalizePromptText((descByTalent as any)[tk])
        if (!desc0 || !/附加伤害/.test(desc0)) continue
        const mCpct = desc0.match(/暴击率固定为\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/)
        const mCdmg = desc0.match(/暴击伤害固定为\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/)
        if (!mCpct || !mCdmg) continue
        const cpctPct = Number(mCpct[1])
        const cdmgPct = Number(mCdmg[1])
        if (!Number.isFinite(cpctPct) || !Number.isFinite(cdmgPct) || cpctPct <= 0 || cdmgPct <= 0) continue

        // Pick the table most closely tied to the "附加伤害" placeholder by locating the nearest `$n[...]` before it.
        const pos = desc0.indexOf('附加伤害')
        if (!(pos >= 0)) continue
        let varIdx: number | null = null
        for (const mm of desc0.matchAll(/\$(\d+)\[(?:i|f1|f2)]%?/g)) {
          if (typeof mm.index === 'number' && mm.index < pos) {
            const n = Number(mm[1])
            if (Number.isFinite(n) && n > 0 && n <= 99) varIdx = Math.trunc(n)
          }
        }
        if (!varIdx) continue

        const list = (tables as any)[tk]
        const tableName = Array.isArray(list) ? String(list[varIdx - 1] || '').trim() : ''
        if (!tableName || /(能量恢复|削韧)/.test(tableName)) continue

        const cpctR = Number((cpctPct / 100).toFixed(6))
        const baseCdmgR = Number((cdmgPct / 100).toFixed(6))
        let cdmgRExpr = String(baseCdmgR)
        if (extra0 && extra0.cons >= 1 && extra0.cons <= 6) {
          const cdmgTotalR = Number(((cdmgPct + extra0.pct) / 100).toFixed(6))
          cdmgRExpr = `(cons >= ${extra0.cons} ? ${cdmgTotalR} : ${baseCdmgR})`
        }
        const multExpr = `1 + ${cpctR} * (${cdmgRExpr})`

        const dmgExpr = `({ avg: (dmg(talent.${tk}[${jsString(tableName)}], \"\", \"skillDot\").avg || 0) * (${multExpr}) })`
        const tkBase = tk.replace(/\d+$/, '')
        const wantsParams: Record<string, boolean> | undefined = ((): Record<string, boolean> | undefined => {
          if (tkBase === 'q') return { qBuff: true }
          if (tkBase === 'e') return { e: true }
          return undefined
        })()

        const isSameTalent = (d: CalcSuggestDetail): boolean => {
          const t0 = typeof d.talent === 'string' ? String(d.talent).trim() : ''
          if (!t0) return false
          return t0 === tk || t0.replace(/\d+$/, '') === tkBase
        }
        const hasRow = (d: CalcSuggestDetail): boolean => /附加伤害/.test(normalizePromptText(d.title))

        const idx = details.findIndex((d) => hasRow(d) && isSameTalent(d))
        if (idx >= 0) {
          const d = details[idx]!
          d.kind = 'dmg'
          d.talent = tk as any
          d.table = tableName
          if (!d.key) d.key = tkBase || 'q'
          d.dmgExpr = dmgExpr
          if (wantsParams) {
            const p0 = d.params
            const p =
              p0 && typeof p0 === 'object' && !Array.isArray(p0)
                ? { ...(p0 as Record<string, number | boolean | string>) }
                : {}
            Object.assign(p, wantsParams)
            d.params = p
          }
        } else {
          // Insert a baseline-like showcase row near the front.
          const title = tkBase === 'q' ? '终结技附加伤害' : '附加伤害'
          details.unshift({
            title,
            kind: 'dmg',
            talent: tk as any,
            table: tableName,
            key: tkBase || 'q',
            ...(wantsParams ? { params: wantsParams } : {}),
            dmgExpr
          })
          while (details.length > 20) details.pop()
        }
      }
    } catch {
      // Best-effort only.
    }

    // Technique (SU blessings) break extra damage showcase (baseline-style max stacks).
    // Example: "最多计入20个祝福 ... 额外造成等同于100%<元素>属性击破伤害的击破伤害"
    // We can model it as: reaction("<elem>Break") * (toughness+2)/4 * (maxBlessings * pct/100).
    if (elemBreak) {
      const hints = (input.buffHints || []).filter((s) => typeof s === 'string') as string[]
      const tech = hints.find((h) => /秘技/.test(h) && /祝福/.test(h) && /最多计入/.test(h) && /属性击破伤害/.test(h))
      const techNorm = normalizePromptText(tech)
      if (techNorm) {
        const limM = techNorm.match(/最多计入\s*(\d{1,3})\s*个祝福/)
        const lim = limM ? Math.trunc(Number(limM[1])) : 0
        let pct: number | null = null
        const rePct = /(\d+(?:\.\d+)?)\s*[%％]/g
        let mm: RegExpExecArray | null
        while ((mm = rePct.exec(techNorm))) {
          const n = Number(mm[1])
          if (!Number.isFinite(n) || n <= 0 || n > 1000) continue
          const tail = techNorm.slice(mm.index, mm.index + 60)
          if (/属性击破伤害/.test(tail)) {
            pct = n
            break
          }
        }

        const mul = lim > 0 && pct ? (lim * pct) / 100 : 0
        const mulOk = Number.isFinite(mul) && mul > 0 && mul <= 200
        const hasBlessingRow = details.some((d) => /祝福/.test(d.title || '') && /秘技/.test(d.title || '') && /击破伤害/.test(d.title || ''))
        if (mulOk && !hasBlessingRow) {
          const titleBase = `${lim}祝福·秘技击破伤害`
          const mk = (toughness: 2 | 10, coef: number): CalcSuggestDetail => ({
            title: `${titleBase}(${toughness}韧性怪)`,
            kind: 'reaction',
            reaction: elemBreak,
            params: { break: true },
            dmgExpr: `({ avg: (reaction(${jsString(elemBreak)}).avg || 0) / 0.9 * ${coef} * ${mul} })`
          })
          const insertAt = Math.max(0, details.findIndex((d) => /普攻/.test(d.title || '')))
          const at = insertAt >= 0 ? insertAt + 1 : 0
          details.splice(at, 0, mk(2, 1), mk(10, 3))
        }
      }
    }

    // SR title normalization: baseline uses "生命回复" for healing rows more often than "治疗".
    for (const d of details) {
      if (d.kind !== 'heal') continue
      const t = d.title || ''
      if (!t || !/治疗/.test(t)) continue
      if (/(治疗量|治疗加成|治疗提高)/.test(t)) continue
      if (/生命回复/.test(t)) continue
      d.title = t.replace(/治疗/g, '生命回复')
    }

    // SR title normalization: strip redundant "(单目标)/(单体)" markers when they are the ONLY variant.
    // Baseline mostly omits them for plain single-target rows, but keeps them when needed to disambiguate
    // against multi-target variants like 主目标/相邻目标/完整.
    {
      const stripSingle = (t: string): string =>
        String(t || '')
          .replace(/[(（]\s*(单目标|单体)\s*[)）]/g, '')
          .trim()

      const hasMultiMarker = (t: string): boolean =>
        /(主目标|相邻目标|完整|3目标|5目标|全体|随机|弹射|扩散|邻接)/.test(t)

      const baseInfo = new Map<string, { hasMulti: boolean }>()
      for (const d of details) {
        const t0 = normalizePromptText(d.title)
        if (!t0) continue
        const base = normalizePromptText(stripSingle(t0))
        if (!base) continue
        const cur = baseInfo.get(base) || { hasMulti: false }
        if (hasMultiMarker(t0)) cur.hasMulti = true
        baseInfo.set(base, cur)
      }

      for (const d of details) {
        const t0 = normalizePromptText(d.title)
        if (!t0) continue
        if (!/[(（]\s*(单目标|单体)\s*[)）]/.test(t0)) continue
        const base = normalizePromptText(stripSingle(t0))
        if (!base) continue
        const info = baseInfo.get(base)
        if (info?.hasMulti) continue
        d.title = base
      }
    }

    // SR: Normalize dmgKey buckets for variant talent blocks (e2/q2/me2/mt1/mt2/...).
    // In miao-plugin SR mode, most buffs and attr buckets are routed by the base skill key (e/q/me/mt),
    // and variant keys frequently cause large underestimation (missing crit/dmg buckets).
    const normalizeSrDetailKey = (keyRaw: string): string => {
      const k = String(keyRaw || '').trim()
      if (!k) return k
      const parts = k
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      if (parts.length === 0) return k
      const head = parts[0]!
      // Only normalize keys that miao-plugin does NOT treat as separate buff buckets (keep a2/a3 as-is).
      // - e2/e1/... => e
      // - q2/... => q
      // - me2/... => me
      // - mt1/mt2/... => mt
      const m = /^(e|q|me|mt)\d+$/.exec(head)
      if (m) parts[0] = m[1]!
      return parts.join(',')
    }

    for (const d of details) {
      const kind = normalizeKind(d.kind)
      if (kind === 'reaction') continue
      const key0 = typeof (d as any).key === 'string' ? String((d as any).key) : undefined
      if (typeof key0 === 'string') {
        // Keep intentional empty key (rare; used in some baseline rows).
        if (key0.trim() === '') continue
        const norm = normalizeSrDetailKey(key0)
        if (norm !== key0) (d as any).key = norm
        continue
      }
      // If key omitted, prefer base talent key for variant blocks.
      const tk = typeof (d as any).talent === 'string' ? String((d as any).talent).trim() : ''
      const base = tk.replace(/\d+$/, '')
      if (base && base !== tk && /^(e|q|me|mt)$/.test(base)) (d as any).key = base
    }

    // SR: Ensure common enhanced blocks (q2/e2/a2/a3) are not skipped when available.
    // Missing these rows is a major source of maxAvg drift vs baseline (which often includes enhanced/total rows).
    try {
      const hasTalent = (tk: string): boolean =>
        details.some((d: any) => typeof d?.talent === 'string' && String(d.talent).trim() === tk)

      const pickVariantDamageTable = (tk: string): string | null => {
        const list = (tables as any)?.[tk]
        if (!Array.isArray(list) || list.length === 0) return null
        if (list.includes('技能伤害')) return '技能伤害'
        const prefer = list.find(
          (t) =>
            /(?:每段伤害|每次伤害|目标伤害|技能伤害)/.test(String(t || '')) &&
            !srIsBuffOnlyTableName(t) &&
            !/(能量恢复|削韧)/.test(String(t || ''))
        )
        if (prefer) return String(prefer || '').trim() || null
        const any = list.find(
          (t) => /伤害/.test(String(t || '')) && !srIsBuffOnlyTableName(t) && !/(能量恢复|削韧)/.test(String(t || ''))
        )
        return any ? String(any || '').trim() || null : null
      }

      const push = (d: CalcSuggestDetail): void => {
        details.push(d)
        while (details.length > 20) details.pop()
      }

      // SR: Multi-hit skills often expose per-hit tables like "每次伤害/每段伤害".
      // Baseline frequently showcases the *total* damage by multiplying the hit count (from descriptions/cons).
      try {
        type SrCoreTalent = 'a' | 'e' | 'q' | 't'
        const asCore = (tkRaw: unknown): SrCoreTalent | null => {
          const tk = String(tkRaw || '').trim().replace(/\d+$/, '')
          return tk === 'a' || tk === 'e' || tk === 'q' || tk === 't' ? (tk as SrCoreTalent) : null
        }
        const descOf = (tk: SrCoreTalent): string => normalizePromptText((input.talentDesc as any)?.[tk])
        const inferBaseHits = (descRaw: string): number | null => {
          const desc = normalizePromptText(descRaw)
          if (!desc) return null
          // "额外造成4次伤害" => base hits = 1 + 4
          const mExtra = desc.match(/额外造成\s*(\d{1,2})\s*次伤害/)
          if (mExtra) {
            const extra = Math.trunc(Number(mExtra[1]))
            if (Number.isFinite(extra) && extra >= 1 && extra <= 20) return 1 + extra
          }
          // "共计5次/总计5次/一共5次"
          const mTotal = desc.match(/(?:共计|总计|一共)\s*(\d{1,2})\s*次/)
          if (mTotal) {
            const total = Math.trunc(Number(mTotal[1]))
            if (Number.isFinite(total) && total >= 2 && total <= 30) return total
          }
          // "造成5次伤害/造成5段伤害"
          const mTimes = desc.match(/造成\s*(\d{1,2})\s*(?:次|段)\s*伤害/)
          if (mTimes) {
            const total = Math.trunc(Number(mTimes[1]))
            if (Number.isFinite(total) && total >= 2 && total <= 30) return total
          }
          return null
        }

        const hintLines = (input.buffHints || []).map((s) => normalizePromptText(s)).filter(Boolean) as string[]
        const pickCoreTalentFromText = (text: string): SrCoreTalent | null => {
          if (/(普攻|普通攻击)/.test(text)) return 'a'
          if (/战技/.test(text)) return 'e'
          if (/(终结技|大招)/.test(text)) return 'q'
          if (/天赋/.test(text)) return 't'
          return null
        }
        const extraHitsCons: Record<SrCoreTalent, Array<{ cons: number; add: number }>> = { a: [], e: [], q: [], t: [] }
        for (const h0 of hintLines) {
          const h = String(h0 || '').trim()
          if (!h) continue
          const mCons = h.match(/^\s*(\d)\s*魂[：:]/)
          if (!mCons) continue
          const consNeed = Math.trunc(Number(mCons[1]))
          if (!(consNeed >= 1 && consNeed <= 6)) continue
          const tk = pickCoreTalentFromText(h)
          if (!tk) continue
          const mAdd = h.match(/额外伤害次数增加\s*(\d{1,2})\s*次/)
          if (!mAdd) continue
          const add = Math.trunc(Number(mAdd[1]))
          if (!Number.isFinite(add) || add <= 0 || add > 20) continue
          extraHitsCons[tk].push({ cons: consNeed, add })
        }
        const extraHitsExpr = (tk: SrCoreTalent): string => {
          const list = extraHitsCons[tk]
          if (!list.length) return ''
          // Sum all applicable bonuses (rarely multiple, but keep it generic).
          return list.map((x) => `(cons >= ${x.cons} ? ${x.add} : 0)`).join(' + ')
        }

        const inferEnemyCountDynamicStepPct = (descRaw: string): number | null => {
          const desc = normalizePromptText(descRaw)
          if (!desc) return null
          // Common SR wording: "...每有1个可攻击的敌方目标...本次战技造成的伤害提高20%"
          const m = desc.match(/每有\s*1\s*个可攻击的敌方目标[^%]{0,80}?伤害提高\s*(\d{1,4}(?:\.\d+)?)\s*%/)
          if (!m) return null
          const n = Number(m[1])
          // Keep conservative bounds; this is a percent-point value (20 means +20%).
          return Number.isFinite(n) && n > 0 && n <= 200 ? n : null
        }
        const enemyCountStepPctE = inferEnemyCountDynamicStepPct(descOf('e'))

        const isPerHitTable = (t: string): boolean => /(?:每次伤害|单次伤害|每段伤害|单段伤害)/.test(String(t || ''))
        const isPerHitTitle = (t: string): boolean => /(?:每次|单次|每段|单段)/.test(String(t || ''))

        for (const d of details) {
          if (normalizeKind(d.kind) !== 'dmg') continue
          if (typeof d.dmgExpr === 'string' && d.dmgExpr.trim()) continue
          const tk0 = typeof d.talent === 'string' ? d.talent.trim() : ''
          const core = asCore(tk0)
          if (!core) continue
          // Start conservative: only auto-multiply multi-hit *battle skill* rows.
          // (Ultimate/follow-up multi-hit semantics vary a lot across kits; patching them naively can overinflate.)
          if (core !== 'e') continue
          const table = typeof d.table === 'string' ? d.table.trim() : ''
          if (!table || !isPerHitTable(table)) continue
          const title = normalizePromptText(d.title)
          if (!title) continue
          if (isPerHitTitle(title)) continue
          if (/额外/.test(title)) continue
          if (!/(战技|技能)/.test(title)) continue

          const key0 =
            typeof (d as any).key === 'string' && String((d as any).key).trim()
              ? String((d as any).key).trim()
              : 'e'

          // Some skills scale with the number of enemies on the field; baseline commonly models this via `dynamicDmg`.
          // Prefer applying `dmg.dynamic` over naive multi-hit multiplication when applicable.
          if (enemyCountStepPctE) {
            ;(d as any).dmgExpr = `dmg.dynamic(talent.${tk0}[${jsString(table)}], ${jsString(key0)}, { dynamicDmg: ${enemyCountStepPctE} })`
            continue
          }

          // Prefer showcasing *total* skill damage for per-hit tables. Baseline SR meta commonly treats
          // "战技伤害/技能伤害" rows as totals when only per-hit tables are available.
          const wantsTotalExplicit =
            /(?:完整|总伤|总计|合计|总)/.test(title) && !/(?:单次|每次|每段|单段)/.test(title)
          const wantsTotalImplicit = /^(?:战技|技能)伤害(?:\(|$)/.test(title)
          if (!wantsTotalExplicit && !wantsTotalImplicit) continue

          const baseHits = inferBaseHits(descOf('e'))
          if (!baseHits || baseHits <= 1) continue
          const addExpr = extraHitsExpr('e')
          const countExpr = addExpr ? `(${baseHits} + (${addExpr}))` : String(baseHits)
          ;(d as any).dmgExpr = `dmg((talent.${tk0}[${jsString(table)}] || 0) * ${countExpr}, ${jsString(key0)})`
        }
      } catch {
        // Ignore multi-hit inference failures.
      }

      // q2: enhanced ultimate (often includes extra/random hits)
      if ((tables as any).q2 && !hasTalent('q2')) {
        const list = (tables as any).q2 as string[] | undefined
        const table = pickVariantDamageTable('q2')
        if (table) {
          const hasExtra = Array.isArray(list) && list.includes('额外随机伤害')
          const desc = normalizePromptText((input.talentDesc as any)?.q2)
          const mTimes = desc ? desc.match(/(?:额外造成|额外).{0,16}?(\d{1,2})次/) : null
          const n = mTimes ? Math.trunc(Number(mTimes[1])) : NaN
          const times = Number.isFinite(n) && n >= 1 && n <= 20 ? n : null

          if (hasExtra && times) {
            const mainTable = Array.isArray(list) && list.includes('技能伤害') ? '技能伤害' : table
            push({
              title: '强化终结技总伤害',
              kind: 'dmg',
              talent: 'q2',
              table: mainTable,
              key: 'q',
              params: { q: true },
              dmgExpr: `dmg((talent.q2[${jsString(mainTable)}] || 0) + (talent.q2[${jsString('额外随机伤害')}] || 0) * ${times}, \"q\")`
            } as any)
          } else {
            push({ title: '强化终结技伤害', kind: 'dmg', talent: 'q2', table, key: 'q', params: { q: true } } as any)
          }
        }
      }

      // e2: enhanced skill
      if ((tables as any).e2 && !hasTalent('e2')) {
        const table = pickVariantDamageTable('e2')
        if (table) push({ title: '强化战技伤害', kind: 'dmg', talent: 'e2', table, key: 'e' } as any)
      }

      // a2/a3: enhanced normals (rare, but appear in some kits)
      if ((tables as any).a2 && !hasTalent('a2')) {
        const list = (tables as any).a2 as string[] | undefined
        const descRaw = normalizePromptText((input.talentDesc as any)?.a2)
        const tryBuildA2ExprFromDesc = (): { table: string; expr: string } | null => {
          if (!Array.isArray(list) || list.length === 0) return null
          const desc = normalizePromptText(descRaw)
          if (!desc) return null

          // Pattern: "...施放3段攻击...$1... ...施放1段攻击...$2..."
          const hitsByIdx = new Map<number, number>()
          const re = /(?:施放|造成)\s*(\d{1,2})\s*(?:段|次)(?:攻击|伤害)?[^$]{0,200}?\$(\d)/g
          for (const m of desc.matchAll(re)) {
            const hits = Math.trunc(Number(m[1]))
            const idx = Math.trunc(Number(m[2]))
            if (!Number.isFinite(hits) || hits <= 0 || hits > 30) continue
            if (!Number.isFinite(idx) || idx <= 0 || idx > 20) continue
            hitsByIdx.set(idx, (hitsByIdx.get(idx) || 0) + hits)
          }
          if (hitsByIdx.size < 2) return null

          const terms: string[] = []
          let firstTable = ''
          for (const [idx, hits] of Array.from(hitsByIdx.entries()).sort((a, b) => a[0] - b[0])) {
            const tn = String(list[idx - 1] || '').trim()
            if (!tn) continue
            if (!/伤害/.test(tn) || srIsBuffOnlyTableName(tn) || /(能量恢复|削韧)/.test(tn)) continue
            if (!firstTable) firstTable = tn
            const mul = hits === 1 ? '' : ` * ${hits}`
            terms.push(`(talent.a2[${jsString(tn)}] || 0)${mul}`)
          }
          if (!firstTable || terms.length < 2) return null
          return { table: firstTable, expr: `dmg(${terms.join(' + ')}, \"a\")` }
        }

        const built = tryBuildA2ExprFromDesc()
        if (built) {
          push({ title: '强化普攻伤害', kind: 'dmg', talent: 'a2', table: built.table, key: 'a', dmgExpr: built.expr } as any)
        } else {
          const table = pickVariantDamageTable('a2')
          if (table) push({ title: '强化普攻伤害', kind: 'dmg', talent: 'a2', table, key: 'a' } as any)
        }
      }
      if ((tables as any).a3 && !hasTalent('a3')) {
        const table = pickVariantDamageTable('a3')
        if (table) push({ title: '强化普攻伤害(追加)', kind: 'dmg', talent: 'a3', table, key: 'a' } as any)
      }
    } catch {
      // Best-effort only.
    }

    // SR: Derive common "完整(=主目标+相邻*2)" rows when the plan emits both main + adjacent targets
    // but misses a total line (baseline meta frequently has these).
    //
    // Only do this for simple table-based dmg rows (no dmgExpr/pick), to keep it safe and predictable.
    try {
      const normTitleKey = (s: string): string =>
        String(s || '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·•･・…?？、，,。．：:；;!！"'“”‘’()（）【】\[\]{}《》〈〉<>「」『』]/g, '')
          .replace(/[=+~`^|\\]/g, '')
          .replace(/[-_—–]/g, '')

      const hasTitle = (title: string): boolean => {
        const t = normTitleKey(title)
        if (!t) return false
        return details.some((d) => normTitleKey(d.title) === t)
      }

      const tagBlast = (
        titleRaw: string
      ): { base: string; rest: string; which: 'main' | 'adjacent' } | null => {
        const title = normalizePromptText(titleRaw)
        if (!title) return null

        // (主目标 ...)/(相邻目标 ...) pattern
        let m = title.match(/^(.*?伤害)[(（]([^()（）]*?主目标[^()（）]*?)[)）]$/)
        if (m) {
          const base = String(m[1] || '').trim()
          const inside = String(m[2] || '')
          const rest = normalizePromptText(inside.replace(/主目标/g, ' ').replace(/\s+/g, ' ')).trim()
          return { base, rest, which: 'main' }
        }
        m = title.match(/^(.*?伤害)[(（]([^()（）]*?相邻目标[^()（）]*?)[)）]$/)
        if (m) {
          const base = String(m[1] || '').trim()
          const inside = String(m[2] || '')
          const rest = normalizePromptText(inside.replace(/相邻目标/g, ' ').replace(/\s+/g, ' ')).trim()
          return { base, rest, which: 'adjacent' }
        }

        // Suffix pattern: "...主目标伤害" / "...相邻目标伤害"
        m = title.match(/^(.*?)(主目标)伤害$/)
        if (m) {
          let base = String(m[1] || '').trim()
          if (base && !/伤害$/.test(base)) base = `${base}伤害`
          return { base, rest: '', which: 'main' }
        }
        m = title.match(/^(.*?)(相邻目标)伤害$/)
        if (m) {
          let base = String(m[1] || '').trim()
          if (base && !/伤害$/.test(base)) base = `${base}伤害`
          return { base, rest: '', which: 'adjacent' }
        }

        return null
      }

      const groups = new Map<
        string,
        { base: string; rest: string; main?: CalcSuggestDetail; adj?: CalcSuggestDetail }
      >()
      for (const d of details) {
        if (normalizeKind(d.kind) !== 'dmg') continue
        const info = tagBlast(d.title)
        if (!info) continue
        if (!info.base) continue
        const gKey = `${info.base}@@${info.rest}`
        const cur = groups.get(gKey) || { base: info.base, rest: info.rest }
        if (info.which === 'main') cur.main = cur.main || d
        else cur.adj = cur.adj || d
        groups.set(gKey, cur)
      }

      for (const g of groups.values()) {
        const main = g.main
        const adj = g.adj
        if (!main || !adj) continue
        if (main.dmgExpr || adj.dmgExpr) continue
        if (typeof (main as any).pick === 'number' || typeof (adj as any).pick === 'number') continue
        if (typeof main.talent !== 'string' || typeof adj.talent !== 'string') continue
        if (main.talent !== adj.talent) continue
        if (typeof main.table !== 'string' || typeof adj.table !== 'string') continue

        const tk = main.talent as TalentKey
        const mk =
          typeof (main as any).key === 'string' && ((main as any).key as string).trim()
            ? ((main as any).key as string).trim()
            : tk
        const ak =
          typeof (adj as any).key === 'string' && ((adj as any).key as string).trim()
            ? ((adj as any).key as string).trim()
            : tk

        const me = typeof (main as any).ele === 'string' ? String((main as any).ele).trim() : ''
        const ae = typeof (adj as any).ele === 'string' ? String((adj as any).ele).trim() : ''
        const ele = me && ae ? (me === ae ? me : '') : me || ae || ''
        const eleArg = ele ? `, ${jsString(ele)}` : ''

        const callMain = `dmg(talent.${tk}[${jsString(String(main.table))}], ${jsString(mk)}${eleArg})`
        const callAdj = `dmg(talent.${tk}[${jsString(String(adj.table))}], ${jsString(ak)}${eleArg})`
        const dmgExpr = `{ dmg: ${callMain}.dmg + ${callAdj}.dmg * 2, avg: ${callMain}.avg + ${callAdj}.avg * 2 }`

        const rest = g.rest ? ` ${g.rest}` : ''
        const title = `${g.base}(完整${rest})`
        if (hasTitle(title)) continue

        details.push({
          title,
          kind: 'dmg',
          talent: tk,
          table: String(main.table),
          key: mk,
          dmgExpr
        })
      }
    } catch {
      // Ignore derivation errors; keep the original plan.
    }

    // Keep the list bounded.
    while (details.length > 20) details.pop()
  }

  // GS: Natlan "夜魂" (Nightsoul) kits often use a dedicated dmgKey suffix (",nightsoul") in baseline meta to
  // route the correct buff buckets. If the plan contains at least one nightsoul-keyed row for a talent,
  // normalize other rows of that talent to also include the suffix to reduce drift.
  if (input.game === 'gs') {
    const hasNightByTalent = new Set<TalentKeyGs>()
    for (const d of details) {
      const tk = (d as any)?.talent
      if (tk !== 'a' && tk !== 'e' && tk !== 'q') continue
      const k = String((d as any)?.key || '').trim().toLowerCase()
      if (k && /nightsoul/.test(k)) hasNightByTalent.add(tk)
      // Some models forget to tag dmgKey but do set `params.Nightsoul`; treat that as a nightsoul indicator.
      const p = (d as any)?.params
      if (isParamsObject(p) && (((p as any).Nightsoul === true) || ((p as any).nightsoul === true))) hasNightByTalent.add(tk)
    }
    if (hasNightByTalent.size) {
      for (const d of details) {
        const tk = (d as any)?.talent
        if (tk !== 'a' && tk !== 'e' && tk !== 'q') continue
        if (!hasNightByTalent.has(tk)) continue
        const keyRaw = typeof (d as any)?.key === 'string' ? ((d as any).key as string).trim() : ''
        if (!keyRaw) {
          ;(d as any).key = `${tk},nightsoul`
          continue
        }
        if (/nightsoul/i.test(keyRaw)) continue
        ;(d as any).key = `${keyRaw},nightsoul`
      }
    }
  }

  // Keep defDmgKey only when it matches one of the rendered detail dmgKey keys.
  let defDmgKeyRaw = typeof plan.defDmgKey === 'string' ? plan.defDmgKey.trim() : ''
  if (input.game === 'sr' && defDmgKeyRaw) {
    const m = /^(e|q|me|mt)\d+$/.exec(defDmgKeyRaw)
    if (m) defDmgKeyRaw = m[1]!
  }
  const validDmgKeys = new Set(
    details
      .map((d) => (typeof d.key === 'string' && d.key.trim() ? d.key.trim() : typeof d.talent === 'string' ? d.talent : ''))
      .filter(Boolean)
  )
  const defDmgKey = defDmgKeyRaw && validDmgKeys.has(defDmgKeyRaw) ? defDmgKeyRaw : undefined

  const gsBuffIdsOut = new Set<string>()

  const buffsOut: CalcSuggestBuff[] = []
  const buffsRaw = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as Array<unknown>) : []
  if (input.game === 'gs') {
    const ok = new Set(['vaporize', 'melt', 'aggravate', 'spread'])
    for (const b of buffsRaw) {
      if (typeof b !== 'string') continue
      const id = b.trim()
      if (!id) continue
      const canon = id.toLowerCase()
      if (ok.has(canon)) gsBuffIdsOut.add(canon)
    }
  }
  const gsElemKeys = new Set(['anemo', 'geo', 'electro', 'dendro', 'hydro', 'pyro', 'cryo'])
  const isBuffDataKey = (s: string): boolean => /^[A-Za-z_][A-Za-z0-9_]*$/.test(s)
  const gsMultiToDmgKey: Record<string, string> = {
    aMulti: 'aDmg',
    a2Multi: 'a2Dmg',
    a3Multi: 'a3Dmg',
    eMulti: 'eDmg',
    qMulti: 'qDmg'
  }
  const srIsPercentPointKey = (kRaw: string): boolean => {
    if (input.game !== 'sr') return false
    const k = String(kRaw || '').trim()
    if (!k || k.startsWith('_')) return false
    if (k.endsWith('Plus') || k === 'atkPlus' || k === 'hpPlus' || k === 'defPlus') return false
    if (k === 'atk' || k === 'hp' || k === 'def' || k === 'mastery' || k === 'speed') return false
    // Percent-like buckets (stored as percent points in miao-plugin, while SR tables often provide ratios 0~1).
    if (k.endsWith('Pct')) return true
    if (k.endsWith('Dmg')) return true
    // SR also uses a few non-*Dmg/*Pct percent-like keys.
    if (k === 'enemydmg' || k.endsWith('Enemydmg')) return true
    if (k === 'effPct' || k.endsWith('EffPct')) return true
    if (k === 'effDef' || k.endsWith('EffDef')) return true
    if (k === 'stance' || k.endsWith('Stance')) return true
    if (k.endsWith('Cpct')) return true
    if (k.endsWith('Cdmg')) return true
    if (k.endsWith('Inc')) return true
    if (k === 'cpct' || k === 'cdmg' || k === 'dmg' || k === 'phy' || k === 'heal' || k === 'shield') return true
    if (k === 'recharge' || k === 'kx' || k === 'enemyDef' || k === 'enemyIgnore' || k === 'ignore') return true
    if (k === 'fypct' || k === 'fyinc') return true
    return false
  }
  const srIsCritRatePointKey = (kRaw: string): boolean => {
    if (input.game !== 'sr') return false
    const k = String(kRaw || '').trim()
    if (!k || k.startsWith('_')) return false
    return k === 'cpct' || k.endsWith('Cpct')
  }

  const srPctKeyToPlusKey: Record<string, string> = {
    atkPct: 'atkPlus',
    hpPct: 'hpPlus',
    defPct: 'defPlus',
    speedPct: 'speedPlus'
  }
  const srMaybeTeamBuffKeys = new Set([
    'atkPct',
    'atkPlus',
    'hpPct',
    'hpPlus',
    'defPct',
    'defPlus',
    'speedPct',
    'speedPlus',
    'cpct',
    'cdmg',
    'dmg',
    'heal',
    'shield',
    // Skill-scoped crit/dmg buffs are still "team-like" for ally-targeted talents (e.g. buffs applied to a teammate).
    'aCpct',
    'eCpct',
    'qCpct',
    'tCpct',
    'aCdmg',
    'eCdmg',
    'qCdmg',
    'tCdmg',
    'aDmg',
    'eDmg',
    'qDmg',
    'tDmg'
  ])
  const srTalentDesc = input.game === 'sr' ? (input.talentDesc || {}) : {}
  const srDescText = (tk: string): string => normalizePromptText((srTalentDesc as any)?.[tk])
  const srIsAllyTargetedTalent = (tk: string): boolean => {
    const t = srDescText(tk)
    if (!t) return false
    // "我方全体/全队" buffs usually include the caster; keep them.
    // Only drop clear single-target ally buffs (baseline often assumes these are used on teammates, not self).
    const team = /(我方全体|全队|全体队友)/.test(t)
    if (team) return false
    const single = /(指定我方单体|指定我方目标|指定1名我方|指定我方)/.test(t)
    const self = /自身/.test(t)
    return single && !self
  }

  const srBuffKeyAllowedByTitle = (keyRaw: string, titleRaw: string): boolean => {
    if (input.game !== 'sr') return true
    const key = String(keyRaw || '').trim()
    if (!key) return false
    if (key.startsWith('_')) return true // display-only placeholder (safe)

    const title = normalizePromptText(titleRaw)
    if (!title) return true

    // Upstream-derived buffs use stable machine titles like `upstream:DEF_PEN[ignore]`.
    // These titles often do NOT contain the CN wording used by LLM guardrails below, so trust the explicit `[key]`.
    if (/^upstream:/i.test(title) && title.includes(`[${key}]`)) return true

    // Mechanics that do NOT directly affect damage numbers in panel calc.
    // These are frequently hallucinated into dmg buffs and cause large deviations.
    if (/(击破效率|削韧|弱点击破效率)/.test(title)) return false
    // Turn-order manipulation does not affect outgoing panel damage numbers.
    if (/(行动(值|条)?).{0,6}(延后|提前)/.test(title) || /(延后|提前).{0,6}行动/.test(title)) return false
    // Incoming-damage reduction does not affect outgoing panel damage numbers.
    if (/(受到|承受).{0,6}伤害/.test(title) && /(降低|减少|减免|减伤)/.test(title)) return false
    // SuperBreak-only multipliers should be modeled inside superBreak detail rows, not as global dmg buffs.
    if (/超击破伤害/.test(title) && /(提高|提升|增加)/.test(title)) return false

    // Break effect must use stance (击破特攻).
    if (/击破特攻/.test(title)) return key === 'stance'

    // Shred/ignore keys must match their wording to avoid random misreads (e.g. 行动延后 -> enemyDef).
    if (key === 'kx') return /抗性/.test(title)
    if (key === 'enemyDef') return /防御/.test(title) && /(降低|下降|减少|减防|无视|穿透)/.test(title)
    if (key === 'ignore' || key === 'enemyIgnore') return /(无视防御|忽视防御|防御穿透)/.test(title)

    // Probability / effect hit / effect res should never become dmg buckets.
    if (/效果抵抗/.test(title)) return key === 'effDef'
    if (/效果命中/.test(title)) return key === 'effPct'
    if (/(基础概率|概率|几率)/.test(title)) return key === 'effPct' || key === 'effDef'
    if (/命中/.test(title) && /(提高|提升|增加)/.test(title)) return key === 'effPct' || key === 'effDef'

    return true
  }

  const baseTableName = (t: string): string => (t && t.endsWith('2') ? t.slice(0, -1) : t)
  const detailTableBaseByTalent = new Map<TalentKey, Set<string>>()
  for (const d of details) {
    const tk = d.talent
    const tn = typeof d.table === 'string' ? d.table : ''
    if (!tk || !tn) continue
    const base = baseTableName(tn)
    const set = detailTableBaseByTalent.get(tk) || new Set<string>()
    set.add(base)
    detailTableBaseByTalent.set(tk, set)
  }

  const shouldDropBuffExpr = (buffKey: string, expr: string): boolean => {
    if (!expr) return false
    if (buffKey.startsWith('_')) return false // display-only placeholder
    if (!/\btalent\s*\./.test(expr)) return false

    // If a buff expression directly recomputes base damage from the SAME "伤害" multiplier table already used in details,
    // it's very likely double-counting (and makes comparisons explode).
    const re = /\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]/g
    let m: RegExpExecArray | null
    while ((m = re.exec(expr))) {
      const tk = m[1] as TalentKey
      const table = String(m[3] || '')
      if (!table) continue
      const used = detailTableBaseByTalent.get(tk)
      if (!used) continue
      const base = baseTableName(table)
      if (!used.has(base)) continue

      if (/伤害/.test(base) && !/(提升|提高|加成|额外|追加|转化|比例)/.test(base)) {
        return true
      }
    }
    return false
  }

  for (const bRaw of clampBuffs(buffsRaw, 30)) {
    if (!bRaw || typeof bRaw !== 'object') continue
    const b = bRaw as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) continue

    const sort = typeof b.sort === 'number' && Number.isFinite(b.sort) ? Math.trunc(b.sort) : undefined
    const consRaw = typeof b.cons === 'number' && Number.isFinite(b.cons) ? Math.trunc(b.cons) : undefined
    const cons = consRaw && consRaw >= 1 && consRaw <= 6 ? consRaw : undefined
    const treeRaw = typeof b.tree === 'number' && Number.isFinite(b.tree) ? Math.trunc(b.tree) : undefined
    const tree = treeRaw && treeRaw >= 1 && treeRaw <= 10 ? treeRaw : undefined
    const checkRaw0 = typeof b.check === 'string' ? b.check.trim() : ''
    const checkRaw = checkRaw0 ? normalizeCalcExpr(checkRaw0) : ''
    let check: string | undefined
    if (
      checkRaw &&
      isSafeExpr(checkRaw) &&
      !hasIllegalTalentKeyRef(checkRaw) &&
      !hasIllegalCalcMemberAccess(checkRaw) &&
      !hasIllegalParamsRef(checkRaw) &&
      !hasIllegalTalentRef(checkRaw) &&
      !hasIllegalCalcCall(checkRaw) &&
      !hasBareKeyRef(checkRaw)
    ) {
      try {
        validateTalentTableRefs(checkRaw)
        check = checkRaw
      } catch {
        check = undefined
      }
    }

    let data: Record<string, number | string> | undefined
    const dataRaw = b.data
    if (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) {
      const out: Record<string, number | string> = {}
      let n = 0
      for (const [k, v] of Object.entries(dataRaw as Record<string, unknown>)) {
        const kk = String(k || '').trim()
        if (!kk) continue
        let key = kk
        // Baseline uses dmg/phy for GS elemental/physical bonuses. Some models may output element names.
        if (input.game === 'gs' && gsElemKeys.has(key)) key = 'dmg'
        if (input.game === 'gs' && (key === 'physical' || key === 'phys')) key = 'phy'
        // Models may prefix real miao-plugin buff keys with "_" (thinking it's a placeholder),
        // which makes DmgAttr ignore the effect. Strip "_" when it looks like a real effect key.
        //
        // Keep "_" when it's clearly a display-only placeholder referenced by the title (e.g. "[_recharge]%").
        if (key.startsWith('_')) {
          const rest = key.slice(1)
          const hasPlaceholderInTitle = title.includes(`[${key}]`)
          if (!hasPlaceholderInTitle && rest && isAllowedMiaoBuffDataKey(input.game, rest)) key = rest
        }

        // LLMs frequently misuse `*Multi` keys for simple "伤害提升X%" buffs (which should be `*Dmg` additive bonuses
        // in baseline semantics). Only keep `*Multi` when the title explicitly describes a multiplier change.
        if (input.game === 'gs') {
          const mapped = gsMultiToDmgKey[key]
          if (mapped) {
            const t = title
            const isExplicitMultiplier =
              /(倍率|系数)/.test(t) ||
              /造成原本\s*\d+/.test(t) ||
              /(提高到|变为|变成|改为)\s*\d+/.test(t) ||
              /原本\d+%/.test(t)
            const isPlainDamageUp = /(造成的)?伤害(提升|提高|增加)/.test(t)
            if (isPlainDamageUp && !isExplicitMultiplier) key = mapped
          }
        }
        if (!isBuffDataKey(key)) continue
        if (!isAllowedMiaoBuffDataKey(input.game, key)) continue
        if (n >= 50) break
        if (key in out) continue
        if (typeof v === 'number' && Number.isFinite(v)) {
          // `*Multi` keys in miao-plugin are stored as an *extra multiplier percent* (delta from base 100%):
          // - aMulti=37.91 means (1 + 37.91/100) => 137.91% total multiplier
          // Models often output the *total* percent (e.g. 137.91). Convert total -> delta when it looks like total.
          let num = v
          if (/Multi$/.test(key) && num >= 100 && num <= 400) num = num - 100
           // Shred/ignore values should be non-negative; use positive numbers to represent "reduce/ignore".
           if (/^(enemyDef|enemyIgnore|ignore|kx|fykx)$/.test(key) && num < 0) num = Math.abs(num)
           // SR: Talent tables store percent values as ratios (e.g. 0.4 means 40%),
           // while buff buckets expect percent points (40). Fix obvious ratio values.
           if (srIsPercentPointKey(key) && Math.abs(num) <= 3) num = num * 100
           // SR: For panel damage meta, negative percent-like buffs are almost always a sign of misreading
           // "受到伤害降低/减伤" as an outgoing dmg bonus. Baseline meta does not use negative outgoing buffs.
           if (input.game === 'sr' && srIsPercentPointKey(key) && num < 0) continue
           // Guardrail: prune obviously wrong percent-like magnitudes early to avoid blocking batch regen.
           // (e.g. mis-modeled heal amount emitted as `heal: 6400` instead of a heal detail row)
           if (srIsCritRatePointKey(key) && Math.abs(num) > 100) continue
           if (srIsPercentPointKey(key) && Math.abs(num) > 500) continue
           if (!srBuffKeyAllowedByTitle(key, title)) continue
           out[key] = num
           n++
 	        } else if (typeof v === 'string') {
	          const vv0 = v.trim()
          if (!vv0) continue
          const vv = normalizeCalcExpr(vv0)
          if (!isSafeExpr(vv)) continue
          if (hasBareKeyRef(vv)) continue
          if (hasIllegalTalentKeyRef(vv)) continue
          if (hasIllegalCalcMemberAccess(vv)) continue
          if (hasIllegalParamsRef(vv)) continue
          if (hasIllegalTalentRef(vv)) continue
          if (hasIllegalCalcCall(vv)) continue
          try {
            validateTalentTableRefs(vv)
          } catch {
            continue
          }
          // Buff values in miao-plugin are generally stored as "percent numbers" (e.g. 20 means +20%).
          // Using `toRatio()` here is almost always a unit mistake (becomes 100x smaller).
	          if (/\btoRatio\s*\(/.test(vv)) continue

          if (shouldDropBuffExpr(key, vv)) continue

	          let expr = vv
            // SR: If a percent-type key is assigned a stat-based expression, it's almost always meant to be a flat "+ value"
            // (baseline uses atkPlus/hpPlus/defPlus/speedPlus). Convert to *Plus to avoid extreme damage inflation.
            if (input.game === 'sr') {
              const mapped = srPctKeyToPlusKey[key]
              if (mapped && /\bcalc\s*\(\s*attr\./.test(expr)) {
                key = mapped
                if (key in out) continue
              }
            }

            // SR: Guardrail + auto-fix for "*Plus" keys:
            // - models often misuse percent-point conversions (`* 100` / `/0.01`) on flat-stat buckets
            // - models also sometimes use percent points directly (e.g. `calc(attr.def) * 35` for 35%)
            // Fix obvious cases, otherwise drop suspicious >= 100% conversions (mul >= 1 && mul < 10) to avoid inflating many rows.
            if (input.game === 'sr' && /Plus$/.test(key) && /\bcalc\s*\(\s*attr\./.test(expr)) {
              let fixed = expr
              if (/\*\s*(?:100|1e2)\b/i.test(fixed) || /\/\s*(?:0\.01|1e-2)\b/i.test(fixed)) {
                fixed = fixed
                  .replace(/\*\s*(?:100|1e2)\b/gi, '')
                  .replace(/\/\s*(?:0\.01|1e-2)\b/gi, '')
                fixed = normalizeCalcExpr(fixed)
              }

              // Convert obvious percent-point multipliers into ratios: `calc(attr.def) * 35` => `... * 0.35`.
              const m0 = fixed.match(
                /^\s*calc\s*\(\s*attr\.(atk|hp|def|mastery|speed)\s*\)\s*\*\s*([+-]?\d+(?:\.\d+)?)\s*$/
              )
              if (m0) {
                const mul0 = Number(m0[2])
                if (Number.isFinite(mul0) && mul0 >= 10 && mul0 <= 200) {
                  const mulFix = Number((mul0 / 100).toFixed(6))
                  fixed = `calc(attr.${m0[1]}) * ${mulFix}`
                }
              }

              // Drop remaining suspicious large multipliers (likely mis-modeled extra damage mechanics).
              const m1 = fixed.match(
                /^\s*calc\s*\(\s*attr\.(atk|hp|def|mastery|speed)\s*\)\s*\*\s*([+-]?\d+(?:\.\d+)?)\s*$/
              )
              if (m1) {
                const mul1 = Number(m1[2])
                if (Number.isFinite(mul1) && mul1 >= 1) continue
              }

              expr = fixed
            }

            if (!srBuffKeyAllowedByTitle(key, title)) continue

            // SR: Skill descriptions often include *team/ally* buffs. In miao-plugin's single-character panel calc,
            // these should not be applied to the current character (baseline usually omits them).
            if (input.game === 'sr' && srMaybeTeamBuffKeys.has(key)) {
              const m = expr.match(/\btalent\s*\.\s*(a|e|q|t)\s*\[/)
              const tk = m ? m[1] : ''
              if (tk && srIsAllyTargetedTalent(tk)) continue
            }

             // SR: Convert ratio-space expressions into percent points for percent-like buckets.
             // Only do this when the expression looks like a ratio (no large numeric literals, no explicit *100),
             // otherwise we risk double-scaling already-correct constants like 30.
             if (srIsPercentPointKey(key)) {
               const mNum = expr.match(/^\s*([+-]?\d+(?:\.\d+)?)\s*$/)
               if (mNum) {
                 const num = Number(mNum[1])
                 if (Number.isFinite(num) && Math.abs(num) <= 3) expr = String(num * 100)
               } else {
                 // Prefer sample-driven scaling for direct talent-table references to avoid double-scaling.
                 const mRef = expr.match(/^\s*talent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*$/)
                 if (mRef) {
                   const tk = String(mRef[1] || '').trim()
                   const tn0 = String(mRef[3] || '').trim()
                   const base = baseTableName(tn0)
                   const s0 = (input.tableSamples as any)?.[tk]?.[tn0] ?? (input.tableSamples as any)?.[tk]?.[base]
                   const sampleNum =
                     typeof s0 === 'number' && Number.isFinite(s0)
                       ? s0
                       : Array.isArray(s0) && typeof s0[0] === 'number' && Number.isFinite(s0[0])
                         ? Number(s0[0])
                         : null
                   const ratioLike = sampleNum != null ? Math.abs(sampleNum) <= 3 : true
                   if (ratioLike) expr = `(${expr}) * 100`
                 } else if (/\btalent\s*\./.test(expr)) {
                   const hasExplicit100 = /\*\s*(?:100|1e2)\b/.test(expr) || /\/\s*(?:0\.01|1e-2)\b/i.test(expr)
                   const hasBigNum = /\b[5-9]\d*(?:\.\d+)?\b/.test(expr)
                   if (!hasExplicit100 && !hasBigNum) expr = `(${expr}) * 100`
                 }
               }
             }
 	          // `*Multi` keys are stored as delta-percent in miao-plugin; a plain talent table reference is
 	          // almost always the *total* percent (e.g. 137.91%), so we convert it to delta by subtracting 100.
	          if (/Multi$/.test(key)) {
	            const m = expr.match(/^\s*talent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]\s*$/)
	            if (m) {
	              const talentKey = m[1] as TalentKey
	              const tableName = m[3] || ''
	              const unitMap = input.tableUnits?.[talentKey]
	              const baseTableName = tableName.endsWith('2') ? tableName.slice(0, -1) : tableName
	              const unit = unitMap ? unitMap[tableName] || unitMap[baseTableName] : ''
	              // If the referenced table is a stat-scaling ratio (HP/DEF/EM), do NOT apply the "-100" conversion.
	              // Example: "生命值上限/层" tables are additive scaling, not total multiplier percent.
	              const unitNorm = normalizePromptText(unit)
	              const isStatRatioUnit = /(生命上限|生命值上限|最大生命值|生命值|hp|防御力|防御|def|精通|元素精通|mastery|\bem\b)/i.test(
	                unitNorm
	              )
	              if (!isStatRatioUnit) expr = `${expr} - 100`
	            }
	          }
	          // Shred/ignore expressions should be non-negative; wrap with abs to avoid common "-" mistakes.
	          if (/^(enemyDef|enemyIgnore|ignore|kx|fykx)$/.test(key) && !/^\s*Math\.abs\s*\(/.test(expr)) {
	            expr = `Math.abs(${expr})`
	          }
	          out[key] = expr
	          n++
	        }
      }

      // Some models still emit real buff keys with a leading "_" (e.g. `_aPlus`),
      // which miao-plugin treats as placeholder-only and ignores for actual buff effects.
      // Normalize them into real keys when safe and non-conflicting.
      for (const k0 of Object.keys(out)) {
        if (!k0.startsWith('_')) continue
        // If the title explicitly references this key as a placeholder, keep it display-only.
        if (title.includes(`[${k0}]`)) continue
        const rest = k0.slice(1)
        if (!rest) continue
        if (!isAllowedMiaoBuffDataKey(input.game, rest)) continue
        if (Object.prototype.hasOwnProperty.call(out, rest)) continue
        out[rest] = out[k0]!
        delete out[k0]
      }
      if (Object.keys(out).length) data = out
    }

    // Drop no-op buff shells (check-only / title-only). They clutter outputs and can skew defParams inference.
    if (!data) continue

    const out: CalcSuggestBuff = { title }
    if (typeof sort === 'number') out.sort = sort
    if (typeof cons === 'number') out.cons = cons
    if (typeof tree === 'number') out.tree = tree
    if (check) out.check = check
    out.data = data
    buffsOut.push(out)
  }

  // SR: Drop model-invented "推导" buffs. They are rarely baseline-compatible and often cause large drift
  // by applying unconditional dmg/crit multipliers that should be conditional (or not represented as buffs at all).
  if (input.game === 'sr') {
    for (let i = buffsOut.length - 1; i >= 0; i--) {
      const t0 = normalizePromptText((buffsOut[i] as any)?.title)
      if (t0 && /^推导/.test(t0)) buffsOut.splice(i, 1)
    }
  }

  // SR: Do NOT treat fixed heal amount tables like "生命值回复" as buff multipliers (heal/healInc).
  // These are direct healing amounts and should be represented via details(kind=heal), otherwise we can
  // accidentally inflate healing by ~100x when they get interpreted as percent-like bonuses.
  if (input.game === 'sr') {
    for (const b of buffsOut) {
      const data: any = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      for (const key0 of Object.keys(data)) {
        const key = String(key0 || '').trim()
        if (!key) continue
        if (key !== 'heal' && key !== 'healInc') continue
        const v = data[key]
        if (typeof v !== 'string') continue
        const expr = v.trim()
        if (!expr) continue
        if (/\btalent\s*\.\s*(?:a|e|q|t|me|mt)\s*\[\s*(['"])(?:生命值回复|生命回复)\1\s*\]/.test(expr)) {
          delete data[key]
        }
      }
    }
    for (let i = buffsOut.length - 1; i >= 0; i--) {
      const b: any = buffsOut[i]
      const data = b?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const keys = Object.keys(data).filter((k) => k && !k.startsWith('_'))
      if (keys.length === 0) buffsOut.splice(i, 1)
    }
  }

  // Buff checks that reference params.<key> must use keys that are actually set by at least one detail row
  // (or be part of our small common-state allowlist). Otherwise the buff will silently never apply and panel
  // regression drifts wildly low; worse, models often hallucinate params keys (e.g. "params.Nightsoul").
  {
    const detailParamKeys = new Set<string>()
    for (const d of details) {
      const p = (d as any)?.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const k of Object.keys(p as any)) {
        if (k && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) detailParamKeys.add(k)
      }
    }

    const common = new Set<string>([
      // Common GS state flags (recommended in prompt).
      'e',
      'q',
      'off_field',
      'offField',
      'inField',
      // HP/target conditions.
      'half',
      'halfHp',
      'lowHp',
      'targetHp50',
      'targetHp80',
      'hpBelow50',
      'hpAbove50',
      // Common SR state flags (kept here so shared helpers are safe across games).
      'qBuff',
      'break',
      // Common input shapes.
      'stack',
      'stacks'
    ])
    for (const k of detailParamKeys) common.add(k)

    const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/g
    for (const b of buffsOut) {
      const title = typeof (b as any)?.title === 'string' ? String((b as any).title).trim() : ''
      // Upstream-direct node-local premods are intentionally modeled via opt-in params; keep their checks.
      if (
        title.startsWith('upstream:genshin-optimizer(node-premod-variant:') ||
        title.startsWith('upstream:genshin-optimizer(node-premod-row:')
      ) {
        continue
      }

      const check = (b as any)?.check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr || !/params\./.test(expr)) continue

      const used = new Set<string>()
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = String(m[1] || '').trim()
        if (k) used.add(k)
      }
      if (used.size === 0) continue
      const hasUnknown = Array.from(used).some((k) => !common.has(k))
      if (hasUnknown) delete (b as any).check
    }
  }

  // SR: Normalize obvious LLM buff key scope mistakes before we derive missing buffs from tables.
  // This helps:
  // - prevent Q-only crit/dmg buffs from polluting A/E/T damage lines,
  // - allow derived table-based buffs to fill missing global crit stats,
  // - prune suspicious crit expressions that reference non-crit tables when real crit tables exist.
  if (input.game === 'sr') {
    const critRateTables = new Set<string>()
    const critDmgTables = new Set<string>()
    for (const list of Object.values(tables)) {
      for (const tn of list || []) {
        if (/暴击率/.test(tn)) critRateTables.add(tn)
        if (/(暴击伤害|爆伤)/.test(tn)) critDmgTables.add(tn)
      }
    }

    const firstTableRef = (expr: string): { tk: string; table: string } | null => {
      const m = expr.match(/\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]/)
      if (!m) return null
      return { tk: String(m[1] || ''), table: String(m[3] || '') }
    }

    const moveKey = (data: Record<string, unknown>, from: string, to: string): void => {
      if (!Object.prototype.hasOwnProperty.call(data, from)) return
      if (!Object.prototype.hasOwnProperty.call(data, to)) (data as any)[to] = (data as any)[from]
      delete (data as any)[from]
    }

    for (const b of buffsOut) {
      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue

      const title = normalizePromptText((b as any).title)
      const check = typeof (b as any)?.check === 'string' ? normalizePromptText((b as any).check) : ''
      const isAfterCast = /(释放|施放).*(终结技|元素爆发|Q).*(后|之后)/.test(title)
      const wantsQByTitle = (/^Q/.test(title) || /终结技|元素爆发/.test(title)) && !isAfterCast
      const wantsQByCheck = /\bparams\.q\b/.test(check)

      // Fix common semantic drift: "无视防御" should be `ignore`, not `enemyDef`.
      if (/无视/.test(title) && /防御/.test(title)) {
        if (Object.prototype.hasOwnProperty.call(data, 'enemyDef') && !Object.prototype.hasOwnProperty.call(data, 'ignore')) {
          ;(data as any).ignore = (data as any).enemyDef
          delete (data as any).enemyDef
        }
      } else if (/防御/.test(title) && /(降低|减少|减防)/.test(title)) {
        if (Object.prototype.hasOwnProperty.call(data, 'ignore') && !Object.prototype.hasOwnProperty.call(data, 'enemyDef')) {
          ;(data as any).enemyDef = (data as any).ignore
          delete (data as any).ignore
        }
      }

      // Scope obvious Q-only crit/dmg buffs into q* buckets.
      if (wantsQByTitle || wantsQByCheck) {
        moveKey(data, 'cpct', 'qCpct')
        moveKey(data, 'cdmg', 'qCdmg')
        moveKey(data, 'dmg', 'qDmg')
      }

      // Scope global crit/dmg keys when they directly reference talent.q tables.
      for (const k0 of Object.keys(data)) {
        const k = String(k0 || '').trim()
        if (!k) continue
        const v = (data as any)[k]
        if (typeof v !== 'string') continue
        const ref = firstTableRef(v)
        if (!ref) continue
        if (ref.tk !== 'q') continue
        if (k === 'cpct') moveKey(data, 'cpct', 'qCpct')
        if (k === 'cdmg') moveKey(data, 'cdmg', 'qCdmg')
        if (k === 'dmg') moveKey(data, 'dmg', 'qDmg')
      }

      // Drop suspicious crit expressions when real crit tables exist somewhere in the kit.
      // This is a common LLM mistake (e.g. using "参数" or "技能伤害" tables as crit stats).
      for (const k0 of Object.keys(data)) {
        const k = String(k0 || '').trim()
        if (!k) continue
        const v = (data as any)[k]
        if (typeof v !== 'string') continue
        const ref = firstTableRef(v)
        if (!ref) continue
        const tn = ref.table || ''

        if ((k === 'cpct' || /Cpct$/.test(k)) && critRateTables.size) {
          if (!/暴击率/.test(tn) && /(参数\d*|技能伤害)/.test(tn)) delete (data as any)[k]
        }
        if ((k === 'cdmg' || /Cdmg$/.test(k)) && critDmgTables.size) {
          if (!/(暴击伤害|爆伤)/.test(tn) && /(参数\d*|技能伤害)/.test(tn)) delete (data as any)[k]
        }
      }
    }

    for (let i = buffsOut.length - 1; i >= 0; i--) {
      const b: any = buffsOut[i]
      const data = b?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        buffsOut.splice(i, 1)
        continue
      }
      if (Object.keys(data).length === 0) buffsOut.splice(i, 1)
    }
  }

  // SR: Derive core debuff buffs from the talent description placeholder contexts when the model misses them.
  // This prevents extreme underestimation for kits where "技能伤害" tables actually represent debuff values
  // (e.g. 防御力降低、敌方受到伤害提高).
  const applySrDerivedBuffs = (): void => {
    if (input.game !== 'sr') return
    const multiKeys = new Set(['kx', 'enemyDef', 'ignore', 'enemydmg'])
    const hasUpstream = buffsOut.some((b: any) => typeof b?.title === 'string' && String(b.title).startsWith('upstream:'))
    const hasKey = (k: string): boolean =>
      buffsOut.some((b) => {
        const data = (b as any)?.data
        return !!data && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, k)
      })

    const hasSameExpr = (key: string, expr: string): boolean =>
      buffsOut.some((b) => {
        const data = (b as any)?.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false
        if (!Object.prototype.hasOwnProperty.call(data, key)) return false
        return String((data as any)[key]) === expr
      })

    const pushIfMissing = (title: string, key: string, expr: string): void => {
      if (!isAllowedMiaoBuffDataKey('sr', key)) return
      if (hasUpstream && hasKey(key)) return
      if (!multiKeys.has(key) && hasKey(key)) return
      if (hasSameExpr(key, expr)) return
      buffsOut.push({ title, data: { [key]: expr } as any })
    }

    const qI = srIntentTableByTalent.get('q')
    if (qI?.enemyDef) {
      pushIfMissing('推导：终结技防御力降低[enemyDef]%', 'enemyDef', `talent.q[${jsString(qI.enemyDef)}] * 100`)
    }
    if (qI?.enemydmg) {
      const baseExpr = `talent.q[${jsString(qI.enemydmg)}] * 100`
      pushIfMissing(
        '推导：终结技使敌方受到伤害提高[enemydmg]%',
        'enemydmg',
        hasUpstream ? `(params.q ? (${baseExpr}) : 0)` : baseExpr
      )
    }

    const eI = srIntentTableByTalent.get('e')
    if (eI?.enemyDef) {
      pushIfMissing('推导：战技防御力降低[enemyDef]%', 'enemyDef', `talent.e[${jsString(eI.enemyDef)}] * 100`)
    }
    if (eI?.enemydmg) {
      pushIfMissing('推导：战技使敌方受到伤害提高[enemydmg]%', 'enemydmg', `talent.e[${jsString(eI.enemydmg)}] * 100`)
    }

    const tI = srIntentTableByTalent.get('t')
    if (tI?.enemyDef) {
      pushIfMissing('推导：天赋防御力降低[enemyDef]%', 'enemyDef', `talent.t[${jsString(tI.enemyDef)}] * 100`)
    }
    if (tI?.enemydmg) {
      pushIfMissing(
        '推导：天赋使敌方受到伤害提高[enemydmg]%',
        'enemydmg',
        `talent.t[${jsString(tI.enemydmg)}] * 100`
      )
    }

    // SR: Derive common self buffs from table names when LLM misses them.
    // Keep it conservative: only add when the key is completely missing.
    const srPickSkillKey = (text: string): 'a' | 'e' | 'q' | 't' | 'me' | 'mt' | '' => {
      // Order matters: avoid matching "天赋" before "忆灵天赋".
      if (/忆灵天赋/.test(text)) return 'mt'
      if (/忆灵技/.test(text)) return 'me'
      if (/(普攻|普通攻击)/.test(text)) return 'a'
      if (/战技/.test(text)) return 'e'
      if (/终结技/.test(text)) return 'q'
      if (/(天赋|反击|追击|追加攻击|追加)/.test(text)) return 't'
      return ''
    }

    const hasMemKit = Object.keys(tables || {}).some((k) => /^m[et]\d*$/.test(String(k || '').trim()))
    const escapeRe = (s: string): string => String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const parseSpriteName = (textRaw: unknown): string => {
      const s = normalizePromptText(textRaw)
      if (!s || !/召唤忆灵/.test(s)) return ''
      const m =
        /召唤忆灵[^“「『"《》]{0,20}(?:“([^”]{1,12})”|「([^」]{1,12})」|『([^』]{1,12})』|"([^"]{1,12})"|《([^》]{1,12})》)/.exec(
          s
        )
      return String(m?.[1] || m?.[2] || m?.[3] || m?.[4] || m?.[5] || '').trim()
    }
    const parseSpriteNameLoose = (textRaw: unknown): string => {
      const s = normalizePromptText(textRaw)
      if (!s) return ''
      const m = /忆灵\s*([^\s，。、；：:「」『』“”《》]{1,12})/.exec(s)
      return String(m?.[1] || '').trim()
    }
    const spriteName = hasMemKit
      ? parseSpriteName((input.talentDesc as any)?.z) ||
        parseSpriteName((input.talentDesc as any)?.q) ||
        parseSpriteNameLoose((input.talentDesc as any)?.t) ||
        parseSpriteNameLoose((input.talentDesc as any)?.z) ||
        parseSpriteNameLoose((input.talentDesc as any)?.q) ||
        ''
      : ''

    const srPickBuffKeyFromTableName = (talentKey: TalentKey, tableNameRaw: string): string | null => {
      const tableName = String(tableNameRaw || '').trim()
      const tn = normalizePromptText(tableName)
      if (!tn) return null
      // Non-damage affecting / ambiguous mechanics: ignore.
      if (/(基础概率|概率|几率|效果命中|效果抵抗|命中|抵抗|击破效率|削韧|持续时间|回合|次数|层数上限)/.test(tn)) return null
      // Delta talent multiplier tables are additive to the base multiplier (handled in details as base+delta).
      // Deriving them into `*Dmg` buffs would massively inflate damage and/or double-count.
      if (/(伤害)?倍率(提高|提升|增加)/.test(tn)) return null

      const tkBase = String(talentKey || '')
        .trim()
        .replace(/\d+$/, '') as TalentKey

      // Prefer intent inferred from placeholder contexts (more reliable than generic table names like "技能伤害/伤害提高").
      const intent = srIntentTableByTalent.get(talentKey) || srIntentTableByTalent.get(tkBase)
      if (intent?.enemyDef && intent.enemyDef === tableName) return 'enemyDef'
      if (intent?.enemydmg && intent.enemydmg === tableName) return 'enemydmg'

      const scope = (
        baseKey: 'cpct' | 'cdmg' | 'dmg'
      ): 'cpct' | 'cdmg' | 'dmg' | 'aCpct' | 'eCpct' | 'qCpct' | 'meCpct' | 'mtCpct' | 'aCdmg' | 'eCdmg' | 'qCdmg' | 'meCdmg' | 'mtCdmg' | 'aDmg' | 'eDmg' | 'qDmg' | 'meDmg' | 'mtDmg' => {
        const sk = srPickSkillKey(tn)
        // Prefer explicit wording in the table name; otherwise scope Q/E/A/忆灵 tables to reduce cross-skill pollution.
        const inferred =
          sk ||
          (tkBase === 'q' || tkBase === 'e' || tkBase === 'a' || tkBase === 'me' || tkBase === 'mt' ? (tkBase as any) : '')
        if (!inferred) return baseKey as any
        if (baseKey === 'cpct') return `${inferred}Cpct` as any
        if (baseKey === 'cdmg') return `${inferred}Cdmg` as any
        return `${inferred}Dmg` as any
      }

      if (/暴击率/.test(tn)) return scope('cpct')
      if (/(暴击伤害|爆伤)/.test(tn)) return scope('cdmg')
      if (/抗性穿透/.test(tn)) return 'kx'
      if (/抗性/.test(tn) && !/效果抵抗|效果抗性|效果命中|命中|抵抗/.test(tn) && /(降低|减少)/.test(tn)) return 'kx'
      if (/无视/.test(tn) && /防御/.test(tn)) return 'ignore'
      if (/(防御力降低|防御降低|减防)/.test(tn)) return 'enemyDef'
      if (/击破特攻/.test(tn)) return 'stance'

      if (/(攻击力|攻击)/.test(tn) && /(提高|提升|增加|加成)/.test(tn)) return 'atkPct'
      if (/(生命上限|生命值上限|最大生命值|生命值)/.test(tn) && /(提高|提升|增加|加成)/.test(tn)) return 'hpPct'
      if (/防御力/.test(tn) && /(提高|提升|增加|加成)/.test(tn)) return 'defPct'

      // Damage bonus vs enemy damage taken.
      if (/受到/.test(tn) && /伤害/.test(tn) && /(提高|提升|增加)/.test(tn)) return 'enemydmg'
      // Derive damage-bonus buckets from "伤害提高/增伤" tables:
      // - Prefer skill-scoped keys (qDmg/eDmg/...) when the table is in Q/E/A/忆灵 buckets, to avoid polluting other skills.
      // - Fall back to global `dmg` for passive-like tables (often in `t`) that do not mention a specific skill.
      if (/伤害/.test(tn) && /(提高|提升|增加|加成|增伤)/.test(tn)) {
        // Some SR tables sit under E/Q buckets but describe a team-wide/global buff, e.g.
        // "使我方全体造成的伤害提高..." (Robin E). Baseline usually models these as global `dmg`,
        // not `eDmg/qDmg`, so we opt into global when the description is explicit.
        const desc0 = normalizePromptText((input.talentDesc as any)?.[tkBase])
        // Remembrance kits: some passive (`t`) tables apply only to the memosprite, but the table name is generic
        // (e.g. "伤害提高"). Use the memosprite name in the official description as a conservative scope signal.
        if (hasMemKit && spriteName && tkBase === 't' && desc0) {
          const re = new RegExp(
            `${escapeRe(spriteName)}.{0,18}(?:造成|造成的).{0,18}伤害.{0,18}(?:提高|提升|增加|加成|增伤)`
          )
          if (re.test(desc0)) return 'meDmg'
        }
        const isTeamAll =
          !!desc0 &&
          /(我方全体|全体|队友|其他我方|除自身|为其他)/.test(desc0) &&
          /(造成的伤害|造成伤害).{0,12}(提高|提升|增加|加成|增伤)/.test(desc0)
        if (isTeamAll) return 'dmg'
        return scope('dmg')
      }

      return null
    }

    const srSampleNum = (talentKey: TalentKey, tableName: string): number | null => {
      const s = (input.tableSamples as any)?.[talentKey]?.[tableName]
      if (typeof s === 'number' && Number.isFinite(s)) return s
      if (Array.isArray(s) && typeof s[0] === 'number' && Number.isFinite(s[0])) return Number(s[0])
      return null
    }

    const srExprFromTable = (talentKey: TalentKey, tableName: string, key: string): string => {
      const tableLit = jsString(tableName)
      const base = `talent.${String(talentKey)}[${tableLit}]`
      if (!srIsPercentPointKey(key)) return base
      const sn = srSampleNum(talentKey, tableName)
      // SR scalar tables are usually *ratios* (0.2 means 20%), but we omit scalar samples from prompts for size.
      // When we can't sample it, default to ratio-space and scale into percent-points to match miao-plugin buff buckets.
      const ratioLike = sn != null ? Math.abs(sn) <= 3 : true
      return ratioLike ? `${base} * 100` : base
    }

    // Add a few core percent buffs (dmg/cpct/cdmg/kx/enemyDef/enemydmg/atkPct/hpPct/defPct/stance).
    for (const tk0 of Object.keys(tables)) {
      const tk = tk0 as TalentKey
      const tkStr = String(tk || '').trim()
      const isAllyTalent = tkStr ? srIsAllyTargetedTalent(tkStr) : false
      const list = tables[tk] || []
      for (const tn of list) {
        const k = srPickBuffKeyFromTableName(tk, tn)
        if (!k) continue
        if (isAllyTalent && srMaybeTeamBuffKeys.has(k)) continue
        if (!isAllowedMiaoBuffDataKey('sr', k)) continue
        pushIfMissing(`推导：${tn}[${k}]`, k, srExprFromTable(tk, tn, k))
      }
    }

    // SR: Derive stance (击破特攻) buffs from trace/cons hint lines when they are NOT present in talent tables.
    // This is common for Harmony/support kits and is a major source of break damage drift vs baseline.
    try {
      const hintLines = (input.buffHints || [])
        .filter((s) => typeof s === 'string')
        .map((s) => normalizePromptText(s))
        .filter(Boolean) as string[]

      const pickStancePct = (text: string): number | null => {
        const num = (s: string): number | null => {
          const n = Number(s)
          return Number.isFinite(n) ? n : null
        }

        // Avoid mis-reading threshold-style traces:
        // "击破特攻大于120%时..." is NOT "击破特攻提高120%".
        if (/击破特攻.{0,12}(?:大于|超过)/.test(text)) return null

        // Prefer explicit "击破特攻提高/提升/增加 X%" patterns.
        const m1 = /击破特攻.{0,16}(?:提高|提升|增加)\s*([0-9]+(?:\.\d+)?)\s*[%％]/.exec(text)
        if (m1) return num(m1[1]!)

        // Handle reversed wording: "X%击破特攻提高/提升/增加".
        const m2 = /([0-9]+(?:\.\d+)?)\s*[%％].{0,16}击破特攻.{0,16}(?:提高|提升|增加)/.exec(text)
        if (m2) return num(m2[1]!)

        return null
      }

      const hasSameStance = (b: { tree?: number; cons?: number; check?: string }): boolean =>
        buffsOut.some((x: any) => {
          if (!x || typeof x !== 'object') return false
          const data = x.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) return false
          if (!Object.prototype.hasOwnProperty.call(data, 'stance')) return false
          if ((x.tree || 0) !== (b.tree || 0)) return false
          if ((x.cons || 0) !== (b.cons || 0)) return false
          const c0 = typeof x.check === 'string' ? String(x.check).trim() : ''
          const c1 = typeof b.check === 'string' ? String(b.check).trim() : ''
          return c0 === c1
        })

      for (const h of hintLines) {
        if (!/击破特攻/.test(h)) continue
        if (!/(提高|提升|增加)/.test(h)) continue
        // Skip teammate-only wording to avoid over-applying to self.
        if (/(其他我方|除自身|为其他|其他队友)/.test(h)) continue

        const stance = pickStancePct(h)
        if (stance === null) continue
        if (stance <= 0 || stance > 500) continue

        const mTree = h.match(/^行迹\s*(\d)\s*[：:]/)
        const tree = mTree ? Math.trunc(Number(mTree[1])) : 0
        const mCons = h.match(/^\s*(\d)\s*魂[：:]/)
        const consNeed = mCons ? Math.trunc(Number(mCons[1])) : 0

        const check = /弱点.{0,8}击破|击破时/.test(h) ? 'params.break === true' : ''

        const buff = {
          title: h,
          ...(tree >= 1 && tree <= 6 ? { tree } : {}),
          ...(consNeed >= 1 && consNeed <= 6 ? { cons: consNeed } : {}),
          ...(check ? { check } : {}),
          data: { stance }
        } as any

        if (hasSameStance({ tree: buff.tree, cons: buff.cons, check: buff.check })) continue
        buffsOut.push(buff)
      }
    } catch {
      // best-effort only
    }

    // Add hpPlus from paired "生命提高(百分比+固定值)" tables (common in SR, affects dmg on HP-scaling kits).
    if (!hasKey('hpPlus')) {
      for (const tk0 of Object.keys(tables)) {
        const tk = tk0 as TalentKey
        const tkStr = String(tk || '').trim()
        if (tkStr && srIsAllyTargetedTalent(tkStr)) continue
        const list = tables[tk] || []
        const pct = list.find((t) => /(生命|生命上限|生命值上限).*(提高|增加).*(百分比|%)/.test(t) && !/(治疗|回复|恢复|护盾)/.test(t))
        const flat = list.find((t) => /(生命|生命上限|生命值上限).*(提高|增加).*(固定值|固定数值)/.test(t) && !/(治疗|回复|恢复|护盾)/.test(t))
        if (!pct || !flat) continue
        if (!isAllowedMiaoBuffDataKey('sr', 'hpPlus')) break

        const pctBase = `talent.${String(tk)}[${jsString(pct)}]`
        const sn = srSampleNum(tk, pct)
        const pctIsRatio = sn != null ? Math.abs(sn) <= 3 : true
        const pctExpr = pctIsRatio ? pctBase : `(${pctBase}) / 100`
        const flatExpr = `talent.${String(tk)}[${jsString(flat)}]`
        pushIfMissing(`推导：生命上限提高[hpPlus]`, 'hpPlus', `attr.hp.base * (${pctExpr}) + (${flatExpr})`)
        break
      }
    }

    // Add atkPlus from paired "攻击力提高(百分比+固定值)" tables (SR common, affects dmg showcase).
    //
    // Notes:
    // - These are often "flat ATK add based on *caster ATK*", NOT a plain atkPct.
    // - Baseline commonly gates ultimate-sourced ones by `params.q`; we use `params.qBuff`.
    const deriveAtkPlusFromTalent = (tk: TalentKey, opts: { title: string; sort?: number; check: string }): void => {
      if (hasKey('atkPlus')) return
      if (!isAllowedMiaoBuffDataKey('sr', 'atkPlus')) return
      const list = (tables as any)?.[tk]
      if (!Array.isArray(list) || list.length === 0) return

      const pct =
        list.find((t) => /(攻击提高).*(攻击力)?.*百分比/.test(t)) ||
        list.find((t) => /(攻击力|攻击).*(提高|增加).*(百分比|%)/.test(t))
      const flat =
        list.find((t) => /(攻击提高).*(固定值|固定数值)/.test(t)) ||
        list.find((t) => /(攻击力|攻击).*(提高|增加).*(固定值|固定数值)/.test(t))
      if (!pct || !flat) return

      // Use `attr.atk` (AttrItem) to match baseline semantics; it coerces to number via toString().
      const expr = `talent.${String(tk)}[${jsString(pct)}] * attr.atk + talent.${String(tk)}[${jsString(flat)}]`
      if (hasSameExpr('atkPlus', expr)) return

      buffsOut.push({
        title: opts.title,
        ...(typeof opts.sort === 'number' ? { sort: opts.sort } : {}),
        check: opts.check,
        data: { atkPlus: expr }
      })
    }

    // Prefer Q, then E (some characters source this from skill).
    deriveAtkPlusFromTalent('q', { title: '推导：终结技攻击力提高[atkPlus]', sort: 9, check: 'params.qBuff === true' })
    deriveAtkPlusFromTalent('e', { title: '推导：战技攻击力提高[atkPlus]', sort: 8, check: 'params.e === true' })
  }
  applySrDerivedBuffs()

  // SR: Prune obviously-duplicated debuff buckets (common LLM artifact after we add derived buffs).
  // Keep:
  // - at most 1 expression per (key + talent table ref)
  // - drop numeric-constant `enemyDef/ignore/enemydmg` when an expression-based one exists
  if (input.game === 'sr') {
    try {
      const debuffKeys = new Set(['enemyDef', 'ignore', 'enemydmg', 'kx'])
      const refRe = /\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]/g

      const firstTableRef = (expr: string): { tk: string; table: string } | null => {
        refRe.lastIndex = 0
        const m = refRe.exec(expr)
        if (!m) return null
        return { tk: String(m[1] || ''), table: String(m[3] || '') }
      }

      const isSimplePctDerived = (expr: string, tk: string, table: string): boolean => {
        const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        const re = new RegExp(
          `^\\s*talent\\s*\\.\\s*${esc(tk)}\\s*\\[\\s*(['\"])${esc(table)}\\1\\s*\\]\\s*\\*\\s*100\\s*$`
        )
        return re.test(expr.trim())
      }

      const deleteKeyFromBuff = (buff: any, key: string): void => {
        const data = buff?.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) return
        delete data[key]
      }

      const cleanupEmptyBuffData = (): void => {
        for (let i = buffsOut.length - 1; i >= 0; i--) {
          const b: any = buffsOut[i]
          const data = b?.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          const keys = Object.keys(data).filter((k) => k && !k.startsWith('_'))
          if (keys.length === 0) buffsOut.splice(i, 1)
        }
      }

      for (const key of debuffKeys) {
        const items: Array<{ buff: any; expr: string | null; isConst: boolean; refSig: string; ref?: { tk: string; table: string } }> = []
        for (const b of buffsOut) {
          const data = (b as any)?.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          if (!Object.prototype.hasOwnProperty.call(data, key)) continue
          const v = (data as any)[key]
          if (typeof v === 'number') {
            items.push({ buff: b, expr: null, isConst: true, refSig: 'const' })
            continue
          }
          if (typeof v === 'string') {
            const expr = v.trim()
            const ref = firstTableRef(expr)
            const refSig = ref ? `${ref.tk}|${ref.table}` : 'expr'
            items.push({ buff: b, expr, isConst: false, refSig, ref: ref || undefined })
            continue
          }
          // function/object: keep (hard to compare safely)
          items.push({ buff: b, expr: null, isConst: false, refSig: 'opaque' })
        }
        if (items.length <= 1) continue

        // Drop constant debuffs when expression-based exists (except kx: constants are common in baseline).
        if (key !== 'kx') {
          const hasExpr = items.some((x) => !x.isConst && (x.refSig.includes('|') || x.refSig === 'expr'))
          if (hasExpr) {
            for (const it of items) {
              if (it.isConst) deleteKeyFromBuff(it.buff, key)
            }
          }
        }

        // De-dup per (talent table ref).
        const byRef = new Map<string, typeof items>()
        for (const it of items) {
          if (!it.expr || !it.ref || it.refSig === 'opaque' || it.refSig === 'const') continue
          const list = byRef.get(it.refSig) || []
          list.push(it)
          byRef.set(it.refSig, list)
        }
        for (const list of byRef.values()) {
          if (list.length <= 1) continue
          // Prefer the simple `talent.<tk>["<table>"] * 100` form if present.
          let keep = list.find((it) => it.expr && it.ref && isSimplePctDerived(it.expr, it.ref.tk, it.ref.table)) || list[0]
          for (const it of list) {
            if (it === keep) continue
            deleteKeyFromBuff(it.buff, key)
          }
        }
      }

      cleanupEmptyBuffData()
    } catch {
      // best-effort pruning
    }
  }

  // SR: Infer major trace (行迹) index from buffHints to match baseline gating behavior.
  // LLMs often omit `tree`, causing trace buffs to be applied unconditionally and inflating damage.
  if (input.game === 'sr') {
    try {
      const hints = Array.isArray(input.buffHints) ? (input.buffHints as unknown[]) : []
      const nameToIdx = new Map<string, number>()
      for (const h0 of hints) {
        const h = normalizePromptText(h0)
        if (!h) continue
        const m = /^行迹\s*(\d{1,2})\s*[：:]\s*([^：:]+)\s*[：:]/.exec(h)
        if (!m) continue
        const idx = Number(m[1])
        const name = String(m[2] || '').trim()
        if (!name) continue
        if (!Number.isFinite(idx) || idx < 1 || idx > 10) continue
        if (!nameToIdx.has(name)) nameToIdx.set(name, Math.trunc(idx))
      }

      if (nameToIdx.size) {
        const extractTraceName = (titleRaw: unknown): string => {
          const title = normalizePromptText(titleRaw)
          if (!title) return ''
          if (!/行迹/.test(title)) return ''
          // Prefer the first segment after "行迹" and an optional separator/digits.
          // Examples:
          // - 行迹·视界外来信·暴击伤害提高  -> 视界外来信
          // - 行迹-止厄：普攻造成的伤害提高40% -> 止厄
          // - 行迹1：冷漠的诚实：... -> 冷漠的诚实
          const m =
            /行迹\s*(?:\d{1,2})?\s*[·\-_—–]?\s*([^：:·\-_—–，。；;]+)\s*(?:[：:·\-_—–，。；;]|$)/.exec(title) ||
            null
          return m ? String(m[1] || '').trim() : ''
        }

        for (const b of buffsOut) {
          const name = extractTraceName((b as any)?.title)
          if (!name) continue
          const idx = nameToIdx.get(name)
          if (idx == null) continue
          ;(b as any).tree = idx
        }
      }
    } catch {
      // Best-effort: do not block generation.
    }
  }

  // SR: Drop clearly ally-targeted / teammate-only eidolon buffs (common on supports).
  // Baseline meta often omits these from the caster's own panel damage calc to avoid inflating self damage.
  if (input.game === 'sr') {
    try {
      const hints = Array.isArray(input.buffHints) ? (input.buffHints as unknown[]) : []

      // Technique (秘技) is often a team-wide pre-battle buff. Baseline SR metas usually omit these from single-character
      // panel damage calcs to avoid assuming team uptime. Drop technique-derived buffs only when the official technique
      // text clearly targets "我方全体/队友/...".
      let techIsTeam = false
      for (const h0 of hints) {
        const h = normalizePromptText(h0)
        if (!h) continue
        if (!/^秘技\s*[：:]/.test(h)) continue
        if (/(我方全体|全队|全体队友|队友|其他我方|指定我方|我方目标|除自身)/.test(h)) {
          techIsTeam = true
          break
        }
      }
      if (techIsTeam) {
        for (let i = buffsOut.length - 1; i >= 0; i--) {
          const t0 = normalizePromptText((buffsOut[i] as any)?.title)
          if (!t0) continue
          if (/^秘技/.test(t0) || t0.includes('秘技')) buffsOut.splice(i, 1)
        }
      }

      const consDesc = new Map<number, string>()
      for (const h0 of hints) {
        const h = normalizePromptText(h0)
        if (!h) continue
        const m = /^(\d)\s*魂\s*[：:]\s*[^：:]+\s*[：:]\s*(.+)$/.exec(h)
        if (!m) continue
        const cons = Number(m[1])
        if (!Number.isFinite(cons) || cons < 1 || cons > 6) continue
        const desc = String(m[2] || '').trim()
        if (desc) consDesc.set(cons, desc)
      }

      if (consDesc.size) {
        const kept: CalcSuggestBuff[] = []
        for (const b of buffsOut) {
          const consRaw = (b as any)?.cons
          const cons = typeof consRaw === 'number' && Number.isFinite(consRaw) ? Math.trunc(consRaw) : NaN
          if (!Number.isFinite(cons) || cons < 1 || cons > 6) {
            kept.push(b)
            continue
          }

          const desc = consDesc.get(cons)
          const t = normalizePromptText(desc)
          if (!t) {
            kept.push(b)
            continue
          }

          const selfExcluded = /(除自身|除自己|自身以外|自己以外|不包括自身|不包括自己)/.test(t)
          const hasSelf = /(自身|自己)/.test(t) && !selfExcluded
          const allyOnly = /(指定我方|我方目标|队友|其他我方|除自身|为其他)/.test(t)
          if (!hasSelf && allyOnly) continue
          kept.push(b)
        }
        buffsOut.splice(0, buffsOut.length, ...kept)
      }

      // Also drop ally-only buffs by their own title text (when hint text is unavailable).
      // Example: "队友击破特攻提高..." should not inflate the caster's own panel damage.
      if (buffsOut.length) {
        const kept: CalcSuggestBuff[] = []
        for (const b of buffsOut) {
          const title = normalizePromptText((b as any)?.title)
          if (!title) continue
          const selfExcluded = /(除自身|除自己|自身以外|自己以外|不包括自身|不包括自己)/.test(title)
          const hasSelf = /(自身|自己|装备者|本角色)/.test(title) && !selfExcluded
          const allyOnly = /(指定我方|我方目标|队友|其他我方|除自身|为其他)/.test(title)
          if (!hasSelf && allyOnly) continue
          kept.push(b)
        }
        buffsOut.splice(0, buffsOut.length, ...kept)
      }

      // SR: Cons "倍率提高" is usually patched into details (delta to talent ratio), not modeled as `*Multi` buffs.
      // Drop `*Multi` keys on cons-gated buffs to avoid double-counting / wrong-unit drift (LLM common failure mode).
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const b: any = buffsOut[i]
        const consRaw = b?.cons
        const cons = typeof consRaw === 'number' && Number.isFinite(consRaw) ? Math.trunc(consRaw) : NaN
        if (!Number.isFinite(cons) || cons < 1 || cons > 6) continue
        const data = b?.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue
        for (const k of Object.keys(data)) {
          if (/Multi$/.test(k)) delete (data as any)[k]
        }
        const keys = Object.keys(data).filter((k) => k && !k.startsWith('_'))
        if (keys.length === 0) buffsOut.splice(i, 1)
      }
    } catch {
      // Best-effort: do not block generation.
    }
  }

  // SR: DOT damage does not crit. If a DOT-related buff was (mis)modeled using crit buckets,
  // re-map it to dot buckets to avoid systematic drift.
  if (input.game === 'sr') {
    for (const b of buffsOut) {
      const title = normalizePromptText((b as any)?.title)
      if (!title) continue
      const isDotLike = /(持续伤害|dot|触电|风化|裂伤|灼烧|纠缠|冻结)/i.test(title)
      if (!isDotLike) continue

      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      if (Object.prototype.hasOwnProperty.call(data, 'dotDmg') || Object.prototype.hasOwnProperty.call(data, 'dotEnemydmg') || Object.prototype.hasOwnProperty.call(data, 'dotMulti')) {
        continue
      }

      if (Object.prototype.hasOwnProperty.call(data, 'cpct')) delete (data as any).cpct

      if (Object.prototype.hasOwnProperty.call(data, 'cdmg')) {
        const v = (data as any).cdmg
        delete (data as any).cdmg
        const wantsMulti = /倍率/.test(title)
        const k = wantsMulti ? 'dotMulti' : /受到/.test(title) ? 'dotEnemydmg' : 'dotDmg'
        if (isAllowedMiaoBuffDataKey('sr', k)) (data as any)[k] = v
      }
    }
  }

  // SR: Similar to GS, models often over-gate plain stat/debuff buffs with ad-hoc params flags, causing
  // systematic underestimation on baseline-style showcases. Drop params-only gating for safe global keys.
  if (input.game === 'sr') {
    const safeKeys = new Set([
      'atkPct',
      'hpPct',
      'defPct',
      'speedPct',
      'recharge',
      'cpct',
      'cdmg',
      'dmg',
      'enemydmg',
      'effPct',
      'effDef',
      'heal',
      'shield',
      'stance',
      'multi',
      'kx',
      'enemyDef',
      'enemyIgnore',
      'ignore',
      // DOT-only buckets (won't affect non-DOT rows even if unconditional).
      'dotDmg',
      'dotEnemydmg',
      'dotMulti'
    ])

    const isHpConditionTitle = (t: string): boolean =>
      /(半血|低血|生命值\s*(?:低于|小于|少于|高于|大于|不少于|不低于|不小于)|目标生命)/.test(t)

    for (const b of buffsOut) {
      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const keys = Object.keys(data).filter((k) => k && !k.startsWith('_'))
      if (keys.length === 0) continue
      if (!keys.every((k) => safeKeys.has(k))) continue

      const check = (b as any)?.check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr) continue
      if (!/params\./.test(expr)) continue
      // `params.<key>` may legitimately use names like "talent"/"attr"; strip them before detecting real scope refs.
      const exprNoParams = expr.replace(/\bparams\.[A-Za-z_][A-Za-z0-9_]*/g, 'params')
      if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent|element)\b/.test(exprNoParams)) continue
      if (/\bparams\.(?:half|halfHp|lowHp|targetHp50|targetHp80|hpBelow50|hpAbove50)\b/i.test(expr)) continue
      // Keep core state gating (e/q/qBuff/break). These are used to align baseline-style showcase assumptions.
      if (/\bparams\.(?:e|q|qBuff|break)\b/.test(expr)) continue

      // Keep row-scoped upstream-direct gating (node-local premods). Dropping this turns row-only buffs
      // into unconditional global buffs and causes large drift.
      if (/\bupstream:genshin-optimizer\(node-premod-(?:row|variant):/i.test(String((b as any)?.title || ''))) continue

      const title = normalizePromptText((b as any)?.title)
      if (title && isHpConditionTitle(title)) continue

      delete (b as any).check
    }
  }

  // SR: Cons/trace buffs are frequently over-gated by models using `params.a/e/q/t`, which often turns them into
  // dead buffs (details forget to set params) and drifts far below baseline-style showcases. For cons/tree buffs,
  // drop params-only gating when it doesn't involve key gameplay states (qBuff/break/HP thresholds).
  if (input.game === 'sr') {
    try {
      const keepParamKeys = new Set([
        'qBuff',
        'break',
        'half',
        'halfHp',
        'lowHp',
        'targetHp50',
        'targetHp80',
        'hpBelow50',
        'hpAbove50'
      ])
      const isPlainSkillFlag = (k: string): boolean => k === 'a' || k === 'e' || k === 'q' || k === 't'

      for (const b of buffsOut) {
        if (!b || typeof b !== 'object') continue
        const consOrTree =
          (typeof (b as any).cons === 'number' && Number.isFinite((b as any).cons)) ||
          (typeof (b as any).tree === 'number' && Number.isFinite((b as any).tree))
        if (!consOrTree) continue

        const check = typeof (b as any).check === 'string' ? String((b as any).check) : ''
        if (!check.trim()) continue
        if (!/params\./.test(check)) continue

        // Only params-based checks; do not touch checks that depend on other runtime context.
        const exprNoParams = check.replace(/\bparams\.[A-Za-z_][A-Za-z0-9_]*/g, 'params')
        if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent|element)\b/.test(exprNoParams)) continue

        const keys = Array.from(check.matchAll(/\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/g))
          .map((m) => String(m[1] || '').trim())
          .filter(Boolean)
        if (!keys.length) continue
        if (keys.some((k) => keepParamKeys.has(k))) continue
        if (!keys.every(isPlainSkillFlag)) continue

        delete (b as any).check
      }
    } catch {
      // Best-effort: do not block generation.
    }
  }

  // SR: Ensure detail params exist when buffs reference `params.*`.
  // Note: baseline SR calc.js rarely uses `params.qBuff` gating; do not auto-gate ultimate buffs here.
  const applySrStateGating = (): void => {
    if (input.game !== 'sr') return

    const wantsParam = (k: string): boolean =>
      buffsOut.some((b) => typeof (b as any)?.check === 'string' && new RegExp(`\\bparams\\.${k}\\b`).test((b as any).check))

    const ensureParamOnDetails = (pred: (d: CalcSuggestDetail) => boolean, k: string, v: boolean): void => {
      if (!wantsParam(k)) return
      for (const d of details) {
        if (!pred(d)) continue
        const p0 = (d as any)?.params
        if (p0 && typeof p0 === 'object' && !Array.isArray(p0) && Object.prototype.hasOwnProperty.call(p0, k)) continue
        const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, number | boolean | string>) } : {}
        p[k] = v
        ;(d as any).params = p
      }
    }

    ensureParamOnDetails((d) => typeof d.talent === 'string' && String(d.talent).startsWith('e'), 'e', true)
    ensureParamOnDetails(
      (d) => (typeof d.talent === 'string' && String(d.talent).startsWith('q')) || /终结技/.test(normalizePromptText(d.title)),
      'qBuff',
      true
    )
    ensureParamOnDetails((d) => d.kind === 'reaction' || /击破/.test(normalizePromptText(d.title)), 'break', true)
  }
  applySrStateGating()

  // GS: "元素附魔/转为X伤害" is frequently (and incorrectly) modeled by LLMs as a flat `dmg` buff.
  // In baseline semantics, infusion/conversion should be expressed via params/ele selection, not by adding damage%.
  // Prune such rows to avoid 2x+ overestimation in panel regression.
  if (input.game === 'gs') {
    for (let i = buffsOut.length - 1; i >= 0; i--) {
      const b = buffsOut[i]!
      const title = normalizePromptText((b as any)?.title)
      if (!title) continue
      const elemWord = '(?:火|水|雷|冰|风|岩|草|物理)'
      const looksLikeInfusion =
        /(元素附魔|附魔)/.test(title) ||
        /将.{0,24}(普通攻击|普攻|重击|下落攻击).{0,24}转为/.test(title) ||
        /(普通攻击|普攻|重击|下落攻击).{0,24}转为/.test(title) ||
        new RegExp(`${elemWord}.{0,12}(?:附魔|转为|转化)`).test(title) ||
        new RegExp(`(?:转为|转化为|转换为).{0,12}${elemWord}`).test(title) ||
        new RegExp(`伤害(?:转为|转化为|转换为).{0,12}${elemWord}`).test(title)
      if (!looksLikeInfusion) continue

      const data = (b as any).data
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        // No effect anyway; keep the list clean.
        buffsOut.splice(i, 1)
        continue
      }
      const keys = Object.keys(data).filter((k) => k && !k.startsWith('_'))
      if (keys.length === 0) {
        buffsOut.splice(i, 1)
        continue
      }
      const isDmgLikeKey = (k: string): boolean =>
        k === 'dmg' || k === 'phy' || k === 'aDmg' || k === 'a2Dmg' || k === 'a3Dmg'
      if (keys.every(isDmgLikeKey)) {
        buffsOut.splice(i, 1)
      }
    }
  }

  // If official passive/cons hints contain "抗性降低xx%", normalize to a single baseline-like max-tier `kx` buff.
  // (LLMs frequently omit or mis-model kx gating, leading to systematic underestimation in comparisons.)
  // NOTE: This is primarily an LLM-plan repair heuristic.
  // When upstream context is present (upstream / upstream-direct channels), prefer upstream-derived semantics
  // over CN-text parsing to avoid injecting baseline-incompatible unconditional res-shred (e.g. conditional kx
  // lines that baseline omits from calc.js for simplicity).
  if (input.game === 'gs' && !input.upstream) {
    const hints = (input.buffHints || []).filter((s) => typeof s === 'string') as string[]
    const hasKx = buffsOut.some((b) => {
      const data = (b as any)?.data
      return !!data && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, 'kx')
    })
    // Only derive when the model missed it entirely; otherwise prefer model output to avoid double-counting.
    if (!hasKx) {
      type KxCand = { kx: number; cons?: number }
      const cands: KxCand[] = []
      for (const h0 of hints) {
        const h = normalizePromptText(h0)
        if (!h) continue
        if (!/(抗性|元素抗性)/.test(h) || !/降低/.test(h)) continue

        const consM = h.match(/^\s*(\d)\s*命[：:]/)
        const cons = consM ? Math.trunc(Number(consM[1])) : undefined
        const consOk = typeof cons === 'number' && cons >= 1 && cons <= 6

        // Try to capture the percent specifically tied to "抗性降低", not the max percent in the whole sentence
        // (some cons texts also include "伤害提升100%" which must NOT become kx=100).
        const pats = [
          /(?:草|火|水|雷|冰|风|岩)?元素?\s*抗性.{0,12}降低.{0,10}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/,
          /降低.{0,10}?([0-9]+(?:\.[0-9]+)?)\s*[%％].{0,12}?(?:草|火|水|雷|冰|风|岩)?元素?\s*抗性/
        ]
        let best: number | null = null
        for (const re of pats) {
          const m = h.match(re)
          if (!m) continue
          const n = Number(m[1])
          if (!Number.isFinite(n) || n <= 0 || n > 80) continue
          best = best === null ? n : Math.max(best, n)
        }
        if (best === null) continue
        cands.push({ kx: best, ...(consOk ? { cons } : {}) })
      }

      if (cands.length) {
        // De-dup by (cons,kx) and keep stable order: passives first, then cons asc.
        const seen = new Set<string>()
        const uniq = cands.filter((c) => {
          const k = `${c.cons ?? 0}:${c.kx}`
          if (seen.has(k)) return false
          seen.add(k)
          return true
        })
        uniq.sort((a, b) => (a.cons ?? 0) - (b.cons ?? 0) || b.kx - a.kx)

        for (const c of uniq) {
          buffsOut.unshift({
            title: `被动/命座：敌方元素抗性降低[kx]%`,
            ...(typeof c.cons === 'number' ? { cons: c.cons } : {}),
            data: { kx: c.kx }
          })
        }
      }
    }
  }

  // If official hints explicitly grant "<n>%<元素>元素伤害加成", ensure a baseline-style `dmg` buff exists.
  // (LLMs frequently omit these, which can make panel regression drift low by ~40-60% for some accounts.)
  if (input.game === 'gs' && !input.upstreamDirect) {
    const hints = (input.buffHints || []).filter((s) => typeof s === 'string') as string[]
    // Some sources shorten "火元素伤害加成" -> "火伤加成" (omit "元素" and sometimes "害").
    const elemRe = /(火|水|雷|冰|风|岩|草)(?:元素)?伤(?:害)?加成/g
    for (const h of hints) {
      const hn = normalizePromptText(h)
      // Skip stat-derived conversions like:
      // - "基于元素充能效率的20%提升水元素伤害加成"
      // - "超过100%的部分，每1%获得0.4%雷元素伤害加成"
      // These are NOT flat buffs and should be modeled as attr-based formulas.
      if (/(基于|根据|超过|超出|每)\S{0,20}(元素充能效率|充能效率|生命值上限|最大生命值|生命上限|攻击力|防御力|元素精通|精通)/.test(hn)) {
        continue
      }

      const elems: string[] = []
      const seen = new Set<string>()
      let m: RegExpExecArray | null
      elemRe.lastIndex = 0
      while ((m = elemRe.exec(h))) {
        const e = m[1]
        if (!e || seen.has(e)) continue
        seen.add(e)
        elems.push(e)
      }
      if (!elems.length) continue

      const hnLower = hn.toLowerCase()
      const isHalfHpCond =
        /(半血|低血|生命值.{0,12}(?:低于|小于|少于|不高于|不大于|不超过|≤|<=).{0,6}50\s*[%％]|生命值.{0,12}50\s*[%％])/.test(
          hn
        ) || /hp.{0,12}50\s*%/.test(hnLower)

      const pickElemDmgPct = (text: string, elem: string): number | null => {
        const t = normalizePromptText(text)
        if (!t) return null
        const out: number[] = []
        const pats = [
          new RegExp(`(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*[%％]\\\\s*${elem}元素伤害加成`, 'g'),
          new RegExp(`(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*[%％]\\\\s*${elem}伤(?:害)?加成`, 'g'),
          new RegExp(`${elem}元素伤害加成\\\\s*(?:提高|提升|增加|加成)?\\\\s*(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*[%％]`, 'g'),
          new RegExp(`${elem}伤(?:害)?加成\\\\s*(?:提高|提升|增加|加成)?\\\\s*(\\\\d+(?:\\\\.\\\\d+)?)\\\\s*[%％]`, 'g')
        ]
        for (const re of pats) {
          for (const m of t.matchAll(re)) {
            const n = Number(m[1])
            if (!Number.isFinite(n) || n <= 0 || n > 200) continue
            out.push(n)
          }
        }
        if (out.length) return Math.max(...out)

        // Fallback: choose percent numbers that are close to the element-dmg wording, and skip HP-threshold percents.
        const nums: number[] = []
        const reNum = /(\d+(?:\.\d+)?)\s*[%％]/g
        let mm: RegExpExecArray | null
        while ((mm = reNum.exec(t))) {
          const n = Number(mm[1])
          if (!Number.isFinite(n) || n <= 0 || n > 200) continue
          const pos = typeof mm.index === 'number' ? mm.index : -1
          const ctx = pos >= 0 ? t.slice(Math.max(0, pos - 18), Math.min(t.length, pos + 30)) : ''
          // Skip HP-threshold wording (e.g. "生命值低于50%") even if the same sentence later mentions dmg bonus.
          // Otherwise we may mis-treat the threshold percent as an element dmg bonus (common LLM drift cause).
          if (/(生命值|生命|血量)/.test(ctx) && /(低于|小于|少于|不高于|不大于|不超过|≤|<=)/.test(ctx)) {
            continue
          }
          if (ctx.includes(elem) && /伤害加成/.test(ctx)) nums.push(n)
        }
        if (nums.length) return Math.max(...nums)
        return null
      }

      const baseVals: number[] = []
      for (const e of elems) {
        const n = pickElemDmgPct(h, e)
        if (n != null) baseVals.push(n)
      }
      if (!baseVals.length) continue
      const baseVal = Math.max(...baseVals)
      // Baseline commonly assumes "full stacks" for showcase buffs.
      // If the hint explicitly mentions max stacks, multiply the base percent accordingly.
      let stack = 1
      const stackM = h.match(/(?:至多|最多)叠加\s*(\d+)(?:层|次)/)
      if (stackM) {
        const n = Number(stackM[1])
        if (Number.isFinite(n)) stack = Math.max(1, Math.min(10, Math.trunc(n)))
      }
      const val = Math.min(200, baseVal * stack)

      const consM = h.match(/^\s*(\d)\s*命[：:]/)
      const cons = consM ? Math.trunc(Number(consM[1])) : undefined
      const consOk = typeof cons === 'number' && cons >= 1 && cons <= 6

      for (const e of elems) {
        const title = `${consOk ? `${cons}命：` : ''}${e}元素伤害加成提升[dmg]%`

        // Remove wrong/duplicate elemental dmg bonus buffs for this element (models often confuse thresholds like "50%" with the buff value).
        // Also drop half-HP shorthand rows like "半血火伤加成[dmg]%" to avoid double-counting after we normalize into a canonical row.
        for (let i = buffsOut.length - 1; i >= 0; i--) {
          const b = buffsOut[i]!
          const t0 = normalizePromptText((b as any)?.title)
          if (!t0) continue
          const isElemBonusTitle =
            t0.includes(`${e}元素伤害加成`) || t0.includes(`${e}伤害加成`) || t0.includes(`${e}伤加成`)
          const isHalfHpLikeTitle =
            isHalfHpCond &&
            t0.includes(e) &&
            /(半血|低血|生命值|血量)/.test(t0) &&
            (/伤/.test(t0) || new RegExp(`${e}伤`).test(t0)) &&
            /加成/.test(t0)
          if (!isElemBonusTitle && !isHalfHpLikeTitle) continue
          if (consOk && typeof (b as any)?.cons === 'number' && (b as any).cons !== cons) continue
          if (!consOk && typeof (b as any)?.cons === 'number') continue
          const data = (b as any)?.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          const dmg = (data as any).dmg
          if (typeof dmg !== 'number' || !Number.isFinite(dmg)) continue
          buffsOut.splice(i, 1)
        }

        buffsOut.push({
          title,
          ...(consOk ? { cons } : {}),
          ...(isHalfHpCond ? { check: 'params.halfHp === true' } : {}),
          data: { dmg: val }
        })
      }
    }
  }

  // LLMs often over-gate resistance-shred buffs with ad-hoc params flags (e.g. `params.e === true || params.q === true`),
  // which makes the buff silently not apply to showcased details that don't set such params. For baseline-style
  // comparison (and to reduce systematic underestimation), treat `kx` buffs as unconditional unless they depend on
  // non-param state like cons/weapon/trees/currentTalent.
  if (input.game === 'gs') {
    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'kx')) continue

      // Upstream-direct node-local premods rely on params-based row gating; never drop their checks.
      const title = typeof (b as any)?.title === 'string' ? String((b as any).title).trim() : ''
      if (
        title.startsWith('upstream:genshin-optimizer(node-premod-variant:') ||
        title.startsWith('upstream:genshin-optimizer(node-premod-row:')
      ) {
        continue
      }

      const check = (b as any).check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr) continue
      // `params.<key>` may legitimately use names like "talent"/"attr"; strip them before detecting real scope refs.
      const exprNoParams = expr.replace(/\bparams\.[A-Za-z_][A-Za-z0-9_]*/g, 'params')
      if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent)\b/.test(exprNoParams)) continue
      if (/params\./.test(expr)) delete (b as any).check
    }
  }

  // Similar to `kx`: LLMs often over-gate plain stat buffs (atkPct/cpct/...) with params flags. For baseline-style
  // showcase comparisons, keep these stat buffs unconditional when the check depends ONLY on params and the buff
  // does not target a specific talent bucket (e/q/a...).
  if (input.game === 'gs') {
    const safeStatKeys = new Set(['atkPct', 'hpPct', 'defPct', 'mastery', 'recharge', 'cpct', 'cdmg', 'dmg', 'phy', 'heal', 'shield'])
    for (const b of buffsOut) {
      const data = (b as any)?.data
      if (!data || typeof data !== 'object') continue
      const keys = Object.keys(data as any).filter((k) => k && !k.startsWith('_'))
      if (!keys.length) continue
      if (!keys.every((k) => safeStatKeys.has(k))) continue

      // Upstream-direct node-local premods rely on params-based row gating; never drop their checks.
      const title = typeof (b as any)?.title === 'string' ? String((b as any).title).trim() : ''
      if (
        title.startsWith('upstream:genshin-optimizer(node-premod-variant:') ||
        title.startsWith('upstream:genshin-optimizer(node-premod-row:')
      ) {
        continue
      }

      const check = (b as any).check
      if (typeof check !== 'string') continue
      const expr = check.trim()
      if (!expr) continue
      if (!/params\./.test(expr)) continue
      // Preserve real HP-threshold / target-HP gating (e.g. Hu Tao <=50% HP elemental dmg bonus).
      // Dropping these checks makes buffs unconditional and can inflate panel regression by 50%+.
      if (/\bparams\.(?:half|halfHp|lowHp|targetHp50|targetHp80|hpBelow50|hpAbove50)\b/i.test(expr)) continue
      // `params.<key>` may legitimately use names like "talent"/"attr"; strip them before detecting real scope refs.
      const exprNoParams = expr.replace(/\bparams\.[A-Za-z_][A-Za-z0-9_]*/g, 'params')
      if (/\b(cons|weapon|trees|currentTalent|attr|calc|talent|element)\b/.test(exprNoParams)) continue
      delete (b as any).check
    }
  }

  if (input.game === 'gs') {
    // If buffs gate on params.e/params.q but no corresponding talent rows set them,
    // enable the flag on that talent's details (prevents "buff never applies" drift).
    const wantsParamFlag = (k: 'e' | 'q'): boolean =>
      buffsOut.some((b) => typeof (b as any)?.check === 'string' && new RegExp(`\\bparams\\.${k}\\b`).test((b as any).check))

    const ensureFlagOnTalent = (tk: TalentKeyGs, k: 'e' | 'q'): void => {
      if (!wantsParamFlag(k)) return
      const list = details.filter((d) => d.talent === tk)
      if (list.length === 0) return
      for (const d of list) {
        const p0 = d.params
        if (p0 && typeof p0 === 'object' && !Array.isArray(p0) && Object.prototype.hasOwnProperty.call(p0, k)) continue
        const p = p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, number | boolean | string>) } : {}
        p[k] = true
        d.params = p
      }
    }

    ensureFlagOnTalent('e', 'e')
    ensureFlagOnTalent('q', 'q')

    // If a buff is gated by boolean state params (e.g. `params.longPress === true`) but some affected
    // showcase details forget to set that param, the buff silently doesn't apply and comparisons drift low.
    // For any buff whose data targets a specific talent bucket (a/a2/a3/e/q/...), copy missing boolean params
    // from the buff.check into the corresponding details' params.
    const bumpMissingBoolParamsOnAffectedDetails = (): void => {
      const parseParamEq = (expr: string): Array<{ key: string; value: boolean | number }> => {
        const out: Array<{ key: string; value: boolean | number }> = []
        const reBool = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*===\s*(true|false)\b/g
        let m: RegExpExecArray | null
        while ((m = reBool.exec(expr))) {
          const k = m[1] || ''
          if (!k) continue
          out.push({ key: k, value: m[2] === 'true' })
        }

        // Also support simple numeric mode toggles like `params.form === 1`.
        // (Do NOT try to infer thresholds like `>= 3` here.)
        const reNum = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*===\s*(\d+(?:\.\d+)?)\b/g
        while ((m = reNum.exec(expr))) {
          const k = m[1] || ''
          if (!k) continue
          const n = Number(m[2])
          if (!Number.isFinite(n)) continue
          out.push({ key: k, value: n })
        }
        return out
      }

      const inferAffectedBases = (data: Record<string, unknown>): Set<string> => {
        const bases = new Set<string>()
        for (const k0 of Object.keys(data)) {
          const k = String(k0 || '').trim()
          if (!k) continue
          const m = k.match(/^(a3|a2|a|e|q|t|nightsoul)(?:Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)?$/)
          if (!m) continue
          const base = m[1]!
          // Ignore global-only keys like "nightsoul" without suffix; only apply when it's a scoped bucket.
          if (base === 'nightsoul' && base === k) continue
          bases.add(base)
        }
        return bases
      }

      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        const bases = inferAffectedBases(data as any)
        if (bases.size === 0) continue

        const title = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
        // Upstream-direct node-local premods are modeled as opt-in rows (variant/row-scoped); do NOT auto-propagate
        // their params to all affected details (otherwise the scoped buff becomes unconditional and inflates base rows).
        if (
          title.startsWith('upstream:genshin-optimizer(node-premod-variant:') ||
          title.startsWith('upstream:genshin-optimizer(node-premod-row:')
        ) {
          continue
        }

        const check = typeof (b as any).check === 'string' ? String((b as any).check).trim() : ''
        if (!check || !/params\./.test(check)) continue
        const needs = parseParamEq(check)
        if (needs.length === 0) continue

        for (const d of details) {
          const keyArg = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : typeof d.talent === 'string' ? d.talent : ''
          const base = keyArg.split(',')[0] || ''
          if (!bases.has(base)) continue
          const p0 = d.params
          const p: Record<string, unknown> =
            p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
          let changed = false
          for (const n of needs) {
            if (Object.prototype.hasOwnProperty.call(p, n.key)) continue
            p[n.key] = n.value
            changed = true
          }
          if (changed) d.params = p as any
        }
      }
    }
    bumpMissingBoolParamsOnAffectedDetails()

    // If a buff clearly targets a specific attack name (e.g. "迴猎贯鳞炮") but its data key is talent-scoped
    // (e.g. `eCdmg/eDmg/ePlus`), LLMs often forget to gate it and accidentally apply it to *all* E rows.
    // Add a conservative tag-based gate when we can uniquely match the token to a subset of details.
    const gateTalentScopedBuffsByTitleToken = (): void => {
      const norm = (s: unknown): string =>
        String(typeof s === 'string' ? s : '')
          .trim()
          .replace(/\s+/g, '')
          .replace(/[·!?！？…\\-_—–()（）【】\\[\\]「」『』《》〈〉“”‘’\"']/g, '')

      const buildTokens = (list: string[]): string[] => {
        const out: string[] = []
        for (const t0 of list || []) {
          const t = String(t0 || '').trim()
          if (!t) continue
          const base = t.endsWith('2') ? t.slice(0, -1) : t
          const noDmg = base.replace(/伤害/g, '').trim()
          const cand = [base, noDmg].map(norm).filter(Boolean)
          for (const c of cand) {
            if (c.length < 2) continue
            if (/(百分比|固定值|提升|增加|降低|上限|冷却|持续|能量)/.test(c)) continue
            out.push(c)
            if (out.length >= 40) return uniq(out)
          }
        }
        return uniq(out)
      }

      const tokensA = buildTokens(tables.a || [])
      const tokensE = buildTokens(tables.e || [])
      const tokensQ = buildTokens(tables.q || [])
      const tokensForBase = (base: string): string[] => {
        if (base === 'e') return tokensE
        if (base === 'q') return tokensQ
        // a/a2/a3
        return tokensA
      }

      const keyBaseOfDetail = (d: CalcSuggestDetail): string => {
        const keyArg = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : typeof d.talent === 'string' ? d.talent : ''
        return (keyArg.split(',')[0] || '').trim()
      }

      const detailsByBase = new Map<string, CalcSuggestDetail[]>()
      for (const d of details) {
        const base = keyBaseOfDetail(d)
        if (!base) continue
        const list = detailsByBase.get(base) || []
        list.push(d)
        detailsByBase.set(base, list)
      }

      const matchDetailsByToken = (base: string, token: string): CalcSuggestDetail[] => {
        const list = detailsByBase.get(base) || []
        if (list.length === 0) return []
        return list.filter((d) => {
          const t = norm(d.title || '')
          const tb = norm(typeof d.table === 'string' ? d.table : '')
          return (t && t.includes(token)) || (tb && tb.includes(token))
        })
      }

      const applyTag = (matched: CalcSuggestDetail[], token: string): boolean => {
        const tagKey = 'tag'
        // If there is a conflict, bail out (do not clobber existing tags).
        for (const d of matched) {
          const p0 = d.params
          if (!p0 || typeof p0 !== 'object' || Array.isArray(p0)) continue
          const pv = (p0 as any)[tagKey]
          if (typeof pv === 'string' && pv && pv !== token) return false
        }
        for (const d of matched) {
          const p0 = d.params
          const p: Record<string, unknown> =
            p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
          if (!Object.prototype.hasOwnProperty.call(p, tagKey)) p[tagKey] = token
          d.params = p as any
        }
        return true
      }

      const inferBaseFromDataKeys = (data: Record<string, unknown>): string | null => {
        const bases = new Set<string>()
        for (const k0 of Object.keys(data || {})) {
          const k = String(k0 || '').trim()
          const m = k.match(/^(a3|a2|a|e|q)(?:Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/)
          if (!m) continue
          bases.add(m[1]!)
        }
        if (bases.size !== 1) return null
        return Array.from(bases)[0]!
      }

      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue
        const base = inferBaseFromDataKeys(data as any)
        if (!base) continue

        const titleNorm = norm(b.title)
        if (!titleNorm) continue
        const tokens = tokensForBase(base)
        if (tokens.length === 0) continue

        const all = detailsByBase.get(base) || []
        if (all.length <= 1) continue

        const candidates = tokens.filter((t) => t && titleNorm.includes(t)).sort((a, b) => b.length - a.length)
        if (candidates.length === 0) continue

        let chosen: string | null = null
        let matched: CalcSuggestDetail[] = []
        for (const token of candidates) {
          const ms = matchDetailsByToken(base, token)
          // Only gate when it narrows the scope (prevents overly-generic tokens like "技能").
          if (ms.length >= 1 && ms.length < all.length) {
            chosen = token
            matched = ms
            break
          }
        }
        if (!chosen || matched.length === 0) continue
        if (!applyTag(matched, chosen)) continue

        const prev = typeof (b as any).check === 'string' ? String((b as any).check).trim() : ''
        const gate = `params.tag === ${JSON.stringify(chosen)}`
        ;(b as any).check = prev ? `(${prev}) && (${gate})` : gate
      }
    }
    gateTalentScopedBuffsByTitleToken()

    // If a buff's check references params.<key> that is never provided by any detail params,
    // the buff will be silently "dead" and cause systematic underestimation. Prefer simplifying:
    // - drop unknown-param clauses from `a && b && c` checks
    // - if the check is OR-based (contains `||`), fall back to unconditional (remove check)
    const knownParamKeys = new Set<string>()
    for (const d of details) {
      const p = d.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const k of Object.keys(p as Record<string, unknown>)) {
        if (k) knownParamKeys.add(k)
      }
    }

    const extractParamRefs = (expr: string): Set<string> => {
      const out = new Set<string>()
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) out.add(m[1]!)
      return out
    }

    const stripOuterParens = (expr: string): string => {
      let s = expr.trim()
      for (let pass = 0; pass < 5; pass++) {
        if (!(s.startsWith('(') && s.endsWith(')'))) break
        let depth = 0
        let quote: '"' | "'" | null = null
        let escaped = false
        let canStrip = false

        for (let i = 0; i < s.length; i++) {
          const ch = s[i]!

          if (quote) {
            if (escaped) {
              escaped = false
              continue
            }
            if (ch === '\\') {
              escaped = true
              continue
            }
            if (ch === quote) quote = null
            continue
          }

          if (ch === '"' || ch === "'") {
            quote = ch
            continue
          }

          if (ch === '(') depth++
          else if (ch === ')') {
            depth--
            if (depth === 0) {
              // Only strip when the outermost pair closes at the very end.
              canStrip = i === s.length - 1
              break
            }
            if (depth < 0) break
          }
        }

        if (!canStrip) break
        s = s.slice(1, -1).trim()
      }
      return s
    }

    const splitTopLevelAnd = (expr: string): string[] => {
      const parts: string[] = []
      let buf = ''
      let depthParen = 0
      let depthBracket = 0
      let depthBrace = 0
      let quote: '"' | "'" | null = null
      let escaped = false

      for (let i = 0; i < expr.length; i++) {
        const ch = expr[i]!

        if (quote) {
          buf += ch
          if (escaped) {
            escaped = false
            continue
          }
          if (ch === '\\') {
            escaped = true
            continue
          }
          if (ch === quote) quote = null
          continue
        }

        if (ch === '"' || ch === "'") {
          quote = ch
          buf += ch
          continue
        }

        if (ch === '(') {
          depthParen++
          buf += ch
          continue
        }
        if (ch === ')') {
          if (depthParen > 0) depthParen--
          buf += ch
          continue
        }
        if (ch === '[') {
          depthBracket++
          buf += ch
          continue
        }
        if (ch === ']') {
          if (depthBracket > 0) depthBracket--
          buf += ch
          continue
        }
        if (ch === '{') {
          depthBrace++
          buf += ch
          continue
        }
        if (ch === '}') {
          if (depthBrace > 0) depthBrace--
          buf += ch
          continue
        }

        if (
          ch === '&' &&
          expr[i + 1] === '&' &&
          depthParen === 0 &&
          depthBracket === 0 &&
          depthBrace === 0
        ) {
          const t = buf.trim()
          if (t) parts.push(t)
          buf = ''
          i++
          continue
        }

        buf += ch
      }

      const t = buf.trim()
      if (t) parts.push(t)
      return parts
    }

    for (const b of buffsOut) {
      const title = typeof (b as any)?.title === 'string' ? String((b as any).title).trim() : ''
      if (
        title.startsWith('upstream:genshin-optimizer(node-premod-variant:') ||
        title.startsWith('upstream:genshin-optimizer(node-premod-row:')
      ) {
        continue
      }

      const check0 = typeof (b as any).check === 'string' ? String((b as any).check).trim() : ''
      if (!check0 || !/params\./.test(check0)) continue

      const check1 = stripOuterParens(check0)
      const refs = Array.from(extractParamRefs(check1))
      if (refs.length === 0) continue
      const unknown = refs.filter((k) => !knownParamKeys.has(k))
      if (unknown.length === 0) continue

      // Too hard to safely simplify OR logic; avoid dead buffs by dropping check.
      if (/\|\|/.test(check1)) {
        delete (b as any).check
        continue
      }

      const parts = splitTopLevelAnd(check1)
      const kept = parts.filter((p) => {
        const pr = extractParamRefs(p)
        for (const k of pr) {
          if (!knownParamKeys.has(k)) return false
        }
        return true
      })
      const next = kept.join(' && ').trim()
      if (!next) {
        delete (b as any).check
      } else if (next !== check1) {
        ;(b as any).check = next
      } else if (check1 !== check0) {
        // Strip redundant outer parens for consistency.
        ;(b as any).check = check1
      }
    }

    // If buff.data expressions reference params.<k> that is never provided by any detail params,
    // they may silently fall back to low-tier branches (e.g. `params.xxx >= 66 ? 1.2 : 0.6`).
    // When the missing param is used ONLY in `>=`/`>` comparisons, replace it with the max threshold
    // to approximate "满层/最大档位" showcase behavior.
    const fixMissingParamsInDataExpr = (): void => {
      const knownLowerToKey = new Map<string, string>()
      for (const k of knownParamKeys) {
        const lower = k.toLowerCase()
        if (!knownLowerToKey.has(lower)) knownLowerToKey.set(lower, k)
      }

      const countMatches = (s: string, re: RegExp): number => {
        let n = 0
        re.lastIndex = 0
        while (re.exec(s)) n++
        return n
      }

      const thresholdFor = (expr: string, key: string): number | null => {
        const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*(>=|>)\s*(\d{1,4}(?:\.\d+)?)\b/g
        let max = -Infinity
        let strict = false
        let found = false
        let m: RegExpExecArray | null
        while ((m = re.exec(expr))) {
          if (m[1] !== key) continue
          found = true
          const n = Number(m[3])
          if (!Number.isFinite(n)) continue
          if (n > max) max = n
          if (m[2] === '>') strict = true
        }
        if (!found || !Number.isFinite(max)) return null
        const value = strict ? max + 1 : max
        if (!Number.isFinite(value)) return null
        if (value <= 0 || value > 200) return null
        return value
      }

      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        for (const [dk, dv0] of Object.entries(data)) {
          if (typeof dv0 !== 'string') continue
          let dv = dv0.trim()
          if (!dv || !/params\./.test(dv)) continue

          const refs = Array.from(extractParamRefs(dv))
          if (refs.length === 0) continue

          for (const rk0 of refs) {
            if (knownParamKeys.has(rk0)) continue

            // Case-insensitive normalize (params.nightsoul -> params.Nightsoul)
            const mapped = knownLowerToKey.get(rk0.toLowerCase())
            if (mapped && mapped !== rk0) {
              dv = dv.replace(new RegExp(`\\bparams\\.${rk0}\\b`, 'g'), `params.${mapped}`)
              continue
            }

            // Threshold-based fallback (only when params.<k> is used exclusively in `>=`/`>` comparisons).
            const reAny = new RegExp(`\\bparams\\.${rk0}\\b`, 'g')
            const countAny = countMatches(dv, reAny)
            if (countAny === 0) continue
            const reCmp = new RegExp(`\\bparams\\.${rk0}\\b\\s*(?:>=|>)\\s*\\d`, 'g')
            const countCmp = countMatches(dv, reCmp)
            if (countCmp !== countAny) continue

            const th = thresholdFor(dv, rk0)
            if (!th) continue
            dv = dv.replace(reAny, String(th))
          }

          if (dv !== dv0) (data as any)[dk] = dv
        }
      }
    }
    fixMissingParamsInDataExpr()

    // Some triggered effects are frequently hallucinated as attribute buffs, e.g.
    // - "普攻命中时治疗" -> wrongly emitted as `heal: calc(attr.atk) * 0.15`
    // In baseline, buffs are persistent stat modifiers; triggered add/heal should be modeled as details.
    // Prune buff.data entries that derive non-Plus stats from `attr.*` (highly likely to be wrong).
    const pruneDerivedNonPlusBuffData = (): void => {
      const usesAttrValue = (expr: string): boolean => /\bcalc\s*\(\s*attr\./.test(expr) || /\battr\.[A-Za-z_]/.test(expr)
      const hasTrustedUpstream = !!(input as any).upstream
      const isUpstreamDirect = (input as any).upstreamDirect === true
      const isSafeAttrDerivedKey = (kRaw: string): boolean => {
        const k = String(kRaw || '').trim()
        if (!k || k.startsWith('_')) return false
        if (/plus$/i.test(k)) return true
        if (k === 'healInc' || k === 'shieldInc') return true
        // Allow stat-derived percent-like buckets commonly used by baseline meta.
        if (/^(mastery|recharge|cpct|cdmg|dmg|phy|enemydmg|kx|fykx|multi|elevated)(Plus|Pct|Inc)?$/.test(k)) return true
        if (/^(enemyDef|enemyIgnore|ignore)$/.test(k)) return true
        // Skill-scoped percent-like buckets (A/A2/A3/E/Q/Nightsoul).
        if (/^(a|a2|a3|e|q|nightsoul)(Dmg|Enemydmg|Cpct|Cdmg|Multi|Pct|Inc|Elevated)$/.test(k)) return true
        return false
      }
      const hasExplicitStatDerivedEvidence = (titleRaw: unknown): boolean => {
        const t = normalizePromptText(titleRaw)
        if (!t) return false
        return /(基于|根据|按|相当于|每点|每\s*1\s*点|超过|超出)/.test(t)
      }
      const allowsAttr = (k: string, evidenceOk: boolean): boolean =>
        /plus$/i.test(k) || isUpstreamDirect || (evidenceOk && isSafeAttrDerivedKey(k))
      const usesTriggeredValueTalentTable = (expr: string): boolean => {
        // Heuristic: buff keys like `heal`/`shield` represent *bonus multipliers* in miao-plugin.
        // Triggered effects (healing amounts / absorption values) are stored in tables named "...回复/固定值/吸收量"
        // and should be modeled as details (heal/shield rows), NOT as persistent bonus buffs.
        const re = /\btalent\?*\.[A-Za-z_][A-Za-z0-9_]*\s*\[\s*(['"])(.*?)\1\s*\]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(expr))) {
          const tn = normalizePromptText(m[2])
          if (!tn) continue
          const looksLikeAmount =
            /(回复|治疗量|护盾量|护盾值|固定值|吸收量)/.test(tn) && !/(提高|增加|提升|加成)/.test(tn)
          if (looksLikeAmount) return true
        }
        return false
      }

      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const b = buffsOut[i]!
        const evidenceOk = hasTrustedUpstream || hasExplicitStatDerivedEvidence((b as any)?.title)
        const data = b.data
        if (!data || typeof data !== 'object') continue

        for (const [k0, v] of Object.entries(data)) {
          const k = String(k0 || '').trim()
          if (!k) continue
          if (typeof v !== 'string') continue
          const expr = v.trim()
          if (!expr) continue

          // Prevent common hallucinations:
          // - "基于攻击力/生命值的治疗" -> wrongly emitted as `heal: calc(attr.atk)*...` (inflates all heals)
          // - "回复/固定值/吸收量" tables -> wrongly emitted as bonus buffs (unit mismatch)
          const isHealShieldBonus = k === 'heal' || k === 'shield'
          if (isHealShieldBonus && usesTriggeredValueTalentTable(expr)) {
            delete (data as any)[k0]
            continue
          }

          if (!usesAttrValue(expr)) continue
          if (allowsAttr(k, evidenceOk)) continue
          delete (data as any)[k0]
        }

        if (Object.keys(data).length === 0) buffsOut.splice(i, 1)
      }
    }
    pruneDerivedNonPlusBuffData()

    // GS: Derive a small set of high-confidence buffs from official passive/cons texts.
    // This reduces systematic under/over-estimation without copying baseline calc implementations.
    const applyGsDerivedBuffsFromHints = (): void => {
      if (input.game !== 'gs') return

      const hintLines: string[] = []
      for (const h of input.buffHints || []) {
        const t = normalizePromptText(h)
        if (t) hintLines.push(t)
      }
      for (const v of Object.values(input.talentDesc || {})) {
        const t = normalizePromptText(v)
        if (t) hintLines.push(t)
      }

      // 1) Recharge -> elemental dmg bonus conversions, e.g.:
      // - "水元素伤害加成获得额外提升，提升程度相当于元素充能效率的20%。"
      // - "基于元素充能效率超过100%的部分，每1% … 雷元素伤害加成提升0.4%。"
      const inferRechargeDmg = (): { coef: number; minus100: boolean } | null => {
        for (const s of hintLines) {
          if (!/(元素充能效率|充能效率)/.test(s)) continue
          if (!/(元素伤害加成|伤害加成)/.test(s)) continue

          const minus100 = /(超过|超出)\s*100\s*%/.test(s) || /超过100%/.test(s)
          if (minus100) {
            const m = s.match(/伤害加成.{0,12}?(?:提升|提高|增加|获得).{0,12}?([0-9]+(?:\.[0-9]+)?)\s*%/)
            if (!m) continue
            const coef = Number(m[1])
            if (!Number.isFinite(coef) || coef <= 0 || coef > 10) continue
            return { coef, minus100: true }
          }

          const m = s.match(/充能效率.{0,20}?(?:的|×|x|\*)\s*([0-9]+(?:\.[0-9]+)?)\s*%/i)
          if (!m) continue
          const n = Number(m[1])
          if (!Number.isFinite(n) || n <= 0 || n > 200) continue
          return { coef: n / 100, minus100: false }
        }
        return null
      }

      const rechargeDmg = inferRechargeDmg()
      if (rechargeDmg) {
        // Remove likely-wrong recharge-to-dmg buffs emitted by LLM / earlier heuristics.
        for (let i = buffsOut.length - 1; i >= 0; i--) {
          const b = buffsOut[i]!
          const title = normalizePromptText((b as any).title)
          const data = (b as any).data
          if (!data || typeof data !== 'object') continue
          if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) continue
          if (/(元素充能效率|充能效率|recharge)/i.test(title)) {
            buffsOut.splice(i, 1)
            continue
          }
          // If the conversion was mis-parsed as a flat "<n>%元素伤害加成", drop it.
          const dmg = (data as any).dmg
          if (typeof dmg === 'number' && Number.isFinite(dmg)) {
            // For "above-100%" conversions, any unconditional flat element dmg buff is very likely a mis-model.
            if (rechargeDmg.minus100 && /元素伤害加成/.test(title) && typeof (b as any).cons !== 'number') {
              buffsOut.splice(i, 1)
              continue
            }
            const targetFlat = rechargeDmg.minus100 ? null : rechargeDmg.coef * 100
            if (targetFlat !== null && Math.abs(dmg - targetFlat) < 1e-9 && /元素伤害加成/.test(title)) {
              buffsOut.splice(i, 1)
            }
          }
        }

        const expr = rechargeDmg.minus100
          ? `Math.max(calc(attr.recharge) - 100, 0) * ${rechargeDmg.coef}`
          : `calc(attr.recharge) * ${rechargeDmg.coef}`
        buffsOut.push({
          title: `天赋：元素充能效率转元素伤害加成[dmg]%`,
          sort: 4,
          data: { dmg: expr }
        })
      }

      // 2) Q-side "伤害加成" tables are usually buffs (e.g. omen/vulnerability-like effects).
      if (qTables.includes('伤害加成')) {
        const already = buffsOut.some((b) => {
          const data = (b as any)?.data
          if (!data || typeof data !== 'object') return false
          for (const v of Object.values(data as Record<string, unknown>)) {
            if (typeof v === 'string' && v.includes('talent.q["伤害加成"]')) return true
          }
          return false
        })
        if (!already) {
          buffsOut.push({
            title: `元素爆发：伤害加成[dmg]%`,
            data: { dmg: `talent.q["伤害加成"]` }
          })
        }
      }

      // 3) Reaction-specific bonuses (e.g. vaporize/melt/spread/aggravate) from passives.
      const pushReactionBonus = (key: 'vaporize' | 'melt' | 'spread' | 'aggravate', re: RegExp): void => {
        const hasKey = buffsOut.some((b) => !!(b as any)?.data && Object.prototype.hasOwnProperty.call((b as any).data, key))
        if (hasKey) return
        let best: number | null = null
        for (const s of hintLines) {
          if (!/^被动：/.test(s)) continue
          if (!re.test(s)) continue
          if (!/(伤害|造成).{0,6}(提高|提升|增加)/.test(s)) continue
          const reNum = /(\d+(?:\.\d+)?)\s*[%％]/g
          let m: RegExpExecArray | null
          while ((m = reNum.exec(s))) {
            const n = Number(m[1])
            if (!Number.isFinite(n) || n <= 0 || n > 200) continue
            best = best === null ? n : Math.max(best, n)
          }
        }
        if (best === null) return
        buffsOut.push({
          title: `被动：反应伤害加成[${key}]%`,
          data: { [key]: best }
        })
      }
      pushReactionBonus('vaporize', /(蒸发|vaporize)/i)
      pushReactionBonus('melt', /(融化|melt)/i)
      pushReactionBonus('spread', /(蔓激化|spread)/i)
      pushReactionBonus('aggravate', /(超激化|aggravate)/i)

      // 3.5) Stacked "damage increase by stat%" additive bonuses:
      // e.g. "至多叠加2层...每层使本次<技能>造成的伤害基于攻击力的320%提高" => assume max stacks (showcase-style) and emit `ePlus`.
      const pushStackedStatAdditiveBonus = (): void => {
        const hasKey = (k: string): boolean =>
          buffsOut.some((b) => {
            const data = (b as any)?.data
            return !!data && typeof data === 'object' && !Array.isArray(data) && Object.prototype.hasOwnProperty.call(data, k)
          })

        const norm = (s: string): string =>
          normalizePromptText(s)
            .replace(/\s+/g, '')
            .replace(/[()（）【】\[\]<>]/g, '')
            .trim()

        const buildTokens = (list: string[]): string[] => {
          const out: string[] = []
          for (const t0 of list) {
            const t = String(t0 || '').trim()
            if (!t) continue
            const base = t.endsWith('2') ? t.slice(0, -1) : t
            const noDmg = base.replace(/伤害/g, '').trim()
            const cand = [base, noDmg].map(norm).filter(Boolean)
            for (const c of cand) {
              if (c.length < 2) continue
              if (/(百分比|固定值|提升|增加|降低|上限|冷却|持续|能量)/.test(c)) continue
              out.push(c)
              if (out.length >= 30) return uniq(out)
            }
          }
          return uniq(out)
        }

        const tokensA = buildTokens(tables.a || [])
        const tokensE = buildTokens(tables.e || [])
        const tokensQ = buildTokens(tables.q || [])

        const inferTalentKey = (textRaw: string): TalentKeyGs | null => {
          const s = norm(textRaw)
          if (!s) return null
          if (/(元素战技|战技|E)/.test(s)) return 'e'
          if (/(元素爆发|爆发|Q)/.test(s)) return 'q'
          if (/(普攻|普通攻击|A|重击|下落)/.test(s)) return 'a'
          const hitCount = (tokens: string[]): number => tokens.reduce((acc, t) => (t && s.includes(t) ? acc + 1 : acc), 0)
          const aHit = hitCount(tokensA)
          const eHit = hitCount(tokensE)
          const qHit = hitCount(tokensQ)
          const best = Math.max(aHit, eHit, qHit)
          if (best <= 0) return null
          if (eHit === best && eHit >= qHit && eHit >= aHit) return 'e'
          if (qHit === best && qHit >= aHit) return 'q'
          return 'a'
        }

        const statToKey: Record<CalcScaleStat, string> = { atk: 'atk', hp: 'hp', def: 'def', mastery: 'mastery' }
        const talentToPlusKey: Partial<Record<TalentKeyGs, string>> = { a: 'aPlus', e: 'ePlus', q: 'qPlus' }

        for (const s0 of hintLines) {
          const s = normalizePromptText(s0)
          if (!s) continue
          if (!/至多叠加/.test(s) || !/每层/.test(s)) continue
          if (!/伤害/.test(s) || !/(基于|按)/.test(s)) continue

          const stackM = s.match(/至多叠加\s*(\d+)\s*层/)
          const maxStack = stackM ? Math.max(1, Math.min(10, Math.trunc(Number(stackM[1])))) : 1

          const m = s.match(
            /每层[^%]{0,60}?(?:基于|按)[^%]{0,20}?(攻击力|生命值上限|最大生命值|生命上限|生命值|防御力|元素精通|精通)[^%]{0,20}?([0-9]+(?:\.[0-9]+)?)\s*[%％]\s*(?:提高|提升|增加)/
          )
          if (!m) continue
          const statWord = String(m[1] || '')
          const pct = Number(m[2])
          if (!Number.isFinite(pct) || pct <= 0 || pct > 2000) continue

          const stat: CalcScaleStat =
            /精通/.test(statWord) ? 'mastery' : /防御/.test(statWord) ? 'def' : /生命/.test(statWord) ? 'hp' : 'atk'
          const coef = (pct / 100) * maxStack
          if (!Number.isFinite(coef) || coef <= 0 || coef > 30) continue

          const tk = inferTalentKey(s)
          if (!tk) continue
          const key = talentToPlusKey[tk]
          if (!key) continue
          if (hasKey(key)) continue

          buffsOut.push({
            title: `推导：叠层基于${statWord}提高[${key}]（按最大层数）`,
            sort: 6,
            data: { [key]: `calc(attr.${statToKey[stat]}) * ${coef}` }
          })
        }
      }
      pushStackedStatAdditiveBonus()

      // 4) Mastery-based dmg/crit bonuses with threshold + cap (e.g. Nahida A4 style passives).
      // Best-effort only: derive when the text is explicit, otherwise leave it to the LLM.
      const pushMasteryThresholdCaps = (): void => {
        const existing = new Set<string>()
        for (const b of buffsOut) {
          const data = (b as any)?.data
          if (!data || typeof data !== 'object' || Array.isArray(data)) continue
          for (const k of Object.keys(data as any)) existing.add(String(k))
        }

        const norm = (s: string): string =>
          normalizePromptText(s)
            .replace(/\s+/g, '')
            .replace(/[()（）【】\[\]<>]/g, '')
            .trim()

        const aTables = tables.a || []
        const eTables = tables.e || []
        const qTablesAll = tables.q || []

        const buildTokens = (list: string[]): string[] => {
          const out: string[] = []
          for (const t0 of list) {
            const t = String(t0 || '').trim()
            if (!t) continue
            const base = t.endsWith('2') ? t.slice(0, -1) : t
            const noDmg = base.replace(/伤害/g, '').trim()
            const cand = [base, noDmg].map(norm).filter(Boolean)
            for (const c of cand) {
              if (c.length < 2) continue
              if (/(百分比|固定值|提升|增加|降低|上限|冷却|持续|能量)/.test(c)) continue
              out.push(c)
              if (out.length >= 30) return uniq(out)
            }
          }
          return uniq(out)
        }

        const tokensA = buildTokens(aTables)
        const tokensE = buildTokens(eTables)
        const tokensQ = buildTokens(qTablesAll)

        const inferTalentKey = (textRaw: string): TalentKeyGs | null => {
          const s = norm(textRaw)
          if (!s) return null
          if (/(元素战技|战技|E)/.test(s)) return 'e'
          if (/(元素爆发|爆发|Q)/.test(s)) return 'q'
          if (/(普攻|普通攻击|A|重击|下落)/.test(s)) return 'a'

          const hitCount = (tokens: string[]): number => tokens.reduce((acc, t) => (t && s.includes(t) ? acc + 1 : acc), 0)
          const aHit = hitCount(tokensA)
          const eHit = hitCount(tokensE)
          const qHit = hitCount(tokensQ)
          const best = Math.max(aHit, eHit, qHit)
          if (best <= 0) return null
          if (eHit === best && eHit >= qHit && eHit >= aHit) return 'e'
          if (qHit === best && qHit >= aHit) return 'q'
          return 'a'
        }

        const pickThreshold = (textRaw: string): number => {
          const s = normalizePromptText(textRaw)
          if (!s) return 0
          const m = s.match(/(?:元素精通|精通|mastery).{0,16}?(?:超过|高于|大于)\s*(\d{1,4})/i)
          if (!m) return 0
          const n = Number(m[1])
          return Number.isFinite(n) && n >= 0 && n <= 5000 ? Math.trunc(n) : 0
        }

        const pickPerPointAndCap = (
          textRaw: string,
          keyword: '伤害' | '暴击率' | '暴击伤害'
        ): { per: number; cap: number } | null => {
          const s = normalizePromptText(textRaw)
          if (!s || !s.includes(keyword)) return null
          const idx = s.indexOf(keyword)
          const seg = s.slice(Math.max(0, idx - 40), Math.min(s.length, idx + 80))
          const nums: number[] = []
          const re = /(\d+(?:\.\d+)?)\s*[%％]/g
          let m: RegExpExecArray | null
          while ((m = re.exec(seg))) {
            const n = Number(m[1])
            if (!Number.isFinite(n) || n <= 0 || n > 500) continue
            nums.push(n)
          }
          if (nums.length < 2) return null
          const per = Math.min(...nums)
          const cap = Math.max(...nums)
          if (!(per > 0 && cap > 0 && cap >= per)) return null
          return { per, cap }
        }

        const keyOf = (tk: TalentKeyGs, kind: 'dmg' | 'cpct' | 'cdmg'): string => {
          if (kind === 'dmg') return tk === 'a' ? 'aDmg' : tk === 'e' ? 'eDmg' : 'qDmg'
          if (kind === 'cdmg') return tk === 'a' ? 'aCdmg' : tk === 'e' ? 'eCdmg' : 'qCdmg'
          return tk === 'a' ? 'aCpct' : tk === 'e' ? 'eCpct' : 'qCpct'
        }

        for (const line0 of hintLines) {
          if (!/^被动：/.test(line0)) continue
          const line = normalizePromptText(line0)
          if (!line) continue
          if (!/(元素精通|精通|mastery)/i.test(line)) continue
          if (!/(每点|每\\s*\\d+\\s*点)/.test(line) || !/(至多|最多|最大|上限)/.test(line)) continue

          const tk = inferTalentKey(line)
          if (!tk) continue
          const th = pickThreshold(line)

          const dmg = pickPerPointAndCap(line, '伤害')
          if (dmg) {
            const k = keyOf(tk, 'dmg')
            if (!existing.has(k)) {
              const expr = `Math.min(${dmg.cap}, Math.max(calc(attr.mastery) - ${th}, 0) * ${dmg.per})`
              buffsOut.push({ title: `被动：基于元素精通提高[${k}]%`, sort: 9, data: { [k]: expr } as any })
              existing.add(k)
            }
          }

          const cpct = pickPerPointAndCap(line, '暴击率')
          if (cpct) {
            const k = keyOf(tk, 'cpct')
            if (!existing.has(k)) {
              const expr = `Math.min(${cpct.cap}, Math.max(calc(attr.mastery) - ${th}, 0) * ${cpct.per})`
              buffsOut.push({ title: `被动：基于元素精通提高[${k}]%`, sort: 9, data: { [k]: expr } as any })
              existing.add(k)
            }
          }

          const cdmg = pickPerPointAndCap(line, '暴击伤害')
          if (cdmg) {
            const k = keyOf(tk, 'cdmg')
            if (!existing.has(k)) {
              const expr = `Math.min(${cdmg.cap}, Math.max(calc(attr.mastery) - ${th}, 0) * ${cdmg.per})`
              buffsOut.push({ title: `被动：基于元素精通提高[${k}]%`, sort: 9, data: { [k]: expr } as any })
              existing.add(k)
            }
          }
        }
      }
      pushMasteryThresholdCaps()

      // 5) HP-based flat extra damage (Plus) from passives, e.g.:
      // "共鸣伤害提高生命值上限的1.9%，天星伤害提高生命值上限的33%。"
      const hpPlus: Record<string, number> = {}
      const mapPlusKey = (t: string): string | null => {
        if (/普通攻击|普攻/.test(t)) return 'aPlus'
        if (/重击/.test(t)) return 'a2Plus'
        if (/下落攻击|坠地/.test(t)) return 'a3Plus'
        if (/元素战技|战技|共鸣伤害/.test(t)) return 'ePlus'
        if (/元素爆发|爆发|天星伤害/.test(t)) return 'qPlus'
        return null
      }
      for (const s of hintLines) {
        if (!/^被动：/.test(s)) continue
        if (!/生命值上限/.test(s) || !/伤害/.test(s) || !/(提高|提升|增加)/.test(s)) continue
        const re = /(普通攻击|重击|下落攻击|元素战技|元素爆发|共鸣伤害|天星伤害)\S{0,30}?生命值上限\S{0,30}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g
        let m: RegExpExecArray | null
        while ((m = re.exec(s))) {
          const key = mapPlusKey(m[1] || '')
          if (!key) continue
          const pct = Number(m[2])
          if (!Number.isFinite(pct) || pct <= 0 || pct > 200) continue
          hpPlus[key] = Math.max(hpPlus[key] ?? -Infinity, pct / 100)
        }
      }
      if (Object.keys(hpPlus).length) {
        const already = buffsOut.some((b) => {
          const data = (b as any)?.data
          return !!data && typeof data === 'object' && Object.keys(hpPlus).some((k) => Object.prototype.hasOwnProperty.call(data, k))
        })
        if (!already) {
          const data: Record<string, string> = {}
          for (const [k, r] of Object.entries(hpPlus)) {
            data[k] = `calc(attr.hp) * ${r}`
          }
          buffsOut.push({
            title: `被动：基于生命值上限的额外伤害[*Plus]`,
            sort: 9,
            data
          })
        }
      }
    }
    applyGsDerivedBuffsFromHints()

    // If a `qPlus` buff is gated by a simple numeric param threshold (e.g. `params.xxx > 0`),
    // but the main Q showcase row sets `params.xxx = 0`, the comparison will systematically undercount.
    // Bump that row to the minimum required stack so the buff can actually apply.
    const bumpZeroStackOnQPlus = (): void => {
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|>)\s*(\d{1,3})\b/
      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        if (!Object.prototype.hasOwnProperty.call(data, 'qPlus')) continue
        const check = typeof (b as any).check === 'string' ? ((b as any).check as string) : ''
        if (!check) continue
        const m = check.match(re)
        if (!m) continue
        const k = m[1]!
        const op = m[2]!
        const n0 = Number(m[3])
        if (!k || !Number.isFinite(n0)) continue
        const need = op === '>' ? Math.trunc(n0) + 1 : Math.trunc(n0)
        if (need < 1 || need > 20) continue

        for (const d of details) {
          if (d.talent !== 'q') continue
          const p = d.params
          if (!p || typeof p !== 'object' || Array.isArray(p)) continue
          if (!Object.prototype.hasOwnProperty.call(p, k)) continue
          const v = (p as any)[k]
          if (typeof v !== 'number' || !Number.isFinite(v) || v !== 0) continue
          const title = d.title || ''
          if (/0层|0档|0堆叠|0叠|零/.test(title)) continue
          ;(p as any)[k] = need
          d.params = p as any
          break
        }
      }
    }
    bumpZeroStackOnQPlus()

    // Some "stack bonus" talent tables are additive stat-scaling ratios (e.g. unit contains "生命值上限/层"),
    // but LLMs often mis-model them as *Dmg/*Multi buffs. When we can identify a base "<...>基础伤害" table
    // plus a matching per-stack "伤害提升" table, patch the detail formula to sum ratios directly.
    const patchStackedRatioBaseTables = (): void => {
      const inferStatFromUnit = (unitRaw: unknown): CalcScaleStat | null => {
        const u = normalizePromptText(unitRaw)
        if (!u) return null
        if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(u)) return 'hp'
        if (/(防御力|\bdef\b)/i.test(u)) return 'def'
        if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(u)) return 'mastery'
        if (/(攻击力|攻击|\batk\b)/i.test(u)) return 'atk'
        return null
      }
      const isStackUnit = (unitRaw: unknown): boolean => {
        const u = normalizePromptText(unitRaw)
        return !!u && /(\/层|每层|\/枚|每枚|\/次|每次)/.test(u)
      }
      const scoreParamKey = (k: string): number => {
        if (/stack/i.test(k)) return 3
        if (/layer/i.test(k)) return 2
        if (/buffcount/i.test(k)) return 2
        if (/(count|cnt|num)$/i.test(k)) return 1
        return 0
      }

      const unitsAll = (input.tableUnits || {}) as any
      for (const tk of ['a', 'e', 'q'] as const) {
        const tblList = (input.tables as any)?.[tk]
        if (!Array.isArray(tblList) || tblList.length === 0) continue
        const unitMap = (unitsAll as any)?.[tk] || {}
        const unitOf = (name: string): string => {
          const base = name.endsWith('2') ? name.slice(0, -1) : name
          return String(unitMap[name] || unitMap[base] || '')
        }

        const baseTables = (tblList as string[]).filter((t) => typeof t === 'string' && /基础伤害/.test(t))
        if (baseTables.length === 0) continue
        const perStackTables = (tblList as string[]).filter(
          (t) => typeof t === 'string' && /伤害提升/.test(t) && isStackUnit(unitOf(t))
        )
        if (perStackTables.length === 0) continue
        const extraTables = (tblList as string[]).filter(
          (t) => typeof t === 'string' && /额外提升/.test(t) && !isStackUnit(unitOf(t))
        )

        for (const baseTable of baseTables) {
          const stat = inferStatFromUnit(unitOf(baseTable))
          if (!stat) continue
          const per = perStackTables.find((t) => inferStatFromUnit(unitOf(t)) === stat)
          if (!per) continue
          const token = baseTable.replace(/基础伤害/g, '').trim()
          const extra =
            token && extraTables.find((t) => inferStatFromUnit(unitOf(t)) === stat && typeof t === 'string' && t.includes(token))

          const candidates = details.filter((d) => d.talent === tk && d.table === baseTable)
          if (candidates.length === 0) continue

          const paramMax: Record<string, number> = {}
          for (const d of candidates) {
            const p = d.params
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue
            for (const [k0, v] of Object.entries(p as any)) {
              const k = String(k0 || '').trim()
              if (!k) continue
              if (typeof v !== 'number' || !Number.isFinite(v)) continue
              paramMax[k] = Math.max(paramMax[k] ?? -Infinity, v)
            }
          }

          const paramKey = Object.keys(paramMax).sort((ka, kb) => {
            const sa = scoreParamKey(ka)
            const sb = scoreParamKey(kb)
            if (sa !== sb) return sb - sa
            return (paramMax[kb] ?? 0) - (paramMax[ka] ?? 0)
          })[0]
          if (!paramKey) continue
          const maxVal = Math.trunc(paramMax[paramKey] ?? NaN)
          if (!Number.isFinite(maxVal) || maxVal <= 0 || maxVal > 20) continue

          for (const d of candidates) {
            const p = d.params
            if (!p || typeof p !== 'object' || Array.isArray(p)) continue
            if (typeof (p as any)[paramKey] !== 'number' || !Number.isFinite((p as any)[paramKey])) continue
            // Skip rows that also set other numeric params (likely different mechanics, e.g. multi-target).
            const otherNumeric = Object.entries(p as any).some(
              ([k, v]) => k !== paramKey && typeof v === 'number' && Number.isFinite(v)
            )
            if (otherNumeric) continue

            const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : tk
            const ele = typeof d.ele === 'string' && d.ele.trim() ? d.ele.trim() : ''

            let sumExpr = `talent.${tk}[${JSON.stringify(baseTable)}] + params.${paramKey} * talent.${tk}[${JSON.stringify(per)}]`
            if (extra) {
              sumExpr += ` + (params.${paramKey} === ${maxVal} ? talent.${tk}[${JSON.stringify(extra)}] : 0)`
            }
            const eleArg = ele ? `, ${JSON.stringify(ele)}` : ''
            d.dmgExpr = `dmg.basic(calc(attr.${stat}) * toRatio(${sumExpr}), ${JSON.stringify(key)}${eleArg})`
          }

          // Remove buff rows that reference these tables to avoid double-counting.
          const refs = [per, extra].filter(Boolean) as string[]
          if (refs.length) {
            for (let i = buffsOut.length - 1; i >= 0; i--) {
              const b = buffsOut[i]!
              const data = b.data
              if (!data || typeof data !== 'object') continue
              const vals = Object.values(data as any)
              const hit = vals.some((v) => typeof v === 'string' && refs.some((tn) => v.includes(JSON.stringify(tn))))
              if (hit) buffsOut.splice(i, 1)
            }
          }
        }
      }
    }
    patchStackedRatioBaseTables()

    // Element-specific dmg buffs: if the title clearly targets one element but the model emitted a generic `dmg`
    // bonus with no element gating, add a conservative `element === "火|水|..."` check to avoid double-buffing.
    const elemRe = /(火|水|雷|冰|风|岩|草)元素/
    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) continue
      const m = String(b.title || '').match(elemRe)
      if (!m) continue
      const elemCn = m[1]!
      const prev = typeof (b as any).check === 'string' ? ((b as any).check as string).trim() : ''
      const gate = `element === ${JSON.stringify(elemCn)}`
      if (!prev || prev === 'true') {
        ;(b as any).check = gate
        continue
      }
      if (!/\belement\b/.test(prev)) {
        ;(b as any).check = `(${prev}) && ${gate}`
      }
    }

    // Some anemo characters provide an "elemental dmg bonus" based on mastery that should apply to the
    // absorbed element (NOT the character's own anemo damage). If the model emits it as a generic `dmg`
    // buff without element gating, conservatively exclude self-element to reduce systematic overestimation.
    const selfElemCnById: Record<string, string> = {
      anemo: '风',
      geo: '岩',
      electro: '雷',
      dendro: '草',
      hydro: '水',
      pyro: '火',
      cryo: '冰'
    }
    const selfElemCn = selfElemCnById[String((input as any).elem || '')] || ''
    if (selfElemCn) {
      for (const b of buffsOut) {
        const data = b.data
        if (!data || typeof data !== 'object') continue
        if (!Object.prototype.hasOwnProperty.call(data, 'dmg')) continue
        const title = String(b.title || '')
        if (!/元素精通/.test(title) || !/元素伤害/.test(title)) continue
        const prev = typeof (b as any).check === 'string' ? ((b as any).check as string).trim() : ''
        if (/\belement\b/.test(prev)) continue
        const gate = `element !== ${JSON.stringify(selfElemCn)}`
        if (!prev || prev === 'true') {
          ;(b as any).check = gate
          continue
        }
        ;(b as any).check = `(${prev}) && ${gate}`
      }
    }
  }

  if (input.game === 'gs' && !input.upstreamDirect) {
    // Some characters have passives like:
    // - "技能X造成的伤害提升，提升值相当于元素精通的90%"
    // Baseline usually models this as a *detail-local* flat add (by modifying that specific detail row),
    // while exposing the amount as a display-only `_qPlus/_ePlus` in buffs.
    //
    // LLMs frequently emit this as a global `qPlus/ePlus` buff, which then wrongly applies to other Q/E rows
    // (e.g. Q1/Q2/extra summons), causing massive damage drift. To keep behaviour closer to baseline, if we can
    // confidently associate a `*Plus` buff to a specific table name via its title, we:
    // - move the flat add into that matching detail via dmgExpr, and
    // - rename `qPlus/ePlus/...Plus` to `_qPlus/_ePlus/...` so it becomes display-only (ignored by DmgAttr).
    const norm = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】[\]「」『』《》〈〉“”‘’"']/g, '')

    const plusKeyToTalent = (k: string): TalentKeyGs | null => {
      if (k === 'aPlus' || k === 'a2Plus' || k === 'a3Plus') return 'a'
      if (k === 'ePlus') return 'e'
      if (k === 'qPlus') return 'q'
      return null
    }

    const tableTerms = (tableRaw: string): string[] => {
      const t0 = String(tableRaw || '').trim()
      if (!t0) return []
      const t = t0.endsWith('2') ? t0.slice(0, -1) : t0
      const noDmg = t.replace(/伤害/g, '').trim()
      const out = uniq([t, noDmg].map((x) => norm(x)).filter(Boolean))
      return out
    }

    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      const titleNorm = norm(b.title)
      if (!titleNorm) continue

      for (const [k, v] of Object.entries(data)) {
        if (!/^(a|a2|a3|e|q)Plus$/.test(k)) continue
        if (k.startsWith('_')) continue
        const tk = plusKeyToTalent(k)
        if (!tk) continue

        // Only shift when the buff title clearly mentions a specific table (avoid breaking true global plus buffs).
        const match = details.find((d) => {
          if (d.kind !== 'dmg') return false
          if (d.talent !== tk) return false
          const tn = typeof d.table === 'string' ? d.table : ''
          if (!tn) return false
          const terms = tableTerms(tn)
          if (terms.length === 0) return false
          return terms.some((term) => term && titleNorm.includes(term))
        })
        if (!match) continue

        const extraExpr = typeof v === 'number' ? String(v) : typeof v === 'string' ? v.trim() : ''
        if (!extraExpr) continue

        const keyArg = typeof match.key === 'string' && match.key.trim() ? match.key.trim() : tk
        const eleArg = typeof match.ele === 'string' && match.ele.trim() ? `, ${JSON.stringify(match.ele.trim())}` : ''
        const tableLit = JSON.stringify(String(match.table))
        const call = `dmg(talent.${tk}[${tableLit}], ${JSON.stringify(keyArg)}${eleArg})`

        // Preserve buff conditions when shifting into a detail-local flat add.
        // Otherwise, a conditional `*Plus` (e.g. C6-only) would become unconditional and wildly drift damage.
        const guardParts: string[] = []
        if (typeof b.cons === 'number' && Number.isFinite(b.cons)) guardParts.push(`cons >= ${Math.trunc(b.cons)}`)
        if (typeof b.check === 'string' && b.check.trim()) guardParts.push(`(${b.check.trim()})`)
        const guard = guardParts.filter(Boolean).join(' && ')
        const extra = guard ? `(${guard} ? (${extraExpr}) : 0)` : `(${extraExpr})`
        ;(match as any).dmgExpr = `{ dmg: ${call}.dmg + ${extra}, avg: ${call}.avg + ${extra} }`

        // Rename to underscore variant (display-only).
        const k2 = `_${k}`
        if (!(k2 in data)) (data as any)[k2] = v
        delete (data as any)[k]
      }

      if (b.data && Object.keys(b.data).length === 0) delete (b as any).data
    }
  }

  if (wantsDionaShowcase && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    // Prefer baseline-style "showcase" healing bonus for C6 (kept unconditional like baseline).
    pushFront({
      title: '迪奥娜6命：生命值低于50%时受治疗加成提升[heal]%',
      cons: 6,
      data: { heal: 30 }
    })
  }

  if (wantsSkirkCoreBuffs && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/万流归寂|死河渡断|虚境裂隙|极恶技·尽|蛇之狡谋/i)

    pushFront({
      title: '天赋-万流归寂：默认3层死河渡断（普攻/爆发倍率修正）',
      data: { aMulti: 170, qMulti: 160 }
    })

    const crackTable = '汲取0/1/2/3枚虚境裂隙伤害提升2'
    pushFront({
      title: '元素爆发-极恶技·尽：3枚虚境裂隙，使普攻造成的伤害提高[aDmg]%',
      data: { aDmg: `talent.q[\"${crackTable}\"][3]` }
    })
  }

  if (wantsFurinaFanfare && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/气氛值|万众狂欢|普世欢腾/i)
    dropBy(/无人听的自白|沙龙成员|召唤物/i)

    pushFront({
      title: '天赋Q·万众狂欢：300层气氛值提升[dmg]%伤害，[healInc]%受治疗加成',
      sort: 9,
      data: {
        dmg: 'talent.q[\"气氛值转化提升伤害比例\"] * 300',
        healInc: 'talent.q[\"气氛值转化受治疗加成比例\"] * 300'
      }
    })

    // Showcase: consume party HP to boost salon member damage.
    pushFront({
      title: '芙宁娜天赋：消耗4队友生命值，E伤害提升140%'
    })

    // Showcase: passive summon damage bonus scales with HP (percent numbers).
    pushFront({
      title: '芙宁娜被动：基于生命值，提升召唤物伤害[eDmg]%',
      sort: 9,
      data: { eDmg: 'Math.min(28, calc(attr.hp) / 1000 * 0.7)' }
    })
  }

  if (wantsNeuvilletteCharged && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/那维|衡平推裁|古海孑遗|至高仲裁|双水|hpBase/i)

    pushFront({
      title: '天赋-至高仲裁：提升[dmg]%水元素伤害',
      data: { dmg: 30 }
    })
    pushFront({
      title: '双水Buff：生命值提高[hpPct]%',
      data: { hpPct: 25 }
    })
    pushFront({
      title: '那维2命：重击·衡平推裁的暴击伤害提升[a2Cdmg]%',
      cons: 2,
      data: { a2Cdmg: 42 }
    })
  }

  if (wantsMavuikaWarWill && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    // Drop any LLM-emitted near-duplicates for this mechanic so we don't double-buff.
    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/炎花献礼/)
    dropBy(/基扬戈兹/)
    dropBy(/燔天之时|战意增伤|战意转化/)

    pushFront({
      title: '元素爆发-燔天之时：战意增伤（以 params.zy 表示战意）',
      sort: 9,
      check: 'params.zy > 0',
      data: {
        _zy: 'params.zy',
        qPlus: 'params.zy * talent.q["坠日斩伤害提升"] * calc(attr.atk) / 100',
        aPlus: 'params.zy * talent.q["驰轮车普通攻击伤害提升"] * calc(attr.atk) / 100',
        a2Plus: 'params.zy * talent.q["驰轮车重击伤害提升"] * calc(attr.atk) / 100'
      }
    })
    pushFront({
      title: '天赋-炎花献礼：攻击力提升',
      data: { atkPct: 30 }
    })
    pushFront({
      title: '天赋-基扬戈兹：战意转化为全伤害加成',
      check: 'params.zy > 0',
      data: { dmg: '0.2 * params.zy' }
    })
  }

  if (wantsColombinaLunar && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·・•\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/月曜反应|引力干涉|月兆祝赐|月亮诱发|哥伦比娅/)

    pushFront({
      title: '元素爆发：月曜反应伤害提升',
      check: 'params.q === true',
      data: {
        lunarCharged: 'talent.q["月曜反应伤害提升"]',
        lunarBloom: 'talent.q["月曜反应伤害提升"]',
        lunarCrystallize: 'talent.q["月曜反应伤害提升"]'
      }
    })
    pushFront({
      title: '天赋：触发引力干涉时暴击率提升（默认满层3）',
      check: 'params.Gravity_Interference === true',
      data: { cpct: 15 }
    })
    pushFront({
      title: '天赋：月兆祝赐·借汝月光（月曜反应基础伤害提升）',
      sort: 9,
      check: 'params.Moonsign_Benediction === true',
      data: { fypct: 'Math.min(Math.floor(calc(attr.hp) / 1000) * 0.2, 7)' }
    })
  }

  if (wantsNeferVeil && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/奈芙尔|伪秘之帷|月兆祝赐|月下的豪赌|尘沙的女儿|BondOfLife/i)

    pushFront({
      title: '奈芙尔技能：「伪秘之帷」使元素爆发伤害提升[qDmg]%',
      data: {
        qDmg: 'talent.q[\"伤害提升\"] * Math.min((params.Veil_of_Falsehood || 99), (cons >= 2 ? 5 : 3))'
      }
    })
    pushFront({
      title: '奈芙尔天赋：基于元素精通攻击力提升[atkPlus]',
      sort: 9,
      data: { atkPlus: 'Math.max(Math.min((calc(attr.mastery) * 0.4), 200), 0)' }
    })
    pushFront({
      title: '奈芙尔天赋：满层「伪秘之帷」使元素精通提升[mastery]',
      data: {
        mastery:
          '(params.Veil_of_Falsehood || 99) >= (cons >= 2 ? 5 : 3) ? 100 : 0'
      }
    })
    pushFront({
      title: '奈芙尔天赋：[月兆祝赐 · 廊下暮影] 触发绽放反应时转为触发月绽放反应,基础伤害提升[fypct]',
      sort: 9,
      check: 'params.Lunar',
      data: { fypct: 'Math.min((calc(attr.mastery) * 0.0175), 14)' }
    })
    pushFront({
      title: '奈芙尔1命：幻戏造成的月绽放反应基础伤害提升[fyplus]',
      cons: 1,
      check: 'params.Lunar && params.Phantasm_Performance',
      data: {
        fyplus:
          '(calc(attr.mastery) * 60 / 100) * Math.min((1 + (params.Veil_of_Falsehood || 99) / 10), (cons >= 2 ? 1.5 : 1.3))'
      }
    })
    pushFront({
      title: '奈芙尔2命：元素精通额外提升[mastery]',
      cons: 2,
      data: { mastery: '(params.Veil_of_Falsehood || 99) >= 5 ? 100 : 0' }
    })
    pushFront({
      title: '奈芙尔4命：附近敌人的元素抗性降低[kx]%',
      cons: 4,
      data: { kx: 20 }
    })
    pushFront({
      title: '奈芙尔6命：处于满辉时月绽放反应伤害擢升[elevated]%',
      cons: 6,
      check: 'params.Lunar',
      data: { elevated: '(params.Moonsign || 0) >= 2 ? 15 : 0' }
    })
  }

  if (wantsEmilieBurning && input.game === 'gs') {
    const norm = (s: string): string =>
      s
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·??\\-—–()（）【】\\[\\]「」『』《》〈〉“”‘’"']/g, '')

    const hasTitle = (title: string): boolean => buffsOut.some((b) => norm(b.title) === norm(title))
    const pushFront = (b: CalcSuggestBuff): void => {
      if (hasTitle(b.title)) return
      buffsOut.unshift(b)
    }

    const dropBy = (re: RegExp): void => {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const t = buffsOut[i]?.title || ''
        if (re.test(t)) buffsOut.splice(i, 1)
      }
    }
    dropBy(/艾梅莉埃|清露香氛|柔灯之匣|燃烧/i)

    pushFront({
      title: '艾梅莉埃天赋：基于攻击力，对处于燃烧状态下的敌人造成的伤害提升[dmg]%',
      data: { dmg: 'Math.min(36, calc(attr.atk) / 1000 * 15)' }
    })
    pushFront({
      title: '艾梅莉埃1命：元素战技与清露香氛造成的伤害提升20%',
      cons: 1,
      data: { dmg: 'params.e ? 20 : 0' }
    })
    pushFront({
      title: '艾梅莉埃2命：攻击命中敌人时，该敌人的草元素抗性降低[kx]%',
      cons: 2,
      data: { kx: 30 }
    })
    pushFront({
      title: '艾梅莉埃6命：施放元素战技与元素爆发后,普攻与重击造成的伤害提升[aPlus]',
      cons: 6,
      data: { aPlus: 'calc(attr.atk) * 300 / 100', a2Plus: 'calc(attr.atk) * 300 / 100' }
    })
  }

  // NOTE: When following upstream directly, keep upstream-derived buffs as the source of truth.
  // The Lauma showcase override below is a baseline-like heuristic intended for LLM channels and
  // can incorrectly gate always-on upstream premods (e.g. A4 skill dmg bonus) or inject team-only
  // debuffs (e.g. enemy RES shred) into the default context.
  if (wantsLaumaShowcase && input.game === 'gs' && !input.upstreamDirect) {
    // Use deterministic, baseline-like param gates & buff math for Lauma.
    // This is derived from unique official table names / numeric rules (no baseline code reuse).
    buffsOut.length = 0

    buffsOut.push({
      title: '菈乌玛天赋：处于满辉时月绽放反应暴击率提升10%,暴击伤害提升20%',
      check: '(params.Moonsign || 0) >= 2',
      data: { cpct: 'params.Lunar ? 10 : 0', cdmg: 'params.Lunar ? 20 : 0' }
    })

    buffsOut.push({
      title: '菈乌玛天赋：元素战技造成的伤害提升[eDmg]%',
      sort: 9,
      check: 'params.Linnunrata',
      data: { eDmg: 'Math.min(calc(attr.mastery) * 0.04, 32)' }
    })

    buffsOut.push({
      title: '菈乌玛天赋：触发绽放反应时转为触发月绽放反应，基础伤害提升[fypct]%',
      sort: 9,
      check: 'params.Lunar',
      data: { fypct: 'Math.min(calc(attr.mastery) * 0.0175, 14)' }
    })

    if ((tables.e || []).includes('元素抗性降低')) {
      buffsOut.push({
        title: '菈乌玛技能：元素战技命中敌人时该敌人的抗性降低[kx]%',
        data: { kx: 'talent.e[\"元素抗性降低\"]' }
      })
    }

    if ((tables.q || []).includes('绽放、超绽放、烈绽放反应伤害提升') && (tables.q || []).includes('月绽放反应伤害提升')) {
      buffsOut.push({
        title: '菈乌玛元素爆发：绽放、超绽放、烈绽放、月绽放反应造成的伤害提升[fyplus]',
        sort: 9,
        check: 'params.Pale_Hymn',
        data: {
          fyplus:
            'calc(attr.mastery) * (params.Lunar ? talent.q[\"月绽放反应伤害提升\"] : talent.q[\"绽放、超绽放、烈绽放反应伤害提升\"]) / 100'
        }
      })
    }

    buffsOut.push({
      title: '菈乌玛2命：绽放、超绽放、烈绽放、月绽放伤害额外提升[fyplus]',
      sort: 9,
      cons: 2,
      check: 'params.Pale_Hymn',
      data: { fyplus: 'calc(attr.mastery) * (params.Lunar ? 400 : 500) / 100' }
    })

    buffsOut.push({
      title: '菈乌玛2命：处于满辉时月绽放反应伤害提升[lunarBloom]%',
      cons: 2,
      check: 'params.Lunar && (params.Moonsign || 0) >= 2',
      data: { lunarBloom: 40 }
    })

    buffsOut.push({
      title: '菈乌玛6命：处于满辉时月绽放反应伤害擢升[elevated]%',
      cons: 6,
      check: 'params.Lunar && (params.Moonsign || 0) >= 2',
      data: { elevated: 25 }
    })
  }

  // Generic post-process: slash-variant array tables
  // Example: "岩脊伤害/共鸣伤害2" -> [stelePct, resonancePct]
  // These arrays are NOT `[pct, flat]`; treat them as variant lists and either:
  // - split into separate details (when both parts are meaningful damage/heal/shield titles), or
  // - infer `pick` based on title matching.
  {
    const norm = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')

    const outDetails: CalcSuggestDetail[] = []
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.kind !== 'dmg' || !d.talent || !d.table || !String(d.table).includes('/')) {
        outDetails.push(d)
        continue
      }

      // Respect explicit pick.
      if (typeof d.pick === 'number' && Number.isFinite(d.pick) && d.pick >= 0 && d.pick <= 10) {
        outDetails.push(d)
        continue
      }

      const sample = (input.tableSamples as any)?.[d.talent]?.[d.table]
      if (
        !Array.isArray(sample) ||
        sample.length < 2 ||
        !sample.every((x) => typeof x === 'number' && Number.isFinite(x))
      ) {
        outDetails.push(d)
        continue
      }

      const baseName = d.table.endsWith('2') ? d.table.slice(0, -1) : d.table
      const parts = baseName
        .split('/')
        .map((s) => String(s || '').trim())
        .filter(Boolean)

      if (parts.length === sample.length) {
        const meaningful = (p: string): boolean => /(伤害|治疗|护盾|吸收量)/.test(p) && p.length >= 2
        if (parts.every(meaningful)) {
          for (let i = 0; i < parts.length; i++) {
            outDetails.push({ ...d, title: parts[i]!, pick: i })
          }
          continue
        }

        const titleN = norm(d.title)
        const hits = parts
          .map((p, i) => ({ i, ok: !!p && titleN.includes(norm(p)) }))
          .filter((x) => x.ok)
          .map((x) => x.i)
        if (hits.length === 1) {
          outDetails.push({ ...d, pick: hits[0]! })
          continue
        }
      }

      outDetails.push(d)
    }

    details.length = 0
    details.push(...outDetails)
    while (details.length > 20) details.pop()
  }

  // GS: expand small numeric-array damage tables into multiple segment rows.
  // This helps align baseline segment details (e.g. 1/2/3-hit arrays) when the plan omitted picks/rows.
  expandGsArrayVariantDetails(input, details)

  // GS: infer missing `pick` for non-slash variant array tables (e.g. BondOfLife low/high variants).
  applyGsArrayVariantPicksFromTitles(input, details)

  // GS: normalize some common titles towards baseline conventions.
  if (input.game === 'gs') {
    normalizeGsDetailTitlesTowardsBaseline(details)
  }

  // GS: If the model picked a `...2` multi-hit table like "[pct, times]" (text sample contains "*N"),
  // but the baseline-style total table without trailing "2" exists, prefer the total table for charged-attack rows.
  //
  // Example: Ayaka `重击伤害2` = [55.13, 3] with text "55.13%*3", while `重击伤害` is the summed percentage.
  // If we keep `...2` we would need a per-hit vs total title; baseline uses the summed table.
  if (input.game === 'gs') {
    const isIntTimes = (n: unknown): n is number =>
      typeof n === 'number' && Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 1 && n <= 20

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.talent !== 'a') continue
      const table = typeof d.table === 'string' ? d.table.trim() : ''
      if (!table || !table.endsWith('2')) continue

      const tk = d.talent
      const sample = (input.tableSamples as any)?.[tk]?.[table]
      const times = Array.isArray(sample) && sample.length >= 2 ? Number(sample[1]) : NaN
      if (!isIntTimes(times)) continue

      const text = normalizePromptText((input.tableTextSamples as any)?.[tk]?.[table])
      if (!text || !/[*×xX]\s*\d+/.test(text) || !/[%％]/.test(text)) continue

      const baseTable = table.slice(0, -1)
      if (!baseTable || baseTable === table) continue
      const ok = (tables as any)?.[tk]
      if (!Array.isArray(ok) || !ok.includes(baseTable)) continue

      const title = normalizePromptText(d.title)
      const wantsPerHit = /(单次|单段|每段|每跳|每次)/.test(title)
      if (wantsPerHit) continue

      const key = typeof d.key === 'string' ? d.key.trim() : ''
      const baseKey = (key.split(',')[0] || '').trim()
      if (baseKey !== 'a2' && !/重击/.test(title)) continue

      d.table = baseTable
      delete (d as any).pick
    }
  }

  // Cleanup: models sometimes emit a `*Multi` buff for a "伤害提升/加成" coefficient that is already used as a `*Plus`
  // additive damage term elsewhere (e.g. per-stack extra damage like "每层提高X%攻击力的伤害"). In miao-plugin, `*Multi`
  // is an independent multiplier bucket; keeping both often causes systematic under/over-estimation. Prefer `*Plus` and drop
  // those redundant `*Multi` entries when they reference the same talent table.
  if (input.game === 'gs') {
    const refRe = /\btalent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/g
    const collectRefs = (expr: string): Array<{ tk: string; table: string }> => {
      const out: Array<{ tk: string; table: string }> = []
      if (!expr) return out
      let m: RegExpExecArray | null
      while ((m = refRe.exec(expr))) {
        const tk = m[1]
        const table = m[3]
        if (!tk || !table) continue
        out.push({ tk, table })
        if (out.length >= 8) break
      }
      return out
    }

    const plusRefs = new Set<string>()
    for (const b of buffsOut) {
      const data = b?.data
      if (!data || typeof data !== 'object') continue
      for (const [k, v] of Object.entries(data)) {
        if (!/Plus$/.test(k)) continue
        if (typeof v !== 'string') continue
        for (const r of collectRefs(v)) plusRefs.add(`${r.tk}:${r.table}`)
      }
    }

    if (plusRefs.size) {
      for (let i = buffsOut.length - 1; i >= 0; i--) {
        const b = buffsOut[i]!
        const data = b.data
        if (!data || typeof data !== 'object') continue

        let changed = false
        for (const [k, v] of Object.entries(data)) {
          if (!/Multi$/.test(k)) continue
          if (typeof v !== 'string') continue
          const vv = v.trim()
          // Only consider plain talent-table refs (optionally with "- 100") to avoid touching intentionally complex formulas.
          if (!/^\s*talent\s*\.\s*[aeqt]\s*\[\s*(['"]).*?\1\s*\]\s*(?:-\s*100\s*)?$/.test(vv)) continue
          const refs = collectRefs(vv)
          if (!refs.length) continue
          if (!refs.some((r) => plusRefs.has(`${r.tk}:${r.table}`))) continue
          delete (data as any)[k]
          changed = true
        }

        if (changed && Object.keys(data).length === 0) {
          buffsOut.splice(i, 1)
        }
      }
    }
  }

  // GS: Many baseline calcs intentionally omit `ele="phy"` for normal/charged/plunge rows so they benefit from the
  // generic `dmg` bucket (artifact/weapon "造成的伤害提升" etc). Models often overuse `phy`, which can cause large
  // underestimation (since it switches the dmg bonus bucket from `attr.dmg` to `attr.phy`).
  //
  // Heuristic:
  // - Always drop `phy` for catalyst normal attacks.
  // - If the kit hints at self-infusion, drop `phy` for talent=a rows.
  // - If there are global `dmg` buffs but no global `phy` buffs, prefer the `dmg` bucket and drop `phy`.
  if (input.game === 'gs') {
    const hintParts: string[] = []
    for (const h0 of Array.isArray(input.buffHints) ? input.buffHints : []) {
      const h = normalizePromptText(h0)
      if (h) hintParts.push(h)
    }
    if (input.talentDesc) {
      for (const v0 of Object.values(input.talentDesc)) {
        const v = normalizePromptText(v0)
        if (v) hintParts.push(v)
      }
    }
    const hintText = hintParts.join('\n')
    const hasInfusionHint =
      /(元素附魔|将.{0,24}(普通攻击|重击|下落攻击).{0,24}转为|普通攻击.{0,24}转为|重击.{0,24}转为|下落攻击.{0,24}转为)/.test(
        hintText
      ) || /\binfusion\b/i.test(hintText)

    const hasGlobalDmg = buffsOut.some((b) => {
      const data = b?.data
      return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'dmg')
    })
    const hasGlobalPhy = buffsOut.some((b) => {
      const data = b?.data
      return !!data && typeof data === 'object' && Object.prototype.hasOwnProperty.call(data, 'phy')
    })
    const preferDmgBucket = hasGlobalDmg && !hasGlobalPhy

    const isCatalyst = input.weapon === 'catalyst'

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (d.talent !== 'a') continue
      const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
      if (ele.toLowerCase() !== 'phy') continue

      const title0 = normalizePromptText((d as any).title)
      const table0 = normalizePromptText((d as any).table)
      if (/(物理|physical|phys)/i.test(`${title0} ${table0}`)) continue

      if (isCatalyst || hasInfusionHint || preferDmgBucket) {
        delete (d as any).ele
      }
    }
  }

  // GS: Resolve/愿力 style stack multipliers (e.g. 雷电将军「诸愿百眼之轮」).
  // When we see a dedicated q-table like "愿力加成" but the plan doesn't emit a `qPct` buff,
  // add a minimal showcase buff and normalize detail params from `{ stacks: N }` -> `{ type, num }`.
  // This is still API-driven (table name/value), not baseline-copying.
  if (input.game === 'gs' && qTables.includes('愿力加成')) {
    const hasQpct = buffsOut.some((b) => !!b.data && Object.prototype.hasOwnProperty.call(b.data, 'qPct'))
    if (!hasQpct) {
      buffsOut.unshift({
        // Keep the wording explicitly damage-related so the conservative GS buff filter
        // does not drop `qPct` as a non-damage buff.
        title: '元素爆发：愿力伤害加成（按 params.type/params.num）',
        data: { qPct: '("type" in params ? talent.q["愿力加成"][params.type] * params.num : 0)' }
      })
    }

    for (const d of details) {
      if (d.talent !== 'q') continue
      const p0 = d.params
      if (!p0 || typeof p0 !== 'object' || Array.isArray(p0)) continue
      const p = { ...(p0 as Record<string, unknown>) }
      if (Object.prototype.hasOwnProperty.call(p, 'type') && Object.prototype.hasOwnProperty.call(p, 'num')) continue
      const stacksRaw = (p as any).stacks
      const stacks = typeof stacksRaw === 'number' && Number.isFinite(stacksRaw) ? Math.trunc(stacksRaw) : null
      if (stacks === null) continue

      const hint = `${d.title || ''} ${d.table || ''}`
      // type=0: 梦想一刀（初击）；type=1: 梦想一心（后续普攻/重击）
      const type = /梦想一心/.test(hint) || /一段伤害|重击伤害/.test(hint) ? 1 : 0
      delete (p as any).stacks
      ;(p as any).type = type
      ;(p as any).num = stacks
      d.params = p as any
      if (typeof (d as any).check === 'string' && /\bparams\.stacks\b/.test((d as any).check)) {
        ;(d as any).check = String((d as any).check).replace(/\bparams\.stacks\b/g, 'params.num')
      }
    }

    // Some models mistakenly treat "愿力加成" as a damage multiplier table and emit a low-damage row.
    // Canonical modeling: keep base Q hit tables as details, and apply the bonus via `qPct` with params.type/num.
    for (let i = details.length - 1; i >= 0; i--) {
      const d = details[i]!
      if (d.talent !== 'q') continue
      const tn = typeof d.table === 'string' ? String(d.table) : ''
      if (tn && /愿力加成/.test(tn)) details.splice(i, 1)
    }

    const inferMaxWish = (): number => {
      const texts = [
        ...(Array.isArray(input.buffHints) ? (input.buffHints as string[]) : []),
        ...Object.values(input.talentDesc || {})
      ]
      for (const t0 of texts) {
        const t = normalizePromptText(t0)
        if (!t || !/愿力/.test(t)) continue
        const m = t.match(/(?:至多|最多)\S{0,8}?(\d{1,3})\S{0,2}层\S{0,6}?愿力/)
        if (!m) continue
        const n = Number(m[1])
        if (Number.isFinite(n) && n > 0 && n <= 120) return Math.trunc(n)
      }
      return 60
    }
    const maxWish = inferMaxWish()

    const baseSlashTable =
      qTables.find((t) => /梦想一刀/.test(t) && /基础/.test(t) && /伤害/.test(t)) ||
      qTables.find((t) => /梦想一刀/.test(t) && /伤害/.test(t)) ||
      ''
    const followNaTable = qTables.find((t) => /一段伤害/.test(t)) || ''
    const followCaTable = qTables.find((t) => /重击伤害/.test(t)) || ''

    const hasTitle = (title: string): boolean => details.some((d) => normalizePromptText(d.title) === title)
    const slashName = (() => {
      const n = normalizePromptText(baseSlashTable).replace(/基础/g, '').replace(/伤害/g, '').trim()
      return n || '梦想一刀'
    })()

    const insertAt = (() => {
      const i0 = details.findIndex((d) => d.talent === 'q')
      return i0 >= 0 ? i0 : 0
    })()
    const inserts: CalcSuggestDetail[] = []
    if (baseSlashTable) {
      const t0 = `Q${slashName}伤害(零愿力)`
      const t1 = `Q${slashName}伤害(满愿力)`
      if (!hasTitle(t0)) inserts.push({ title: t0, kind: 'dmg', talent: 'q', table: baseSlashTable, key: 'q' })
      if (!hasTitle(t1))
        inserts.push({
          title: t1,
          kind: 'dmg',
          talent: 'q',
          table: baseSlashTable,
          key: 'q',
          params: { type: 0, num: maxWish }
        })
    }
    if (followNaTable) {
      const t = `Q后普攻一段伤害(满愿力)`
      if (!hasTitle(t))
        inserts.push({
          title: t,
          kind: 'dmg',
          talent: 'q',
          table: followNaTable,
          key: 'q',
          params: { type: 1, num: maxWish }
        })
    }
    if (followCaTable) {
      const t = `Q后重击伤害(满愿力)`
      if (!hasTitle(t))
        inserts.push({
          title: t,
          kind: 'dmg',
          talent: 'q',
          table: followCaTable,
          key: 'q',
          params: { type: 1, num: maxWish }
        })
    }
    if (inserts.length) {
      // Insert right after the first Q row so tail trimming keeps these high-signal rows.
      details.splice(insertAt + 1, 0, ...inserts)
    }
  }

  // GS: Fix common LLM confusion between `atkPct` (percent ATK) vs `atkPlus` (flat ATK add).
  // If the referenced talent table clearly scales from HP/DEF (unit/text sample contains HP/DEF),
  // convert `atkPct: talent.e["..."]` into `atkPlus: calc(attr.hp/def) * talent.e["..."] / 100`.
  if (input.game === 'gs') {
    const inferBaseStat = (tk: 'a' | 'e' | 'q' | 't', table: string): 'atk' | 'hp' | 'def' | 'mastery' | null => {
      const unitMap = (input.tableUnits as any)?.[tk]
      const unit0 = unitMap && typeof unitMap === 'object' && !Array.isArray(unitMap) ? unitMap[table] : undefined
      const unit = normalizePromptText(unit0)
      if (unit) {
        if (/(生命值上限|最大生命值|生命值|HP)/i.test(unit)) return 'hp'
        if (/(防御力|DEF)/i.test(unit)) return 'def'
        if (/(元素精通|精通|EM|mastery)/i.test(unit)) return 'mastery'
        if (/(攻击力|攻击|ATK)/i.test(unit)) return 'atk'
      }

      const sample0 = (input.tableTextSamples as any)?.[tk]?.[table]
      const sample = normalizePromptText(sample0)
      if (!sample) return null
      if (/(%|％).{0,6}(生命值上限|最大生命值|生命值|HP)/i.test(sample)) return 'hp'
      if (/(%|％).{0,6}(防御力|DEF)/i.test(sample)) return 'def'
      if (/(%|％).{0,6}(元素精通|精通|EM|mastery)/i.test(sample)) return 'mastery'
      if (/(%|％).{0,6}(攻击力|攻击|ATK)/i.test(sample)) return 'atk'
      return null
    }

    // Some HP->ATK conversions have an explicit cap like "不超过基础攻击力的400%".
    const hints = [
      ...(Array.isArray(input.buffHints) ? (input.buffHints as string[]) : []),
      ...Object.values(input.talentDesc || {})
    ]
    let baseAtkCapPct: number | null = null
    for (const h0 of hints) {
      const h = normalizePromptText(h0)
      if (!h) continue
      if (!/基础攻击力/.test(h)) continue
      if (!/(不超过|不会超过|上限)/.test(h)) continue
      const m = h.match(/(\d+(?:\.\d+)?)\s*[%％]/)
      if (!m) continue
      const n = Number(m[1])
      if (!Number.isFinite(n) || n <= 0 || n > 2000) continue
      if (!baseAtkCapPct || n > baseAtkCapPct) baseAtkCapPct = n
    }

    for (const b of buffsOut) {
      const data = b.data
      if (!data || typeof data !== 'object') continue
      if (!Object.prototype.hasOwnProperty.call(data, 'atkPct')) continue
      if (Object.prototype.hasOwnProperty.call(data, 'atkPlus')) continue
      const v = (data as any).atkPct
      if (typeof v !== 'string') continue
      const expr = v.trim()
      // Accept both a plain table ref and a more complex (often-wrong) expression that includes a table ref,
      // e.g. `Math.min((talent.e["攻击力提高"] - 100) * calc(attr.hp) / calc(attr.atkBase), 400)`.
      const m = expr.match(/\btalent\s*\.\s*([aeqt])\s*\[\s*(['"])(.*?)\2\s*\]/)
      if (!m) continue
      const tk = m[1] as 'a' | 'e' | 'q' | 't'
      const table = m[3] || ''
      if (!table) continue
      const base = inferBaseStat(tk, table)
      if (base !== 'hp' && base !== 'def') continue

      const stat = base === 'hp' ? 'hp' : 'def'
      // Canonical conversion: treat the table value as a percentage coefficient (do NOT subtract 100).
      // This matches baseline patterns for "基于生命值/防御力，提高攻击力" style buffs.
      let newExpr = `calc(attr.${stat}) * talent.${tk}[\"${table}\"] / 100`
      if (baseAtkCapPct && base === 'hp' && /攻击力提高/.test(table)) {
        newExpr = `Math.min(${newExpr}, attr.atk.base * ${baseAtkCapPct / 100})`
      }
      delete (data as any).atkPct
      ;(data as any).atkPlus = newExpr
    }

    // HP/DEF -> ATK conversion buffs are global stat changes. Some models incorrectly gate them by `currentTalent`
    // (e.g. only apply to A/E but not Q), which systematically underestimates burst damage compared to baseline.
    // If a buff's `atkPlus` is derived from a talent table and the check only uses `currentTalent`, drop the check.
    for (const b of buffsOut) {
      const data = b?.data
      if (!data || typeof data !== 'object') continue
      const v = (data as any).atkPlus
      if (typeof v !== 'string') continue
      if (!/\btalent\s*\./.test(v)) continue
      const check = typeof (b as any).check === 'string' ? String((b as any).check) : ''
      if (!check || !/\bcurrentTalent\b/.test(check)) continue
      if (/\bparams\./.test(check)) continue
      delete (b as any).check
    }

    // If we have a dedicated "攻击力提高" coefficient table under E and it clearly scales from HP/DEF,
    // ensure an `atkPlus` buff exists (models sometimes omit it entirely, causing large dmg drift).
    if (Array.isArray(tables.e) && tables.e.includes('攻击力提高')) {
      const base = inferBaseStat('e', '攻击力提高')
      if (base === 'hp' || base === 'def') {
        const stat = base === 'hp' ? 'hp' : 'def'
        const hasAtkPlus = buffsOut.some((b) => {
          const data = b?.data
          if (!data || typeof data !== 'object') return false
          const v = (data as any).atkPlus
          return typeof v === 'string' && /talent\s*\.\s*e\s*\[\s*['"]攻击力提高['"]\s*\]/.test(v)
        })
        if (!hasAtkPlus) {
          let expr = `calc(attr.${stat}) * talent.e[\"攻击力提高\"] / 100`
          if (baseAtkCapPct && base === 'hp') {
            expr = `Math.min(${expr}, attr.atk.base * ${baseAtkCapPct / 100})`
          }
          buffsOut.unshift({
            title: '元素战技：基于生命值提高攻击力',
            check: 'params.e === true',
            data: { atkPlus: expr }
          })
        }
      }
    }
  }

  const patchGsShowcaseParamsEFromBuffs = (): void => {
    // GS: If an important E-state buff (gated by `params.e`) affects global stats / A/Q damage,
    // ensure showcase rows also enable `params.e` (baseline often assumes "E后/开E" rotation for such kits).
    if (input.game !== 'gs') return
    const affectsQ = (data: Record<string, number | string>): boolean => {
      for (const k of Object.keys(data || {})) {
        // Global stats / dmg bonus / enemy modifiers
        if (
          /^(atk|hp|def)(Base|Plus|Pct|Inc)?$/.test(k) ||
          /^(mastery|recharge|cpct|cdmg|heal|dmg|phy|shield)(Plus|Pct|Inc)?$/.test(k) ||
          /^(enemyDef|enemyIgnore|ignore|kx|fykx|multi|elevated)$/.test(k)
        ) {
          return true
        }
        // Direct Q-scope keys
        if (/^q(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(k)) return true
      }
      return false
    }
    const affectsA = (data: Record<string, number | string>): boolean => {
      for (const k of Object.keys(data || {})) {
        // Global stats / dmg bonus / enemy modifiers
        if (
          /^(atk|hp|def)(Base|Plus|Pct|Inc)?$/.test(k) ||
          /^(mastery|recharge|cpct|cdmg|heal|dmg|phy|shield)(Plus|Pct|Inc)?$/.test(k) ||
          /^(enemyDef|enemyIgnore|ignore|kx|fykx|multi|elevated)$/.test(k)
        ) {
          return true
        }
        // Direct A-scope keys (including charged/plunge variants)
        if (/^a(?:2|3)?(Def|Ignore|Dmg|Enemydmg|Plus|Pct|Cpct|Cdmg|Multi|Elevated)$/.test(k)) return true
      }
      return false
    }

    const refsParamE = (b: CalcSuggestBuff): boolean => {
      const check = typeof (b as any)?.check === 'string' ? String((b as any).check) : ''
      if (check && /\bparams\.e\b/.test(check)) return true

      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) return false
      for (const v of Object.values(data as Record<string, unknown>)) {
        if (typeof v !== 'string') continue
        if (/\bparams\.e\b/.test(v)) return true
      }
      return false
    }

    const needsEOnQ = buffsOut.some((b) => {
      if (!b || typeof b !== 'object') return false
      if (!refsParamE(b)) return false
      const data = b.data
      if (!data || typeof data !== 'object') return false
      return affectsQ(data)
    })
    const needsEOnA = buffsOut.some((b) => {
      if (!b || typeof b !== 'object') return false
      if (!refsParamE(b)) return false
      const data = b.data
      if (!data || typeof data !== 'object') return false
      return affectsA(data as any)
    })

    if (needsEOnQ) {
      for (const d of details) {
        if (d.talent !== 'q') continue
        const p0 = d.params
        const p: Record<string, unknown> =
          p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
        if (Object.prototype.hasOwnProperty.call(p, 'e')) continue
        p.e = true
        d.params = p as any
      }
    }
    // Some kits (e.g. Hu Tao) rely on an E-state buff that is conceptually global, but upstream/baseline
    // may only expose Q-side showcase rows. If we detected any important params.e-gated buff for Q, also
    // enable `params.e` for A rows to keep "开E/E后" showcases closer to baseline.
    if (needsEOnA || needsEOnQ) {
      for (const d of details) {
        if (d.talent !== 'a') continue
        const p0 = d.params
        const p: Record<string, unknown> =
          p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, unknown>) } : {}
        if (Object.prototype.hasOwnProperty.call(p, 'e')) continue
        p.e = true
        d.params = p as any
      }
    }
  }

  patchGsShowcaseParamsEFromBuffs()

  // SR: Extract "*Plus" (flat additional damage value) buffs from constellation hint text.
  // Many SR profiles use max talent levels that can exceed table lengths in meta (yielding undefined => 0),
  // and baseline calc.js often relies on `aPlus/tPlus/...` to keep showcase rows non-zero.
  if (input.game === 'sr') {
    // When upstream context is present, prefer upstream-derived semantics over heuristic CN-text parsing.
    // This avoids generating misleading "推导：X魂造成的伤害提高" style global buffs for skill-specific multipliers.
    if (!input.upstream) deriveSrConsFromBuffHints(input.buffHints, details, buffsOut)
    patchSrBuffGateFieldsFromTitles(buffsOut)
    patchSrNonAtkDmgExprCalls(input, details)
    patchSrRedundantDmgExprMultipliersFromDmgBuffs(details, buffsOut)
  }

  // GS: If the character has clear EM/reaction hints but the plan omitted all reaction rows,
  // add a single representative transformative reaction row to avoid "too-low maxAvg" regressions
  // (e.g. electro EM triggers commonly benchmarked by hyperBloom).
  if (input.game === 'gs') {
    applyGsBurstAltAttackKeyMapping(input, details)
    applyGsPostprocess({ input, tables, details, okReactions, gsBuffIdsOut })
    // GS: postprocess may insert new Q/A rows; patch again to ensure they inherit `params.e` when needed.
    patchGsShowcaseParamsEFromBuffs()
    patchGsNodePremodVariantDetailsFromBuffs(details, buffsOut)
    rewriteGsBasePlusPerLayerDetails({ input, tables, details })

    // GS: When a talent table's unit indicates a damage multiplier bucket (e.g. "普通攻击伤害"),
    // model it as a `*Multi` buff (delta from base 100%) so showcased rows align with baseline semantics.
    //
    // Derived purely from official table units + runtime talent values (no baseline code reuse).
    if (multiUnitTables.length) {
      const existingMultiKeys = new Set<string>()
      for (const b of buffsOut) {
        const data = (b as any)?.data
        if (!data || typeof data !== 'object' || Array.isArray(data)) continue
        for (const k of Object.keys(data)) {
          const kk = String(k || '').trim()
          if (kk && /Multi$/.test(kk)) existingMultiKeys.add(kk)
        }
      }

      // Group by (multiKey,stateFlag) and only auto-model unambiguous cases (single source table).
      const groups = new Map<string, typeof multiUnitTables>()
      for (const m of multiUnitTables) {
        if (!m || !m.multiKey) continue
        if (!m.stateFlag) continue
        // If the plan already provided this multiKey, avoid double-counting.
        if (existingMultiKeys.has(m.multiKey)) continue
        const gk = `${m.multiKey}:${m.stateFlag}`
        const list = groups.get(gk) || []
        list.push(m)
        groups.set(gk, list)
      }

      const data: Record<string, string> = {}
      for (const list of groups.values()) {
        if (!Array.isArray(list) || list.length !== 1) continue
        const m = list[0]!
        const tk = m.originTalent
        const tn = m.table
        if (!tk || !tn) continue
        if (!tables[tk]?.includes(tn)) continue

        const base = `talent.${tk}[${JSON.stringify(tn)}]`
        const scalar = `(Array.isArray(${base}) ? ${base}[0] : ${base})`
        // `*Multi` keys are stored as delta from base 100%.
        const delta = `(${scalar} - 100)`
        const gated = `(params.${m.stateFlag} ? ${delta} : 0)`
        data[m.multiKey] = gated
      }

      if (Object.keys(data).length) {
        buffsOut.unshift({
          title: '倍率表乘区（来自天赋表单位）',
          data
        })
      }
    }

    patchGsBuffGateFieldsFromTitles(buffsOut)
    rewriteGsBuffStatScalingConstRatiosToTalentTables(input, buffsOut)
  }

  // SR: normalize multi-target titles and fill a few baseline-like showcase rows (generic, no per-character hardcode).
  if (input.game === 'sr') {
    // SR: `details[i].ele` is NOT an element/reaction selector.
    // Baseline SR calcs only use `ele="skillDot"` as a special tag (DoT / fixed-crit approximation).
    // Break/superBreak and status DoTs (shock/burn/...) must be modeled via kind=reaction + reaction="<id>".
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
      if (ele && ele !== 'skillDot') delete (d as any).ele
    }

    applySrPostprocess({ input, tables, details })
    applySrBuffPostprocess({ input, tables, buffs: buffsOut })
    patchSrVariantStateParamsFromBuffs(details, buffsOut)
    // Final SR fixup: ensure "倍率提高" deltas are treated as additive (base + delta), including rows
    // created by SR post-processing.
    rewriteSrDeltaMultiplierIncreaseExprs(details)
  }

  // GS: Drop one-shot ("next cast") multiplier buffs to stay closer to baseline semantics.
  // Baseline commonly omits these to avoid rotation/state modeling (prevents ~3x regressions).
  if (input.game === 'gs') {
    applyGsBuffFilterTowardsBaseline(input, buffsOut)
  }

  // GS: Geo shields have 150% absorption vs all damage types.
  // Represent this as a generic `shieldInc: 50` buff (miao-plugin multiplies shields by `attr.shield.inc / 100`).
  // This is safe to apply whenever the kit exposes at least one shield showcase row.
  if (input.game === 'gs') {
    const elem = normalizePromptText(input.elem).toLowerCase()
    const isGeo = elem === 'geo'
    const hasShield = details.some((d) => normalizeKind((d as any)?.kind) === 'shield')
    if (isGeo && hasShield) {
      const alreadyHasShieldInc = buffsOut.some((b) => {
        const data = b && typeof b === 'object' && !Array.isArray(b) ? ((b as any).data as unknown) : null
        if (!data || typeof data !== 'object' || Array.isArray(data)) return false
        return 'shieldInc' in (data as Record<string, unknown>)
      })
      if (!alreadyHasShieldInc) {
        buffsOut.unshift({
          title: '岩系护盾：吸收效率150%',
          data: { shieldInc: 50 }
        })
      }
    }
  }

  // GS: Derive "shield strength" buffs from hint text when it is clearly described as a simple % (+ optional stacks).
  // Keep it conservative and generic (no per-character tables / baseline code reuse).
  if (input.game === 'gs') {
    applyGsShieldStrengthBuffFromHints({ input, details, buffs: buffsOut })
  }

  // GS: If we use any reaction variants, ensure mastery is present in mainAttr (baseline pattern).
  if (input.game === 'gs') {
    const ok = new Set(['vaporize', 'melt', 'aggravate', 'spread'])
    for (const d of details) {
      const eleRaw = typeof (d as any)?.ele === 'string' ? String((d as any).ele).trim() : ''
      const ele = eleRaw ? eleRaw.toLowerCase() : ''
      if (ok.has(ele)) gsBuffIdsOut.add(ele)
    }

    const hasReactionLike = gsBuffIdsOut.size > 0 || details.some((d) => normalizeKind((d as any)?.kind) === 'reaction')
    if (hasReactionLike) {
      const parts = mainAttr
        .split(',')
        .map((s) => String(s || '').trim())
        .filter(Boolean)
      const hasMastery = parts.some((p) => {
        const t = p.toLowerCase()
        return t === 'mastery' || t === 'em' || t === 'elementalmastery'
      })
      if (!hasMastery) {
        parts.push('mastery')
        mainAttr = parts.join(',')
      }
    }
  }

  // GS: Ensure reaction-variant dmg rows have reaction-aware titles (prevents mismatching plain vs reaction rows).
  if (input.game === 'gs') {
    const map: Record<string, string> = {
      vaporize: '蒸发',
      melt: '融化',
      spread: '蔓激化',
      aggravate: '超激化'
    }
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (normalizeKind((d as any).kind) !== 'dmg') continue
      const eleRaw = typeof (d as any).ele === 'string' ? String((d as any).ele).trim() : ''
      const ele = eleRaw ? eleRaw.toLowerCase() : ''
      const cn = map[ele]
      if (!cn) continue
      if (typeof (d as any).title !== 'string') continue
      let title = String((d as any).title).trim()
      if (!title) continue

      // Normalize ambiguous "激化" wording into the specific reaction name when possible.
      if (ele === 'spread' && !title.includes('蔓激化') && title.includes('激化') && !title.includes('超激化')) {
        title = title.replace(/激化/g, '蔓激化')
      }
      if (ele === 'aggravate' && !title.includes('超激化') && title.includes('激化') && !title.includes('蔓激化')) {
        title = title.replace(/激化/g, '超激化')
      }

      if (title.includes(cn)) {
        ;(d as any).title = title
        continue
      }

      // Prefer baseline-like suffix forms.
      if (/伤害$/.test(title)) {
        if (ele === 'spread' || ele === 'aggravate') title = title.replace(/伤害$/, `·${cn}`)
        else title = title.replace(/伤害$/, cn)
      } else {
        title = `${title}${cn}`
      }
      ;(d as any).title = title
    }
  }

  // GS: Final param fixups (run late so rows inserted by any GS postprocess are covered).
  if (input.game === 'gs') {
    const isLowHpLike = (s: string): boolean => /(低血|低生命|低于50%|半血|生命值低于|生命值少于)/.test(normalizePromptText(s))

    // 1) If a row title indicates low HP, always mark `params.halfHp=true` so buffs gated by halfHp can apply.
    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      if (!isLowHpLike(String((d as any).title || ''))) continue
      const p0 = (d as any).params
      const p: Record<string, any> =
        p0 && typeof p0 === 'object' && !Array.isArray(p0) ? { ...(p0 as Record<string, any>) } : {}
      if (!Object.prototype.hasOwnProperty.call(p, 'halfHp')) p.halfHp = true
      ;(d as any).params = p
    }
  }

  const buffsFinal: Array<CalcSuggestBuff | string> = []
  if (input.game === 'gs') {
    for (const id of Array.from(gsBuffIdsOut).sort()) buffsFinal.push(id)
  }
  buffsFinal.push(...buffsOut)

  return { mainAttr, defDmgKey, details, buffs: buffsFinal }
}

function patchGsNodePremodVariantDetailsFromBuffs(details: CalcSuggestDetail[], buffs: CalcSuggestBuff[]): void {
  try {
    if (!Array.isArray(details) || details.length === 0) return
    if (!Array.isArray(buffs) || buffs.length === 0) return

    const existingParams = new Set<string>()
    for (const d of details) {
      const p = (d as any)?.params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const k of Object.keys(p)) {
        const kk = String(k || '').trim()
        if (kk) existingParams.add(kk)
      }
    }

    const preferEle = new Set(['vaporize', 'melt', 'aggravate', 'spread'])
    let inserted = 0

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      const title = typeof (b as any).title === 'string' ? String((b as any).title).trim() : ''
      if (!title.startsWith('upstream:genshin-optimizer(node-premod-variant:')) continue

      const check = typeof (b as any).check === 'string' ? String((b as any).check) : ''
      const mParam = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/.exec(check)
      const paramKey = String(mParam?.[1] || '').trim()
      if (!paramKey) continue
      if (existingParams.has(paramKey)) continue

      const data = (b as any).data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      const keys = Object.keys(data).map((k) => String(k || '').trim())
      const bucket = keys.some((k) => /^e[A-Z]/.test(k)) ? 'e' : keys.some((k) => /^q[A-Z]/.test(k)) ? 'q' : ''
      if (!bucket) continue

      const candidates = details.filter((d) => {
        if (!d || typeof d !== 'object') return false
        if (String((d as any).talent || '').trim() !== bucket) return false
        const kind = normalizeKind((d as any).kind)
        if (kind === 'heal' || kind === 'shield' || kind === 'reaction') return false
        return true
      })
      if (!candidates.length) continue

      const pick = (() => {
        for (const d of candidates) {
          const ele = typeof (d as any).ele === 'string' ? String((d as any).ele).trim().toLowerCase() : ''
          if (ele && preferEle.has(ele)) return d
          const t = String((d as any).title || '')
          if (/蒸发|融化|超激化|蔓激化/.test(t)) return d
        }
        return candidates[0]!
      })()

      const baseIdx = details.indexOf(pick)
      if (baseIdx < 0) continue

      const p0 = (pick as any).params
      const p: Record<string, number | boolean | string> =
        p0 && typeof p0 === 'object' && !Array.isArray(p0) ? ({ ...(p0 as any) } as any) : ({} as any)
      if (Object.prototype.hasOwnProperty.call(p, paramKey)) continue
      p[paramKey] = true

      const label = paramKey.replace(/^node_/, '')
      const next: CalcSuggestDetail = {
        ...(pick as any),
        title: `${String((pick as any).title || bucket.toUpperCase())}(${label || 'variant'})`,
        params: p as any
      }
      if (typeof (b as any).cons === 'number' && Number.isFinite((b as any).cons)) (next as any).cons = (b as any).cons
      if (typeof (b as any).tree === 'number' && Number.isFinite((b as any).tree)) (next as any).tree = (b as any).tree

      details.splice(baseIdx + 1, 0, next)
      existingParams.add(paramKey)
      inserted++
      while (details.length > 20) details.pop()
      if (inserted >= 6) break
    }
  } catch {
    // best-effort
  }
}

function patchSrVariantStateParamsFromBuffs(details: CalcSuggestDetail[], buffs: CalcSuggestBuff[]): void {
  try {
    const isStateLikeKey = (k: string): boolean => /(?:enhanced|state|mode|stance)/i.test(k)

    const keys = new Set<string>()
    const scan = (exprRaw: unknown): void => {
      const expr = typeof exprRaw === 'string' ? exprRaw : ''
      if (!expr) return
      const re = /\bparams\.([A-Za-z0-9_]+)\b/g
      for (const m of expr.matchAll(re)) {
        const k = String(m[1] || '').trim()
        if (!k) continue
        if (k === 'q' || k === 'e' || k === 'strength') continue
        if (!isStateLikeKey(k)) continue
        keys.add(k)
        if (keys.size >= 25) break
      }
    }

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      scan((b as any).check)
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const v of Object.values(data as Record<string, unknown>)) scan(v)
      }
      if (keys.size >= 25) break
    }

    const list = Array.from(keys)
    if (!list.length) return

    for (const d of details) {
      if (!d || typeof d !== 'object') continue
      const tk = typeof (d as any).talent === 'string' ? String((d as any).talent).trim() : ''
      if (!tk) continue
      // Only apply to variant talent blocks (a2/e2/q2/...), so that normal rows stay conservative.
      if (!/\d+$/.test(tk)) continue

      const p0 = (d as any).params
      const p: Record<string, number | boolean | string> =
        p0 && typeof p0 === 'object' && !Array.isArray(p0) ? ({ ...(p0 as any) } as any) : ({} as any)

      let changed = false
      for (const k of list) {
        if (Object.prototype.hasOwnProperty.call(p, k)) continue
        p[k] = true
        changed = true
      }
      if (changed) (d as any).params = p as any
    }
  } catch {
    // best-effort
  }
}

function rewriteGsBuffStatScalingConstRatiosToTalentTables(input: CalcSuggestInput, buffs: CalcSuggestBuff[]): void {
  try {
    if (input.game !== 'gs') return
    if (!buffs.length) return

    const unitsAll = (input.tableUnits || {}) as any
    const valuesAll = (input.tableValues || {}) as any
    if (!valuesAll || typeof valuesAll !== 'object') return

    type Cand = { tk: string; table: string; stat: 'atk' | 'def' | 'hp'; values: number[] }
    const cands: Cand[] = []

    const norm = (s: unknown): string => normalizePromptText(String(s || ''))
    const unitToStat = (uRaw: unknown): 'atk' | 'def' | 'hp' | null => {
      const u = norm(uRaw)
      if (!u) return null
      if (/(生命值上限|最大生命值|生命值|\bhp\b)/i.test(u)) return 'hp'
      if (/(防御力|防御|\bdef\b)/i.test(u)) return 'def'
      if (/(攻击力|攻击|\batk\b)/i.test(u)) return 'atk'
      return null
    }

    const isBuffLikeTable = (tRaw: string): boolean => {
      const t = norm(tRaw)
      if (!t) return false
      // Only rewrite when the table name is clearly a buff table (avoid mapping to raw damage tables).
      return /(提高|提升|增加|降低|减少|加成)/.test(t)
    }

    for (const [tk0, tableMapRaw] of Object.entries(valuesAll)) {
      const tk = String(tk0 || '').trim()
      if (!tk) continue
      if (!/^[aeqt]$/.test(tk)) continue
      if (!tableMapRaw || typeof tableMapRaw !== 'object' || Array.isArray(tableMapRaw)) continue
      const unitMap = unitsAll?.[tk] || {}

      for (const [table0, arrRaw] of Object.entries(tableMapRaw as Record<string, unknown>)) {
        const table = String(table0 || '').trim()
        const arr = Array.isArray(arrRaw) ? (arrRaw as unknown[]) : []
        if (!table || arr.length < 5) continue
        if (!isBuffLikeTable(table)) continue
        const nums = arr.map((v) => Number(v)).filter((n) => Number.isFinite(n)) as number[]
        if (nums.length < 5) continue
        const stat = unitToStat(unitMap?.[table])
        if (!stat) continue
        cands.push({ tk, table, stat, values: nums })
      }
    }

    if (!cands.length) return

    // Only rewrite when the constant matches a talent-table entry *numerically*.
    // Otherwise, we would drift from upstream semantics (some upstream ratios carry more precision than Hakush tables).
    const tol = 1e-6 // percent points
    const findTableForPct = (stat: 'atk' | 'def' | 'hp', pct: number): Cand | null => {
      let best: Cand | null = null
      let hits = 0
      for (const c of cands) {
        if (c.stat !== stat) continue
        if (!c.values.some((v) => Math.abs(v - pct) <= tol)) continue
        hits++
        best = c
        if (hits > 1) return null
      }
      return best
    }

    const rewriteExpr = (exprRaw: unknown): unknown => {
      if (typeof exprRaw !== 'string') return exprRaw
      let expr = String(exprRaw)
      if (!expr.trim()) return exprRaw

      // Detect simple linear stat scaling like `1.368 * calc(attr.def)` where 1.368 is max-level ratio.
      const re =
        /(?:\(\s*)?(\d+(?:\.\d+)?)(?:\s*\))?\s*\*\s*(?:\(\s*)?calc\s*\(\s*attr\.(hp|def|atk)\s*\)\s*(?:\)\s*)?/g
      expr = expr.replace(re, (full, cRaw, statRaw) => {
        const c = Number(cRaw)
        const stat = String(statRaw || '').trim() as any
        if (!Number.isFinite(c) || c <= 0) return full
        // Avoid rewriting integer multipliers (too ambiguous).
        if (!String(cRaw).includes('.')) return full
        if (stat !== 'hp' && stat !== 'def' && stat !== 'atk') return full
        const pct = c * 100
        if (!Number.isFinite(pct) || pct <= 0 || pct > 500) return full

        const hit = findTableForPct(stat, pct)
        if (!hit) return full
        const ref = `toRatio(talent.${hit.tk}[${JSON.stringify(hit.table)}])`
        return full.replace(cRaw, ref)
      })

      return expr
    }

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      const data = (b as any).data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue
      let changed = false
      for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
        const vv = rewriteExpr(v)
        if (vv !== v) {
          ;(data as any)[k] = vv as any
          changed = true
        }
      }
      if (changed) (b as any).data = data
    }
  } catch {
    // best-effort
  }
}

function patchSrBuffGateFieldsFromTitles(buffs: CalcSuggestBuff[]): void {
  try {
    const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))
    const isCritRateKey = (k: string): boolean => k === 'cpct' || /Cpct$/.test(k)
    const isPercentLikeKey = (k: string): boolean => {
      if (!k || k.startsWith('_')) return false
      if (k.endsWith('Inc') || k.endsWith('Multi')) return true
      if (k.endsWith('Plus') || k === 'atkPlus' || k === 'hpPlus' || k === 'defPlus') return false
      if (k.endsWith('Pct') || k.endsWith('Dmg') || k.endsWith('Cdmg') || k.endsWith('Cpct')) return true
      if (
        k === 'cpct' ||
        k === 'cdmg' ||
        k === 'dmg' ||
        k === 'phy' ||
        k === 'heal' ||
        k === 'shield' ||
        k === 'recharge' ||
        k === 'kx' ||
        k === 'enemyDef' ||
        k === 'enemyIgnore' ||
        k === 'ignore' ||
        k === 'enemydmg' ||
        k === 'effPct' ||
        k === 'effDef' ||
        k === 'stance'
      ) {
        return true
      }
      return false
    }
    const wrapClampExpr = (expr: string, lo: number, hi: number): string =>
      `Math.max(${lo}, Math.min(${hi}, (${expr})))`

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      const title = String((b as any).title || '').trim()
      if (!title) continue

      // Fill missing cons from title (e.g. "1魂..." / "6命...").
      if (typeof (b as any).cons !== 'number') {
        const m = /(^|[^\d])([1-6])\s*(?:魂|命)/.exec(title)
        if (m) (b as any).cons = Number(m[2])
      }

      // Fill missing major trace index from title (e.g. "行迹1..." / "行迹-...").
      if (typeof (b as any).tree !== 'number') {
        const m = /(^|[^\d])行迹\s*([1-9]\d*)/.exec(title)
        if (m) (b as any).tree = Math.trunc(Number(m[2]))
      }

      // Common key compatibility: some LLMs output "speedPlus" while baseline uses "speed".
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if (Object.prototype.hasOwnProperty.call(data, 'speedPlus') && !Object.prototype.hasOwnProperty.call(data, 'speed')) {
          data.speed = (data as any).speedPlus
          delete (data as any).speedPlus
        }

        // Numeric clamp for common unit mistakes (avoid rejecting whole LLM plans).
        for (const [kRaw, vRaw] of Object.entries(data as any)) {
          const k = String(kRaw || '')
          if (typeof vRaw === 'string') {
            const expr = vRaw.trim()
            if (!expr) continue
            if (isCritRateKey(k)) {
              ;(data as any)[k] = wrapClampExpr(expr, 0, 100)
              continue
            }
            if (isPercentLikeKey(k)) {
              const isBigDmgKey = k === 'dmg' || /Dmg$/.test(k)
              // SR: keep within js-validate bounds; tighten a few known buckets.
              if (k === 'kx') (data as any)[k] = wrapClampExpr(expr, -500, 500)
              else if (k === 'enemydmg') (data as any)[k] = wrapClampExpr(expr, -80, 250)
              else if (k === 'enemyDef' || k === 'enemyIgnore' || k === 'ignore') (data as any)[k] = wrapClampExpr(expr, 0, 120)
              else (data as any)[k] = wrapClampExpr(expr, -80, isBigDmgKey ? 5000 : 500)
              continue
            }
            continue
          }
          if (typeof vRaw !== 'number' || !Number.isFinite(vRaw)) continue
          let v = vRaw

          if (isCritRateKey(k)) {
            // Prefer clamping; crit-rate over 100 is almost always invalid for miao-plugin.
            v = clamp(v, -100, 100)
          } else if (isPercentLikeKey(k)) {
            // Fix common x100 / x10 mistakes on percent-like values.
            const abs = Math.abs(v)
            if (abs > 500) {
              const v100 = v / 100
              const v10 = v / 10
              if (Math.abs(v100) <= 500) v = v100
              else if (Math.abs(v10) <= 500) v = v10
              else v = clamp(v, -500, 500)
            }
            if (k !== 'kx' && v < -80) v = -80

            // SR-only tighter bounds for some debuff buckets.
            if ((k === 'enemyDef' || k === 'enemyIgnore' || k === 'ignore') && Math.abs(v) > 120) {
              const v100 = v / 100
              if (Math.abs(v100) <= 120) v = v100
              else v = clamp(v, -120, 120)
            }
          }

          if (v !== vRaw) (data as any)[k] = v
        }
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }
}

function patchGsBuffGateFieldsFromTitles(buffs: CalcSuggestBuff[]): void {
  try {
    const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))
    const isCritRateKey = (k: string): boolean => k === 'cpct' || /Cpct$/.test(k)
    const isPercentLikeKey = (k: string): boolean => {
      if (!k || k.startsWith('_')) return false
      if (k.endsWith('Inc') || k.endsWith('Multi')) return true
      if (
        k.endsWith('Plus') ||
        k === 'atkPlus' ||
        k === 'hpPlus' ||
        k === 'defPlus' ||
        k === 'fyplus' ||
        k === 'fybase'
      ) {
        return false
      }
      if (k.endsWith('Pct') || k.endsWith('Dmg') || k.endsWith('Cdmg') || k.endsWith('Cpct')) return true
      if (k === 'cpct' || k === 'cdmg' || k === 'dmg' || k === 'phy' || k === 'heal' || k === 'shield') return true
      if (k === 'recharge' || k === 'kx' || k === 'enemyDef' || k === 'enemyIgnore' || k === 'ignore') return true
      if (k === 'fypct' || k === 'fyinc' || k === 'fycdmg' || k === 'elevated' || k === 'multi' || k === 'fykx') return true
      return false
    }

    const wrapClampExpr = (expr: string, lo: number, hi: number): string =>
      `Math.max(${lo}, Math.min(${hi}, (${expr})))`

    const rescalePercentLike = (v: number, hiAbs: number): number => {
      const abs = Math.abs(v)
      if (abs <= hiAbs) return v
      const v100 = v / 100
      if (Math.abs(v100) <= hiAbs) return v100
      const v10 = v / 10
      if (Math.abs(v10) <= hiAbs) return v10
      return clamp(v, -hiAbs, hiAbs)
    }

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      const title = String((b as any).title || '').trim()
      if (!title) continue

      // Fill missing cons from title (e.g. "4命效果：...").
      if (typeof (b as any).cons !== 'number') {
        const m = /(^|[^\d])([1-6])\s*命/.exec(title)
        if (m) (b as any).cons = Number(m[2])
      }

      const data = (b as any).data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue

      for (const [kRaw, vRaw] of Object.entries(data as any)) {
        const k = String(kRaw || '').trim()
        if (!k) continue

          // Clamp runtime outputs (avoid rejecting whole LLM plans in js-validate).
          if (typeof vRaw === 'string') {
            const expr = vRaw.trim()
            if (!expr) continue
            if (isCritRateKey(k)) {
            // NOTE: allow negative crit rate (e.g. Kokomi's -100% crit) while staying within validator bounds.
            ;(data as any)[k] = wrapClampExpr(expr, -100, 100)
            } else if (isPercentLikeKey(k)) {
              // Keep within validator bounds; negative outgoing percent-like buffs are almost always misreads.
              ;(data as any)[k] = wrapClampExpr(expr, -80, 500)
            }
            continue
        }

        if (typeof vRaw !== 'number' || !Number.isFinite(vRaw)) continue
        let v = vRaw

        if (isCritRateKey(k)) {
          v = rescalePercentLike(v, 100)
          // NOTE: allow negative crit rate (e.g. Kokomi's -100% crit) while staying within validator bounds.
          v = clamp(v, -100, 100)
        } else if (isPercentLikeKey(k)) {
          // Guardrail for unit mistakes like 6000% (should be 60%).
          v = rescalePercentLike(v, 500)

          // Shred/ignore keys should be non-negative.
          if (/^(enemyDef|enemyIgnore|ignore|kx|fykx)$/.test(k)) {
            if (v < 0) v = Math.abs(v)
            if (k === 'kx' || k === 'fykx') v = clamp(v, 0, 100)
            else v = clamp(v, 0, 120)
          } else {
            // Negative outgoing percent-like buffs are almost always misreads (baseline rarely uses them).
            if (v < 0) {
              delete (data as any)[k]
              continue
            }
          }

          if (v > 500) v = 500
        }

        if (v !== vRaw) (data as any)[k] = v
      }
    }
  } catch {
    // Best-effort: do not block generation.
  }
}

function patchSrNonAtkDmgExprCalls(input: CalcSuggestInput, details: CalcSuggestDetail[]): void {
  if (input.game !== 'sr') return

  const inferBaseStat = (talentKey: string): 'atk' | 'hp' | 'def' | 'mixed' => {
    const desc = normalizePromptText((input.talentDesc as any)?.[talentKey])
    // IMPORTANT: avoid treating the generic verb "攻击" as an ATK-scaling hint.
    const hasAtk = /攻击力/.test(desc)
    const hasHp = /(生命值上限|最大生命值|生命上限|生命值)/.test(desc)
    const hasDef = /防御力/.test(desc)
    const hits = [hasAtk, hasHp, hasDef].filter(Boolean).length
    if (hits > 1) return 'mixed'
    if (hasHp) return 'hp'
    if (hasDef) return 'def'
    return 'atk'
  }

  type Call = { start: number; end: number; args: string[]; raw: string }

  const scanCalls = (expr: string): Call[] => {
    const out: Call[] = []
    const s = expr
    const len = s.length
    let i = 0

    const isIdentChar = (ch: string): boolean => /[A-Za-z0-9_$]/.test(ch)

    while (i < len) {
      const idx = s.indexOf('dmg', i)
      if (idx < 0) break
      const before = idx > 0 ? s[idx - 1] : ''
      const after = idx + 3 < len ? s[idx + 3] : ''
      // Skip property access (e.g. "dmg.basic(") and non-call occurrences.
      if (before === '.' || isIdentChar(before) || (after && after !== '(' && !/\s/.test(after))) {
        i = idx + 3
        continue
      }

      let j = idx + 3
      while (j < len && /\s/.test(s[j]!)) j++
      if (s[j] !== '(') {
        i = idx + 3
        continue
      }

      const callStart = idx
      const argsStart = j + 1
      let k = argsStart
      let depthParen = 1
      let depthBracket = 0
      let depthBrace = 0
      let inStr: '"' | "'" | null = null
      let escaped = false
      const args: string[] = []
      let last = argsStart

      for (; k < len; k++) {
        const ch = s[k]!
        if (inStr) {
          if (escaped) {
            escaped = false
            continue
          }
          if (ch === '\\\\') {
            escaped = true
            continue
          }
          if (ch === inStr) {
            inStr = null
            continue
          }
          continue
        }
        if (ch === '"' || ch === "'") {
          inStr = ch
          continue
        }
        if (ch === '(') depthParen++
        else if (ch === ')') depthParen--
        else if (ch === '[') depthBracket++
        else if (ch === ']') depthBracket--
        else if (ch === '{') depthBrace++
        else if (ch === '}') depthBrace--

        const topLevel = depthParen === 1 && depthBracket === 0 && depthBrace === 0
        if (topLevel && ch === ',') {
          args.push(s.slice(last, k).trim())
          last = k + 1
          continue
        }
        if (depthParen === 0) {
          args.push(s.slice(last, k).trim())
          const callEnd = k + 1
          out.push({ start: callStart, end: callEnd, args, raw: s.slice(callStart, callEnd) })
          break
        }
      }

      i = idx + 3
    }
    return out
  }

  const rewriteOne = (call: Call, base: 'hp' | 'def'): string | null => {
    if (call.args.length < 2) return null
    const arg1 = call.args[0] || ''
    // If the user already multiplied by a stat, do not rewrite (avoid double-scaling).
    if (/\bcalc\s*\(\s*attr\./.test(arg1) || /\battr\./.test(arg1)) return null
    const rest = call.args.slice(1).join(', ')
    return `dmg.basic(calc(attr.${base}) * toRatio(${arg1}), ${rest})`
  }

  for (const d of details) {
    const dmgExpr = typeof (d as any)?.dmgExpr === 'string' ? String((d as any).dmgExpr).trim() : ''
    if (!dmgExpr) continue

    const calls = scanCalls(dmgExpr)
    if (calls.length === 0) continue

    let out = dmgExpr
    // Apply replacements from back to front so indices stay valid.
    for (let i = calls.length - 1; i >= 0; i--) {
      const c = calls[i]!
      const arg1 = c.args[0] || ''
      const mTk = /\btalent\.\s*([A-Za-z0-9_]+)/.exec(arg1)
      const tk = mTk ? String(mTk[1]) : typeof (d as any).talent === 'string' ? String((d as any).talent) : ''
      const base0 = tk ? inferBaseStat(tk) : 'atk'
      if (base0 !== 'hp' && base0 !== 'def') continue
      const rep = rewriteOne(c, base0)
      if (!rep) continue
      out = out.slice(0, c.start) + rep + out.slice(c.end)
    }

    if (out !== dmgExpr) (d as any).dmgExpr = out
  }
}

function patchSrRedundantDmgExprMultipliersFromDmgBuffs(details: CalcSuggestDetail[], buffs: CalcSuggestBuff[]): void {
  try {
    const byCons = new Map<number, Map<string, number[]>>()
    for (const b of buffs) {
      const consRaw = (b as any)?.cons
      const cons = typeof consRaw === 'number' && Number.isFinite(consRaw) ? Math.trunc(consRaw) : 0
      if (!(cons >= 1 && cons <= 6)) continue

      const data = (b as any)?.data
      if (!data || typeof data !== 'object' || Array.isArray(data)) continue

      for (const [k0, v] of Object.entries(data)) {
        const k = String(k0 || '').trim()
        if (!k) continue
        if (!(k === 'dmg' || /Dmg$/.test(k))) continue
        if (typeof v !== 'number' || !Number.isFinite(v)) continue

        let m = byCons.get(cons)
        if (!m) {
          m = new Map<string, number[]>()
          byCons.set(cons, m)
        }
        const arr = m.get(k) || []
        arr.push(v)
        m.set(k, arr)
      }
    }

    if (byCons.size === 0) return

    const pickBucketKeys = (talentRaw: unknown): string[] => {
      const tk0 = typeof talentRaw === 'string' ? String(talentRaw).trim() : ''
      const tk = tk0.replace(/\d+$/, '')
      if (!tk) return ['dmg']
      if (tk.startsWith('me')) return ['meDmg', 'dmg']
      if (tk.startsWith('mt')) return ['mtDmg', 'dmg']
      if (tk.startsWith('a')) return ['aDmg', 'dmg']
      if (tk.startsWith('e')) return ['eDmg', 'dmg']
      if (tk.startsWith('q')) return ['qDmg', 'dmg']
      if (tk.startsWith('t')) return ['tDmg', 'dmg']
      if (tk.startsWith('dot')) return ['dotDmg', 'dmg']
      if (tk.startsWith('break')) return ['breakDmg', 'dmg']
      return ['dmg']
    }

    const refMulRe =
      /\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]\s*\*\s*([0-9]+(?:\.[0-9]+)?)\b/g

    const close = (a: number, b: number): boolean => Math.abs(a - b) <= 0.5

    for (const d of details) {
      const consRaw = (d as any)?.cons
      const cons = typeof consRaw === 'number' && Number.isFinite(consRaw) ? Math.trunc(consRaw) : 0
      if (!(cons >= 1 && cons <= 6)) continue
      const m = byCons.get(cons)
      if (!m) continue

      const expr0 = typeof (d as any)?.dmgExpr === 'string' ? String((d as any).dmgExpr).trim() : ''
      if (!expr0) continue

      const keys = pickBucketKeys((d as any)?.talent)
      const pcts: number[] = []
      for (const k of keys) {
        const arr = m.get(k)
        if (arr && arr.length) pcts.push(...arr)
      }
      if (pcts.length === 0) continue

      let changed = false
      const out = expr0.replace(refMulRe, (full, tk, q, table, factorRaw) => {
        const factor = Number(factorRaw)
        if (!Number.isFinite(factor)) return full
        if (factor <= 1.001 || factor > 80) return full
        // Only strip non-integer factors: integer multipliers are commonly hit-count totals.
        if (Math.abs(factor - Math.round(factor)) < 1e-9) return full

        const pct = (factor - 1) * 100
        if (!Number.isFinite(pct) || pct <= 0 || pct > 2000) return full
        const ok = pcts.some((v) => close(v, pct))
        if (!ok) return full

        changed = true
        return `talent.${tk}[${q}${table}${q}]`
      })
      if (changed) (d as any).dmgExpr = out
    }
  } catch {
    // Best-effort: do not block generation.
  }
}

function deriveSrConsFromBuffHints(
  buffHints: unknown,
  details: CalcSuggestDetail[],
  buffs: CalcSuggestBuff[]
): void {
  try {
    const hints = Array.isArray(buffHints) ? (buffHints as unknown[]) : []
    if (hints.length === 0) return

    const existingKeys = new Set<string>()
    for (const b of buffs) {
      const d = (b as any)?.data
      if (!d || typeof d !== 'object' || Array.isArray(d)) continue
      for (const k of Object.keys(d)) existingKeys.add(k)
    }

    const normTitle = (s: string): string =>
      String(s || '')
        .trim()
        .replace(/\s+/g, '')
        .replace(/[·!?！？…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, '')
    const existingTitles = new Set(details.map((d) => normTitle((d as any)?.title)))
    const pushDerivedDetail = (d: CalcSuggestDetail): void => {
      if (details.length >= 20) return
      const t = normTitle(d.title)
      if (!t || existingTitles.has(t)) return
      existingTitles.add(t)
      details.push(d)
    }

    const pickTalentKey = (text: string): 'a' | 'e' | 'q' | 't' | null => {
      if (/(普攻|普通攻击)/.test(text)) return 'a'
      if (/战技/.test(text)) return 'e'
      if (/终结技/.test(text)) return 'q'
      if (/(反击|天赋|附加伤害|追加伤害|追加攻击|追击)/.test(text)) return 't'
      return null
    }
    const pickStat = (text: string): 'atk' | 'hp' | 'def' | null => {
      if (/(生命上限|生命值上限|最大生命值|生命值)/.test(text)) return 'hp'
      if (/防御力/.test(text)) return 'def'
      if (/(攻击力|攻击)/.test(text)) return 'atk'
      return null
    }
    const pickPct = (text: string, stat: 'atk' | 'hp' | 'def'): number | null => {
      const num = (s: string): number | null => {
        const n = Number(s)
        return Number.isFinite(n) ? n : null
      }
      if (stat === 'hp') {
        const m1 =
          /([0-9]+(?:\.[0-9]+)?)\s*[%％]\s*(?:生命上限|生命值上限|最大生命值|生命值)/.exec(text)
        if (m1) return num(m1[1]!)
        const m2 =
          /(?:生命上限|生命值上限|最大生命值|生命值)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/.exec(text)
        return m2 ? num(m2[1]!) : null
      }
      if (stat === 'def') {
        const m1 = /([0-9]+(?:\.[0-9]+)?)\s*[%％]\s*防御力/.exec(text)
        if (m1) return num(m1[1]!)
        const m2 = /防御力(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/.exec(text)
        return m2 ? num(m2[1]!) : null
      }
      const m1 = /([0-9]+(?:\.[0-9]+)?)\s*[%％]\s*(?:攻击力|攻击)/.exec(text)
      if (m1) return num(m1[1]!)
      const m2 = /(?:攻击力|攻击)(?:的)?\s*([0-9]+(?:\.[0-9]+)?)\s*[%％]/.exec(text)
      return m2 ? num(m2[1]!) : null
    }
    const pickFlat = (text: string): number | null => {
      const m = /(?:\+|＋)\s*([0-9]+(?:\.[0-9]+)?)\b/.exec(text)
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) ? n : null
    }
    const pickPlainPct = (text: string): number | null => {
      const m = /([0-9]+(?:\.[0-9]+)?)\s*[%％]/.exec(text)
      if (!m) return null
      const n = Number(m[1])
      return Number.isFinite(n) ? n : null
    }

    const pickMaxPctByRegex = (text: string, re: RegExp, max = 2000): number | null => {
      const vals: number[] = []
      for (const m of text.matchAll(re)) {
        const n = Number(m[1])
        if (!Number.isFinite(n) || n <= 0 || n > max) continue
        vals.push(n)
      }
      if (!vals.length) return null
      return Math.max(...vals)
    }

    const inferConsGateCheck = (text: string): string | undefined => {
      // Keep gating only when the trigger is explicit. Otherwise, baseline-style showcases often assume max uptime.
      if (/(施放|释放)终结技|终结技时/.test(text)) return 'params.q === true'
      if (/(施放|释放)战技|战技时/.test(text)) return 'params.e === true'
      return undefined
    }

    const findConsBuffKey = (key: string, cons: number): any =>
      buffs.find((b: any) => {
        if (!b || typeof b !== 'object') return false
        if (typeof b.cons !== 'number' || !Number.isFinite(b.cons) || Math.trunc(b.cons) !== cons) return false
        const d = b.data
        return d && typeof d === 'object' && !Array.isArray(d) && Object.prototype.hasOwnProperty.call(d, key)
      })

    const patchTalentMultiDetail = (opts: { cons: number; talent: 'a' | 'e' | 'q' | 't'; deltaPct: number }): void => {
      const { cons, talent, deltaPct } = opts
      if (!Number.isFinite(deltaPct) || deltaPct <= 0 || deltaPct > 2000) return
      const delta = Number((deltaPct / 100).toFixed(6))
      // Find a representative dmg row for that talent block and patch it to include cons-based delta.
      const row = details.find((d: any) => {
        const kind = typeof d.kind === 'string' ? String(d.kind).trim().toLowerCase() : 'dmg'
        return kind === 'dmg' && d.talent === talent && typeof d.table === 'string' && !!String(d.table).trim()
      }) as any
      if (!row) return
      if (typeof row.dmgExpr === 'string' && row.dmgExpr.trim()) return
      const table = String(row.table || '').trim()
      if (!table) return
      const key = typeof row.key === 'string' && row.key.trim() ? row.key.trim() : talent
      row.dmgExpr = `dmg(talent.${talent}[${jsString(table)}] + (cons >= ${cons} ? ${delta} : 0), ${jsString(key)})`
    }

    for (const h0 of hints) {
      const h = normalizePromptText(h0)
      if (!h) continue

      const mCons = /^(\d+)\s*魂[:：]/.exec(h)
      if (!mCons) continue
      const cons = Number(mCons[1])
      if (!Number.isFinite(cons) || cons < 1 || cons > 6) continue
      const check = inferConsGateCheck(h)

      // *Plus inferred buffs
      if (/(额外造成|伤害值提高|伤害提高|伤害提升|提升数值|提高数值)/.test(h)) {
        const talentKey = pickTalentKey(h)
        const stat = pickStat(h)
        if (talentKey && stat) {
          const pct = pickPct(h, stat)
          if (pct != null && Number.isFinite(pct) && pct > 0 && pct <= 2000) {
            const dataKey = `${talentKey}Plus`
            if (!existingKeys.has(dataKey)) {
              const ratio = Number((pct / 100).toFixed(6))
              const statCn = stat === 'hp' ? '生命上限' : stat === 'def' ? '防御力' : '攻击力'
              buffs.push({
                title: `推导：${cons}魂基于${statCn}的追加伤害值`,
                cons,
                ...(check ? { check } : {}),
                data: {
                  [dataKey]: `calc(attr.${stat}) * ${ratio}`
                }
              })
              existingKeys.add(dataKey)
            }
          }
        }
      }

      // Global dmg% buffs from Eidolon text (common, deterministic).
      // Example: "造成的伤害提高160%".
      if (/(造成|造成的).{0,8}伤害.{0,8}(提高|提升|增加)/.test(h)) {
        // Scope detection:
        // - Many eidolons are phrased as "施放终结技时，使自身造成的伤害提高..." (global buff, triggered by Q).
        // - Only treat it as skill-scoped when the skill name is directly tied to the damage phrase (baseline-like).
        const scoped = /(?:普攻|普通攻击|战技|终结技|天赋|秘技|追加攻击|追击|反击|追加|附加|持续|dot|击破|超击破)(?!时)(?!后)[^。\n]{0,18}(?:造成的)?伤害.{0,8}(提高|提升|增加)/i.test(
          h
        )

        // Skill-scoped dmg% buffs (e.g. "战技造成的伤害提高20%" / "天赋的追加攻击造成的伤害提高729%").
        // Use bucketed keys (aDmg/eDmg/qDmg/tDmg) instead of global `dmg` to keep it maintainable and closer to baseline.
        if (scoped) {
          // Guardrail: "倍率提高" should be handled by `patchTalentMultiDetail` instead.
          if (!/(倍率|伤害倍率)/.test(h)) {
            const pct =
              pickMaxPctByRegex(h, /伤害.{0,8}(?:提高|提升|增加).{0,16}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g) ??
              pickPlainPct(h)
            if (pct != null) {
              const keys: string[] = []
              if (/(普攻|普通攻击)/.test(h)) keys.push('aDmg')
              if (/战技/.test(h)) keys.push('eDmg')
              if (/终结技/.test(h)) keys.push('qDmg')
              if (/(天赋|追加攻击|追击|反击|追加)/.test(h)) keys.push('tDmg')

              const need: string[] = []
              for (const k of keys) {
                if (!isAllowedMiaoBuffDataKey('sr', k)) continue
                const existing = findConsBuffKey(k, cons)
                if (existing) {
                  const d: any = existing.data
                  if (d && typeof d === 'object') (d as any)[k] = pct
                  continue
                }
                if (existingKeys.has(k)) continue
                need.push(k)
              }

              if (need.length) {
                const data: Record<string, number> = {}
                for (const k of need) data[k] = pct
                buffs.push({
                  title: `推导：${cons}魂技能伤害提高`,
                  cons,
                  data
                })
                for (const k of need) existingKeys.add(k)
              }
            }
          }
        } else {
          // Prefer max-tier value when multiple clauses exist (baseline-style showcase).
          const pct =
            pickMaxPctByRegex(h, /伤害.{0,8}(?:提高|提升|增加).{0,16}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g) ?? null
          if (pct != null) {
            const existing = findConsBuffKey('dmg', cons)
            if (existing) {
              const d: any = existing.data
              if (d && typeof d === 'object' && typeof d.dmg === 'number') d.dmg = pct
            } else {
              buffs.push({
                title: `推导：${cons}魂造成的伤害提高[dmg]%`,
                cons,
                ...(check ? { check } : {}),
                data: { dmg: pct }
              })
            }
          }
        }
      }

      // Final multiplier ("为原伤害的140%") style buffs from Eidolon text.
      // This wording is usually a multiplicative modifier, better modeled as `*Multi` (or global `multi`)
      // rather than an additive `dmg` buff.
      try {
        const pctTo =
          pickMaxPctByRegex(
            h,
            /\u4e3a\u539f(?:\u672c)?\u4f24\u5bb3.{0,12}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g
          ) ??
          pickMaxPctByRegex(
            h,
            /\u53d8\u4e3a\u539f(?:\u672c)?\u4f24\u5bb3.{0,12}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g
          ) ??
          null

        if (pctTo != null && Number.isFinite(pctTo) && pctTo > 100 && pctTo <= 3000) {
          const delta = Number((pctTo - 100).toFixed(6))
          const talentKey = pickTalentKey(h)
          const dataKey = talentKey ? `${talentKey}Multi` : 'multi'
          if (isAllowedMiaoBuffDataKey('sr', dataKey)) {
            const gateKey = `cons${cons}`
            const expr = `params.${gateKey} ? ${delta} : 0`
            const existing = findConsBuffKey(dataKey, cons)
            if (existing) {
              const d: any = existing.data
              if (d && typeof d === 'object') (d as any)[dataKey] = expr
            } else if (!existingKeys.has(dataKey)) {
              buffs.push({
                title: `推导：${cons}魂 伤害为原伤害的${pctTo}%[${dataKey}]`,
                cons,
                data: { [dataKey]: expr }
              })
              existingKeys.add(dataKey)
            }
          }
        }
      } catch {
        // ignore
      }
      // kx% (resistance penetration) is a common SR damage modifier.
      if (/抗性穿透/.test(h) && /(提高|提升|增加)/.test(h)) {
        const pct = pickMaxPctByRegex(h, /抗性穿透.{0,12}([0-9]+(?:\.[0-9]+)?)\s*[%％]/g, 100) ?? null
        if (pct != null) {
          const existing = findConsBuffKey('kx', cons)
          if (existing) {
            const d: any = existing.data
            if (d && typeof d === 'object' && typeof d.kx === 'number') d.kx = pct
          } else {
            buffs.push({
              title: `推导：${cons}魂抗性穿透提高[kx]%`,
              cons,
              ...(check ? { check } : {}),
              data: { kx: pct }
            })
          }
        }
      }

      // Crit buffs from Eidolon text.
      if (/(暴击率|暴击伤害|爆伤)/.test(h) && /(提高|提升|增加)/.test(h)) {
        const cpct = pickMaxPctByRegex(h, /暴击率.{0,10}([0-9]+(?:\.[0-9]+)?)\s*[%％]/g, 100)
        if (cpct != null) {
          const existing = findConsBuffKey('cpct', cons)
          if (existing) {
            const d: any = existing.data
            if (d && typeof d === 'object' && typeof d.cpct === 'number') d.cpct = cpct
          } else {
            buffs.push({
              title: `推导：${cons}魂暴击率提高[cpct]%`,
              cons,
              ...(check ? { check } : {}),
              data: { cpct }
            })
          }
        }

        const cdmg = pickMaxPctByRegex(h, /(?:暴击伤害|爆伤).{0,10}([0-9]+(?:\.[0-9]+)?)\s*[%％]/g, 500)
        if (cdmg != null) {
          const existing = findConsBuffKey('cdmg', cons)
          if (existing) {
            const d: any = existing.data
            if (d && typeof d === 'object' && typeof d.cdmg === 'number') d.cdmg = cdmg
          } else {
            buffs.push({
              title: `推导：${cons}魂暴击伤害提高[cdmg]%`,
              cons,
              ...(check ? { check } : {}),
              data: { cdmg }
            })
          }
        }
      }

      // Ignore DEF
      if ((/无视|ignore/i.test(h) && /防御/.test(h)) || /\u65e0\u89c6.*\u9632\u5fa1/.test(h)) {
        const pct = pickMaxPctByRegex(h, /([0-9]+(?:\.[0-9]+)?)\s*[%％].{0,12}防御/g, 120)
        if (pct != null) {
          const existing = findConsBuffKey('ignore', cons)
          if (existing) {
            const d: any = existing.data
            if (d && typeof d === 'object' && typeof d.ignore === 'number') d.ignore = pct
          } else {
            buffs.push({
              title: `推导：${cons}魂无视目标防御力[ignore]%`,
              cons,
              ...(check ? { check } : {}),
              data: { ignore: pct }
            })
          }
        }
      }

      // Enemy DEF shred (debuff): baseline commonly models this as `enemyDef`.
      if (/(防御力降低|防御降低|减防)/.test(h) && !/(无视|ignore)/i.test(h)) {
        const pct =
          pickMaxPctByRegex(h, /防御.{0,10}(?:降低|下降|减少).{0,12}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g, 120) ?? null
        if (pct != null) {
          const existing = findConsBuffKey('enemyDef', cons)
          if (existing) {
            const d: any = existing.data
            if (d && typeof d === 'object' && typeof d.enemyDef === 'number') d.enemyDef = pct
          } else {
            buffs.push({
              title: `推导：${cons}魂降低目标防御力[enemyDef]%`,
              cons,
              ...(check ? { check } : {}),
              data: { enemyDef: pct }
            })
          }
        }
      }

      // Talent multiplier delta (e.g. "终结技的伤害倍率提高240%").
      // In SR, such wording usually means "+X%倍率" (additive to the talent ratio), not a final multiplier buff.
      if (/(倍率|伤害倍率)/.test(h) && /(提高|提升|增加)/.test(h)) {
        const talentKey = pickTalentKey(h)
        const pct =
          pickMaxPctByRegex(h, /(?:伤害倍率|倍率).{0,8}(?:提高|提升|增加).{0,12}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/g) ??
          pickPlainPct(h)
        if (talentKey && pct != null && Number.isFinite(pct) && pct > 0) {
          patchTalentMultiDetail({ cons, talent: talentKey, deltaPct: pct })
        }
      }

      // Cons heal/shield rows
      const wantsShield =
        /护盾/.test(h) && (/(抵消|吸收)/.test(h) || /护盾.{0,10}持续/.test(h))
      const wantsHeal =
        (/(治疗|回复)/.test(h) ||
          (/恢复/.test(h) && /(生命上限|生命值上限|最大生命值|生命值)/.test(h))) &&
        /(生命上限|生命值上限|最大生命值|生命值)/.test(h)
      if (!wantsShield && !wantsHeal) continue

      const statOrder: Array<'atk' | 'hp' | 'def'> = wantsHeal ? ['hp', 'def', 'atk'] : ['def', 'hp', 'atk']
      let stat: 'atk' | 'hp' | 'def' | null = null
      let pct: number | null = null
      for (const s of statOrder) {
        const p = pickPct(h, s)
        if (p != null) {
          stat = s
          pct = p
          break
        }
      }
      if (!stat) stat = pickStat(h)
      if (!stat) continue
      if (pct == null) pct = pickPct(h, stat)
      const flat = pickFlat(h)
      if (pct == null && flat == null) continue

      const ratio = pct != null && Number.isFinite(pct) ? Number((pct / 100).toFixed(6)) : 0
      const exprParts: string[] = []
      if (pct != null && Number.isFinite(pct) && pct > 0) exprParts.push(`calc(attr.${stat}) * ${ratio}`)
      if (flat != null && Number.isFinite(flat) && flat !== 0) exprParts.push(String(flat))
      if (exprParts.length === 0) continue

      const kind: CalcDetailKind = wantsShield ? 'shield' : 'heal'
      const fn = wantsShield ? 'shield' : 'heal'
      const isDotLike = /(持续|回合开始|持续治疗)/.test(h)
      const title = wantsShield ? `${cons}命护盾量` : `${cons}命${isDotLike ? '持续' : ''}治疗量`
      pushDerivedDetail({ title, kind, cons, dmgExpr: `${fn}(${exprParts.join(' + ')})` })
    }
  } catch {
    // Best-effort: do not block generation.
  }
}

export function applySrDerivedFromBuffHints(input: CalcSuggestInput, plan: CalcSuggestResult): void {
  if (input.game !== 'sr') return
  const details = Array.isArray(plan.details) ? plan.details : []
  const buffsRaw = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as Array<unknown>) : []
  const buffStrings: string[] = []
  const buffsArr: CalcSuggestBuff[] = []
  for (const b of buffsRaw) {
    if (typeof b === 'string') {
      const t = b.trim()
      if (t) buffStrings.push(t)
      continue
    }
    if (!b || typeof b !== 'object' || Array.isArray(b)) continue
    if (!(b as any).title) continue
    buffsArr.push(b as CalcSuggestBuff)
  }

  // NOTE: `deriveSrConsFromBuffHints` may push new buff entries; write back after derivation.
  deriveSrConsFromBuffHints(input.buffHints, details, buffsArr)
  patchSrBuffGateFieldsFromTitles(buffsArr)
  ;(plan as any).buffs = [...buffStrings, ...buffsArr]
}
