/**
 * AnimeGameData client with on-disk caching.
 *
 * Upstream is a GitHub repo that publishes deobfuscated ExcelBinOutput JSON.
 * This is a "gap-filler" source: use it only for fields Hakush does not expose.
 */

import path from 'node:path'
import { downloadToFile } from '../../http/download.js'
import { DEFAULT_ANIME_GAME_DATA_BASE_URL, animeGameDataUrl } from './endpoints.js'
import { readJsonFile } from './read-json.js'

export interface AnimeGameDataClientOptions {
  /** Absolute path to `.cache/animeGameData` */
  cacheRootAbs: string
  /** Raw base URL. If omitted, uses env or default. */
  baseUrl?: string
  /** When true, re-download even if cached file exists. */
  force: boolean
  /** Optional logger for progress output. */
  log?: Pick<Console, 'info' | 'warn'>
}

export class AnimeGameDataClient {
  private cacheRootAbs: string
  private baseUrl: string
  private force: boolean
  private log?: Pick<Console, 'info' | 'warn'>

  constructor(opts: AnimeGameDataClientOptions) {
    this.cacheRootAbs = opts.cacheRootAbs
    this.baseUrl =
      (opts.baseUrl && opts.baseUrl.trim()) ||
      (process.env.META_ANIME_GAME_DATA_BASE_URL && process.env.META_ANIME_GAME_DATA_BASE_URL.trim()) ||
      DEFAULT_ANIME_GAME_DATA_BASE_URL
    this.force = opts.force
    this.log = opts.log
  }

  private cachePath(relPath: string): string {
    // Keep relPath stable even on Windows.
    return path.join(this.cacheRootAbs, relPath.split('/').join(path.sep))
  }

  private async getJsonCached<T>(relPath: string): Promise<T> {
    const url = animeGameDataUrl(this.baseUrl, relPath)
    const filePath = this.cachePath(relPath)
    const res = await downloadToFile(url, filePath, { force: this.force })
    if (!res.ok) {
      throw new Error(`[meta-gen] AnimeGameData fetch failed: ${url} -> ${res.error}`)
    }
    if (res.action === 'downloaded') {
      this.log?.info?.(`[meta-gen] animeGameData cached ${relPath} (${res.bytes} bytes)`)
    }
    return readJsonFile<T>(filePath)
  }

  // ---------- GS (Genshin) ----------

  async getGsReliquaryExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/ReliquaryExcelConfigData.json')
  }

  async getGsReliquaryAffixExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/ReliquaryAffixExcelConfigData.json')
  }

  async getGsReliquaryMainPropExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/ReliquaryMainPropExcelConfigData.json')
  }

  async getGsMaterialExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/MaterialExcelConfigData.json')
  }

  async getGsMaterialSourceDataExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/MaterialSourceDataExcelConfigData.json')
  }

  async getGsDailyDungeonConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/DailyDungeonConfigData.json')
  }

  async getGsDungeonExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/DungeonExcelConfigData.json')
  }

  async getGsCityConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/CityConfigData.json')
  }

  async getGsReliquarySetExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/ReliquarySetExcelConfigData.json')
  }

  async getGsWeaponExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/WeaponExcelConfigData.json')
  }

  async getGsWeaponCurveExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/WeaponCurveExcelConfigData.json')
  }

  async getGsWeaponPromoteExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/WeaponPromoteExcelConfigData.json')
  }

  async getGsEquipAffixExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/EquipAffixExcelConfigData.json')
  }

  async getGsAvatarExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/AvatarExcelConfigData.json')
  }

  async getGsAvatarCurveExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/AvatarCurveExcelConfigData.json')
  }

  async getGsAvatarPromoteExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/AvatarPromoteExcelConfigData.json')
  }

  async getGsAvatarSkillExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/AvatarSkillExcelConfigData.json')
  }

  async getGsProudSkillExcelConfigData(): Promise<unknown> {
    return this.getJsonCached('ExcelBinOutput/ProudSkillExcelConfigData.json')
  }

  async getGsTextMapCHS(): Promise<unknown> {
    return this.getJsonCached('TextMap/TextMapCHS.json')
  }
}
