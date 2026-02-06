import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath } from "node:url"

import { loadToolConfig } from "../dist/config/config.js"
import { tryCreateLlmService } from "../dist/llm/try-create.js"
import { buildCalcJsWithLlmOrHeuristic } from "../dist/generate/calc/llm-calc.js"
import { runPromisePool } from "../dist/utils/promise-pool.js"

function parseArgs(argv) {
  const out = {}
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (!a.startsWith("--")) continue
    const k = a.slice(2)
    const v = argv[i + 1]
    if (!v || v.startsWith("--")) {
      out[k] = true
    } else {
      out[k] = v
      i++
    }
  }
  return out
}

function parseBool(v, defaultValue) {
  if (v === undefined) return defaultValue
  if (v === true) return true
  if (v === false) return false
  if (typeof v !== "string") return defaultValue
  const t = v.trim().toLowerCase()
  if (!t) return defaultValue
  if (t === "1" || t === "true" || t === "yes" || t === "y") return true
  if (t === "0" || t === "false" || t === "no" || t === "n") return false
  return defaultValue
}

function parseNum(v, defaultValue) {
  if (v === undefined) return defaultValue
  const n = Number(v)
  return Number.isFinite(n) ? n : defaultValue
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function sha256File(filePathAbs) {
  const buf = fs.readFileSync(filePathAbs)
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function normalizeTextInline(text) {
  if (typeof text !== "string") return ""
  return text
    .replace(/<[^>]+>/g, "")
    .replaceAll("\\n", " ")
    .replaceAll("\n", " ")
    .replace(/\s+/g, " ")
    .trim()
}

function inferUnitHintFromTableValues(valuesRaw) {
  const values = Array.isArray(valuesRaw) ? valuesRaw : []
  for (const v of values.slice(0, 3)) {
    const t = normalizeTextInline(v)
    if (!t) continue
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(t)) return "元素精通"
    if (/(生命值上限|最大生命值|生命值|\bhp\b)/i.test(t)) return "生命值上限"
    if (/(防御力|\bdef\b)/i.test(t)) return "防御力"
    if (/(攻击力|攻击|\batk\b)/i.test(t)) return "攻击力"
  }
  return ""
}

function getGsTables(meta) {
  const talentData = isRecord(meta.talentData) ? meta.talentData : null
  if (!talentData) return null
  const get = (k) => {
    const blk = talentData[k]
    if (!isRecord(blk)) return []
    return Object.keys(blk).filter(Boolean)
  }
  const a = get("a")
  const e = get("e")
  const q = get("q")
  if (a.length === 0 && e.length === 0 && q.length === 0) return null
  return { a, e, q }
}

function getSrTables(meta) {
  const talentRaw = isRecord(meta.talent) ? meta.talent : null
  if (!talentRaw) return null
  const get = (k) => {
    const blk = talentRaw[k]
    if (!isRecord(blk)) return []
    const tablesRaw = blk.tables
    const names = []
    if (Array.isArray(tablesRaw)) {
      for (const t of tablesRaw) {
        if (isRecord(t) && typeof t.name === "string") names.push(t.name.trim())
      }
    } else if (isRecord(tablesRaw)) {
      for (const t of Object.values(tablesRaw)) {
        if (isRecord(t) && typeof t.name === "string") names.push(t.name.trim())
      }
    }
    return names.filter(Boolean)
  }
  const a = get("a")
  const e = get("e")
  const q = get("q")
  const t = get("t")
  if (a.length === 0 && e.length === 0 && q.length === 0 && t.length === 0) return null
  return { a, e, q, t }
}

function buildGsDescAndUnits(meta) {
  const talentDesc = {}
  const tableUnits = {}
  const tableTextByName = {}
  const talentRaw = isRecord(meta.talent) ? meta.talent : null
  if (!talentRaw) return { talentDesc, tableUnits, tableTextByName }

  for (const k of ["a", "e", "q"]) {
    const blk = talentRaw[k]
    if (!isRecord(blk)) continue

    const desc = blk.desc
    if (typeof desc === "string") talentDesc[k] = desc
    else if (Array.isArray(desc)) talentDesc[k] = desc.filter((x) => typeof x === "string").join("\n")

    const tablesRaw = blk.tables
    const outUnits = {}
    const outText = {}
    const pushTable = (t) => {
      if (!isRecord(t)) return
      const name = typeof t.name === "string" ? t.name.trim() : ""
      if (!name || name in outUnits) return
      let unit = typeof t.unit === "string" ? t.unit : ""
      unit = unit.trim()
      if (!unit) unit = inferUnitHintFromTableValues(t.values)
      outUnits[name] = unit

      const values = t.values
      if (Array.isArray(values) && values.length) {
        const sampleText = normalizeTextInline(values[0])
        if (sampleText) outText[name] = sampleText
      }
    }
    if (Array.isArray(tablesRaw)) {
      for (const t of tablesRaw) pushTable(t)
    } else if (isRecord(tablesRaw)) {
      for (const t of Object.values(tablesRaw)) pushTable(t)
    }
    if (Object.keys(outUnits).length) tableUnits[k] = outUnits
    if (Object.keys(outText).length) tableTextByName[k] = outText
  }

  return { talentDesc, tableUnits, tableTextByName }
}

function buildSrDescAndUnits(meta) {
  const talentDesc = {}
  const tableUnits = {}
  const tableTextByName = {}
  const talentRaw = isRecord(meta.talent) ? meta.talent : null
  if (!talentRaw) return { talentDesc, tableUnits, tableTextByName }

  for (const k of ["a", "e", "q", "t"]) {
    const blk = talentRaw[k]
    if (!isRecord(blk)) continue

    const desc = blk.desc
    if (typeof desc === "string") talentDesc[k] = desc
    else if (Array.isArray(desc)) talentDesc[k] = desc.filter((x) => typeof x === "string").join("\n")

    const tablesRaw = blk.tables
    const outUnits = {}
    const outText = {}
    const pushTable = (t) => {
      if (!isRecord(t)) return
      const name = typeof t.name === "string" ? t.name.trim() : ""
      if (!name || name in outUnits) return
      let unit = typeof t.unit === "string" ? t.unit : ""
      unit = unit.trim()
      if (!unit) unit = inferUnitHintFromTableValues(t.values)
      outUnits[name] = unit

      const values = t.values
      if (Array.isArray(values) && values.length) {
        const sampleText = normalizeTextInline(values[0])
        if (sampleText) outText[name] = sampleText
      }
    }
    if (Array.isArray(tablesRaw)) {
      for (const t of tablesRaw) pushTable(t)
    } else if (isRecord(tablesRaw)) {
      for (const t of Object.values(tablesRaw)) pushTable(t)
    }
    if (Object.keys(outUnits).length) tableUnits[k] = outUnits
    if (Object.keys(outText).length) tableTextByName[k] = outText
  }

  return { talentDesc, tableUnits, tableTextByName }
}

function buildBuffHintsGs(meta) {
  const hints = []
  const isCombatLike = (s) => /(伤害|攻击|防御|生命|暴击|元素|精通|充能|治疗|护盾|抗性|穿透|提高|提升|降低|增加|减少|\d|%)/.test(s)
  const isNonCombat = (s) =>
    /(探索派遣|派遣任务|钓鱼)/.test(s) ||
    /(完美烹饪|烹饪.{0,12}时|合成.{0,12}时|制作.{0,12}时|锻造.{0,12}时|加工.{0,12}时|采集.{0,12}时)/.test(s)

  const passiveRaw = Array.isArray(meta.passive) ? meta.passive : []
  for (const p of passiveRaw) {
    if (!isRecord(p)) continue
    const name = typeof p.name === "string" ? p.name.trim() : ""
    const descArr = Array.isArray(p.desc) ? p.desc : []
    const desc = descArr.filter((x) => typeof x === "string").join(" ").trim()
    if (!name || !desc) continue
    if (isNonCombat(desc)) continue
    if (!isCombatLike(desc)) continue
    hints.push(`被动：${name}：${desc}`)
  }

  const consRaw = isRecord(meta.cons) ? meta.cons : null
  if (consRaw) {
    const keys = Object.keys(consRaw)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    for (const n of keys) {
      const c = consRaw[String(n)]
      if (!isRecord(c)) continue
      const name = typeof c.name === "string" ? c.name.trim() : ""
      const descArr = Array.isArray(c.desc) ? c.desc : []
      const desc = descArr.filter((x) => typeof x === "string").join(" ").trim()
      if (!name || !desc) continue
      if (!isCombatLike(desc)) continue
      hints.push(`${n}命：${name}：${desc}`)
    }
  }

  return hints
}

function buildBuffHintsSr(meta) {
  const hints = []

  const talentRaw = isRecord(meta.talent) ? meta.talent : null
  const z = talentRaw && isRecord(talentRaw.z) ? talentRaw.z : null
  if (z) {
    const name = typeof z.name === "string" ? z.name.trim() : ""
    const desc = typeof z.desc === "string" ? z.desc.trim() : ""
    if (name && desc) hints.push(`秘技：${name}：${desc}`)
  }

  const consRaw = isRecord(meta.cons) ? meta.cons : null
  if (consRaw) {
    const keys = Object.keys(consRaw)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
    for (const n of keys) {
      const c = consRaw[String(n)]
      if (!isRecord(c)) continue
      const name = typeof c.name === "string" ? c.name.trim() : ""
      const desc = typeof c.desc === "string" ? c.desc.trim() : ""
      if (!name || !desc) continue
      hints.push(`${n}魂：${name}：${desc}`)
    }
  }

  const treeData = isRecord(meta.treeData) ? meta.treeData : null
  if (treeData) {
    const nodes = []
    for (const v of Object.values(treeData)) {
      if (!isRecord(v)) continue
      if (v.type !== "skill" || v.root !== true) continue
      const idx = typeof v.idx === "number" && Number.isFinite(v.idx) ? Math.trunc(v.idx) : 0
      const name = typeof v.name === "string" ? v.name.trim() : ""
      const desc = typeof v.desc === "string" ? v.desc.trim() : ""
      if (!idx || !name || !desc) continue
      nodes.push({ idx, name, desc })
    }
    nodes.sort((a, b) => a.idx - b.idx)
    for (const n of nodes) {
      hints.push(`行迹${n.idx}：${n.name}：${n.desc}`)
    }
  }

  return hints
}

function buildTableSamples(meta) {
  const out = {}
  const talentData = isRecord(meta.talentData) ? meta.talentData : null
  if (!talentData) return out
  for (const k of ["a", "e", "q", "t"]) {
    const blk = talentData[k]
    if (!isRecord(blk)) continue
    const sampleMap = {}
    for (const [name, values] of Object.entries(blk)) {
      if (!name || typeof name !== "string") continue
      if (!Array.isArray(values) || values.length === 0) continue
      const sample = values[0]
      if (Array.isArray(sample) || (sample && typeof sample === "object")) {
        sampleMap[name] = sample
      }
    }
    if (Object.keys(sampleMap).length) out[k] = sampleMap
  }
  return out
}

function buildTableTextSamples(tableSamples, tableTextByName) {
  const out = {}
  for (const [k, m] of Object.entries(tableSamples || {})) {
    if (!m || typeof m !== "object" || Array.isArray(m)) continue
    const textMap = tableTextByName?.[k]
    if (!textMap || typeof textMap !== "object") continue
    const outK = {}
    for (const name of Object.keys(m)) {
      if (!name) continue
      const baseName = name.endsWith("2") ? name.slice(0, -1) : name
      const txt = textMap[name] || textMap[baseName] || ""
      if (txt) outK[name] = txt
    }
    if (Object.keys(outK).length) out[k] = outK
  }
  return out
}

function splitNames(raw) {
  const s = typeof raw === "string" ? raw : ""
  if (!s.trim()) return []
  return s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean)
}

function pickNamesFromDiff(diffJsonPathAbs, { top, minDev }) {
  const raw = JSON.parse(fs.readFileSync(diffJsonPathAbs, "utf8"))
  const diffs = Array.isArray(raw?.diffs) ? raw.diffs : []
  const rows = []
  for (const d of diffs) {
    const name = typeof d?.name === "string" ? d.name : ""
    const ratio = Number(d?.worst?.ratio)
    const abs = Number(d?.worst?.abs || 0)
    if (!name) continue
    if (!Number.isFinite(ratio)) continue
    // Include hard-zero cases: baseline>0 vs generated=0 commonly yields ratio=0.
    // Prefer regenerating these first (dev=Infinity).
    if (ratio === 0) {
      if (!(abs > 0)) continue
      rows.push({ name, ratio, dev: Number.POSITIVE_INFINITY, abs, title: String(d?.worst?.title || "") })
      continue
    }
    if (ratio < 0) continue
    const dev = ratio >= 1 ? ratio : 1 / ratio
    if (dev < minDev) continue
    rows.push({ name, ratio, dev, abs, title: String(d?.worst?.title || "") })
  }
  rows.sort((a, b) => b.dev - a.dev)
  return rows.slice(0, top).map((r) => r.name)
}

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")

const args = parseArgs(process.argv)
const game = String(args.game || "gs").trim()
const outputRoot = String(args.outputRoot || args["output-root"] || "temp/metaGenerator/.output").trim()
const forceCache = parseBool(args.forceCache ?? args["force-cache"], true)
const concurrencyArg = parseNum(args.concurrency, 0)
const minDev = parseNum(args.minDev ?? args["min-dev"], 1.25)
const top = Math.max(1, Math.trunc(parseNum(args.top, 12)))

if (game !== "gs" && game !== "sr") {
  console.error(`[regen-calc-batch] invalid --game: ${game}`)
  process.exitCode = 1
  process.exit(1)
}

const fromDiff = String(args.fromDiff || args["from-diff"] || "").trim()
const fromDiffAbs = fromDiff ? (path.isAbsolute(fromDiff) ? fromDiff : path.resolve(projectRoot, fromDiff)) : ""

let names = splitNames(args.names || args.name || "")
if (names.length === 0 && fromDiffAbs) {
  if (!fs.existsSync(fromDiffAbs)) {
    console.error(`[regen-calc-batch] diff json not found: ${fromDiffAbs}`)
    process.exitCode = 1
    process.exit(1)
  }
  names = pickNamesFromDiff(fromDiffAbs, { top, minDev })
}

if (names.length === 0) {
  console.error(
    "[regen-calc-batch] Usage:\n" +
      "  node circaltest/regen-calc-batch.mjs --names \"莱依拉,夏沃蕾\" [--concurrency 4]\n" +
      "  node circaltest/regen-calc-batch.mjs --fromDiff <diff.json> [--minDev 1.25] [--top 12] [--concurrency 4]"
  )
  process.exitCode = 1
  process.exit(1)
}

const outputRootAbs = path.isAbsolute(outputRoot) ? outputRoot : path.resolve(projectRoot, outputRoot)

const ctx = {
  projectRoot,
  repoRoot: projectRoot,
  cwd: process.cwd(),
  now: new Date(),
  log: console
}

const toolConfig = loadToolConfig(projectRoot) ?? undefined
const llm = tryCreateLlmService(ctx, toolConfig, { purpose: "calc", required: true })
const llmCacheRootAbs = path.join(projectRoot, ".cache", "llm")

const concurrency =
  concurrencyArg > 0
    ? Math.max(1, Math.trunc(concurrencyArg))
    : Math.max(1, Math.trunc(toolConfig?.llm?.maxConcurrency || 1))

console.log(
  `[regen-calc-batch] start: game=${game} names=${names.length} concurrency=${concurrency} forceCache=${forceCache}`
)

let done = 0
let ok = 0
let failed = 0
const failures = []

await runPromisePool(
  names,
  concurrency,
  async (name) => {
    const charDir = path.join(outputRootAbs, `meta-${game}`, "character", name)
    const dataPath = path.join(charDir, "data.json")
    if (!fs.existsSync(dataPath)) throw new Error(`[regen-calc-batch] data.json not found: ${dataPath}`)

    const metaRaw = JSON.parse(fs.readFileSync(dataPath, "utf8"))
    if (!isRecord(metaRaw)) throw new Error(`[regen-calc-batch] invalid meta JSON: ${dataPath}`)

    const elem = typeof metaRaw.elem === "string" ? metaRaw.elem : ""
    const weapon = typeof metaRaw.weapon === "string" ? metaRaw.weapon : ""
    const star = typeof metaRaw.star === "number" && Number.isFinite(metaRaw.star) ? metaRaw.star : 0
    const tables = game === "gs" ? getGsTables(metaRaw) : getSrTables(metaRaw)
    if (!tables) throw new Error(`[regen-calc-batch] failed to infer talent tables: ${name}`)

    const { talentDesc, tableUnits, tableTextByName } = game === "gs" ? buildGsDescAndUnits(metaRaw) : buildSrDescAndUnits(metaRaw)
    const buffHints = game === "gs" ? buildBuffHintsGs(metaRaw) : buildBuffHintsSr(metaRaw)
    const tableSamples = buildTableSamples(metaRaw)
    const tableTextSamples = buildTableTextSamples(tableSamples, tableTextByName)

    const outPath = path.join(charDir, "calc.js")
    const beforeSha = fs.existsSync(outPath) ? sha256File(outPath) : ""

    const { js, usedLlm, error } = await buildCalcJsWithLlmOrHeuristic(
      llm,
      {
        game,
        name,
        elem,
        weapon,
        star,
        tables,
        tableUnits,
        tableSamples,
        tableTextSamples,
        talentDesc,
        buffHints
      },
      { cacheRootAbs: llmCacheRootAbs, force: forceCache }
    )

    fs.writeFileSync(outPath, js, "utf8")
    const afterSha = sha256File(outPath)

    done++
    if (usedLlm) ok++
    else failed++
    if (!usedLlm) failures.push({ name, error: error || "LLM not used" })

    const head = `[regen-calc-batch] ${done}/${names.length} ${name}`
    const extra = [
      usedLlm ? "llm=Y" : "llm=N",
      beforeSha && afterSha && beforeSha !== afterSha ? "sha=changed" : "sha=same",
      error ? `warn=${String(error).slice(0, 140)}` : ""
    ]
      .filter(Boolean)
      .join(" ")
    console.log(`${head} ${extra}`)
  },
  {
    onError: (e, name) => {
      done++
      failed++
      failures.push({ name, error: e instanceof Error ? e.message : String(e) })
      console.log(`[regen-calc-batch] ${done}/${names.length} ${name} llm=N error=${String(e).slice(0, 220)}`)
    }
  }
)

console.log(`[regen-calc-batch] done: ok=${ok} failed=${failed}`)
if (failures.length) {
  console.log(`[regen-calc-batch] failures:`)
  for (const f of failures) {
    console.log(`- ${f.name}: ${f.error}`)
  }
}
