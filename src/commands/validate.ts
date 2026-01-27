/**
 * Validate parity between baseline meta and generated meta output.
 *
 * MVP scope:
 * - file-level parity (JSON deep-equal; others by sha256)
 * - report output (json + markdown)
 *
 * Later scope:
 * - runtime parity (Meta lookups, panel render, dmg calc)
 */

import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import fs from 'node:fs'
import { walkFiles } from '../fs/walk.js'
import { sha256File } from '../fs/hash.js'
import { ensureDir } from '../fs/ensure.js'
import { writeValidateReport } from '../report/validate-report.js'
import type { CommandContext, MetaType, ValidateOptions, ValidateReport } from '../types.js'
import { toPosixRelativePath } from '../utils/path.js'
import { resolveRepoPath } from '../utils/resolve-path.js'
import { createRng, sampleArray } from '../utils/prng.js'

function metaGameDir(root: string, game: string): string {
  return path.join(root, `meta-${game}`)
}

const KNOWN_TYPE_DIRS = new Set<MetaType>(['artifact', 'character', 'material', 'weapon'])

function isJsonFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.json')
}

function tryReadJson(filePath: string): { ok: true; data: unknown } | { ok: false; error: string } {
  try {
    const txt = fs.readFileSync(filePath, 'utf8')
    return { ok: true, data: JSON.parse(txt) }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Check whether `base` is a structural subset of `out`.
 *
 * This is used when validating "update-mode" outputs:
 * generated meta may include new entries, but must not change existing ones.
 *
 * Rules:
 * - primitives: strict equal
 * - arrays: strict deep equal (order/length must match)
 * - objects: every key in `base` must exist in `out` and match recursively
 */
function isJsonSubset(base: unknown, out: unknown): boolean {
  if (base === out) return true
  if (base === null || out === null) return false
  if (Array.isArray(base) || Array.isArray(out)) {
    return isDeepStrictEqual(base, out)
  }
  if (typeof base !== 'object' || typeof out !== 'object') return false
  const a = base as Record<string, unknown>
  const b = out as Record<string, unknown>
  for (const [k, v] of Object.entries(a)) {
    if (!(k in b)) return false
    if (!isJsonSubset(v, b[k])) return false
  }
  return true
}

export async function validateCommand(ctx: CommandContext, options: ValidateOptions): Promise<void> {
  const baselineRoot = resolveRepoPath(ctx, options.baselineRoot)
  const outputRoot = resolveRepoPath(ctx, options.outputRoot)
  const { games, types, strictExtra, sampleFiles } = options
  const typeSet = new Set(types)

  const reportDir = path.join(ctx.projectRoot, 'reports')
  ensureDir(reportDir)

  const seed = (options.seed && options.seed.trim() ? options.seed.trim() : `${Date.now()}`).trim()
  const rand = createRng(seed)

  const report: ValidateReport = {
    meta: {
      baselineRoot,
      outputRoot,
      games,
      types,
      generatedAt: ctx.now.toISOString(),
      sampling: {
        mode: sampleFiles < 0 ? 'full' : 'sample',
        sampleFiles,
        seed,
        alwaysIncluded: 0
      }
    },
    summary: {
      ok: true,
      totalCompared: 0,
      missing: 0,
      different: 0,
      extra: 0
    },
    missingFiles: [],
    differentFiles: [],
    extraFiles: []
  }

  const ignoreNames = new Set(['.git', '.gitignore', '.DS_Store', 'Thumbs.db', '.ace-tool'])
  const expectedRelSet = new Set<string>()

  type CompareItem = { baseFile: string; outFile: string; relKey: string; isTopLevel: boolean }
  const allCompareItems: CompareItem[] = []

  for (const game of games) {
    const baseMetaDir = metaGameDir(baselineRoot, game)
    const outMetaDir = metaGameDir(outputRoot, game)

    if (!fs.existsSync(baseMetaDir)) throw new Error(`[meta-gen] Missing baseline directory: ${baseMetaDir}`)

    // We validate:
    // - selected high-frequency type buckets: artifact/character/material/weapon
    // - any other root-level meta directories that exist in baseline (e.g. info/public/.ace-tool)
    const entries = fs.readdirSync(baseMetaDir, { withFileTypes: true })
    for (const ent of entries) {
      if (ignoreNames.has(ent.name)) continue
      if (!ent.isDirectory()) continue

      if (KNOWN_TYPE_DIRS.has(ent.name as MetaType) && !typeSet.has(ent.name as MetaType)) continue

      const baseDir = path.join(baseMetaDir, ent.name)
      const outDir = path.join(outMetaDir, ent.name)

      for await (const baseFile of walkFiles(baseDir, { ignoreNames })) {
        const rel = toPosixRelativePath(baseDir, baseFile)
        const relKey = `meta-${game}/${ent.name}/${rel}`
        expectedRelSet.add(relKey)

        const outFile = path.join(outDir, rel.split('/').join(path.sep))

        allCompareItems.push({
          baseFile,
          outFile,
          relKey,
          isTopLevel: !rel.includes('/')
        })
      }

      // Extra files scan will run after sampling selection (still full scan for correctness)
    }
  }

  const alwaysItems = allCompareItems.filter((i) => i.isTopLevel)
  const candidateItems = allCompareItems.filter((i) => !i.isTopLevel)
  report.meta.sampling.alwaysIncluded = alwaysItems.length

  const selectedItems: CompareItem[] =
    sampleFiles < 0
      ? allCompareItems
      : alwaysItems.concat(sampleArray(candidateItems, Math.min(sampleFiles, candidateItems.length), rand))

  // Compare selected files
  for (const item of selectedItems) {
    report.summary.totalCompared++

    if (!fs.existsSync(item.outFile)) {
      report.summary.ok = false
      report.summary.missing++
      report.missingFiles.push(item.relKey)
      continue
    }

    if (isJsonFile(item.baseFile)) {
      const a = tryReadJson(item.baseFile)
      const b = tryReadJson(item.outFile)
      if (!a.ok || !b.ok) {
        report.summary.ok = false
        report.summary.different++
        report.differentFiles.push({
          file: item.relKey,
          reason: `json parse error: baseline=${a.ok ? 'ok' : a.error} output=${b.ok ? 'ok' : b.error}`
        })
        continue
      }
      const same = strictExtra ? isDeepStrictEqual(a.data, b.data) : isJsonSubset(a.data, b.data)
      if (!same) {
        report.summary.ok = false
        report.summary.different++
        report.differentFiles.push({
          file: item.relKey,
          reason: strictExtra ? 'json content differs' : 'json output is not a superset of baseline'
        })
      }
      continue
    }

    const [ha, hb] = await Promise.all([sha256File(item.baseFile), sha256File(item.outFile)])
    if (ha !== hb) {
      report.summary.ok = false
      report.summary.different++
      report.differentFiles.push({ file: item.relKey, reason: 'sha256 differs' })
    }
  }

  // Extra files scan (full)
  for (const game of games) {
    const outMetaDir = metaGameDir(outputRoot, game)
    if (!fs.existsSync(outMetaDir)) continue

    // Mirror selection logic:
    // - scan selected type buckets
    // - always scan "extra" root-level dirs (even if baseline is missing) so `--strict-extra` can catch them
    const outEntries = fs.readdirSync(outMetaDir, { withFileTypes: true })
    for (const ent of outEntries) {
      if (ignoreNames.has(ent.name)) continue
      if (!ent.isDirectory()) continue

      if (KNOWN_TYPE_DIRS.has(ent.name as MetaType) && !typeSet.has(ent.name as MetaType)) continue

      const outDir = path.join(outMetaDir, ent.name)
      for await (const outFile of walkFiles(outDir, { ignoreNames })) {
        const rel = toPosixRelativePath(outDir, outFile)
        const relKey = `meta-${game}/${ent.name}/${rel}`
        if (!expectedRelSet.has(relKey)) {
          report.summary.extra++
          report.extraFiles.push(relKey)
        }
      }
    }
  }

  if (strictExtra && report.summary.extra > 0) {
    report.summary.ok = false
  }

  await writeValidateReport(reportDir, report)

  const okText = report.summary.ok ? 'OK' : 'FAILED'
  ctx.log.info(
    `[meta-gen] validate ${okText}: compared=${report.summary.totalCompared} ` +
      `missing=${report.summary.missing} diff=${report.summary.different} extra=${report.summary.extra}`
  )
  ctx.log.info(
    `[meta-gen] sampling: mode=${report.meta.sampling.mode} sampleFiles=${report.meta.sampling.sampleFiles} ` +
      `alwaysIncluded=${report.meta.sampling.alwaysIncluded} seed=${report.meta.sampling.seed}`
  )
  ctx.log.info(`[meta-gen] report written to ${reportDir}`)

  if (!report.summary.ok) {
    process.exitCode = 1
  }
}
