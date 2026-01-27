/**
 * Hakush client with on-disk caching.
 *
 * metaGenerator is designed to be reproducible; we therefore cache upstream
 * responses under `temp/metaGenerator/.cache/hakush/...` and read from disk
 * for subsequent runs.
 */

import path from 'node:path'
import type { Game } from '../../types.js'
import { downloadToFile } from '../../http/download.js'
import { readJsonFile } from './read-json.js'
import { hakushApiBase, toHakushGame, toHakushLang } from './endpoints.js'

export interface HakushClientOptions {
  /** Absolute path to `.cache/hakush` */
  cacheRootAbs: string
  /** When true, re-download even if cached file exists. */
  force: boolean
  /** Optional logger for progress output. */
  log?: Pick<Console, 'info' | 'warn'>
}

export class HakushClient {
  private cacheRootAbs: string
  private force: boolean
  private log?: Pick<Console, 'info' | 'warn'>

  constructor(opts: HakushClientOptions) {
    this.cacheRootAbs = opts.cacheRootAbs
    this.force = opts.force
    this.log = opts.log
  }

  private cachePath(relPath: string): string {
    // Keep relPath stable even on Windows.
    return path.join(this.cacheRootAbs, relPath.split('/').join(path.sep))
  }

  private async getJsonCached<T>(url: string, relPath: string): Promise<T> {
    const filePath = this.cachePath(relPath)
    const res = await downloadToFile(url, filePath, { force: this.force })
    if (!res.ok) {
      throw new Error(`[meta-gen] Hakush fetch failed: ${url} -> ${res.error}`)
    }
    if (res.action === 'downloaded') {
      this.log?.info?.(`[meta-gen] hakush cached ${relPath} (${res.bytes} bytes)`)
    }
    return readJsonFile<T>(filePath)
  }

  async getNew(game: Game): Promise<unknown> {
    const hg = toHakushGame(game)
    const url = `${hakushApiBase(hg)}/new.json`
    return this.getJsonCached(url, `${hg}/new.json`)
  }

  // ---------- GS (GI) ----------

  async getGsWeaponList(): Promise<Record<string, unknown>> {
    const hg = 'gi'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/weapon.json`, `${hg}/data/weapon.json`)
  }

  async getGsCharacterList(): Promise<Record<string, unknown>> {
    const hg = 'gi'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/character.json`, `${hg}/data/character.json`)
  }

  async getGsArtifactList(): Promise<Record<string, unknown>> {
    const hg = 'gi'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/artifact.json`, `${hg}/data/artifact.json`)
  }

  async getGsItemAll(): Promise<unknown> {
    const hg = 'gi'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/zh/item_all.json`, `${hg}/data/zh/item_all.json`)
  }

  async getGsWeaponDetail(id: string | number): Promise<unknown> {
    const hg = 'gi'
    const lang = toHakushLang('gs')
    return this.getJsonCached(`${hakushApiBase(hg)}/data/${lang}/weapon/${id}.json`, `${hg}/data/${lang}/weapon/${id}.json`)
  }

  async getGsCharacterDetail(id: string | number): Promise<unknown> {
    const hg = 'gi'
    const lang = toHakushLang('gs')
    return this.getJsonCached(`${hakushApiBase(hg)}/data/${lang}/character/${id}.json`, `${hg}/data/${lang}/character/${id}.json`)
  }

  async getGsArtifactDetail(id: string | number): Promise<unknown> {
    const hg = 'gi'
    const lang = toHakushLang('gs')
    return this.getJsonCached(`${hakushApiBase(hg)}/data/${lang}/artifact/${id}.json`, `${hg}/data/${lang}/artifact/${id}.json`)
  }

  // ---------- SR (HSR) ----------

  async getSrLightconeList(): Promise<Record<string, unknown>> {
    const hg = 'hsr'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/lightcone.json`, `${hg}/data/lightcone.json`)
  }

  async getSrCharacterList(): Promise<Record<string, unknown>> {
    const hg = 'hsr'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/character.json`, `${hg}/data/character.json`)
  }

  async getSrRelicsetList(): Promise<Record<string, unknown>> {
    const hg = 'hsr'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/relicset.json`, `${hg}/data/relicset.json`)
  }

  async getSrItemAll(): Promise<unknown> {
    const hg = 'hsr'
    return this.getJsonCached(`${hakushApiBase(hg)}/data/cn/item_all.json`, `${hg}/data/cn/item_all.json`)
  }

  async getSrLightconeDetail(id: string | number): Promise<unknown> {
    const hg = 'hsr'
    const lang = toHakushLang('sr')
    return this.getJsonCached(
      `${hakushApiBase(hg)}/data/${lang}/lightcone/${id}.json`,
      `${hg}/data/${lang}/lightcone/${id}.json`
    )
  }

  async getSrCharacterDetail(id: string | number): Promise<unknown> {
    const hg = 'hsr'
    const lang = toHakushLang('sr')
    return this.getJsonCached(
      `${hakushApiBase(hg)}/data/${lang}/character/${id}.json`,
      `${hg}/data/${lang}/character/${id}.json`
    )
  }

  async getSrRelicsetDetail(id: string | number): Promise<unknown> {
    const hg = 'hsr'
    const lang = toHakushLang('sr')
    return this.getJsonCached(
      `${hakushApiBase(hg)}/data/${lang}/relicset/${id}.json`,
      `${hg}/data/${lang}/relicset/${id}.json`
    )
  }
}

