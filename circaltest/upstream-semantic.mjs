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

function buildTableValuesGs(meta, tables) {
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

function pickScalarFromLevelArray(v) {
  // meta talentData values are arrays by level; pick the max-level scalar.
  if (!Array.isArray(v) || v.length === 0) return 0
  const last = v[v.length - 1]
  if (typeof last === 'number' && Number.isFinite(last)) return last
  if (Array.isArray(last) && last.length) {
    const x = last[0]
    return typeof x === 'number' && Number.isFinite(x) ? x : 0
  }
  if (last && typeof last === 'object') {
    for (const x of Object.values(last)) {
      if (typeof x === 'number' && Number.isFinite(x)) return x
      if (Array.isArray(x) && typeof x[0] === 'number' && Number.isFinite(x[0])) return x[0]
    }
  }
  return 0
}

function buildTalentSnapshot(game, meta) {
  const out = {}
  if (game === 'gs') {
    const td = isRecord(meta.talentData) ? meta.talentData : null
    if (!td) return out
    for (const [tk, blk] of Object.entries(td)) {
      if (!isRecord(blk)) continue
      const outTk = {}
      for (const [name, values] of Object.entries(blk)) {
        if (!name) continue
        outTk[name] = pickScalarFromLevelArray(values)
      }
      if (Object.keys(outTk).length) out[tk] = outTk
    }
    return out
  }

  // sr
  const talent = isRecord(meta.talent) ? meta.talent : null
  if (!talent) return out
  for (const [tk, blk] of Object.entries(talent)) {
    if (!isRecord(blk)) continue
    const tables = isRecord(blk.tables) ? blk.tables : null
    if (!tables) continue
    const outTk = {}
    for (const t of Object.values(tables)) {
      if (!isRecord(t)) continue
      const name = typeof t.name === 'string' ? t.name.trim() : ''
      const values = Array.isArray(t.values) ? t.values : []
      if (!name || values.length === 0) continue
      const last = values[values.length - 1]
      if (typeof last === 'number' && Number.isFinite(last)) outTk[name] = last
    }
    if (Object.keys(outTk).length) out[tk] = outTk
  }
  return out
}

function mkAttrItem(base) {
  return {
    base,
    plus: 0,
    pct: 0,
    inc: 0,
    valueOf() {
      const b = Number(this.base) || 0
      const p = Number(this.plus) || 0
      const pct = Number(this.pct) || 0
      return b + p + (b * pct) / 100
    },
    toString() {
      return String(this.valueOf())
    }
  }
}

function mkAttrSample(game) {
  const base = {
    atk: mkAttrItem(2000),
    hp: mkAttrItem(40000),
    def: mkAttrItem(1000),
    mastery: mkAttrItem(800),
    recharge: mkAttrItem(120),
    heal: mkAttrItem(0),
    shield: mkAttrItem(100),
    cpct: mkAttrItem(50),
    cdmg: mkAttrItem(100),
    dmg: mkAttrItem(0),
    phy: mkAttrItem(0),
    // sr-only buckets
    speed: mkAttrItem(100),
    enemydmg: mkAttrItem(0),
    effPct: mkAttrItem(0),
    effDef: mkAttrItem(0),
    stance: mkAttrItem(0)
  }
  return new Proxy(base, {
    get(t, p) {
      if (typeof p === 'string' && p in t) return t[p]
      return mkAttrItem(0)
    }
  })
}

function mkCalcFn() {
  return (ds) => {
    if (!ds || typeof ds !== 'object') return 0
    const b = Number(ds.base) || 0
    const p = Number(ds.plus) || 0
    const pct = Number(ds.pct) || 0
    return b + p + (b * pct) / 100
  }
}

function gsElemToCn(elemRaw) {
  const e = String(elemRaw || '').trim().toLowerCase()
  if (e === 'pyro') return '火'
  if (e === 'hydro') return '水'
  if (e === 'electro') return '雷'
  if (e === 'cryo') return '冰'
  if (e === 'anemo') return '风'
  if (e === 'geo') return '岩'
  if (e === 'dendro') return '草'
  return '火'
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

function eqNumber(a, b, eps = 1e-8) {
  if (a === b) return true
  if (typeof a !== 'number' || typeof b !== 'number') return false
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false
  const diff = Math.abs(a - b)
  if (diff <= eps) return true
  const denom = Math.max(1, Math.abs(a), Math.abs(b))
  return diff / denom <= 1e-8
}

function normalizeKey(game, k) {
  const key = String(k || '').trim()
  if (!key) return ''
  if (game === 'sr') {
    if (key === 'speedPlus') return 'speed'
  }
  return key
}

const ABS_KEYS = new Set(['enemyDef', 'enemyIgnore', 'ignore', 'kx', 'fykx'])

function shouldApplyByCons(b, cons) {
  const need = typeof b?.cons === 'number' && Number.isFinite(b.cons) ? Math.trunc(b.cons) : 0
  return !need || cons >= need
}

function sumBuffsByKey(game, buffs, ctx, caches) {
  const sums = new Map()
  const list = Array.isArray(buffs) ? buffs : []
  for (const b of list) {
    if (!isRecord(b)) continue
    if (!shouldApplyByCons(b, ctx.cons)) continue

    const checkRaw = b.check
    const ok = (() => {
      if (typeof checkRaw === 'function') {
        try {
          return !!checkRaw(ctx)
        } catch {
          return false
        }
      }
      if (typeof checkRaw === 'string' && checkRaw.trim()) {
        const expr = checkRaw.trim()
        const fn = caches.checkFn.get(expr) || (() => {
          const f = compileExpr(expr, { number: false })
          caches.checkFn.set(expr, f)
          return f
        })()
        try {
          return !!fn(ctx)
        } catch {
          return false
        }
      }
      return true
    })()
    if (!ok) continue

    const data = isRecord(b.data) ? b.data : null
    if (!data) continue
    for (const [k0, vRaw] of Object.entries(data)) {
      const k = normalizeKey(game, k0)
      if (!k || k.startsWith('_')) continue

      let ret
      if (typeof vRaw === 'number') ret = vRaw
      else if (typeof vRaw === 'function') {
        try {
          ret = vRaw(ctx)
        } catch {
          ret = undefined
        }
      } else if (typeof vRaw === 'string' && vRaw.trim()) {
        const expr = vRaw.trim()
        const fn = caches.dataFn.get(expr) || (() => {
          const f = compileExpr(expr, { number: true })
          caches.dataFn.set(expr, f)
          return f
        })()
        try {
          ret = fn(ctx)
        } catch {
          ret = undefined
        }
      } else {
        continue
      }

      if (typeof ret !== 'number' || !Number.isFinite(ret)) continue
      const v = ABS_KEYS.has(k) ? Math.abs(ret) : ret
      sums.set(k, (sums.get(k) || 0) + v)
    }
  }
  return sums
}

function mergeParams(...objs) {
  const out = {}
  for (const o of objs) {
    if (!isRecord(o)) continue
    for (const [k, v] of Object.entries(o)) {
      if (!k) continue
      out[k] = v
    }
  }
  return out
}

function detailCurrentTalent(d) {
  const key = typeof d?.key === 'string' ? String(d.key).trim() : ''
  if (key) return (key.split(',')[0] || '').trim() || key
  const tk = typeof d?.talent === 'string' ? String(d.talent).trim() : ''
  return tk || ''
}

async function main() {
  const __filename = fileURLToPath(import.meta.url)
  const __dirname = path.dirname(__filename)
  const repoRoot = path.resolve(__dirname, '..')

  const args = parseArgs(process.argv)
  const stamp = nowStamp()
  const evidenceDir = path.join(repoRoot, 'circaltest', 'evidence', `${stamp}-upstream-semantic`)
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
    console.error(`[upstream-semantic] invalid --games: ${gamesArg}`)
    process.exitCode = 1
    return
  }

  const upstreamCfg = (toolConfig.calc && toolConfig.calc.upstream) || {}
  const includeTeamBuffs = Boolean(upstreamCfg.includeTeamBuffs)
  const preferUpstreamDefaults = upstreamCfg.preferUpstreamDefaults !== false

  const caches = { dataFn: new Map(), checkFn: new Map() }

  const results = {
    outputRoot: path.relative(repoRoot, outputRootAbs),
    includeTeamBuffs,
    upstreamDefaults: preferUpstreamDefaults ? 'upstream' : 'conservative',
    games: {}
  }

  for (const game of games) {
    const charRootAbs = path.join(outputRootAbs, `meta-${game}`, 'character')
    const names = walkCharDirs(charRootAbs)

    const perGame = {
      game,
      characters: names.length,
      ok: 0,
      failed: 0,
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
        // GS node-local premods depend on this.
        tableValues: game === 'gs' ? buildTableValuesGs(meta, tables) : {}
      }

      const upstreamBuffs =
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
      const genBuffs = Array.isArray(mod?.buffs) ? mod.buffs : []
      const details = Array.isArray(mod?.details) ? mod.details : []
      const defParams = isRecord(mod?.defParams) ? mod.defParams : {}

      const talent = buildTalentSnapshot(game, meta)
      const attr = mkAttrSample(game)
      const calc = mkCalcFn()
      const weapon = {
        name: input.weapon || '武器',
        star: typeof input.star === 'number' && Number.isFinite(input.star) ? input.star : 5,
        affix: 1,
        type: input.weapon || ''
      }
      const trees = new Proxy(
        {},
        {
          get() {
            return 1
          }
        }
      )
      const baseElement = game === 'gs' ? gsElemToCn(elem) : 'shock'

      const contexts = []
      contexts.push({ params: defParams, currentTalent: '' })
      for (const d of details) {
        if (!isRecord(d)) continue
        contexts.push({
          params: mergeParams(defParams, d.params),
          currentTalent: detailCurrentTalent(d)
        })
      }
      if (contexts.length > 40) contexts.splice(40)

      const failKeys = new Set()

      for (const c of contexts) {
        const ctx = {
          talent,
          attr,
          calc,
          params: c.params || {},
          cons: 6,
          weapon,
          trees,
          element: baseElement,
          currentTalent: c.currentTalent || ''
        }

        const upSum = sumBuffsByKey(game, upstreamBuffs, ctx, caches)
        if (upSum.size === 0) continue

        const genSum = sumBuffsByKey(game, genBuffs, ctx, caches)

        for (const [k, vUp] of upSum.entries()) {
          const vGen = genSum.get(k) || 0
          if (!eqNumber(vUp, vGen)) failKeys.add(`${k}: up=${vUp.toFixed(6)} gen=${vGen.toFixed(6)}`)
        }
        if (failKeys.size) break
      }

      if (failKeys.size) {
        perGame.failed++
        perGame.failures.push({
          name,
          id,
          diffs: Array.from(failKeys).slice(0, 12)
        })
      } else {
        perGame.ok++
      }
    }

    results.games[game] = perGame

    const md = []
    md.push(`# upstream-semantic (${game})`)
    md.push(`- outputRoot: ${path.relative(repoRoot, outputRootAbs)}`)
    md.push(`- includeTeamBuffs: ${String(includeTeamBuffs)}`)
    md.push(`- upstreamDefaults: ${results.upstreamDefaults}`)
    md.push(`- characters: ${perGame.characters}`)
    md.push(`- ok: ${perGame.ok}`)
    md.push(`- failed: ${perGame.failed}`)
    if (perGame.failures.length) {
      md.push('')
      md.push('## failures (first 12 diffs per avatar)')
      for (const f of perGame.failures.slice(0, 50)) {
        md.push(`- ${f.name} (${f.id ?? 'unknown'})`)
        for (const d of f.diffs || []) md.push(`  - ${d}`)
      }
    }
    fs.writeFileSync(path.join(summaryDir, `${game}.md`), md.join('\n'), 'utf8')
  }

  fs.writeFileSync(path.join(summaryDir, 'summary.json'), JSON.stringify(results, null, 2), 'utf8')

  console.log(`[upstream-semantic] evidence: ${path.relative(repoRoot, summaryDir)}`)
  for (const game of Object.keys(results.games)) {
    const g = results.games[game]
    console.log(`[upstream-semantic] ${game}: ok=${g.ok} failed=${g.failed}`)
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})

