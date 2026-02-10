/**
 * Fix common LLM mistakes around crit expectation math.
 *
 * In miao-plugin, `dmg(...)` already returns `{ dmg, avg }`, where `avg` is crit-expected damage.
 * LLMs sometimes multiply `.avg` again by `(1 + cpct * cdmg)` (often using percent-point units),
 * which can inflate results by orders of magnitude and breaks regression.
 */

type Quote = "'" | '"' | '`'

function findMatchingParen(expr: string, openIdx: number): number {
  const s = expr
  const len = s.length
  let depth = 0
  let inStr: Quote | null = null
  let escaped = false

  for (let i = openIdx; i < len; i++) {
    const ch = s[i]!
    if (inStr) {
      if (escaped) {
        escaped = false
        continue
      }
      if (ch === '\\') {
        escaped = true
        continue
      }
      if (ch === inStr) {
        inStr = null
        continue
      }
      continue
    }

    if (ch === "'" || ch === '"' || ch === '`') {
      inStr = ch as Quote
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function looksLikeCritExpectationFactor(factor: string): boolean {
  const s = factor.replace(/\s+/g, '')
  if (!s.startsWith('*(')) return false
  // We only need to detect the common "1 + critRate * critDmg" style. Units differ across engines,
  // so we remove the factor entirely instead of trying to correct it.
  return s.includes('calc(attr.cpct)') && s.includes('calc(attr.cdmg)')
}

export function rewriteDmgExprRemoveCritExpectation(exprRaw: string): string | null {
  let expr = String(exprRaw || '')
  if (!expr) return null
  if (!expr.includes('calc') || !expr.includes('attr.cpct') || !expr.includes('attr.cdmg')) return null

  let changed = false

  // Iterate until stable; expressions are short so this is cheap.
  for (let pass = 0; pass < 8; pass++) {
    let inStr: Quote | null = null
    let escaped = false
    let found = false

    for (let i = 0; i < expr.length; i++) {
      const ch = expr[i]!
      if (inStr) {
        if (escaped) {
          escaped = false
          continue
        }
        if (ch === '\\') {
          escaped = true
          continue
        }
        if (ch === inStr) {
          inStr = null
          continue
        }
        continue
      }

      if (ch === "'" || ch === '"' || ch === '`') {
        inStr = ch as Quote
        continue
      }

      const tail = expr.slice(i)
      const kind = tail.startsWith('.avg') ? 'avg' : tail.startsWith('.dmg') ? 'dmg' : null
      if (!kind) continue

      const propStart = i
      const propEnd = i + 4 // exclusive

      let j = propEnd
      while (j < expr.length && /\s/.test(expr[j]!)) j++
      if (expr[j] !== '*') continue

      const mulStart = j
      j++
      while (j < expr.length && /\s/.test(expr[j]!)) j++
      if (expr[j] !== '(') continue

      const parenEnd = findMatchingParen(expr, j)
      if (parenEnd < 0) continue

      const factor = expr.slice(mulStart, parenEnd + 1)
      if (!looksLikeCritExpectationFactor(factor)) continue

      // Apply rewrite:
      // - ".avg * (1 + ...cpct...cdmg...)" -> ".avg"
      // - ".dmg * (1 + ...cpct...cdmg...)" -> ".avg"
      const before = expr.slice(0, propStart)
      const after = expr.slice(parenEnd + 1)
      const prop = kind === 'dmg' ? '.avg' : '.avg'
      expr = before + prop + expr.slice(propEnd, mulStart) + after

      changed = true
      found = true
      break
    }

    if (!found) break
  }

  return changed ? expr : null
}

