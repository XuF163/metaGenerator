/**
 * Batch-upgrade placeholder `calc.js` files under generated meta output.
 *
 * Why:
 * - `gen` focuses on producing static meta; calc.js generation is optional and may be slow (LLM).
 * - For weak/slow free-tier models, it's better to run a dedicated command that can be resumed.
 *
 * What it does:
 * - Scan `meta-{gs|sr}/character` recursively and find `calc.js`
 * - If it is a placeholder, generate a minimal usable calc.js:
 *   - Prefer LLM (OpenAI-compatible) when configured
 *   - Fall back to heuristic when LLM is unavailable
 */

import fs from 'node:fs'
import path from 'node:path'
import { walkFiles } from '../fs/walk.js'
import { loadToolConfig } from '../config/config.js'
import { tryCreateLlmService } from '../llm/try-create.js'
import { buildCalcJsWithLlmOrHeuristic } from '../generate/calc/llm-calc.js'
import type { CommandContext, GenOptions, Game } from '../types.js'
import { resolveRepoPath } from '../utils/resolve-path.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isPlaceholderCalc(filePath: string): boolean {
  try {
    const raw = fs.readFileSync(filePath, 'utf8')
    return raw.includes('Auto-generated placeholder')
  } catch {
    return false
  }
}

function metaGameDir(root: string, game: Game): string {
  return path.join(root, `meta-${game}`)
}

type CalcTables = Partial<Record<'a' | 'e' | 'q' | 't', string[]>>

function getGsTables(meta: Record<string, unknown>): CalcTables | null {
  const talentData = isRecord(meta.talentData) ? (meta.talentData as Record<string, unknown>) : null
  if (!talentData) return null
  const get = (k: 'a' | 'e' | 'q'): string[] => {
    const blk = talentData[k]
    if (!isRecord(blk)) return []
    return Object.keys(blk).filter((x) => x && !x.endsWith('2'))
  }
  const a = get('a')
  const e = get('e')
  const q = get('q')
  if (a.length === 0 && e.length === 0 && q.length === 0) return null
  return { a, e, q }
}

function getSrTables(meta: Record<string, unknown>): CalcTables | null {
  const talent = isRecord(meta.talent) ? (meta.talent as Record<string, unknown>) : null
  if (!talent) return null
  const get = (k: 'a' | 'e' | 'q' | 't'): string[] => {
    const blk = talent[k]
    if (!isRecord(blk)) return []
    const tablesRaw = (blk as Record<string, unknown>).tables
    const names: string[] = []
    if (Array.isArray(tablesRaw)) {
      for (const t of tablesRaw) {
        if (isRecord(t) && typeof t.name === 'string') names.push((t.name as string).trim())
      }
    } else if (isRecord(tablesRaw)) {
      for (const t of Object.values(tablesRaw)) {
        if (isRecord(t) && typeof t.name === 'string') names.push((t.name as string).trim())
      }
    }
    return names.filter(Boolean)
  }
  const a = get('a')
  const e = get('e')
  const q = get('q')
  const t = get('t')
  if (a.length === 0 && e.length === 0 && q.length === 0 && t.length === 0) return null
  return { a, e, q, t }
}

export async function calcCommand(ctx: CommandContext, options: GenOptions): Promise<void> {
  const outputRoot = resolveRepoPath(ctx, options.outputRoot)
  const games = options.games
  ctx.log.info(`[meta-gen] calc: outputRoot=${outputRoot} games=${games.join(',')}`)

  const toolConfig = loadToolConfig(ctx.projectRoot) ?? undefined
  const llm = tryCreateLlmService(ctx, toolConfig, { purpose: 'calc' })
  const llmCacheRootAbs = path.join(ctx.projectRoot, '.cache', 'llm')

  let upgraded = 0
  let scanned = 0

  for (const game of games) {
    const charRoot = path.join(metaGameDir(outputRoot, game), 'character')
    if (!fs.existsSync(charRoot)) continue

    for await (const filePath of walkFiles(charRoot, { ignoreNames: new Set(['.ace-tool']) })) {
      if (path.basename(filePath) !== 'calc.js') continue

      scanned++
      if (!isPlaceholderCalc(filePath)) continue

      const dir = path.dirname(filePath)
      const dataPath = path.join(dir, 'data.json')
      if (!fs.existsSync(dataPath)) continue

      let metaRaw: unknown
      try {
        metaRaw = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      } catch (e) {
        ctx.log.warn(`[meta-gen] calc: failed to parse ${dataPath}: ${String(e)}`)
        continue
      }
      if (!isRecord(metaRaw)) continue

      const name = typeof metaRaw.name === 'string' ? (metaRaw.name as string) : path.basename(dir)
      const elem = typeof metaRaw.elem === 'string' ? (metaRaw.elem as string) : ''
      const weapon = typeof metaRaw.weapon === 'string' ? (metaRaw.weapon as string) : ''
      const star = typeof metaRaw.star === 'number' && Number.isFinite(metaRaw.star) ? (metaRaw.star as number) : 0

      const tables =
        game === 'gs'
          ? getGsTables(metaRaw)
          : game === 'sr'
            ? getSrTables(metaRaw)
            : null
      if (!tables) continue

      const talentDesc: Partial<Record<'a' | 'e' | 'q' | 't', string>> = {}
      const talentRaw = isRecord(metaRaw.talent) ? (metaRaw.talent as Record<string, unknown>) : null
      if (talentRaw) {
        for (const k of ['a', 'e', 'q', 't'] as const) {
          const blk = talentRaw[k]
          if (isRecord(blk) && typeof blk.desc === 'string') talentDesc[k] = blk.desc as string
        }
      }

      const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(
        llm,
        {
          game,
          name,
          elem,
          weapon,
          star,
          tables,
          talentDesc
        },
        { cacheRootAbs: llmCacheRootAbs, force: options.forceCache }
      )

      if (error) {
        ctx.log.warn(`[meta-gen] calc plan failed (${game} ${name}), using heuristic: ${error}`)
      } else if (usedLlm) {
        ctx.log.info(`[meta-gen] calc generated with LLM: ${game} ${name}`)
      }

      try {
        fs.writeFileSync(filePath, js, 'utf8')
        upgraded++
        if (upgraded === 1 || upgraded % 20 === 0) {
          ctx.log.info(`[meta-gen] calc upgraded: ${upgraded} (scanned=${scanned})`)
        }
      } catch (e) {
        ctx.log.warn(`[meta-gen] calc: failed to write ${filePath}: ${String(e)}`)
      }
    }
  }

  ctx.log.info(`[meta-gen] calc done: upgraded=${upgraded} scanned=${scanned}`)
}
