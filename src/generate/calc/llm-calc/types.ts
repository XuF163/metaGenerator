// Shared types for LLM-assisted calc.js generation.

type TalentKeyGs = 'a' | 'e' | 'q'
// SR talent blocks can include extra keys (e.g. Memory path: me/mt/mt1/mt2), and future updates may add more.
// Keep this as a string and validate against `input.tables` at runtime.
type TalentKey = string

export type { TalentKeyGs, TalentKey }

export interface CalcSuggestInput {
  game: 'gs' | 'sr'
  /** Optional numeric avatar id (GS: 100000xx, SR: 1001..). */
  id?: number
  name: string
  elem: string
  weapon?: string
  star?: number
  // Candidate talent table names (must match keys available at runtime).
  tables: Partial<Record<TalentKey, string[]>>
  /**
   * Optional table unit hints for each talent table name.
   * Used to pick correct scaling stat (hp/def) for `dmg.basic(...)` rendering.
   */
  tableUnits?: Partial<Record<TalentKey, Record<string, string>>>
  /**
   * Optional sample values for talent tables (for LLM only).
   * Helpful to distinguish:
   * - number
   * - [pct, flat]
   * - [atkPct, masteryPct] / other multi-component arrays
   *
   * Tip: keep prompts small by only including tables whose sample value is an array/object.
   */
  tableSamples?: Partial<Record<TalentKey, Record<string, unknown>>>
  /**
   * Optional human-readable sample texts for structured talent tables (array/object).
   * Mainly used to infer array component meaning (e.g. "%攻击 + %精通") and to help the LLM.
   *
   * Suggested source: meta.talent.<a/e/q/t>.tables[...].values[0] (mapped to the corresponding `<name>2` keys).
   */
  tableTextSamples?: Partial<Record<TalentKey, Record<string, string>>>
  // Optional skill description text (helps LLM/heuristics pick correct damage tables).
  talentDesc?: Partial<Record<TalentKey, string>>
  /**
   * Optional extra text hints for buffs generation.
   * Keep each entry as a single line (passives/cons/traces/technique).
   */
  buffHints?: string[]
  /**
   * Optional trusted upstream context for "upstream-follow" calc generation.
   *
   * This is intended to be produced by local scripts that read upstream repos (as submodules),
   * then injected into the LLM prompt to reduce hallucination and keep semantics aligned.
   */
  upstream?: {
    /** Upstream project name, e.g. "genshin-optimizer" / "hsr-optimizer". */
    source: string
    /** Optional upstream file path (for debugging). */
    file?: string
    /** Small excerpt / summary (keep it short; prompt is size-limited). */
    excerpt?: string
  }
}

export type CalcDetailKind = 'dmg' | 'heal' | 'shield' | 'reaction'
export type CalcScaleStat = 'atk' | 'hp' | 'def' | 'mastery'

export interface CalcSuggestDetail {
  title: string
  /**
   * Detail kind (defaults to "dmg" when omitted).
   * - dmg: normal talent multiplier damage
   * - heal: healing amount (avg only)
   * - shield: shield absorption (avg only)
   * - reaction: transformative reaction (swirl/bloom/...) using dmgFn.reaction(...)
   */
  kind?: CalcDetailKind
  /**
   * Which talent block to read from (`talent.a/e/q/t[...]`).
   * Required for kind=dmg/heal/shield.
   */
  talent?: TalentKey
  /**
   * Talent table name. Must exist at runtime.
   * Required for kind=dmg/heal/shield.
   */
  table?: string
  /**
   * The second argument passed to dmg() in calc.js.
   * - For GS: typically a/e/q/a2/a3...
   * - For SR: a/e/q/t...
   */
  key?: string
  /**
   * Optional third argument passed to dmg() (e.g. "phy", "vaporize").
   * Keep empty for normal elemental skills.
   */
  ele?: string
  /**
   * Optional array component selector (0-based).
   *
   * Use when the selected talent table returns an array of multiple *variant* percentages, e.g.
   * - "低空/高空坠地冲击伤害2": [lowPct, highPct]
   * - "岩脊伤害/共鸣伤害2": [stelePct, resonancePct]
   *
   * When set, generator will use `t[pick]` as the percentage instead of treating the array as `[pct, flat]`.
   */
  pick?: number
  /**
   * Scaling stat for kind=heal/shield when the table is a percentage (or [pct,flat]).
   * If omitted, generator will infer from tableUnits / talentDesc.
   */
  stat?: CalcScaleStat
  /**
   * Reaction id for kind=reaction (passed to dmgFn.reaction("<id>")).
   */
  reaction?: string
  /**
   * Optional custom damage expression (JS expression, NOT a function).
   * When provided, generator will render this detail's dmg() using the expression directly:
   *   ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (<dmgExpr>)
   *
   * Notes:
   * - Use this when the formula mixes multiple stats/tables, counts hits, or needs conditional branches.
   * - Prefer `dmg.basic(...)` for non-ATK based damage / mixed-stat damage.
   * - You can use: talent, attr, calc, params, cons, weapon, trees, dmg, toRatio.
   */
  dmgExpr?: string
  /**
   * Optional params object for this detail row.
   * This is used by miao-plugin to model stateful skills/buffs (e.g. Q active, stacks).
   * Must be JSON-serializable primitives only (number/boolean/string).
   */
  params?: Record<string, number | boolean | string>
  /**
   * Optional condition expression (JS expression, NOT a function).
   * Rendered as: ({ talent, attr, calc, params, cons, weapon, trees }) => (<expr>)
   */
  check?: string
  /** Optional constellation requirement (1..6). */
  cons?: number
}

export interface CalcSuggestBuff {
  title: string
  /** Sort order (higher first in UI). */
  sort?: number
  /** Constellation / Eidolon requirement (1..6). */
  cons?: number
  /** SR major trace index (1..3/4) when applicable. */
  tree?: number
  /**
   * Optional condition expression (JS expression, NOT a function).
   * Rendered as: ({ talent, attr, calc, params, cons, weapon, trees }) => (<expr>)
   */
  check?: string
  /**
   * Buff data mapping:
   * - number: direct value
   * - string: JS expression (NOT a function), rendered into an arrow fn returning number
   */
  data?: Record<string, number | string>
}

export interface CalcSuggestResult {
  mainAttr: string
  defDmgKey?: string
  details: CalcSuggestDetail[]
  /**
   * Buff list:
   * - object: normal miao-plugin buff entry
   * - string: builtin buff id used by baseline meta (e.g. "vaporize"/"melt"/"spread"/"aggravate")
   */
  buffs?: Array<CalcSuggestBuff | string>
}
