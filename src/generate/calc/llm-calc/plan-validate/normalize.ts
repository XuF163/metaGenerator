import type { CalcDetailKind, CalcScaleStat } from '../types.js'

export function normalizeKind(v: unknown): CalcDetailKind {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (t === 'dmg' || t === 'heal' || t === 'shield' || t === 'reaction') return t
  return 'dmg'
}

export function normalizeStat(v: unknown): CalcScaleStat | undefined {
  const t = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!t) return undefined
  if (t === 'em' || t === 'elementalmastery') return 'mastery'
  if (t === 'atk' || t === 'hp' || t === 'def' || t === 'mastery') return t
  return undefined
}

