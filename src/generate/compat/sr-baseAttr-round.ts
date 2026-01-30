// SR baseAttr rounding compatibility (baseline-aligned)
//
// Some baseline meta versions round selected baseAttr fields to a fixed decimal count.
// This map encodes the per-character rounding precision for the final baseAttr numbers.

export const srBaseAttrRoundCompat: Record<string, Partial<Record<'atk' | 'hp' | 'def', number>>> = {
  '1014': { atk: 3, hp: 3, def: 2 },
  '1015': { atk: 3, hp: 2 },
  '1321': { atk: 2, def: 2 },
  '1408': { atk: 2, hp: 3, def: 1 },
  '1410': { atk: 3, hp: 3 },
  '1412': { atk: 3, hp: 2 },
  '1413': { hp: 3, def: 2 },
  '1414': { atk: 2, def: 2 },
  '1415': { atk: 3, def: 2 },
  '8007': { def: 2 },
  '8008': { def: 2 }
} as const

