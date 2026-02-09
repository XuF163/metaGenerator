import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function nowStamp() {
  // Safe for Windows paths.
  return new Date().toISOString().replace(/[:.]/g, "-")
}

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

function toAbs(repoRoot, p) {
  if (!p) return ""
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p)
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function splitCsv(v) {
  return String(v || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

function isFinitePos(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0
}

function absLogRatio(r) {
  return isFinitePos(r) ? Math.abs(Math.log(r)) : null
}

function withinRatio(r, pct = 0.025) {
  if (!isFinitePos(r)) return false
  const hi = 1 + pct
  const lo = 1 / hi
  return r >= lo && r <= hi
}

function scoreAvatar(d) {
  const cands = [d?.maxAvg?.ratio, d?.maxAvgMatched?.ratio, d?.worst?.ratio]
  let best = 0
  for (const r of cands) {
    const v = absLogRatio(r)
    if (typeof v === "number" && v > best) best = v
  }
  return best
}

function getPrimaryRatio(d) {
  const r = d?.maxAvgMatched?.ratio
  if (isFinitePos(r)) return r
  const r2 = d?.worst?.ratio
  if (isFinitePos(r2)) return r2
  const r3 = d?.maxAvg?.ratio
  if (isFinitePos(r3)) return r3
  return null
}

function extractAvatarIds(raw, { game }) {
  if (!isRecord(raw)) return []
  const avatars = isRecord(raw.avatars) ? raw.avatars : null
  if (!avatars) return []
  const ids = Object.keys(avatars).filter(Boolean)
  if (game === "sr") {
    // SR: playable avatars are 4-digit ids (e.g. 1001..1415, 8005..8006).
    // Some datasets contain internal “加强/强化” variants (e.g. 100500/120500), which do not have meta/calc.
    return ids.filter((id) => /^\d+$/.test(id) && Number(id) > 0 && Number(id) <= 9999)
  }
  return ids
}

function hasAnyArtis(raw) {
  if (!isRecord(raw)) return false
  const avatars = isRecord(raw.avatars) ? raw.avatars : null
  if (!avatars) return false
  for (const v of Object.values(avatars)) {
    if (!isRecord(v)) continue
    const artis = v.artis
    if (isRecord(artis) && Object.keys(artis).length) return true
  }
  return false
}

function listTestdataFiles(testdataRootAbs, game) {
  const dir = path.join(testdataRootAbs, game)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.endsWith(".json"))
    .map((n) => path.join(dir, n))
}

function buildUidAvatarMap(testdataRootAbs, game, { requireArtis }) {
  const map = new Map()
  const universe = new Set()
  const idToName = new Map()
  for (const filePathAbs of listTestdataFiles(testdataRootAbs, game)) {
    const uid = path.basename(filePathAbs, ".json")
    if (!/^\d{6,}$/.test(uid)) continue
    if (uid === "100000000") continue
    let raw = null
    try {
      raw = JSON.parse(fs.readFileSync(filePathAbs, "utf8"))
    } catch {
      continue
    }
    const ids = extractAvatarIds(raw, { game })
    if (!ids.length) continue
    if (requireArtis && !hasAnyArtis(raw)) continue
    const set = new Set(ids.map(String))
    map.set(uid, set)
    for (const id of set) universe.add(id)

    const avatars = isRecord(raw.avatars) ? raw.avatars : null
    if (avatars) {
      for (const [id, av] of Object.entries(avatars)) {
        if (!id || idToName.has(id)) continue
        if (!set.has(String(id))) continue
        if (isRecord(av) && typeof av.name === "string" && av.name.trim()) idToName.set(id, av.name.trim())
      }
    }
  }
  return { map, universe, idToName }
}

function greedyCover(uidToIds, universe) {
  const remaining = new Set(universe)
  const picked = []
  const candidates = Array.from(uidToIds.entries())

  while (remaining.size) {
    let bestUid = ""
    let bestGain = 0
    let bestSet = null

    for (const [uid, set] of candidates) {
      if (picked.includes(uid)) continue
      let gain = 0
      for (const id of set) if (remaining.has(id)) gain++
      if (gain > bestGain) {
        bestGain = gain
        bestUid = uid
        bestSet = set
      }
    }

    if (!bestUid || !bestSet || bestGain <= 0) break
    picked.push(bestUid)
    for (const id of bestSet) remaining.delete(id)
  }

  return { picked, remaining }
}

function runPanelRegressionOnce({ repoRoot, uid, game, enemyLv, evidenceRoot, testdataRoot, baselineMetaRoot, generatedMetaRoot }) {
  return new Promise((resolve, reject) => {
    const args = [
      path.join("circaltest", "panel-regression.mjs"),
      "--useTestdata",
      "--game",
      game,
      "--uid",
      uid,
      "--enemyLv",
      String(enemyLv),
      "--evidenceRoot",
      evidenceRoot,
      "--testdataRoot",
      testdataRoot,
      "--baselineMetaRoot",
      baselineMetaRoot,
      "--generatedMetaRoot",
      generatedMetaRoot
    ]
    const child = spawn(process.execPath, args, { cwd: repoRoot, stdio: "inherit" })
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`[circaltest] panel-regression failed: game=${game} uid=${uid} exitCode=${code}`))
    })
  })
}

function renderSummaryMd({ game, cover, perUid, worstAvatars }) {
  const lines = []
  lines.push(`# panel-regression-cover (${game})`)
  lines.push("")
  lines.push(`- testData avatars: ${cover.universeCount}`)
  lines.push(`- selected uids (${cover.selectedUids.length}): ${cover.selectedUids.join(", ")}`)
  lines.push(`- covered avatars: ${cover.coveredCount}/${cover.universeCount}`)
  if (cover.missingCount) {
    const short = (cover.missingNames || cover.missingIds || []).slice(0, 12).join(", ")
    lines.push(`- missing avatars: ${cover.missingCount}${short ? ` (${short}${cover.missingCount > 12 ? ", ..." : ""})` : ""}`)
  }
  lines.push("")

  lines.push("## Per UID")
  lines.push("")
  lines.push("| uid | avatars | missing | matched=0 | ratios | within±2.5% | meanAbsLogDev |")
  lines.push("|---:|---:|---:|---:|---:|---:|---:|")
  for (const r of perUid) {
    const mean = typeof r.meanAbsLogDev === "number" ? r.meanAbsLogDev.toFixed(4) : ""
    lines.push(
      `| ${r.uid} | ${r.avatars} | ${r.missing} | ${r.matched0} | ${r.ratios} | ${r.within} | ${mean} |`
    )
  }
  lines.push("")

  lines.push("## Worst Avatars (by abs(log(ratio)))")
  lines.push("")
  lines.push("| rank | uid | id | name | ratio | score | hint |")
  lines.push("|---:|---:|---:|---|---:|---:|---|")
  let rank = 1
  for (const w of worstAvatars) {
    const ratio = typeof w.ratio === "number" ? w.ratio.toFixed(4) : ""
    const score = typeof w.score === "number" ? w.score.toFixed(4) : ""
    const hint = String(w.hint || "").replace(/\|/g, "\\|")
    const name = String(w.name || "").replace(/\|/g, "\\|")
    lines.push(`| ${rank++} | ${w.uid} | ${w.id} | ${name} | ${ratio} | ${score} | ${hint} |`)
    if (rank > 30) break
  }
  lines.push("")

  return lines.join("\n")
}

function buildSummaryForGame({ repoRoot, evidenceRootAbs, game, selectedUids, universe, idToName }) {
  const perUid = []
  const worstMap = new Map() // avatarId -> {score, uid, ...}

  for (const uid of selectedUids) {
    const diffPath = path.join(evidenceRootAbs, "diff", game, `${uid}.json`)
    if (!fs.existsSync(diffPath)) {
      perUid.push({
        uid,
        avatars: 0,
        missing: 0,
        matched0: 0,
        ratios: 0,
        within: 0,
        meanAbsLogDev: null,
        error: `diff missing: ${path.relative(repoRoot, diffPath)}`
      })
      continue
    }
    const payload = JSON.parse(fs.readFileSync(diffPath, "utf8"))
    const diffs = Array.isArray(payload?.diffs) ? payload.diffs : []

    let missing = 0
    let matched0 = 0
    let ratios = 0
    let within = 0
    let sumAbsLog = 0

    for (const d of diffs) {
      if (d?.kind === "missing") {
        missing++
        continue
      }
      const matched = Number(d?.maxAvgMatched?.matched || 0)
      if (!matched) matched0++

      const ratio = getPrimaryRatio(d)
      if (isFinitePos(ratio)) {
        const v = absLogRatio(ratio)
        if (typeof v === "number") {
          ratios++
          sumAbsLog += v
          if (withinRatio(ratio, 0.025)) within++
        }
      }

      const score = scoreAvatar(d)
      const prev = worstMap.get(String(d?.id || ""))
      if (!prev || score > prev.score) {
        const hintParts = []
        if (typeof d?.worst?.title === "string" && d.worst.title.trim()) hintParts.push(d.worst.title.trim())
        if (typeof d?.weapon === "string" && d.weapon.trim()) hintParts.push(d.weapon.trim())
        worstMap.set(String(d?.id || ""), {
          uid,
          id: String(d?.id || ""),
          name: String(d?.name || ""),
          ratio: getPrimaryRatio(d),
          score,
          hint: hintParts.slice(0, 2).join(" / ")
        })
      }
    }

    perUid.push({
      uid,
      avatars: diffs.length,
      missing,
      matched0,
      ratios,
      within,
      meanAbsLogDev: ratios ? sumAbsLog / ratios : null
    })
  }

  const worstAvatars = Array.from(worstMap.values())
    .filter((w) => typeof w.score === "number" && Number.isFinite(w.score))
    .sort((a, b) => b.score - a.score)

  const covered = new Set()
  for (const uid of selectedUids) {
    const diffPath = path.join(evidenceRootAbs, "diff", game, `${uid}.json`)
    if (!fs.existsSync(diffPath)) continue
    const payload = JSON.parse(fs.readFileSync(diffPath, "utf8"))
    const diffs = Array.isArray(payload?.diffs) ? payload.diffs : []
    for (const d of diffs) if (d?.id) covered.add(String(d.id))
  }

  const universeIds = Array.from(universe).sort((a, b) => Number(a) - Number(b))
  const coveredIds = Array.from(covered).sort((a, b) => Number(a) - Number(b))
  const missingIds = universeIds.filter((id) => !covered.has(id))
  const missingNames = missingIds.map((id) => {
    const name = idToName?.get?.(id) || ""
    return name ? `${id}:${name}` : id
  })

  const cover = {
    universeCount: universe.size,
    coveredCount: covered.size,
    missingCount: missingIds.length,
    missingIds,
    missingNames,
    selectedUids
  }

  const summary = {
    game,
    evidenceRoot: evidenceRootAbs,
    cover,
    perUid,
    worstAvatars: worstAvatars.slice(0, 200)
  }

  const summaryDir = path.join(evidenceRootAbs, "summary")
  ensureDir(summaryDir)
  const jsonPath = path.join(summaryDir, `${game}.json`)
  const mdPath = path.join(summaryDir, `${game}.md`)
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2))
  fs.writeFileSync(mdPath, renderSummaryMd({ game, cover, perUid, worstAvatars }))

  return { summary, jsonPath, mdPath }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const args = parseArgs(process.argv)

  const gameArg = String(args.game || "both").trim().toLowerCase()
  const games = gameArg === "both" ? ["gs", "sr"] : [gameArg]
  for (const g of games) {
    if (g !== "gs" && g !== "sr") throw new Error(`[circaltest] panel-regression-cover supports --game gs|sr|both (got: ${g})`)
  }

  const enemyLv = Number(args.enemyLv || 103)
  const testdataRoot = toAbs(repoRoot, args.testdataRoot || "testData")
  const requireArtis = !args.allowPartial && !args.partial

  const evidenceRootArg = String(args.evidenceRoot || "").trim()
  const evidenceRootAbs = evidenceRootArg
    ? toAbs(repoRoot, evidenceRootArg)
    : path.join(repoRoot, "circaltest", "evidence", `${nowStamp()}-cover`)

  const baselineMetaRootArg = String(args.baselineMetaRoot || "").trim()
  const generatedMetaRootArg = String(args.generatedMetaRoot || "").trim()

  ensureDir(evidenceRootAbs)

  for (const game of games) {
    const baselineMetaRoot = baselineMetaRootArg ? toAbs(repoRoot, baselineMetaRootArg) : path.join(repoRoot, "temp", "metaBaselineRef", `meta-${game}`)
    const generatedMetaRoot = generatedMetaRootArg
      ? toAbs(repoRoot, generatedMetaRootArg)
      : path.join(repoRoot, "temp", "metaGenerator", ".output", `meta-${game}`)

    const { map, universe, idToName } = buildUidAvatarMap(testdataRoot, game, { requireArtis })
    if (universe.size === 0 || map.size === 0) {
      console.log(`[circaltest] skip game=${game} (no valid testData found under ${path.relative(repoRoot, testdataRoot)}/${game})`)
      continue
    }

    const uidsArgKey = game === "gs" ? "uidsGs" : "uidsSr"
    const explicitUids = splitCsv(args[uidsArgKey] || args.uids || "")
    const { picked, remaining } = explicitUids.length
      ? { picked: explicitUids.filter((u) => map.has(u) && u !== "100000000"), remaining: new Set() }
      : greedyCover(map, universe)

    if (remaining.size) {
      console.log(
        `[circaltest] warning: game=${game} cover incomplete; remaining=${remaining.size}/${universe.size} (try adding more testData)`
      )
    }

    const selectedUids = picked
    console.log(`[circaltest] cover uids for ${game}: ${selectedUids.join(", ")}`)

    for (const uid of selectedUids) {
      await runPanelRegressionOnce({
        repoRoot,
        uid,
        game,
        enemyLv,
        evidenceRoot: evidenceRootAbs,
        testdataRoot,
        baselineMetaRoot,
        generatedMetaRoot
      })
    }

    const { mdPath } = buildSummaryForGame({ repoRoot, evidenceRootAbs, game, selectedUids, universe, idToName })
    console.log(`[circaltest] cover summary (${game}): ${path.relative(repoRoot, mdPath)}`)
  }

  console.log(`[circaltest] panel-regression-cover evidence: ${path.relative(repoRoot, evidenceRootAbs)}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})
