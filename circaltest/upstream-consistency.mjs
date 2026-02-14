import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { loadToolConfig } from '../dist/config/config.js'
import { buildGsUpstreamDirectBuffs } from '../dist/generate/calc/upstream-direct-gs.js'
import { buildSrUpstreamDirectBuffs } from '../dist/generate/calc/upstream-direct-sr.js'

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowStamp() {
  // Safe for Windows paths.
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith('--')) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (!v || v.startsWith('--')) {
      out[k] = true
    } else {
      out[k] = v
      i++
    }
  }
  return out
}

function splitCsv(v) {
  return String(v || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

function isRecord(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function getGsTables(meta) {
  const talentData = isRecord(meta.talentData) ? meta.talentData : null
  if (!talentData) return null
  const get = (k) => {
    const blk = talentData[k]
    if (!isRecord(blk)) return []
    return Object.keys(blk).filter(Boolean)
  }
  const a = get('a')
  const e = get('e')
  const q = get('q')
  if (a.length === 0 && e.length === 0 && q.length === 0) return null
  return { a, e, q }
}

function getSrTables(meta) {
  const talent = isRecord(meta.talent) ? meta.talent : null
  if (!talent) return null
  const out = {}
  for (const [k, blk] of Object.entries(talent)) {
    if (!isRecord(blk)) continue
    const tablesRaw = blk.tables
    const names = []
    if (Array.isArray(tablesRaw)) {
      for (const t of tablesRaw) {
        if (isRecord(t) && typeof t.name === 'string') names.push(t.name.trim())
      }
    } else if (isRecord(tablesRaw)) {
      for (const t of Object.values(tablesRaw)) {
        if (isRecord(t) && typeof t.name === 'string') names.push(t.name.trim())
      }
    }
    const list = names.filter(Boolean)
    if (list.length) out[k] = list
  }
  return Object.keys(out).length ? out : null
}

function buildTableValues(meta, tables) {
  const out = {}
  const talentData = isRecord(meta.talentData) ? meta.talentData : null
  if (!talentData || !tables) return out
  for (const k of Object.keys(tables)) {
    const blk = talentData[k]
    if (!isRecord(blk)) continue
    const outK = {}
    for (const [name, values] of Object.entries(blk)) {
      if (!name || typeof name !== 'string') continue
      if (!Array.isArray(values) || values.length === 0) continue
      if (!values.every((v) => typeof v === 'number' && Number.isFinite(v))) continue
      outK[name] = values.map((v) => Number(v))
    }
    if (Object.keys(outK).length) out[k] = outK
  }
  return out
}

function walkCharDirs(charRootAbs) {
  if (!fs.existsSync(charRootAbs)) return []
  let ents = []
  try {
    ents = fs.readdirSync(charRootAbs, { withFileTypes: true })
  } catch {
    return []
  }
  return ents
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
}

async function importFresh(filePathAbs) {
  const u = pathToFileURL(filePathAbs).href
  return import(`${u}?t=${Date.now()}-${Math.random().toString(16).slice(2)}`)
}

function normalizeExprText(s) {
  return String(s || '')
    .trim()
    .replace(/\s+/g, '')
}

function dataKeys(dataRaw) {
  if (!isRecord(dataRaw)) return []
  return Object.keys(dataRaw)
    .map((k) => String(k || '').trim())
    .filter(Boolean)
    .filter((k) => !k.startsWith('_'))
    .sort()
}

function wrapExpr(expr) {
  return `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => (${expr})`
}

function wrapExprNumber(expr) {
  return (
    `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => {` +
    ` const v = (${expr});` +
    ` if (typeof v === "number") return Number.isFinite(v) ? v : 0;` +
    ` if (v === undefined || v === null || v === false || v === "") return v;` +
    ` return 0 }`
  )
}

function compileExpr(expr, { number } = { number: true }) {
  const body = number ? wrapExprNumber(expr) : wrapExpr(expr)
  // eslint-disable-next-line no-new-func
  return new Function(`return (${body})`)()
}

function collectRefs(expr) {
  const text = String(expr || '')
  const talentTables = new Map()
  const reTalent = /\btalent\.([a-z][a-z0-9]*)\s*\[\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')\s*]/gi
  for (const m of text.matchAll(reTalent)) {
    const tk = String(m[1] || '').trim()
    const lit = String(m[2] || '').trim()
    if (!tk || !lit) continue
    let name = ''
    try {
      if (lit.startsWith('"')) name = JSON.parse(lit)
      else if (lit.startsWith("'")) name = JSON.parse(`\"${lit.slice(1, -1).replace(/\\\\/g, '\\\\\\\\').replace(/\"/g, '\\\\\"')}\"`)
    } catch {
      continue
    }
    if (!name) continue
    if (!talentTables.has(tk)) talentTables.set(tk, new Set())
    talentTables.get(tk).add(name)
  }

  const paramKeys = new Set()
  const reParam = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const m of text.matchAll(reParam)) {
    const k = String(m[1] || '').trim()
    if (k) paramKeys.add(k)
  }

  const attrKeys = new Set()
  const reAttr = /\battr\.([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const m of text.matchAll(reAttr)) {
    const k = String(m[1] || '').trim()
    if (k) attrKeys.add(k)
  }

  const weaponKeys = new Set()
  const reWeapon = /\bweapon\.([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const m of text.matchAll(reWeapon)) {
    const k = String(m[1] || '').trim()
    if (k) weaponKeys.add(k)
  }

  const treeKeys = new Set()
  const reTree = /\btrees\.([A-Za-z_][A-Za-z0-9_]*)\b/g
  for (const m of text.matchAll(reTree)) {
    const k = String(m[1] || '').trim()
    if (k) treeKeys.add(k)
  }

  return { talentTables, paramKeys, attrKeys, weaponKeys, treeKeys }
}

function makeNumProxy(defaultValue = 0) {
  return new Proxy(
    {},
    {
      get(_t, p) {
        if (typeof p === 'symbol') return undefined
        return defaultValue
      }
    }
  )
}

function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function randIn(rng, lo, hi) {
  return lo + (hi - lo) * rng()
}

function makeCtx(rng, { talentTables, paramKeys, attrKeys, weaponKeys, treeKeys }, { paramsMode }) {
  const attr = {}
  const setAttr = (k, v) => {
    attr[k] = v
    attrKeys.add(k)
  }
  setAttr('atk', randIn(rng, 500, 4000))
  setAttr('hp', randIn(rng, 5000, 80000))
  setAttr('def', randIn(rng, 200, 4000))
  setAttr('speed', randIn(rng, 60, 250))
  setAttr('cpct', randIn(rng, 0, 100))
  setAttr('cdmg', randIn(rng, 50, 350))
  setAttr('effPct', randIn(rng, 0, 150))
  setAttr('effDef', randIn(rng, 0, 150))
  setAttr('recharge', randIn(rng, 80, 200))
  setAttr('stance', randIn(rng, 0, 200))

  // Ensure any additionally referenced attr.* exist.
  for (const k of attrKeys) if (!(k in attr)) attr[k] = randIn(rng, 0, 10000)

  const talent = {}
  for (const [tk, set] of talentTables.entries()) {
    if (!set || set.size === 0) continue
    if (!(tk in talent)) talent[tk] = {}
    for (const name of set) {
      // Upstream tables are commonly percents; keep small-ish to avoid overflow.
      talent[tk][name] = randIn(rng, 0, 5)
    }
  }

  const params = (() => {
    if (paramsMode === 'empty') return {}
    const out = {}
    for (const k of paramKeys) {
      // Prefer numeric knobs; booleans can be modeled as 0/1 for stable arithmetic.
      out[k] = randIn(rng, 0, 12)
      if (/^(?:e|q|a|t|z)$/.test(k)) out[k] = 1
      if (/(?:state|buff|mode|stance|enhanced|enhance)/i.test(k)) out[k] = rng() > 0.5 ? 1 : 0
    }
    return out
  })()

  const weaponBase = {}
  for (const k of weaponKeys) weaponBase[k] = randIn(rng, 0, 6)
  const weapon = weaponKeys.size ? new Proxy(weaponBase, { get: (t, p) => (p in t ? t[p] : 0) }) : makeNumProxy(0)

  const treesBase = {}
  for (const k of treeKeys) treesBase[k] = randIn(rng, 0, 1) > 0.5 ? 1 : 0
  const trees = treeKeys.size ? new Proxy(treesBase, { get: (t, p) => (p in t ? t[p] : 0) }) : makeNumProxy(0)

  const cons = Math.floor(randIn(rng, 0, 7))
  const calc = (x) => {
    const n = Number(x)
    return Number.isFinite(n) ? n : 0
  }

  return { talent, attr, calc, params, cons, weapon, trees, element: 'fire', currentTalent: 'e' }
}

function eqNumber(a, b, eps = 1e-9) {
  if (a === b) return true
  if (typeof a !== 'number' || typeof b !== 'number') return false
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const diff = Math.abs(a - b)
  if (diff <= eps) return true
  const denom = Math.max(1, Math.abs(a), Math.abs(b))
  return diff / denom <= 1e-9
}

function normalizeCheckResult(v) {
  return Boolean(v)
}

function isUpstreamBuffTitle(t) {
  return typeof t === 'string' && t.startsWith('upstream:')
}

function listUpstreamBuffsFromModule(mod) {
  const buffs = Array.isArray(mod?.buffs) ? mod.buffs : []
  const out = []
  for (const b of buffs) {
    if (!isRecord(b)) continue
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!isUpstreamBuffTitle(title)) continue
    out.push(b)
  }
  return out
}

function listUpstreamBuffsFromExtracted(buffs) {
  const out = []
  for (const b of Array.isArray(buffs) ? buffs : []) {
    if (!isRecord(b)) continue
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!isUpstreamBuffTitle(title)) continue
    out.push(b)
  }
  return out
}

function buildTitleMap(list) {
  const map = new Map()
  for (const b of list) {
    const title = String(b.title || '').trim()
    if (!title) continue
    if (!map.has(title)) map.set(title, [])
    map.get(title).push(b)
  }
  return map
}

function asNumberOrExpr(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'number', value: v }
  if (typeof v === 'string' && v.trim()) return { kind: 'expr', value: v.trim() }
  return { kind: 'none', value: null }
}

function valueFnFromUpstream(v) {
  const t = asNumberOrExpr(v)
  if (t.kind === 'number') return { kind: 'const', fn: () => t.value, raw: String(t.value) }
  if (t.kind === 'expr') return { kind: 'expr', fn: compileExpr(t.value, { number: true }), raw: t.value }
  return { kind: 'none', fn: () => undefined, raw: '' }
}

function valueFnFromGenerated(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return { kind: 'const', fn: () => v, raw: String(v) }
  if (typeof v === 'function') return { kind: 'fn', fn: v, raw: v.toString() }
  return { kind: 'none', fn: () => undefined, raw: '' }
}

function checkFnFromUpstream(exprRaw) {
  const t = typeof exprRaw === 'string' ? exprRaw.trim() : ''
  if (!t) return null
  return compileExpr(t, { number: false })
}

function checkFnFromGenerated(v) {
  if (typeof v === 'function') return v
  return null
}

function tryMatchBuff(rng, ub, genCandidates) {
  const ubData = isRecord(ub.data) ? ub.data : {}
  const ubKeys = dataKeys(ubData)
  const ubCheck = checkFnFromUpstream(ub.check)

  const ubExprTexts = []
  if (typeof ub.check === 'string') ubExprTexts.push(ub.check)
  for (const k of ubKeys) {
    const v = ubData[k]
    if (typeof v === 'string') ubExprTexts.push(v)
  }
  const refs = ubExprTexts.length ? collectRefs(ubExprTexts.join('\n')) : collectRefs('')

  const ctxEmpty = makeCtx(rng, refs, { paramsMode: 'empty' })
  const ctxRand = makeCtx(rng, refs, { paramsMode: 'random' })

  for (const gb of genCandidates) {
    const gbData = isRecord(gb.data) ? gb.data : {}
    const gbKeys = dataKeys(gbData)
    if (ubKeys.join('|') !== gbKeys.join('|')) continue

    const gbCheck = checkFnFromGenerated(gb.check)
    if (Boolean(ubCheck) !== Boolean(gbCheck)) continue
    if (ubCheck && gbCheck) {
      let ok = true
      for (const ctx of [ctxEmpty, ctxRand]) {
        let a
        let b
        try {
          a = normalizeCheckResult(ubCheck(ctx))
          b = normalizeCheckResult(gbCheck(ctx))
        } catch {
          ok = false
          break
        }
        if (a !== b) {
          ok = false
          break
        }
      }
      if (!ok) continue
    }

    let ok = true
    for (const k of ubKeys) {
      const uFn = valueFnFromUpstream(ubData[k])
      const gFn = valueFnFromGenerated(gbData[k])
      if (uFn.kind === 'none' || gFn.kind === 'none') {
        ok = false
        break
      }
      for (const ctx of [ctxEmpty, ctxRand]) {
        let a
        let b
        try {
          a = uFn.fn(ctx)
          b = gFn.fn(ctx)
        } catch {
          ok = false
          break
        }
        if (typeof a === 'number' || typeof b === 'number') {
          if (!eqNumber(Number(a), Number(b))) {
            ok = false
            break
          }
        } else if (a !== b) {
          ok = false
          break
        }
      }
      if (!ok) break
    }
    if (ok) return gb
  }
  return null
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const repoRoot = path.resolve(__dirname, '..')

  const args = parseArgs(process.argv)
  const stamp = nowStamp()
  const evidenceDir = path.join(repoRoot, 'circaltest', 'evidence', `${stamp}-upstream-consistency`)
  const summaryDir = path.join(evidenceDir, 'summary')
  ensureDir(summaryDir)

  const toolConfig = loadToolConfig(repoRoot) ?? {}
  const outputRootRel = String(args.outputRoot || args['output-root'] || toolConfig.outputRoot || 'temp/metaGenerator/.output')
  const outputRootAbs = path.isAbsolute(outputRootRel) ? outputRootRel : path.resolve(repoRoot, outputRootRel)

  const gamesArg = String(args.games || args.game || 'both').trim().toLowerCase()
  const games =
    gamesArg === 'both' || gamesArg === 'all'
      ? ['gs', 'sr']
      : splitCsv(gamesArg).filter((g) => g === 'gs' || g === 'sr')
  if (!games.length) {
    console.error(`[upstream-consistency] invalid --games: ${gamesArg}`)
    process.exitCode = 1
    return
  }

  const upstreamCfg = (toolConfig.calc && toolConfig.calc.upstream) || {}
  const includeTeamBuffs = Boolean(upstreamCfg.includeTeamBuffs)
  const preferUpstreamDefaults = upstreamCfg.preferUpstreamDefaults !== false

  const seedRaw = String(args.seed || '')
  const seed =
    (seedRaw && Number.isFinite(Number(seedRaw)) ? Math.trunc(Number(seedRaw)) : null) ??
    (Date.now() % 2 ** 31)
  const rng = mulberry32(seed)

  const results = { seed, outputRoot: path.relative(repoRoot, outputRootAbs), games: {} }

  for (const game of games) {
    const charRootAbs = path.join(outputRootAbs, `meta-${game}`, 'character')
    const names = walkCharDirs(charRootAbs)

    const perGame = {
      game,
      characters: names.length,
      upstreamDefaults: preferUpstreamDefaults ? 'upstream' : 'conservative',
      includeTeamBuffs,
      missingUpstreamTitles: 0,
      extraUpstreamTitles: 0,
      mismatched: 0,
      ok: 0,
      failures: []
    }

    for (const name of names) {
      const dirAbs = path.join(charRootAbs, name)
      const dataPath = path.join(dirAbs, 'data.json')
      const calcPath = path.join(dirAbs, 'calc.js')
      if (!fs.existsSync(dataPath) || !fs.existsSync(calcPath)) continue

      let meta = null
      try {
        meta = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      } catch {
        continue
      }
      if (!isRecord(meta)) continue

      const id = typeof meta.id === 'number' && Number.isFinite(meta.id) ? Math.trunc(meta.id) : undefined
      const elem = typeof meta.elem === 'string' ? meta.elem.trim() : ''
      const tables = game === 'gs' ? getGsTables(meta) : getSrTables(meta)
      if (!tables) continue

      const input = {
        game,
        id,
        name: typeof meta.name === 'string' ? meta.name : name,
        elem,
        weapon: typeof meta.weapon === 'string' ? meta.weapon : '',
        star: typeof meta.star === 'number' && Number.isFinite(meta.star) ? meta.star : 0,
        tables,
        tableValues: buildTableValues(meta, tables)
      }

      const extracted =
        game === 'gs'
          ? buildGsUpstreamDirectBuffs({
              projectRootAbs: repoRoot,
              id,
              elem,
              input,
              upstream: {
                genshinOptimizerRoot: upstreamCfg.genshinOptimizerRoot,
                includeTeamBuffs
              }
            })
          : buildSrUpstreamDirectBuffs({
              projectRootAbs: repoRoot,
              id,
              input,
              upstream: {
                hsrOptimizerRoot: upstreamCfg.hsrOptimizerRoot,
                includeTeamBuffs,
                preferUpstreamDefaults
              }
            })

      const mod = await importFresh(calcPath)
      const genUp = listUpstreamBuffsFromModule(mod)
      const upUp = listUpstreamBuffsFromExtracted(extracted)

      const genMap = buildTitleMap(genUp)
      const upMap = buildTitleMap(upUp)

      const missingTitles = []
      const mismatched = []
      for (const [title, ups] of upMap.entries()) {
        const gens = genMap.get(title) || []
        if (gens.length === 0) {
          missingTitles.push(title)
          continue
        }
        for (const ub of ups) {
          const hit = tryMatchBuff(rng, ub, gens)
          if (!hit) mismatched.push(title)
        }
      }

      const extraTitles = []
      for (const title of genMap.keys()) {
        if (!upMap.has(title)) extraTitles.push(title)
      }

      if (missingTitles.length || extraTitles.length || mismatched.length) {
        perGame.failures.push({
          name,
          id,
          missingTitles: missingTitles.slice(0, 30),
          extraTitles: extraTitles.slice(0, 30),
          mismatchedTitles: mismatched.slice(0, 30)
        })
        perGame.missingUpstreamTitles += missingTitles.length
        perGame.extraUpstreamTitles += extraTitles.length
        perGame.mismatched += mismatched.length
      } else {
        perGame.ok++
      }
    }

    results.games[game] = perGame

    const mdLines = []
    mdLines.push(`# upstream-consistency (${game})`)
    mdLines.push(`- seed: ${seed}`)
    mdLines.push(`- outputRoot: ${path.relative(repoRoot, outputRootAbs)}`)
    mdLines.push(`- upstreamDefaults: ${perGame.upstreamDefaults}`)
    mdLines.push(`- includeTeamBuffs: ${String(includeTeamBuffs)}`)
    mdLines.push(`- characters: ${perGame.characters}`)
    mdLines.push(`- ok: ${perGame.ok}`)
    mdLines.push(`- missingUpstreamTitles: ${perGame.missingUpstreamTitles}`)
    mdLines.push(`- extraUpstreamTitles: ${perGame.extraUpstreamTitles}`)
    mdLines.push(`- mismatched: ${perGame.mismatched}`)
    if (perGame.failures.length) {
      mdLines.push('')
      mdLines.push('## failures (first 30 titles per avatar)')
      for (const f of perGame.failures.slice(0, 50)) {
        mdLines.push(`- ${f.name} (${f.id ?? 'unknown'})`)
        if (f.missingTitles.length) mdLines.push(`  - missing: ${f.missingTitles.join(', ')}`)
        if (f.extraTitles.length) mdLines.push(`  - extra: ${f.extraTitles.join(', ')}`)
        if (f.mismatchedTitles.length) mdLines.push(`  - mismatched: ${f.mismatchedTitles.join(', ')}`)
      }
    }
    fs.writeFileSync(path.join(summaryDir, `${game}.md`), mdLines.join('\n'), 'utf8')
  }

  fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(results, null, 2), 'utf8')

  console.log(`[upstream-consistency] evidence: ${path.relative(repoRoot, summaryDir)}`)
  for (const game of Object.keys(results.games)) {
    const g = results.games[game]
    console.log(
      `[upstream-consistency] ${game}: ok=${g.ok} missingTitles=${g.missingUpstreamTitles} extraTitles=${g.extraUpstreamTitles} mismatched=${g.mismatched}`
    )
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

