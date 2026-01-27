/**
 * Artifact alias/abbr tables (scaffold, minimal).
 *
 * Why keep it empty:
 * - These mappings are high-churn and largely QoL-only.
 * - A large preset table bloats scaffold and becomes stale when new relics arrive.
 * - The generator already produces full official names via upstream APIs; users can still search
 *   by full names. Rich nicknames can be generated later (e.g. API-derived or LLM-assisted).
 */

/** Relic piece abbreviation map (optional). */
export const artiAbbr = {}

/** Relic set abbreviation map (optional). */
export const artiSetAbbr = {}

/** Relic set alias map (optional). */
export const aliasCfg = {}

