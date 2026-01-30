/**
 * Generate SR treeData legacy-id mapping used for baseline compatibility.
 *
 * This script reads:
 * - baseline: temp/metaBaselineRef/meta-sr/character/<dir>/data.json
 * - output:   temp/metaGenerator/.output/meta-sr/character/<dir>/data.json
 * - hakush:   .cache/hakush/hsr/data/cn/character/<charId>.json
 *
 * And writes:
 * - src/generate/compat/sr-treeData-id.ts
 *
 * Usage:
 *   node scripts/gen-sr-treeData-id-compat.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'

const repoRoot = path.resolve(process.cwd())
const baselineRoot = path.join(repoRoot, 'temp', 'metaBaselineRef', 'meta-sr', 'character')
const outputRoot = process.env.META_GEN_SR_TREE_DATA_OUTPUT_ROOT
  ? path.resolve(repoRoot, process.env.META_GEN_SR_TREE_DATA_OUTPUT_ROOT)
  : path.join(repoRoot, 'temp', 'metaGenerator', '.output', 'meta-sr', 'character')
const hakushCharRoot = path.join(repoRoot, '.cache', 'hakush', 'hsr', 'data', 'cn', 'character')
const outFile = path.join(repoRoot, 'src', 'generate', 'compat', 'sr-treeData-id.ts')

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'))
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function sortObjectByNumericKey(obj) {
  const entries = Object.entries(obj)
  entries.sort(([a], [b]) => Number(a) - Number(b))
  return Object.fromEntries(entries)
}

function normalizeDesc(s) {
  if (typeof s !== 'string') return ''
  return s.replace(/\s+/g, ' ').trim()
}

function collectHakushPointIds(charId) {
  const filePath = path.join(hakushCharRoot, `${charId}.json`)
  if (!fs.existsSync(filePath)) return new Set()
  const json = readJson(filePath)
  const skillTrees = isRecord(json.SkillTrees) ? json.SkillTrees : {}
  const ids = new Set()
  for (const nodes of Object.values(skillTrees)) {
    if (!isRecord(nodes)) continue
    for (const node of Object.values(nodes)) {
      if (!isRecord(node)) continue
      const pid = typeof node.PointID === 'number' ? node.PointID : null
      if (!pid) continue
      ids.add(pid)
    }
  }
  return ids
}

function findMatch(baseEntry, outEntries) {
  if (!isRecord(baseEntry)) return null
  const type = baseEntry.type
  const name = typeof baseEntry.name === 'string' ? baseEntry.name : ''
  if (!name) return null

  const candidates = outEntries.filter((e) => isRecord(e) && e.type === type && e.name === name)
  if (candidates.length === 0) return null
  if (candidates.length === 1) return candidates[0]

  if (type === 'buff') {
    const baseData = isRecord(baseEntry.data) ? baseEntry.data : {}
    const baseCost = isRecord(baseEntry.cost) ? baseEntry.cost : {}
    const byData = candidates.filter((e) => isDeepStrictEqual(isRecord(e.data) ? e.data : {}, baseData))
    if (byData.length === 1) return byData[0]
    const byDataAndCost = byData.filter((e) => isDeepStrictEqual(isRecord(e.cost) ? e.cost : {}, baseCost))
    if (byDataAndCost.length === 1) return byDataAndCost[0]
    return byDataAndCost[0] || byData[0] || candidates[0]
  }

  if (type === 'skill') {
    const baseDesc = normalizeDesc(baseEntry.desc)
    const baseChildren = Array.isArray(baseEntry.children) ? baseEntry.children : []
    const baseCost = isRecord(baseEntry.cost) ? baseEntry.cost : {}
    const byDesc = candidates.filter((e) => normalizeDesc(e.desc) === baseDesc)
    if (byDesc.length === 1) return byDesc[0]
    const byChildren = candidates.filter((e) => isDeepStrictEqual(Array.isArray(e.children) ? e.children : [], baseChildren))
    if (byChildren.length === 1) return byChildren[0]
    const byCost = candidates.filter((e) => isDeepStrictEqual(isRecord(e.cost) ? e.cost : {}, baseCost))
    if (byCost.length === 1) return byCost[0]
    return byDesc[0] || byChildren[0] || byCost[0] || candidates[0]
  }

  return candidates[0]
}

function main() {
  if (!fs.existsSync(baselineRoot)) throw new Error(`missing baselineRoot: ${baselineRoot}`)
  if (!fs.existsSync(outputRoot)) throw new Error(`missing outputRoot: ${outputRoot}`)
  if (!fs.existsSync(hakushCharRoot)) throw new Error(`missing hakushCharRoot: ${hakushCharRoot}`)

  const dirs = fs
    .readdirSync(baselineRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))

  const mapping = {}
  let totalLegacy = 0
  let totalMapped = 0
  const missing = []

  for (const dir of dirs) {
    const basePath = path.join(baselineRoot, dir, 'data.json')
    const outPath = path.join(outputRoot, dir, 'data.json')
    if (!fs.existsSync(basePath) || !fs.existsSync(outPath)) continue

    const base = readJson(basePath)
    const out = readJson(outPath)
    const charId = base && (typeof base.id === 'number' || typeof base.id === 'string') ? String(base.id) : ''
    if (!charId) continue

    const hakushPointIds = collectHakushPointIds(charId)
    const baseTd = isRecord(base.treeData) ? base.treeData : {}
    const outTd = isRecord(out.treeData) ? out.treeData : {}
    // Only match against real Hakush PointID nodes to avoid circularity when output already includes
    // legacy-id duplicates generated from a previous mapping.
    const outEntries = Object.values(outTd).filter((e) => isRecord(e) && typeof e.id === 'number' && hakushPointIds.has(e.id))

    const charMap = {}
    for (const [legacyId, baseEntry] of Object.entries(baseTd)) {
      const legacyNum = Number(legacyId)
      if (!Number.isFinite(legacyNum)) continue

      // Skip ids that already exist in Hakush PointID space (baseline already uses PointID ids).
      if (hakushPointIds.has(legacyNum)) continue
      totalLegacy++

      const match = findMatch(baseEntry, outEntries)
      if (!match || !isRecord(match) || typeof match.id !== 'number') {
        const type = isRecord(baseEntry) && typeof baseEntry.type === 'string' ? baseEntry.type : ''
        const name = isRecord(baseEntry) && typeof baseEntry.name === 'string' ? baseEntry.name : ''
        missing.push({ dir, charId, legacyId, type, name })
        continue
      }

      const spec = { fromPointId: match.id }
      if (baseEntry.type === 'skill' && typeof baseEntry.idx === 'number' && Number.isFinite(baseEntry.idx)) {
        if (typeof match.idx === 'number' && Number.isFinite(match.idx) && baseEntry.idx !== match.idx) {
          spec.idx = baseEntry.idx
        }
      }
      charMap[legacyId] = spec
      totalMapped++
    }

    if (Object.keys(charMap).length) {
      mapping[charId] = sortObjectByNumericKey(charMap)
    }
  }

  const sortedMapping = sortObjectByNumericKey(mapping)

  const header = `// Legacy SR treeData id compatibility map (baseline-aligned for downstream plugins)\n//\n// Some baseline meta uses historical ids for trace nodes, while Hakush provides PointID values.\n// We keep both id spaces in treeData by duplicating entries at generation time.\n//\n// NOTE: This file is auto-generated by scripts/gen-sr-treeData-id-compat.mjs.\n\nexport type SrTreeDataCompatEntry = { fromPointId: number; idx?: number }\n\nexport const srTreeDataIdCompat: Record<string, Record<string, SrTreeDataCompatEntry>> = ${JSON.stringify(sortedMapping, null, 2)}\n`

  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  fs.writeFileSync(outFile, header, 'utf8')

  console.log(`[gen-sr-treeData-id] baselineRoot=${baselineRoot}`)
  console.log(`[gen-sr-treeData-id] outputRoot=${outputRoot}`)
  console.log(`[gen-sr-treeData-id] wrote ${outFile}`)
  console.log(`[gen-sr-treeData-id] legacyKeys=${totalLegacy} mapped=${totalMapped} chars=${Object.keys(sortedMapping).length}`)
  if (missing.length) {
    console.log(`[gen-sr-treeData-id] unmatched=${missing.length}`)
    console.log(missing.slice(0, 20))
  }
}

main()
