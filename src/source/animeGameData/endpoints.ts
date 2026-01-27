/**
 * AnimeGameData (DimbreathBot) endpoint helpers.
 *
 * We use this repo as a secondary data source to fill gaps not covered by Hakush,
 * e.g. the "real" GS artifact item IDs required for profile matching.
 *
 * Default upstream (as of 2026-01):
 * - https://gitlab.com/Dimbreath/AnimeGameData
 * - Raw base: https://gitlab.com/Dimbreath/AnimeGameData/-/raw/master
 */

export const DEFAULT_ANIME_GAME_DATA_BASE_URL = 'https://gitlab.com/Dimbreath/AnimeGameData/-/raw/master'

export function animeGameDataUrl(baseUrl: string, relPath: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/${relPath.replace(/^\/+/, '')}`
}
