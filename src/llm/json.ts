/**
 * Helpers for parsing strict JSON outputs from LLMs.
 *
 * Even when the prompt asks for "JSON only", providers/models may wrap output
 * in Markdown fences. We keep parsing robust but deterministic.
 */

function stripCodeFence(text: string): string {
  const t = text.trim()
  if (!t.startsWith('```')) return t

  // ```json\n{...}\n```
  const firstNl = t.indexOf('\n')
  if (firstNl === -1) return t
  const body = t.slice(firstNl + 1)
  const endFence = body.lastIndexOf('```')
  if (endFence === -1) return body.trim()
  return body.slice(0, endFence).trim()
}

function extractJsonLike(text: string): string {
  const t = stripCodeFence(text).trim()
  if (!t) return ''

  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first === -1 || last === -1 || last <= first) return ''
  return t.slice(first, last + 1).trim()
}

export function parseJsonFromLlmText(text: string): unknown {
  const raw = extractJsonLike(text)
  if (!raw) {
    throw new Error(`[meta-gen] LLM output does not contain a JSON object`)
  }
  try {
    return JSON.parse(raw) as unknown
  } catch (e) {
    throw new Error(
      `[meta-gen] Failed to parse LLM JSON output: ${e instanceof Error ? e.message : String(e)}\n` +
        raw.slice(0, 2000)
    )
  }
}

