/**
 * turnbasedgamedata (Dimbreath) endpoint helpers.
 *
 * We use this repo as a secondary data source for SR (Honkai: Star Rail) when Hakush/Yatta
 * do not expose the exact mapping we need (e.g. some "Path" / "Aeon" icon paths).
 *
 * Default upstream (as of 2026-01):
 * - https://gitlab.com/Dimbreath/turnbasedgamedata
 * - Raw base: https://gitlab.com/Dimbreath/turnbasedgamedata/-/raw/main
 */

export const DEFAULT_TURN_BASED_GAME_DATA_BASE_URL = 'https://gitlab.com/Dimbreath/turnbasedgamedata/-/raw/main'

export function turnBasedGameDataUrl(baseUrl: string, relPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`
}
