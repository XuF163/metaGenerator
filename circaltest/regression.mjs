import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function walkFiles(rootDir, filter) {
  const out = []
  const stack = [rootDir]
  while (stack.length) {
    const dir = stack.pop()
    if (!dir) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      if (ent.name.startsWith('.')) continue
      const full = path.join(dir, ent.name)
      if (ent.isDirectory()) {
        stack.push(full)
      } else if (ent.isFile()) {
        if (!filter || filter(full)) out.push(full)
      }
    }
  }
  return out
}

async function runPool(items, concurrency, worker) {
  const q = items.slice()
  let idx = 0
  const runners = Array.from({ length: Math.max(1, concurrency) }, async () => {
    while (true) {
      const cur = idx
      idx++
      if (cur >= q.length) return
      await worker(q[cur])
    }
  })
  await Promise.all(runners)
}

async function importFresh(filePath) {
  const u = pathToFileURL(filePath).href
  // Add a cache-buster to avoid Node ESM module cache across repeated runs.
  return import(`${u}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

async function main() {
  const repoRoot = process.cwd()
  const outRoot = path.join(repoRoot, 'temp', 'metaGenerator', '.output')

  const srAliasPath = path.join(outRoot, 'meta-sr', 'character', 'alias.js')
  if (fs.existsSync(srAliasPath)) {
    const m = await importFresh(srAliasPath)
    if (!('abbr' in m)) {
      throw new Error(`[circaltest] SR character alias.js missing export: abbr (${srAliasPath})`)
    }
  }

  const calcRoots = [
    path.join(outRoot, 'meta-gs', 'character'),
    path.join(outRoot, 'meta-sr', 'character')
  ]
  const calcFiles = calcRoots.flatMap((dir) =>
    walkFiles(dir, (p) => path.basename(p) === 'calc.js')
  )
  calcFiles.sort((a, b) => a.localeCompare(b))

  const failures = []
  const concurrency = Number(process.env.CIRCALTEST_CONCURRENCY || 24)

  let ok = 0
  await runPool(calcFiles, concurrency, async (filePath) => {
    try {
      const m = await importFresh(filePath)
      if (!Array.isArray(m.details)) throw new Error('export details must be an array')
      if (!Array.isArray(m.buffs)) throw new Error('export buffs must be an array')
      if (typeof m.mainAttr !== 'string') throw new Error('export mainAttr must be a string')
      ok++
    } catch (e) {
      failures.push({
        file: path.relative(repoRoot, filePath),
        error: e instanceof Error ? e.message : String(e)
      })
    }
  })

  if (failures.length) {
    console.error(`[circaltest] FAIL: calc.js import errors: ${failures.length}/${calcFiles.length}`)
    for (const f of failures.slice(0, 50)) {
      console.error(`- ${f.file}: ${f.error}`)
    }
    if (failures.length > 50) console.error(`... (only first 50 shown)`)
    process.exitCode = 1
    return
  }

  console.log(`[circaltest] OK: calc.js import check passed (${ok}/${calcFiles.length})`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

