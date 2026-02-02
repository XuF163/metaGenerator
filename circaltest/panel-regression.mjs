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
  const normTitle = (s) => {
    let t = String(s || "").trim()
    if (!t) return ""
    // Remove common separators/punctuations.
    t = t.replace(/\s+/g, "").replace(/[·•・?？、，,。．：:；;!！…\-_—–()（）【】\[\]「」『』《》〈〉“”‘’"']/g, "")

    // Normalize common skill prefixes (baseline vs generated titles).
    t = t
      .replace(/元素战技/g, "E")
      .replace(/战技/g, "E")
      .replace(/元素爆发/g, "Q")
      .replace(/爆发/g, "Q")
      .replace(/终结技/g, "Q")
      .replace(/普通攻击/g, "A")
      .replace(/普攻/g, "A")

    // Strip generic words to improve matching.
    t = t.replace(/技能/g, "").replace(/伤害/g, "")

    // Normalize common heal wording (baseline vs generated).
    t = t.replace(/持续治疗/g, "每跳治疗")

    // Some baseline rows use "短E后..." while generated rows may use "E后..." (or vice versa).
    t = t.replace(/短E后/g, "E后")

    // De-dup repeated markers introduced by normalization (e.g. "Q爆发..." -> "QQ...").
    t = t.replace(/E{2,}/g, "E").replace(/Q{2,}/g, "Q").replace(/A{2,}/g, "A")
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

    const entries = []
    let worst = { ratio: 1, abs: 0, title: "" }

    // Match rows by normalized titles first (baseline-oriented), then append any generated-only rows.
    const gList = gRet.map((r, idx) => ({ r, idx, norm: normTitle(r?.title) }))
    const usedG = new Set()

    const pickBestG = (bn) => {
      if (!bn) return null
      let best = null
      for (const it of gList) {
        if (usedG.has(it.idx)) continue
        const gn = it.norm
        if (!gn) continue
        if (gn === bn) return it
        if (gn.includes(bn) || bn.includes(gn)) {
          // Avoid over-matching long baseline titles to generic generated titles like "A一段".
          // This keeps the diff honest: if the generated meta doesn't have the specific row,
          // we prefer showing it as missing rather than matching an unrelated short row.
          const long = bn.length >= gn.length ? bn : gn
          const short = bn.length >= gn.length ? gn : bn
          if (short.length <= 3 && long.length >= 8) continue
          const dist = Math.abs(gn.length - bn.length)
          if (!best || dist < best.dist) best = { ...it, dist }
        }
      }
      return best
    }

    let outIdx = 0
    for (const br0 of bRet) {
      const br = br0 || null
      const bn = normTitle(br?.title)
      const match = pickBestG(bn)
      const gr = match ? match.r : null
      if (match) usedG.add(match.idx)

      const title = (br?.title || gr?.title || "").trim()
      const bAvg = typeof br?.avg === "number" ? br.avg : null
      const gAvg = typeof gr?.avg === "number" ? gr.avg : null
      const bDmg = typeof br?.dmg === "number" ? br.dmg : null
      const gDmg = typeof gr?.dmg === "number" ? gr.dmg : null

      const ratio = bAvg && gAvg ? gAvg / bAvg : null
      const abs = bAvg !== null && gAvg !== null ? Math.abs(gAvg - bAvg) : null

      if (ratio !== null && abs !== null) {
        // Track the most suspicious entry for quick scanning.
        const ratioDist = Math.abs(1 - ratio)
        const worstDist = Math.abs(1 - worst.ratio)
        if (ratioDist > worstDist || (ratioDist === worstDist && abs > worst.abs)) {
          worst = { ratio, abs, title }
        }
      }

      entries.push({
        idx: outIdx++,
        title,
        baseline: { avg: bAvg, dmg: bDmg },
        generated: { avg: gAvg, dmg: gDmg },
        ratio,
        abs
      })
    }

    for (const it of gList) {
      if (usedG.has(it.idx)) continue
      const gr = it.r || null
      const title = (gr?.title || "").trim()
      const gAvg = typeof gr?.avg === "number" ? gr.avg : null
      const gDmg = typeof gr?.dmg === "number" ? gr.dmg : null
      entries.push({
        idx: outIdx++,
        title,
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
    const ar = a?.worst?.ratio ?? 1
    const br = b?.worst?.ratio ?? 1
    return Math.abs(1 - br) - Math.abs(1 - ar)
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

  const uid = String(args.uid || process.env.CIRCALTEST_UID || "").trim()
  if (!uid) throw new Error("Usage: node circaltest/panel-regression.mjs --uid <UID>")

  const game = String(args.game || "gs").trim()
  if (game !== "gs") {
    throw new Error(`[circaltest] panel-regression currently supports --game gs only (got: ${game})`)
  }

  const enemyLv = Number(args.enemyLv || 103)
  const proxy =
    String(args.proxy || process.env.HTTP_PROXY || process.env.http_proxy || "").trim() ||
    "" // optional
  const userAgent = String(args.userAgent || "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36").trim()

  const evidenceRoot = path.join(repoRoot, "circaltest", "evidence", nowStamp())
  const enkaDir = path.join(evidenceRoot, "enka", "raw")
  ensureDir(enkaDir)

  const enkaUrl = String(args.enkaUrl || `https://enka.network/api/uid/${uid}`)
  const raw = await fetchJsonWithRetry(enkaUrl, { proxy: proxy || null, userAgent, retries: 4, timeoutMs: 30_000 })
  raw.uid = uid

  const rawJsonPath = path.join(enkaDir, `${uid}.json`)
  fs.writeFileSync(rawJsonPath, JSON.stringify(raw, null, 2))

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
