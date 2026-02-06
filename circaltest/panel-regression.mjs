import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawn } from "node:child_process"
import { fetch, ProxyAgent } from "undici"

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
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

function tryInferUidFromPath(p) {
  const base = path.basename(String(p || ""), path.extname(String(p || "")))
  // Most datasets are stored as "<uid>.json". Keep it lenient: digits only.
  if (/^\d{6,}$/.test(base)) return base
  return ""
}

async function fetchJsonWithRetry(url, { proxy, userAgent, retries = 3, timeoutMs = 30_000 }) {
  const dispatcher = proxy ? new ProxyAgent(proxy) : undefined
  let lastErr = null
  for (let i = 0; i < retries; i++) {
    try {
      const ctrl = new AbortController()
      const t = setTimeout(() => ctrl.abort(), timeoutMs)
      const res = await fetch(url, {
        dispatcher,
        redirect: "follow",
        headers: userAgent ? { "user-agent": userAgent } : undefined,
        signal: ctrl.signal
      })
      clearTimeout(t)
      const text = await res.text()
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`)
      return JSON.parse(text)
    } catch (e) {
      lastErr = e instanceof Error ? e : new Error(String(e))
      await sleep(800 * (i + 1))
    }
  }
  throw lastErr || new Error("unknown fetch error")
}

function runWorker({ repoRoot, tag, game, enemyLv, metaRoot, rawJsonPath, outFilePath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--preserve-symlinks", "--preserve-symlinks-main", path.join("circaltest", "panel-worker.mjs")],
      {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        CIRCALTEST_SANDBOX: "1",
        CIRCALTEST_TAG: tag,
        CIRCALTEST_GAME: game,
        CIRCALTEST_ENEMY_LV: String(enemyLv),
        CIRCALTEST_META_ROOT: metaRoot,
        CIRCALTEST_RAW_JSON: rawJsonPath,
        CIRCALTEST_OUT_FILE: outFilePath
      }
      }
    )
    child.on("error", reject)
    child.on("exit", (code) => {
      if (code === 0) resolve()
      else reject(new Error(`[circaltest] panel-worker failed: tag=${tag} exitCode=${code}`))
    })
  })
}

function diffRuns(baseline, generated) {
  const game = String(baseline?.game || generated?.game || "gs").trim() || "gs"
  const normTitle = (s) => {
    let t = String(s || "").trim()
    if (!t) return ""
    // Remove whitespace + common separators/punctuations.
    t = t.replace(/\s+/g, "")
    t = t.replace(/[·•･・…?？、，,。．：:；;!！"'“”‘’()（）【】\[\]{}《》〈〉<>「」『』]/g, "")
    t = t.replace(/[=+~`^|\\]/g, "")
    t = t.replace(/[-_—–]/g, "")

    if (game === "sr") {
      // Normalize SR skill prefixes.
      t = t
        .replace(/普通攻击/g, "A")
        .replace(/普攻/g, "A")
        .replace(/战技/g, "E")
        .replace(/终结技/g, "Q")
        .replace(/天赋/g, "T")
        .replace(/秘技/g, "Z")

      // Unify constellation wording (命/魂).
      t = t.replace(/(\d+)命/g, "$1魂")

      // Unify heal/shield wording.
      t = t.replace(/治疗量/g, "治疗").replace(/护盾量/g, "护盾")
    } else {
      // Normalize GS skill prefixes.
      t = t
        .replace(/元素战技/g, "E")
        .replace(/战技/g, "E")
        .replace(/元素爆发/g, "Q")
        .replace(/终结技/g, "Q")
        .replace(/普通攻击/g, "A")
        .replace(/普攻/g, "A")
    }

    // Normalize press wording (E点按 vs 点按E).
    t = t.replace(/短按/g, "点按")
    t = t.replace(/^(点按|长按|短按)([EQATZ])/g, "$2$1")

    // Strip generic words to improve matching.
    t = t.replace(/技能/g, "").replace(/伤害/g, "")

    // Normalize common heal wording (baseline vs generated).
    t = t.replace(/持续治疗/g, "每跳治疗")
    // Some generated rows use "领域发动治疗" to mean the burst-cast heal (baseline: "爆发治疗").
    t = t.replace(/领域发动治疗/g, "爆发治疗")

    // Some baseline rows use "短E后..." while generated rows may use "E后..." (or vice versa).
    t = t.replace(/短E后/g, "E后")

    // De-dup repeated markers introduced by normalization (e.g. "Q爆发..." -> "QQ...").
    t = t
      .replace(/E{2,}/g, "E")
      .replace(/Q{2,}/g, "Q")
      .replace(/A{2,}/g, "A")
      .replace(/T{2,}/g, "T")
      .replace(/Z{2,}/g, "Z")
    return t
  }
  const normTitleLoose = (s) => {
    let t = normTitle(s)
    // Strip a single leading marker only when the remaining title is still informative.
    if (t.length > 1 && /^[EQATZ]/.test(t)) t = t.slice(1)
    // SR titles often differ only by whether they keep skill markers in the middle.
    if (game === "sr") t = t.replace(/[EQATZ]/g, "")
    return t
  }

  const baseById = new Map((baseline.avatars || []).map((a) => [String(a.id), a]))
  const genById = new Map((generated.avatars || []).map((a) => [String(a.id), a]))
  const ids = Array.from(new Set([...baseById.keys(), ...genById.keys()])).sort((a, b) => Number(a) - Number(b))

  const diffs = []
  for (const id of ids) {
    const b = baseById.get(id)
    const g = genById.get(id)
    if (!b || !g) {
      diffs.push({
        id,
        name: b?.name || g?.name || "",
        kind: "missing",
        baseline: !!b,
        generated: !!g
      })
      continue
    }

    const bRet = b?.dmg?.profile?.ret || []
    const gRet = g?.dmg?.profile?.ret || []

    const collectFiniteAvg = (arr) =>
      (arr || [])
        .map((r) => (r && typeof r.avg === "number" && Number.isFinite(r.avg) ? r.avg : null))
        .filter((v) => v !== null)

    const bAvgs = collectFiniteAvg(bRet)
    const gAvgs = collectFiniteAvg(gRet)
    const bMaxAvg = bAvgs.length ? Math.max(...bAvgs) : null
    const gMaxAvg = gAvgs.length ? Math.max(...gAvgs) : null
    const maxAvgRatio =
      bMaxAvg !== null && gMaxAvg !== null && bMaxAvg !== 0
        ? gMaxAvg / bMaxAvg
        : bMaxAvg === 0 && gMaxAvg === 0
          ? 1
          : null
    const bNonZeroAvg = bAvgs.filter((v) => v > 0).length
    const gNonZeroAvg = gAvgs.filter((v) => v > 0).length

    const entries = []
    let worst = { ratio: null, abs: 0, title: "" }

    // Evidence-first matching:
    // - Strict: only match when normalized titles are exactly equal.
    // - Loose (fallback): strip a single leading skill marker (E/Q/A) to match baseline "Qxxx" vs generated "xxx",
    //   but ONLY when the loose key is unique on both sides (prevents misleading pairings).
    const gBucketsStrict = new Map()
    for (const gr0 of gRet) {
      const gr = gr0 || null
      const gn = normTitle(gr?.title)
      if (!gn) continue
      const list = gBucketsStrict.get(gn) || []
      list.push(gr)
      gBucketsStrict.set(gn, list)
    }

    const matchStrict = new Map() // baseline idx -> generated entry
    for (let i = 0; i < bRet.length; i++) {
      const br = bRet[i] || null
      const bn = normTitle(br?.title)
      const bucket = bn ? gBucketsStrict.get(bn) || [] : []
      const gr = bucket.length ? bucket.shift() : null
      if (bn) gBucketsStrict.set(bn, bucket)
      if (gr) matchStrict.set(i, gr)
    }

    const gUnmatched = []
    for (const list of gBucketsStrict.values()) {
      for (const gr0 of list) gUnmatched.push(gr0 || null)
    }

    const bUnmatchedIdx = []
    for (let i = 0; i < bRet.length; i++) {
      if (!matchStrict.has(i)) bUnmatchedIdx.push(i)
    }

    const bLooseCount = new Map()
    for (const bi of bUnmatchedIdx) {
      const br = bRet[bi] || null
      const k = normTitleLoose(br?.title)
      if (!k) continue
      bLooseCount.set(k, (bLooseCount.get(k) || 0) + 1)
    }
    const gLooseCount = new Map()
    const gLooseBucket = new Map()
    for (const gr of gUnmatched) {
      const k = normTitleLoose(gr?.title)
      if (!k) continue
      gLooseCount.set(k, (gLooseCount.get(k) || 0) + 1)
      const list = gLooseBucket.get(k) || []
      list.push(gr)
      gLooseBucket.set(k, list)
    }

    const matchLoose = new Map() // baseline idx -> generated entry
    for (const bi of bUnmatchedIdx) {
      const br = bRet[bi] || null
      const k = normTitleLoose(br?.title)
      if (!k) continue
      if ((bLooseCount.get(k) || 0) !== 1) continue
      if ((gLooseCount.get(k) || 0) !== 1) continue
      const list = gLooseBucket.get(k) || []
      const gr = list.length ? list[0] : null
      if (!gr) continue
      matchLoose.set(bi, gr)
      gLooseBucket.delete(k)
    }

    const gUsedLoose = new Set(matchLoose.values())

    let outIdx = 0
    for (let i = 0; i < bRet.length; i++) {
      const br = bRet[i] || null
      const gr = matchStrict.get(i) || matchLoose.get(i) || null

      const title = (br?.title || gr?.title || "").trim()
      const bAvg = typeof br?.avg === "number" ? br.avg : null
      const gAvg = typeof gr?.avg === "number" ? gr.avg : null
      const bDmg = typeof br?.dmg === "number" ? br.dmg : null
      const gDmg = typeof gr?.dmg === "number" ? gr.dmg : null

      const ratio =
        bAvg !== null && gAvg !== null && bAvg !== 0
          ? gAvg / bAvg
          : bAvg === 0 && gAvg === 0
            ? 1
            : null
      const abs = bAvg !== null && gAvg !== null ? Math.abs(gAvg - bAvg) : null

      if (abs !== null) {
        // Track the most suspicious entry for quick scanning.
        // Prefer ratio distance when ratio is available; otherwise fall back to absolute difference.
        if (ratio !== null && Number.isFinite(ratio)) {
          const ratioDist = Math.abs(1 - ratio)
          const worstDist = typeof worst.ratio === "number" ? Math.abs(1 - worst.ratio) : -1
          if (ratioDist > worstDist || (ratioDist === worstDist && abs > worst.abs)) {
            worst = { ratio, abs, title }
          }
        } else if (typeof worst.ratio !== "number" && abs > worst.abs) {
          worst = { ratio: null, abs, title }
        }
      }

      entries.push({
        idx: outIdx++,
        title,
        match: matchStrict.has(i) ? "strict" : matchLoose.has(i) ? "loose" : "missing",
        baseline: { avg: bAvg, dmg: bDmg },
        generated: { avg: gAvg, dmg: gDmg },
        ratio,
        abs
      })
    }

    for (const gr0 of gUnmatched) {
      const gr = gr0 || null
      if (!gr) continue
      if (gUsedLoose.has(gr)) continue
      const title = (gr?.title || "").trim()
      const gAvg = typeof gr?.avg === "number" ? gr.avg : null
      const gDmg = typeof gr?.dmg === "number" ? gr.dmg : null
      entries.push({
        idx: outIdx++,
        title,
        match: "generated-only",
        baseline: { avg: null, dmg: null },
        generated: { avg: gAvg, dmg: gDmg },
        ratio: null,
        abs: null
      })
    }

    diffs.push({
      id,
      name: b.name,
      level: b.level,
      cons: b.cons,
      weapon: b.weapon?.name || "",
      maxAvg: {
        baseline: bMaxAvg,
        generated: gMaxAvg,
        ratio: maxAvgRatio,
        nonZero: { baseline: bNonZeroAvg, generated: gNonZeroAvg }
      },
      createdBy: {
        baseline: b?.dmg?.profile?.createdBy || "",
        generated: g?.dmg?.profile?.createdBy || ""
      },
      calcSha256: {
        baseline: b?.calc?.sha256 || "",
        generated: g?.calc?.sha256 || ""
      },
      hasDmg: { baseline: !!b.hasDmg, generated: !!g.hasDmg },
      dmgError: { baseline: b?.dmg?.error || "", generated: g?.dmg?.error || "" },
      worst,
      entries
    })
  }

  // Sort by severity (worst ratio distance first).
  diffs.sort((a, b) => {
    const ar = a?.worst?.ratio
    const br = b?.worst?.ratio
    const arDist = typeof ar === "number" ? Math.abs(1 - ar) : 0
    const brDist = typeof br === "number" ? Math.abs(1 - br) : 0
    if (brDist !== arDist) return brDist - arDist
    const aa = typeof a?.worst?.abs === "number" ? a.worst.abs : 0
    const ba = typeof b?.worst?.abs === "number" ? b.worst.abs : 0
    return ba - aa
  })

  return diffs
}

function renderDiffMd({ uid, game, enemyLv, baselineMetaRoot, generatedMetaRoot, baselineFile, generatedFile, diffs }) {
  const lines = []
  lines.push(`# panel-regression (${game})`)
  lines.push("")
  lines.push(`- uid: ${uid}`)
  lines.push(`- enemyLv: ${enemyLv}`)
  lines.push(`- baselineMetaRoot: ${baselineMetaRoot}`)
  lines.push(`- generatedMetaRoot: ${generatedMetaRoot}`)
  lines.push(`- baselineRun: ${baselineFile}`)
  lines.push(`- generatedRun: ${generatedFile}`)
  lines.push("")

  for (const d of diffs) {
    lines.push(`## ${d.name || d.id} (id=${d.id})`)
    if (d.kind === "missing") {
      lines.push(`- kind: missing (baseline=${d.baseline}, generated=${d.generated})`)
      lines.push("")
      continue
    }
    lines.push(`- level/cons: Lv.${d.level} C${d.cons}`)
    lines.push(`- weapon: ${d.weapon}`)
    lines.push(`- createdBy: baseline=${d.createdBy?.baseline || ""} | generated=${d.createdBy?.generated || ""}`)
    if (d.maxAvg) {
      const b = typeof d.maxAvg.baseline === "number" ? d.maxAvg.baseline.toFixed(2) : "n/a"
      const g = typeof d.maxAvg.generated === "number" ? d.maxAvg.generated.toFixed(2) : "n/a"
      const r = typeof d.maxAvg.ratio === "number" ? d.maxAvg.ratio.toFixed(4) : "n/a"
      const bn = d.maxAvg.nonZero?.baseline ?? 0
      const gn = d.maxAvg.nonZero?.generated ?? 0
      lines.push(`- maxAvg(avg): baseline=${b} (${bn} nonZero) | generated=${g} (${gn} nonZero) | ratio=${r}`)
    }
    if (d.dmgError?.baseline || d.dmgError?.generated) {
      lines.push(`- dmgError: baseline=${d.dmgError?.baseline ? "YES" : "NO"} | generated=${d.dmgError?.generated ? "YES" : "NO"}`)
    }
    if (d.worst) {
      const ratio = typeof d.worst.ratio === "number" ? d.worst.ratio.toFixed(4) : "n/a"
      const abs = typeof d.worst.abs === "number" ? d.worst.abs.toFixed(2) : "n/a"
      lines.push(`- worst: ${d.worst.title} (ratio=${ratio}, abs=${abs})`)
    }
    lines.push("")
    lines.push("| idx | title | baseline.avg | generated.avg | ratio | abs |")
    lines.push("|---:|---|---:|---:|---:|---:|")
    for (const e of d.entries || []) {
      const bAvg = e.baseline.avg === null ? "" : e.baseline.avg.toFixed(2)
      const gAvg = e.generated.avg === null ? "" : e.generated.avg.toFixed(2)
      const ratio = e.ratio === null ? "" : e.ratio.toFixed(4)
      const abs = e.abs === null ? "" : e.abs.toFixed(2)
      lines.push(`| ${e.idx} | ${e.title} | ${bAvg} | ${gAvg} | ${ratio} | ${abs} |`)
    }
    lines.push("")
  }
  return lines.join("\n")
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
  const args = parseArgs(process.argv)

  const game = String(args.game || "gs").trim()
  if (game !== "gs" && game !== "sr") {
    throw new Error(`[circaltest] panel-regression supports --game gs|sr (got: ${game})`)
  }

  const enemyLv = Number(args.enemyLv || 103)
  const proxy =
    String(args.proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim() ||
    "" // optional
  const userAgent = String(args.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36").trim()

  const evidenceRoot = path.join(repoRoot, "circaltest", "evidence", nowStamp())

  const testdataRoot = toAbs(repoRoot, args.testdataRoot || "testData")
  const useTestdata = !!args.useTestdata || !!args.testdata

  const fileArg = String(args.file || args.raw || "").trim()
  const filePathAbs = fileArg ? toAbs(repoRoot, fileArg) : ""

  let uid = String(args.uid || process.env.CIRCALTEST_UID || "").trim()
  let rawJsonPath = ""

  if (filePathAbs) {
    if (!fs.existsSync(filePathAbs)) throw new Error(`[circaltest] raw file not found: ${filePathAbs}`)
    rawJsonPath = filePathAbs
    uid = uid || tryInferUidFromPath(filePathAbs)
  } else if (useTestdata) {
    if (!uid) throw new Error("Usage: node circaltest/panel-regression.mjs --useTestdata --uid <UID> [--game gs|sr]")
    rawJsonPath = path.join(testdataRoot, game, `${uid}.json`)
    if (!fs.existsSync(rawJsonPath)) throw new Error(`[circaltest] testData missing: ${rawJsonPath}`)
  } else {
    // Fetch mode (GS only).
    if (!uid) throw new Error("Usage: node circaltest/panel-regression.mjs --uid <UID>")
    if (game !== "gs") {
      throw new Error(`[circaltest] fetch mode only supports --game gs; use --file or --useTestdata for sr`)
    }
    const enkaDir = path.join(evidenceRoot, "enka", "raw")
    ensureDir(enkaDir)

    const enkaUrl = String(args.enkaUrl || `https://enka.network/api/uid/${uid}`)
    const raw = await fetchJsonWithRetry(enkaUrl, { proxy: proxy || null, userAgent, retries: 4, timeoutMs: 30_000 })
    raw.uid = uid

    rawJsonPath = path.join(enkaDir, `${uid}.json`)
    fs.writeFileSync(rawJsonPath, JSON.stringify(raw, null, 2))
  }

  if (!uid) {
    throw new Error(`[circaltest] failed to infer uid (pass --uid explicitly): raw=${rawJsonPath}`)
  }

  const baselineMetaRoot = toAbs(repoRoot, args.baselineMetaRoot || `temp/metaBaselineRef/meta-${game}`)
  const generatedMetaRoot = toAbs(repoRoot, args.generatedMetaRoot || `temp/metaGenerator/.output/meta-${game}`)

  const baselineOut = path.join(evidenceRoot, "baseline", game, `${uid}.json`)
  const generatedOut = path.join(evidenceRoot, "generated", game, `${uid}.json`)
  ensureDir(path.dirname(baselineOut))
  ensureDir(path.dirname(generatedOut))

  await runWorker({
    repoRoot,
    tag: "baseline",
    game,
    enemyLv,
    metaRoot: baselineMetaRoot,
    rawJsonPath,
    outFilePath: baselineOut
  })

  await runWorker({
    repoRoot,
    tag: "generated",
    game,
    enemyLv,
    metaRoot: generatedMetaRoot,
    rawJsonPath,
    outFilePath: generatedOut
  })

  const baseline = JSON.parse(fs.readFileSync(baselineOut, "utf8"))
  const generated = JSON.parse(fs.readFileSync(generatedOut, "utf8"))

  const diffs = diffRuns(baseline, generated)

  const diffDir = path.join(evidenceRoot, "diff", game)
  ensureDir(diffDir)

  const diffJsonPath = path.join(diffDir, `${uid}.json`)
  const diffMdPath = path.join(diffDir, `${uid}.md`)

  fs.writeFileSync(
    diffJsonPath,
    JSON.stringify(
      {
        uid,
        game,
        enemyLv,
        baselineMetaRoot,
        generatedMetaRoot,
        baselineFile: baselineOut,
        generatedFile: generatedOut,
        diffs
      },
      null,
      2
    )
  )

  const diffMd = renderDiffMd({
    uid,
    game,
    enemyLv,
    baselineMetaRoot,
    generatedMetaRoot,
    baselineFile: baselineOut,
    generatedFile: generatedOut,
    diffs
  })
  fs.writeFileSync(diffMdPath, diffMd)

  console.log(`[circaltest] panel-regression evidence: ${path.relative(repoRoot, evidenceRoot)}`)
  console.log(`[circaltest] panel-regression diff: ${path.relative(repoRoot, diffMdPath)}`)
}

main().catch((e) => {
  console.error(e instanceof Error ? e.stack || e.message : String(e))
  process.exitCode = 1
})
