/**
 * Hakush.in endpoint helpers.
 *
 * We treat Hakush as our primary "structured" upstream for GS/SR meta generation.
 * All URLs are expected to be stable and cacheable.
 */

import type { Game } from '../../types.js'

export type HakushGame = 'gi' | 'hsr'
export type HakushLang = 'zh' | 'cn'

export function toHakushGame(game: Game): HakushGame {
  return game === 'gs' ? 'gi' : 'hsr'
}

export function toHakushLang(game: Game): HakushLang {
  // Hakush uses zh for GI and cn for HSR in their localized data endpoints.
  return game === 'gs' ? 'zh' : 'cn'
}

export function hakushApiBase(hg: HakushGame): string {
  return `https://api.hakush.in/${hg}`
}

export function hakushDataUrl(hg: HakushGame, relPath: string): string {
  return `${hakushApiBase(hg)}/${relPath.replace(/^\/+/, '')}`
}

