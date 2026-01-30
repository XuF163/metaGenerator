/**
 * Yatta (sr.yatta.moe) client with lightweight on-disk caching.
 *
 * We treat Yatta as a supplementary source to fill gaps in Hakush data
 * (notably SR relic piece desc/lore).
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../fs/json.js'
import { fetchJsonWithRetry } from '../../http/fetch.js'
import { readJsonFile } from './read-json.js'

export type YattaLang = 'cn' | 'en' | string

export interface YattaClientOptions {
  /** Absolute path to `.cache/yatta` */
  cacheRootAbs: string
  /** When true, re-fetch even if cached file exists. */
  force: boolean
  /** Optional logger for progress output. */
  log?: Pick<Console, 'info' | 'warn'>
}

export class YattaClient {
  private cacheRootAbs: string
  private force: boolean
  private log?: Pick<Console, 'info' | 'warn'>

  constructor(opts: YattaClientOptions) {
    this.cacheRootAbs = opts.cacheRootAbs
    this.force = opts.force
    this.log = opts.log
  }

  private cachePath(relPath: string): string {
    // Keep relPath stable even on Windows.
    return path.join(this.cacheRootAbs, relPath.split('/').join(path.sep))
  }

  private async getJsonCached(relPath: string, url: string, init: RequestInit = {}): Promise<unknown> {
    const filePath = this.cachePath(relPath)
    if (!this.force && fs.existsSync(filePath)) {
      try {
        return readJsonFile(filePath)
      } catch {
        // Corrupted cache: fallthrough to re-fetch.
      }
    }

    const json = await fetchJsonWithRetry(url, init, 2, 60_000)
    writeJsonFile(filePath, json)
    this.log?.info?.(`[meta-gen] yatta cached ${relPath}`)
    return json
  }

  async getSrRelic(id: string | number, lang: YattaLang = 'cn'): Promise<unknown> {
    const relPath = `sr/relic/${lang}/${String(id)}.json`
    const url = `https://sr.yatta.moe/api/v2/${encodeURIComponent(lang)}/relic/${encodeURIComponent(String(id))}`
    return this.getJsonCached(relPath, url, {})
  }

  async getSrAvatar(id: string | number, lang: YattaLang = 'cn'): Promise<unknown> {
    const relPath = `sr/avatar/${lang}/${String(id)}.json`
    const url = `https://sr.yatta.moe/api/v2/${encodeURIComponent(lang)}/avatar/${encodeURIComponent(String(id))}`
    return this.getJsonCached(relPath, url, {})
  }

  async getSrEquipment(id: string | number, lang: YattaLang = 'cn'): Promise<unknown> {
    const relPath = `sr/equipment/${lang}/${String(id)}.json`
    const url = `https://sr.yatta.moe/api/v2/${encodeURIComponent(lang)}/equipment/${encodeURIComponent(String(id))}`
    return this.getJsonCached(relPath, url, {})
  }
}
