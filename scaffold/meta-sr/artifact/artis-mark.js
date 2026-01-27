/**
 * Default relic scoring weights (scaffold, minimal).
 *
 * Rationale:
 * - Per-character scoring weights are high-churn and do not affect the correctness of meta data.json.
 * - Keep scaffold lean; runtime should fall back to its own defaults when a character is not listed.
 *
 * If you want richer weights, add them via a separate generator stage or user config.
 */

export const usefulAttr = {}

