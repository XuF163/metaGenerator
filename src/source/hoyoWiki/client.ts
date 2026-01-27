/**
 * HoYoWiki (wiki.hoyolab.com) client with lightweight on-disk caching.
 *
 * We treat HoYoWiki as a supplementary source:
 * - It can fill gaps where Hakush/Yatta do not host certain assets (e.g. some Virtual currencies).
 * - It is NOT a baseline generator input; we only use its public API responses.
 *
 * Reference (HSR):
 * - https://wiki.hoyolab.com/pc/hsr/home
 * - API: https://sg-wiki-api.hoyolab.com/hoyowiki/hsr/wapi/search?keyword=...
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../fs/json.js'
import { fetchJsonWithRetry } from '../../http/fetch.js'
import { readJsonFile } from './read-json.js'

export type HoYoWikiApp = 'hsr'
export type HoYoWikiLang = 'zh-cn' | 'en-us' | string

export type HoYoWikiSearchItem = {
  entry_page_id: string
  name: string
  icon_url: string
}

export interface HoYoWikiClientOptions {
  /** Absolute path to `.cache/hoyoWiki` */
  cacheRootAbs: string
  /** When true, re-fetch even if cached file exists. */
  force: boolean
  /** Optional logger for progress output. */
  log?: Pick<Console, 'info' | 'warn'>
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toStr(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function safeCacheKey(input: string): string {
  // Stable and filesystem-safe for Windows.
  // (encodeURIComponent keeps semantic stability; we replace '%' to avoid weird tooling edge-cases.)
  return encodeURIComponent(input).replaceAll('%', '_')
}

export class HoYoWikiClient {
  private cacheRootAbs: string
  private force: boolean
  private log?: Pick<Console, 'info' | 'warn'>

  constructor(opts: HoYoWikiClientOptions) {
    this.cacheRootAbs = opts.cacheRootAbs
    this.force = opts.force
    this.log = opts.log
  }

  private cachePath(relPath: string): string {
    // Keep relPath stable even on Windows.
    return path.join(this.cacheRootAbs, relPath.split('/').join(path.sep))
  }

  private async getJsonCached(relPath: string, url: string, init: RequestInit): Promise<unknown> {
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
    this.log?.info?.(`[meta-gen] hoyowiki cached ${relPath}`)
    return json
  }

  private headers(app: HoYoWikiApp, lang: HoYoWikiLang): HeadersInit {
    // HoYoWiki APIs expect these RPC headers + a browser-ish origin/referer.
    // No cookies are required for public queries.
    return {
      'x-rpc-wiki_app': app,
      'x-rpc-language': lang,
      origin: 'https://wiki.hoyolab.com',
      referer: 'https://wiki.hoyolab.com/'
    }
  }

  async searchHsr(keyword: string, lang: HoYoWikiLang = 'zh-cn'): Promise<HoYoWikiSearchItem[]> {
    const trimmed = keyword.trim()
    if (!trimmed) return []

    const relPath = `hsr/search/${lang}/${safeCacheKey(trimmed)}.json`
    const url = `https://sg-wiki-api.hoyolab.com/hoyowiki/hsr/wapi/search?keyword=${encodeURIComponent(trimmed)}`
    const raw = await this.getJsonCached(relPath, url, { headers: this.headers('hsr', lang) })
    const root = isRecord(raw) ? raw : {}
    const data = isRecord(root.data) ? (root.data as Record<string, unknown>) : {}
    const list = Array.isArray(data.list) ? data.list : []

    const out: HoYoWikiSearchItem[] = []
    for (const item of list) {
      if (!isRecord(item)) continue
      const entry_page_id = toStr(item.entry_page_id)
      const name = toStr(item.name)
      const icon_url = toStr(item.icon_url)
      if (!entry_page_id || !name || !icon_url) continue
      out.push({ entry_page_id, name, icon_url })
    }
    return out
  }

  /**
   * Find a HSR entry by name (exact match preferred).
   * Returns null if no usable icon_url is found.
   */
  async findHsrEntryByName(name: string, lang: HoYoWikiLang = 'zh-cn'): Promise<HoYoWikiSearchItem | null> {
    const list = await this.searchHsr(name, lang)
    if (!list.length) return null

    const exact = list.find((it) => it.name === name && it.icon_url)
    if (exact) return exact

    const any = list.find((it) => it.icon_url)
    return any ?? null
  }
}

