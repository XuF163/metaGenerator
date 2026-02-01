import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { loadToolConfig } from "../dist/config/config.js"
import { tryCreateLlmService } from "../dist/llm/try-create.js"
import { buildCalcJsWithLlmOrHeuristic } from "../dist/generate/calc/llm-calc.js"

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

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
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

function buildBuffHintsGs(meta) {
  const hints = []
  const isCombatLike = (s) => /(伤害|攻击|防御|生命|暴击|元素|精通|充能|治疗|护盾|抗性|穿透|提高|提升|降低|增加|减少|\d|%)/.test(s)
  const isNonCombat = (s) => /(探索派遣|派遣任务|烹饪|合成|制作|锻造|加工|采集|钓鱼)/.test(s)

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

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, "..")

const args = parseArgs(process.argv)
const game = String(args.game || "gs")
const name = String(args.name || args.char || "")
const outputRoot = String(args.outputRoot || args["output-root"] || "temp/metaGenerator/.output")

if (game !== "gs" && game !== "sr") {
  console.error(`[regen-calc] invalid --game: ${game}`)
  process.exitCode = 1
  process.exit(1)
}
if (!name) {
  console.error(`[regen-calc] missing --name <character folder name>`)
  process.exitCode = 1
  process.exit(1)
}

const outputRootAbs = path.isAbsolute(outputRoot) ? outputRoot : path.resolve(projectRoot, outputRoot)
const charDir = path.join(outputRootAbs, `meta-${game}`, "character", name)
const dataPath = path.join(charDir, "data.json")
if (!fs.existsSync(dataPath)) {
  console.error(`[regen-calc] data.json not found: ${dataPath}`)
  process.exitCode = 1
  process.exit(1)
}

const metaRaw = JSON.parse(fs.readFileSync(dataPath, "utf8"))
if (!isRecord(metaRaw)) {
  console.error(`[regen-calc] invalid meta JSON: ${dataPath}`)
  process.exitCode = 1
  process.exit(1)
}

const elem = typeof metaRaw.elem === "string" ? metaRaw.elem : ""
const weapon = typeof metaRaw.weapon === "string" ? metaRaw.weapon : ""
const star = typeof metaRaw.star === "number" && Number.isFinite(metaRaw.star) ? metaRaw.star : 0
const tables = game === "gs" ? getGsTables(metaRaw) : null
if (!tables) {
  console.error(`[regen-calc] failed to infer talent tables for: ${game} ${name}`)
  process.exitCode = 1
  process.exit(1)
}

const { talentDesc, tableUnits, tableTextByName } = buildGsDescAndUnits(metaRaw)
const buffHints = game === "gs" ? buildBuffHintsGs(metaRaw) : []
const tableSamples = buildTableSamples(metaRaw)
const tableTextSamples = buildTableTextSamples(tableSamples, tableTextByName)

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
  { cacheRootAbs: llmCacheRootAbs, force: true }
)

const outPath = path.join(charDir, "calc.js")
fs.writeFileSync(outPath, js, "utf8")
console.log(`[regen-calc] wrote: ${outPath}`)
console.log(`[regen-calc] usedLlm=${usedLlm} error=${error || ""}`)
