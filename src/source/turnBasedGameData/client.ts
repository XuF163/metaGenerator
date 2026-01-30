/**
 * turnbasedgamedata client with on-disk caching.
 *
 * Upstream is a GitLab repo that publishes deobfuscated ExcelOutput JSON for HSR.
 * This is a "gap-filler" source: use it only for fields Hakush/Yatta do not expose.
 */

import path from 'node:path'
import { downloadToFile } from '../../http/download.js'
import { DEFAULT_TURN_BASED_GAME_DATA_BASE_URL, turnBasedGameDataUrl } from './endpoints.js'
import { readJsonFile } from './read-json.js'

export interface TurnBasedGameDataClientOptions {
  /** Absolute path to `.cache/turnBasedGameData` */
  cacheRootAbs: string
  /** Raw base URL. If omitted, uses env or default. */
  baseUrl?: string
  /** When true, re-download even if cached file exists. */
  force: boolean
  /** Optional logger for progress output. */
  log?: Pick<Console, 'info' | 'warn'>
}

export class TurnBasedGameDataClient {
  private cacheRootAbs: string
  private baseUrl: string
  private force: boolean
  private log?: Pick<Console, 'info' | 'warn'>

  constructor(opts: TurnBasedGameDataClientOptions) {
    this.cacheRootAbs = opts.cacheRootAbs
    this.baseUrl =
      (opts.baseUrl && opts.baseUrl.trim()) ||
      (process.env.META_TURN_BASED_GAME_DATA_BASE_URL && process.env.META_TURN_BASED_GAME_DATA_BASE_URL.trim()) ||
      DEFAULT_TURN_BASED_GAME_DATA_BASE_URL
    this.force = opts.force
    this.log = opts.log
  }

  private cachePath(relPath: string): string {
    // Keep relPath stable even on Windows.
    return path.join(this.cacheRootAbs, relPath.split('/').join(path.sep))
  }

  private async getJsonCached<T>(relPath: string): Promise<T> {
    const url = turnBasedGameDataUrl(this.baseUrl, relPath)
    const filePath = this.cachePath(relPath)
    const res = await downloadToFile(url, filePath, { force: this.force })
    if (!res.ok) {
      throw new Error(`[meta-gen] turnbasedgamedata fetch failed: ${url} -> ${res.error}`)
    }
    if (res.action === 'downloaded') {
      this.log?.info?.(`[meta-gen] turnbasedgamedata cached ${relPath} (${res.bytes} bytes)`)
    }
    return readJsonFile<T>(filePath)
  }

  // ---------- SR (Star Rail) ----------

  /**
   * Rogue Aeon display config (used to locate some Path/Aeon icon file names).
   *
   * Ref: ExcelOutput/RogueAeonDisplay.json
   */
  async getSrRogueAeonDisplay(): Promise<unknown> {
    return this.getJsonCached('ExcelOutput/RogueAeonDisplay.json')
  }

  /**
   * Avatar base type (Path/Profession) config.
   *
   * Ref: ExcelOutput/AvatarBaseType.json
   */
  async getSrAvatarBaseType(): Promise<unknown> {
    return this.getJsonCached('ExcelOutput/AvatarBaseType.json')
  }

  /**
   * Relic main stat (main affix) config.
   *
   * Ref: ExcelOutput/RelicMainAffixConfig.json
   */
  async getSrRelicMainAffixConfig(): Promise<unknown> {
    return this.getJsonCached('ExcelOutput/RelicMainAffixConfig.json')
  }

  /**
   * Relic sub stat (sub affix) config.
   *
   * Ref: ExcelOutput/RelicSubAffixConfig.json
   */
  async getSrRelicSubAffixConfig(): Promise<unknown> {
    return this.getJsonCached('ExcelOutput/RelicSubAffixConfig.json')
  }

  /**
   * Lightcone (Equipment) skill config.
   *
   * Ref: ExcelOutput/EquipmentSkillConfig.json
   */
  async getSrEquipmentSkillConfig(): Promise<unknown> {
    return this.getJsonCached('ExcelOutput/EquipmentSkillConfig.json')
  }
}
