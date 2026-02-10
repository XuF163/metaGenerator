import type { CalcSuggestInput, TalentKeyGs } from '../types.js'
import { inferArrayTableSchema } from '../table-schema.js'
import { jsString } from '../utils.js'

/**
 * GS: fix a common LLM mistake where an array-table (e.g. "[%ATK, %EM]") is passed directly into `dmg(...)`.
 *
 * Example bad output:
 *   dmg(talent.q["单次伤害2"], "q").dmg * N
 *
 * If "单次伤害2" is a statStat/statFlat array table, `dmg(...)` will receive an array and produce invalid output,
 * often resulting in missing/zero showcase rows in panel-regression.
 *
 * We conservatively rewrite literal-key dmg() calls into an Array.isArray(...) conditional using dmg.basic(...).
 */
export function rewriteGsDmgExprFixArrayDmgCalls(exprRaw: string, input: CalcSuggestInput): string | null {
  const expr = String(exprRaw || '').trim()
  if (!expr) return null
  if (!/\bdmg\s*\(/.test(expr) || !/\btalent\s*\./.test(expr)) return null

  let changed = false

  const out = expr.replace(
    /\bdmg\s*\(\s*talent\s*\.\s*([aeq])\s*\[\s*(['"])([^'"\\]+)\2\s*]\s*,\s*(['"])([^'"\\]+)\4\s*(?:,\s*(['"])([^'"\\]+)\6\s*)?\)/g,
    (full, tkRaw, _qTable, table, _qKey, key, qEle, ele) => {
      const tk = String(tkRaw || '').trim() as TalentKeyGs
      if (tk !== 'a' && tk !== 'e' && tk !== 'q') return full

      const schema = inferArrayTableSchema(input, tk, table)
      if (!schema) return full
      if (schema.kind !== 'statStat' && schema.kind !== 'statFlat') return full

      changed = true

      const acc = `talent.${tk}[${jsString(table)}]`
      const keyArg = jsString(key)
      const eleArg = qEle ? `, ${jsString(ele)}` : ''

      if (schema.kind === 'statStat') {
        const [s0, s1] = schema.stats
        return `(Array.isArray(${acc}) ? dmg.basic(calc(attr.${s0}) * toRatio(${acc}[0]) + calc(attr.${s1}) * toRatio(${acc}[1]), ${keyArg}${eleArg}) : dmg(${acc}, ${keyArg}${eleArg}))`
      }

      // statFlat
      return `(Array.isArray(${acc}) ? dmg.basic(calc(attr.${schema.stat}) * toRatio(${acc}[0]) + (Number(${acc}[1]) || 0), ${keyArg}${eleArg}) : dmg(${acc}, ${keyArg}${eleArg}))`
    }
  )

  return changed ? out : null
}

