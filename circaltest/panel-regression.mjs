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
  const extractCat = (t) => {
    const m = /^([EQATZ])/.exec(String(t || ""))
    return m ? m[1] : ""
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

    const bProfile = b?.dmg?.profile || {}
    const gProfile = g?.dmg?.profile || {}
    const bRetRaw = Array.isArray(bProfile?.ret) ? bProfile.ret : []
    const gRetRaw = Array.isArray(gProfile?.ret) ? gProfile.ret : []
    const bRet = Array.isArray(bProfile?.retEx) ? bProfile.retEx : bRetRaw
    const gRet = Array.isArray(gProfile?.retEx) ? gProfile.retEx : gRetRaw

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

    // Best-effort matching:
    // - Prefer strict normalized title match.
    // - Allow loose match (strip leading skill marker / SR mid-markers) when it yields a closer value,
    //   even if strict matches exist (prevents false positives when generated rows have wrong prefixes).
    const toFiniteNumOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null)
    const withinRatio = (r, pct = 0.025) => {
      if (typeof r !== "number" || !Number.isFinite(r) || r <= 0) return false
      const hi = 1 + pct
      const lo = 1 / hi
      return r >= lo && r <= hi
    }
    const scoreDiff = (bAvg, gAvg) => {
      if (bAvg === null || gAvg === null) return Number.POSITIVE_INFINITY
      if (bAvg === 0) return gAvg === 0 ? 0 : Math.abs(gAvg)
      if (gAvg <= 0) return Number.POSITIVE_INFINITY
      const r = gAvg / bAvg
      if (!Number.isFinite(r) || r <= 0) return Number.POSITIVE_INFINITY
      return Math.abs(Math.log(r))
    }

    const gRows = gRet.map((gr0, gi) => {
      const gr = gr0 || null
      const sig = typeof gr?.sig === "string" ? gr.sig.trim() : ""
      const sigLoose = (() => {
        if (!sig) return ""
        const parts = sig.split("|")
        if (parts.length < 5) return sig
        return `${parts.slice(0, 4).join("|")}|`
      })()
      const strict = normTitle(gr?.title)
      const loose = normTitleLoose(gr?.title)
      return {
        gi,
        gr,
        sig,
        sigLoose,
        strict,
        loose,
        cat: extractCat(strict),
        avg: toFiniteNumOrNull(gr?.avg),
        dmg: toFiniteNumOrNull(gr?.dmg)
      }
    })
    const gBySig = new Map()
    const gBySigLoose = new Map()
    const gByStrict = new Map()
    const gByLoose = new Map()
    for (const row of gRows) {
      if (row.sig) {
        const list = gBySig.get(row.sig) || []
        list.push(row.gi)
        gBySig.set(row.sig, list)
      }
      if (row.sigLoose) {
        const list = gBySigLoose.get(row.sigLoose) || []
        list.push(row.gi)
        gBySigLoose.set(row.sigLoose, list)
      }
      if (row.strict) {
        const list = gByStrict.get(row.strict) || []
        list.push(row.gi)
        gByStrict.set(row.strict, list)
      }
      if (row.loose) {
        const list = gByLoose.get(row.loose) || []
        list.push(row.gi)
        gByLoose.set(row.loose, list)
      }
    }

    const usedGenIdx = new Set()
    const matches = new Map() // baseline idx -> { gi, match }
    const pickBest = (br, bi) => {
      const bSig = typeof br?.sig === "string" ? br.sig.trim() : ""
      const bSigLoose = (() => {
        if (!bSig) return ""
        const parts = bSig.split("|")
        if (parts.length < 5) return bSig
        return `${parts.slice(0, 4).join("|")}|`
      })()
      const bStrict = normTitle(br?.title)
      const bLoose = normTitleLoose(br?.title)
      const bCat = extractCat(bStrict)
      const bAvg = toFiniteNumOrNull(br?.avg)

      const cand = new Set()
      for (const gi of (bSig ? gBySig.get(bSig) || [] : [])) {
        if (!usedGenIdx.has(gi)) cand.add(gi)
      }
      // Allow signature matching without params (baseline often encodes stack/variant params while generated rows may omit them).
      for (const gi of (bSigLoose ? gBySigLoose.get(bSigLoose) || [] : [])) {
        if (!usedGenIdx.has(gi)) cand.add(gi)
      }
      // Fallback to title matching when signature is missing (or not produced by older evidence runs).
      for (const gi of (bStrict ? gByStrict.get(bStrict) || [] : [])) {
        if (!usedGenIdx.has(gi)) cand.add(gi)
      }
      if (bLoose && bLoose.length >= 2) {
        for (const gi of gByLoose.get(bLoose) || []) {
          if (!usedGenIdx.has(gi)) cand.add(gi)
        }
      }

      if (cand.size === 0) return null

      let best = null
      for (const gi of cand) {
        const row = gRows[gi]
        if (!row) continue
        const isSigStrict = !!bSig && row.sig === bSig
        const isSigLoose = !isSigStrict && !!bSigLoose && row.sigLoose === bSigLoose
        if (!isSigStrict && !isSigLoose && bCat && row.cat && row.cat !== bCat) continue

        const isStrict = !!bStrict && row.strict === bStrict
        const match = isSigStrict ? "sig" : isSigLoose ? "sig-loose" : isStrict ? "strict" : "loose"
        const penalty = isSigStrict ? 0 : isSigLoose ? 0.05 : isStrict ? 0.15 : 0.35
        const diff = scoreDiff(bAvg, row.avg)
        const score = penalty + diff

        if (!best || score < best.score - 1e-12) {
          best = { gi, match, score, diff }
          continue
        }
        if (Math.abs(score - best.score) < 1e-12) {
          // Tie-break: prefer signature, then strict, then smaller diff, then smaller index.
          const rank = (m) => (m === "sig" ? 0 : m === "sig-loose" ? 1 : m === "strict" ? 2 : 3)
          if (rank(match) < rank(best.match)) best = { gi, match, score, diff }
          else if (diff < best.diff - 1e-12) best = { gi, match, score, diff }
          else if (gi < best.gi) best = { gi, match, score, diff }
        }
      }

      return best ? { ...best, bi } : null
    }

    for (let i = 0; i < bRet.length; i++) {
      const br = bRet[i] || null
      const picked = pickBest(br, i)
      if (!picked) continue
      usedGenIdx.add(picked.gi)
      matches.set(i, { gi: picked.gi, match: picked.match })
    }

    const bMatchedAvgs = []
    const gMatchedAvgs = []
    let matchedWithin25 = 0

    let outIdx = 0
    for (let i = 0; i < bRet.length; i++) {
      const br = bRet[i] || null
      const mi = matches.get(i)
      const gr = mi ? gRows[mi.gi]?.gr || null : null

      const baselineTitle = (br?.title || "").trim()
      const generatedTitle = (gr?.title || "").trim()
      const title = (baselineTitle || generatedTitle || "").trim()
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

        bMatchedAvgs.push(bAvg)
        gMatchedAvgs.push(gAvg)
        if (withinRatio(ratio, 0.025)) matchedWithin25++
      }

      entries.push({
        idx: outIdx++,
        title,
        match: mi ? mi.match : "missing",
        baselineTitle,
        generatedTitle,
        baseline: { avg: bAvg, dmg: bDmg },
        generated: { avg: gAvg, dmg: gDmg },
        ratio,
        abs
      })
    }

    for (const row of gRows) {
      if (!row || usedGenIdx.has(row.gi)) continue
      const title = (row?.gr?.title || "").trim()
      entries.push({
        idx: outIdx++,
        title,
        match: "generated-only",
        baselineTitle: "",
        generatedTitle: title,
        baseline: { avg: null, dmg: null },
        generated: { avg: typeof row.avg === "number" ? row.avg : null, dmg: typeof row.dmg === "number" ? row.dmg : null },
        ratio: null,
        abs: null
      })
    }

    const bMaxAvgMatched = bMatchedAvgs.length ? Math.max(...bMatchedAvgs) : null
    const gMaxAvgMatched = gMatchedAvgs.length ? Math.max(...gMatchedAvgs) : null
    const maxAvgMatchedRatio =
      bMaxAvgMatched !== null && gMaxAvgMatched !== null && bMaxAvgMatched !== 0
        ? gMaxAvgMatched / bMaxAvgMatched
        : bMaxAvgMatched === 0 && gMaxAvgMatched === 0
          ? 1
          : null

    diffs.push({
      id,
      name: b.name,
      level: b.level,
      cons: b.cons,
      weapon: b.weapon?.name || "",
      matchSummary: {
        matched: bMatchedAvgs.length,
        within25: matchedWithin25,
        withinRate: bMatchedAvgs.length ? matchedWithin25 / bMatchedAvgs.length : 0
      },
      maxAvg: {
        baseline: bMaxAvg,
        generated: gMaxAvg,
        ratio: maxAvgRatio,
        nonZero: { baseline: bNonZeroAvg, generated: gNonZeroAvg }
      },
      maxAvgMatched: {
        baseline: bMaxAvgMatched,
        generated: gMaxAvgMatched,
        ratio: maxAvgMatchedRatio,
        matched: bMatchedAvgs.length
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

  // Sort by severity (maxAvg/worst ratio drift first).
  diffs.sort((a, b) => {
    const scoreRatio = (r) => (typeof r === "number" && Number.isFinite(r) && r > 0 ? Math.abs(Math.log(r)) : 0)
    const score = (d) =>
      Math.max(scoreRatio(d?.maxAvg?.ratio), scoreRatio(d?.maxAvgMatched?.ratio), scoreRatio(d?.worst?.ratio))

    const as = score(a)
    const bs = score(b)
    if (bs !== as) return bs - as

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
    if (d.maxAvgMatched) {
      const b = typeof d.maxAvgMatched.baseline === "number" ? d.maxAvgMatched.baseline.toFixed(2) : "n/a"
      const g = typeof d.maxAvgMatched.generated === "number" ? d.maxAvgMatched.generated.toFixed(2) : "n/a"
      const r = typeof d.maxAvgMatched.ratio === "number" ? d.maxAvgMatched.ratio.toFixed(4) : "n/a"
      const n = d.maxAvgMatched.matched ?? 0
      lines.push(`- maxAvgMatched(avg): baseline=${b} | generated=${g} | ratio=${r} | matched=${n}`)
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
    lines.push("| idx | match | title | gen.title | baseline.avg | generated.avg | ratio | abs |")
    lines.push("|---:|---|---|---|---:|---:|---:|---:|")
    const esc = (s) => String(s || "").replace(/\|/g, "\\|")
    for (const e of d.entries || []) {
      const genTitle =
        e.match === "generated-only"
          ? e.generatedTitle || ""
          : e.generatedTitle && e.baselineTitle && e.generatedTitle !== e.baselineTitle
            ? e.generatedTitle
            : ""
      const bAvg = e.baseline.avg === null ? "" : e.baseline.avg.toFixed(2)
      const gAvg = e.generated.avg === null ? "" : e.generated.avg.toFixed(2)
      const ratio = e.ratio === null ? "" : e.ratio.toFixed(4)
      const abs = e.abs === null ? "" : e.abs.toFixed(2)
      lines.push(`| ${e.idx} | ${e.match} | ${esc(e.title)} | ${esc(genTitle)} | ${bAvg} | ${gAvg} | ${ratio} | ${abs} |`)
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

  const evidenceRootArg = String(args.evidenceRoot || "").trim()
  const evidenceRoot = evidenceRootArg ? toAbs(repoRoot, evidenceRootArg) : path.join(repoRoot, "circaltest", "evidence", nowStamp())

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
  if (uid === "100000000") {
    throw new Error(
      `[circaltest] forbidden uid=100000000 (do not use this uid for regression tests); please pick another uid from testData/${game}/*.json`
    )
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
