import fs from "node:fs"
import path from "node:path"
import crypto from "node:crypto"
import { fileURLToPath, pathToFileURL } from "node:url"

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

function writeJsonIfMissing(filePath, data) {
  if (fs.existsSync(filePath)) return
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2))
}

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath)
  return crypto.createHash("sha256").update(buf).digest("hex")
}

function rmPath(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true })
  } catch {}
}

function toAbsPath(repoRoot, p) {
  if (!p) return ""
  return path.isAbsolute(p) ? p : path.resolve(repoRoot, p)
}

function isRecord(v) {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

function detectRawKind(raw) {
  if (raw && Array.isArray(raw.avatarInfoList)) return "enka"
  if (raw && isRecord(raw.avatars)) return "profile-json"
  return "unknown"
}

const ALLOWED_PROFILE_SOURCES = new Set([
  "enka",
  "EnkaHSR",
  "change",
  "miao",
  "mgg",
  "hanxuan",
  "lyln",
  "homo",
  "avocado.wiki",
  "mysPanel",
  "mysPanelHSR"
])

function normalizeProfileSource(game, source) {
  const s = String(source || "").trim()
  if (ALLOWED_PROFILE_SOURCES.has(s)) return s
  // Local datasets may use custom source tags; force one that miao-plugin accepts.
  return game === "sr" ? "homo" : "enka"
}

function sanitizePlayerInfo(raw, uid) {
  // Avoid storing personal info (nickname/signature/avatar showcase list...) in evidence outputs.
  // We only keep fields that are useful for debugging without being identifying content.
  const out = { uid: uid || "" }
  const pi = raw && isRecord(raw.playerInfo) ? raw.playerInfo : null
  if (pi) {
    if (Number.isFinite(Number(pi.level))) out.level = Number(pi.level)
    if (Number.isFinite(Number(pi.worldLevel))) out.worldLevel = Number(pi.worldLevel)
  }
  // Some local datasets use different top-level fields (no enka playerInfo).
  if (!("level" in out) && raw && raw.level !== undefined) {
    const n = Number(raw.level)
    if (Number.isFinite(n)) out.level = n
  }
  return out
}

function buildDetailSig(detail) {
  try {
    if (!detail || typeof detail !== "object") return ""
    const d = detail
    const fn = typeof d.dmg === "function" ? String(d.dmg) : ""

    const kind = (() => {
      if (/\breaction\s*\(/.test(fn) || /\.reaction\s*\(/.test(fn)) return "reaction"
      if (/\{\s*heal\s*\}/.test(fn) || /\bheal\s*\(/.test(fn)) return "heal"
      if (/\{\s*shield\s*\}/.test(fn) || /\bshield\s*\(/.test(fn)) return "shield"
      return "dmg"
    })()

    const dmgKeyProp = typeof d.dmgKey === "string" ? d.dmgKey.trim() : ""
    const keyFromFn = (() => {
      const m = /\bdmg(?:\.basic)?\s*\([^)]*?,\s*['"]([^'"]+)['"]/.exec(fn)
      return m?.[1]?.trim() || ""
    })()
    const key = dmgKeyProp || keyFromFn

    const eleFromFn = (() => {
      const m = /\bdmg(?:\.basic)?\s*\([^)]*?,\s*['"][^'"]+['"]\s*,\s*['"]([^'"]+)['"]/.exec(fn)
      return m?.[1]?.trim() || ""
    })()

    const paramsPart = (() => {
      const p = d.params
      if (!p || typeof p !== "object" || Array.isArray(p)) return ""
      const keys = Object.keys(p).filter(Boolean).sort()
      if (!keys.length) return ""
      const parts = []
      for (const k of keys) {
        const v = p[k]
        if (typeof v === "number" && Number.isFinite(v)) parts.push(`${k}=${v}`)
        else if (typeof v === "boolean") parts.push(`${k}=${v ? 1 : 0}`)
        else if (typeof v === "string" && v.trim()) parts.push(`${k}=${v.trim()}`)
        else if (v == null) parts.push(`${k}=null`)
      }
      return parts.join(",")
    })()

    const dmgCalls = (fn.match(/\bdmg(?:\.basic)?\s*\(/g) || []).length
    const hitMul = (() => {
      let max = 0
      const re = /\b(?:avg|dmg)\s*:\s*[^,}]*?\*\s*([0-9]+)\b/g
      for (const m of fn.matchAll(re)) {
        const n = Number(m?.[1])
        if (Number.isFinite(n) && n > max) max = n
      }
      return max > 1 ? String(max) : ""
    })()

    const tables = []
    const re = /\btalent\s*\.\s*([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(['"])(.*?)\2\s*\]/g
    for (const m of fn.matchAll(re)) {
      const tk = String(m[1] || "").trim()
      const tn = String(m[3] || "").trim()
      if (!tk || !tn) continue
      tables.push(`${tk}:${tn}`)
      if (tables.length >= 6) break
    }
    const uniq = Array.from(new Set(tables)).sort()
    const tablePart = uniq.join("+")

    // Keep sig stable across different auto-generated wrappers:
    // - Do NOT include dmgCalls/hitMul (they vary with code shape but often represent same semantic row).
    return [kind, key || "", eleFromFn || "", tablePart || "", paramsPart || ""].join("|")
  } catch {
    return ""
  }
}

function normTitleKey(s) {
  let t = String(s || "").trim()
  if (!t) return ""
  t = t.replace(/\s+/g, "")
  t = t.replace(/[·•･・…?？、，,。．：:；;!！"'“”‘’()（）【】\[\]{}《》〈〉<>「」『』]/g, "")
  t = t.replace(/[=+~`^|\\]/g, "")
  t = t.replace(/[-_—–]/g, "")
  return t
}

function expandCalcDetails(detailsRaw, meta) {
  const out = []
  const metaSafe = meta && typeof meta === "object" ? meta : {}

  for (const d0 of detailsRaw || []) {
    if (!d0) continue
    if (typeof d0 === "function") {
      try {
        const v = d0(metaSafe)
        if (Array.isArray(v)) {
          for (const x of v) if (x && typeof x === "object") out.push(x)
        } else if (v && typeof v === "object") {
          out.push(v)
        }
      } catch {}
      continue
    }
    if (typeof d0 === "object") out.push(d0)
  }

  return out
}

function attachRetSig(dmgProfile, charCalcData, meta) {
  try {
    if (!dmgProfile || typeof dmgProfile !== "object") return dmgProfile
    const ret = Array.isArray(dmgProfile.ret) ? dmgProfile.ret : null
    if (!ret) return dmgProfile

    const detailsRaw = Array.isArray(charCalcData?.details) ? charCalcData.details : []
    if (!detailsRaw.length) return dmgProfile

    // IMPORTANT: miao-plugin filters out details whose `check` fails (cons/tree/params...),
    // so `dmgProfile.ret` is not index-aligned with exported `details`.
    // Bind signatures by (normalized) title instead of index to avoid massive mismatches.
    const details = expandCalcDetails(detailsRaw, meta)
    if (!details.length) return dmgProfile

    const byTitle = new Map()
    const byNorm = new Map()
    for (const d of details) {
      const title = String(d?.title || "").trim()
      if (!title) continue
      const sig = buildDetailSig(d)
      if (!sig) continue

      const list = byTitle.get(title) || []
      list.push(sig)
      byTitle.set(title, list)

      const nk = normTitleKey(title)
      if (nk) {
        const list2 = byNorm.get(nk) || []
        list2.push(sig)
        byNorm.set(nk, list2)
      }
    }

    const retEx = ret.map((r) => {
      const title = String(r?.title || "").trim()
      let sig = ""
      if (title) {
        const list = byTitle.get(title)
        if (list && list.length) sig = list.shift() || ""
      }
      if (!sig && title) {
        const nk = normTitleKey(title)
        const list2 = nk ? byNorm.get(nk) : null
        if (list2 && list2.length) sig = list2.shift() || ""
      }
      return { ...(r || {}), sig }
    })
    return { ...dmgProfile, retEx }
  } catch {
    return dmgProfile
  }
}

const calcModuleCache = new Map()
async function tryImportCalcModule(calcPathAbs) {
  try {
    const p = String(calcPathAbs || "").trim()
    if (!p) return null
    if (calcModuleCache.has(p)) return calcModuleCache.get(p)
    if (!fs.existsSync(p)) {
      calcModuleCache.set(p, null)
      return null
    }
    const u = pathToFileURL(p)
    // Cache-bust by mtime to reflect regenerated calc.js during the same process.
    const mtimeMs = Number(fs.statSync(p)?.mtimeMs || 0)
    const mod = await import(`${u.href}?t=${mtimeMs}`)
    calcModuleCache.set(p, mod)
    return mod
  } catch {
    return null
  }
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")

  const game = (process.env.CIRCALTEST_GAME || "gs").trim()
  const enemyLv = Number(process.env.CIRCALTEST_ENEMY_LV || 103)

  // Let the sandboxed miao-plugin know it's running under circaltest (avoid installMeta side-effects).
  process.env.CIRCALTEST_SANDBOX = process.env.CIRCALTEST_SANDBOX || "1"

  console.log(`[circaltest] panel-worker start: game=${game} enemyLv=${enemyLv}`)

  const rawJsonPath = toAbsPath(repoRoot, process.env.CIRCALTEST_RAW_JSON)
  const outFilePath = toAbsPath(repoRoot, process.env.CIRCALTEST_OUT_FILE)
  const metaRoot = toAbsPath(repoRoot, process.env.CIRCALTEST_META_ROOT)
  const tag = (process.env.CIRCALTEST_TAG || "").trim()

  if (!rawJsonPath || !fs.existsSync(rawJsonPath)) {
    throw new Error(`[circaltest] panel-worker missing raw json: ${rawJsonPath}`)
  }
  if (!outFilePath) throw new Error("[circaltest] panel-worker missing out file path")
  if (!metaRoot || !fs.existsSync(metaRoot)) {
    throw new Error(`[circaltest] panel-worker missing meta root: ${metaRoot}`)
  }

  // Strict isolation: only operate under circaltest/.sandbox (no production env touch).
  const sandboxYunzaiRoot = path.join(repoRoot, "circaltest", ".sandbox", "yunzai")
  const sandboxMiaoRoot = path.join(sandboxYunzaiRoot, "plugins", "miao-plugin")
  const sandboxMetaGs = path.join(sandboxMiaoRoot, "resources", "meta-gs")
  const sandboxMetaSr = path.join(sandboxMiaoRoot, "resources", "meta-sr")

  // Minimal yunzai root marker for miao-plugin (some modules read package.json from cwd).
  const sandboxPkgJson = path.join(sandboxYunzaiRoot, "package.json")
  writeJsonIfMissing(sandboxPkgJson, { name: "yunzai-bot", version: "3.0.0", private: true, type: "module" })

  // Run miao-plugin with a yunzai-like cwd so installMeta.js checks do not accidentally
  // target the metaGenerator repo root.
  process.chdir(sandboxYunzaiRoot)

  // Minimal globals required by miao-plugin modules (avoid crashing on logger/redis).
  // Note: miao-plugin uses these globals in many places; for regression we only need noop behavior.
  globalThis.logger = globalThis.logger || {
    info: console.log,
    mark: console.log,
    warn: console.warn,
    error: console.error,
    debug: console.debug,
    trace: console.trace,
    green: (s) => s,
    yellow: (s) => s
  }
  globalThis.redis = globalThis.redis || {
    get: async () => null,
    set: async () => null,
    del: async () => null
  }

  // miao-plugin SR meta depends on GS meta (e.g. wifeCfg shared into GS buckets).
  // Always provide both meta-gs and meta-sr links in the sandbox.
  const metaRootGs =
    game === "gs"
      ? metaRoot
      : toAbsPath(repoRoot, process.env.CIRCALTEST_META_ROOT_GS || path.join("temp", "metaBaselineRef", "meta-gs"))
  const metaRootSr =
    game === "sr"
      ? metaRoot
      : toAbsPath(repoRoot, process.env.CIRCALTEST_META_ROOT_SR || path.join("temp", "metaBaselineRef", "meta-sr"))

  if (!metaRootGs || !fs.existsSync(metaRootGs)) {
    throw new Error(`[circaltest] panel-worker missing meta-gs root (set CIRCALTEST_META_ROOT_GS): ${metaRootGs}`)
  }
  if (!metaRootSr || !fs.existsSync(metaRootSr)) {
    throw new Error(`[circaltest] panel-worker missing meta-sr root (set CIRCALTEST_META_ROOT_SR): ${metaRootSr}`)
  }

  rmPath(sandboxMetaGs)
  ensureDir(path.dirname(sandboxMetaGs))
  fs.symlinkSync(metaRootGs, sandboxMetaGs, "junction")
  console.log(`[circaltest] panel-worker meta link: ${sandboxMetaGs} -> ${metaRootGs}`)

  rmPath(sandboxMetaSr)
  ensureDir(path.dirname(sandboxMetaSr))
  fs.symlinkSync(metaRootSr, sandboxMetaSr, "junction")
  console.log(`[circaltest] panel-worker meta link: ${sandboxMetaSr} -> ${metaRootSr}`)

  const raw = JSON.parse(fs.readFileSync(rawJsonPath, "utf8"))
  const rawKind = detectRawKind(raw)
  const uid = String(raw?.playerInfo?.uid || raw?.uid || process.env.CIRCALTEST_UID || "").trim()
  if (uid === "100000000") {
    throw new Error("[circaltest] forbidden uid=100000000 (do not use this uid for regression tests)")
  }

  const importFromMiao = (rel) => import(pathToFileURL(path.join(sandboxMiaoRoot, rel)).href)

  // Mark resources as "installed" for modules that wait on installPromise().
  try {
    const { installMeta } = await importFromMiao("installMeta.js")
    if (typeof installMeta === "function") {
      await installMeta()
    }
  } catch (e) {
    throw new Error(`[circaltest] installMeta bootstrap failed: ${e instanceof Error ? e.message : String(e)}`)
  }

  // Dynamic import AFTER globals + meta link are ready.
  console.log(`[circaltest] panel-worker importing miao-plugin modules...`)
  console.log(`[circaltest] panel-worker import: models/index.js`)
  const models = await importFromMiao("models/index.js")
  if (typeof models.initMeta !== "function") {
    throw new Error("[circaltest] miao-plugin models/index.js missing export: initMeta")
  }
  const initGames = game === "sr" ? ["gs", "sr"] : [game]
  console.log(`[circaltest] panel-worker initMeta (games=${initGames.join(",")})...`)
  await models.initMeta({ games: initGames, types: ["artifact", "character", "weapon"] })
  console.log(`[circaltest] panel-worker initMeta done`)
  const { Avatar, ProfileDmg, Character, Weapon, Artifact } = models
  if (!Avatar || !ProfileDmg || !Character || !Weapon || !Artifact) {
    throw new Error("[circaltest] miao-plugin models/index.js missing expected exports")
  }
  const DmgAttrMod = await importFromMiao("models/dmg/DmgAttr.js")
  const DmgAttr = DmgAttrMod?.default || DmgAttrMod
  if (!DmgAttr || typeof DmgAttr.getAttr !== "function" || typeof DmgAttr.calcAttr !== "function") {
    throw new Error("[circaltest] miao-plugin DmgAttr import failed")
  }
  console.log(`[circaltest] panel-worker imports ready`)

  const errors = []

  const avatars = []

  // Support two raw formats:
  // - enka.network raw (`avatarInfoList`)
  // - local profile JSON dataset (`avatars`), which is basically miao-plugin Avatar.toJSON() output.
  const avatarInfoList = rawKind === "enka" ? raw?.avatarInfoList || [] : []
  const profileAvatarList =
    rawKind === "profile-json" && isRecord(raw.avatars) ? Object.values(raw.avatars) : []

  const iterList = rawKind === "profile-json" ? profileAvatarList : avatarInfoList

  for (const ds of iterList) {
    try {
      if (rawKind === "profile-json") {
        if (!isRecord(ds)) {
          avatars.push({ id: 0, error: "invalid profile-json avatar ds (non-object)" })
          continue
        }
        const avatarDs = { ...ds }
        // Ensure uid is present for downstream consumers.
        avatarDs.uid = uid
        // Ensure the dataset is treated as a valid panel/profile snapshot by miao-plugin.
        avatarDs._source = normalizeProfileSource(game, avatarDs._source)
        // Some datasets store id as string keys under `avatars`, normalize to number.
        if (avatarDs.id !== undefined) avatarDs.id = Number(avatarDs.id)

        const avatar = new Avatar(avatarDs, game)
        if (!avatar) {
          avatars.push({ id: avatarDs.id || 0, name: avatarDs.name || "", error: "Avatar ctor returned falsy" })
          continue
        }
        avatar.uid = uid

        const hasProfile = !!avatar.isProfile
        const hasDmg = !!avatar.hasDmg

        const attrSummary = (() => {
          const a = avatar.attr || {}
          const pick = (k) => {
            const v = a?.[k]
            return typeof v === "number" && Number.isFinite(v) ? v : v ?? null
          }
          return {
            atk: pick("atk"),
            atkBase: pick("atkBase"),
            hp: pick("hp"),
            hpBase: pick("hpBase"),
            def: pick("def"),
            defBase: pick("defBase"),
            speed: pick("speed"),
            recharge: pick("recharge"),
            cpct: pick("cpct"),
            cdmg: pick("cdmg"),
            dmg: pick("dmg"),
            enemydmg: pick("enemydmg"),
            effPct: pick("effPct"),
            effDef: pick("effDef"),
            stance: pick("stance")
          }
        })()

        let dmgProfile = null
        let dmgSingle = null
        let dmgError = null
        if (hasProfile && hasDmg) {
          try {
            dmgSingle = await avatar.calcDmg({ enemyLv, mode: "single" })
            dmgProfile = await avatar.calcDmg({ enemyLv, mode: "profile" })
          } catch (e) {
            dmgError = e instanceof Error ? (e.stack || e.message) : String(e)
          }
        }

        // calc.js evidence: which file was actually loaded + hash
        let calcPath = ""
        let calcSha256 = ""
        try {
          let ruleName = avatar.char?.name
          if ([10000005, 10000007, 20000000].includes(Number(avatar.char?.id))) {
            ruleName = `旅行者/${avatar.elem}`
          }
          const calc = ProfileDmg.dmgRulePath(ruleName, game)
          if (calc?.path && fs.existsSync(calc.path)) {
            calcPath = calc.path
            calcSha256 = sha256File(calc.path)
          }
        } catch {}

        let dmgCtx = null
        let talentSample = null
        let talentLv = null
        let talentTableLen = null
        if (hasProfile && hasDmg && !dmgError) {
          try {
            const pd = avatar.dmg
            if (pd && typeof pd.getCalcRule === "function") {
              const charCalcData0 = await pd.getCalcRule()
              let charCalcData = charCalcData0
            if (!Array.isArray(charCalcData?.details) || charCalcData.details.length === 0) {
              const imported = await tryImportCalcModule(calcPath)
              if (imported) charCalcData = imported
            }
              talentLv = pd.profile?.talent || null
              const detail = pd.char?.detail || {}
              const maxTableLen = (tk) => {
                const tables = detail?.talent?.[tk]?.tables
                const list = Array.isArray(tables) ? tables : Object.values(tables || {})
                let max = 0
                for (const ds of list) {
                  const len = Array.isArray(ds?.values) ? ds.values.length : 0
                  if (len > max) max = len
                }
                return max || null
              }
              talentTableLen = {
                a: maxTableLen("a"),
                e: maxTableLen("e"),
                q: maxTableLen("q"),
                t: maxTableLen("t")
              }
              const talentPlan = pd.talent()
              const meta = {
                charId: pd.char?.id,
                uid: pd.profile?.uid,
                level: pd.profile?.level,
                cons: (pd.profile?.cons || 0) * 1,
                talent: talentPlan,
                trees: pd.trees(),
                weapon: pd.profile?.weapon,
                elem: avatar.elem,
                element: avatar.elem
              }
              dmgProfile = attachRetSig(dmgProfile, charCalcData, meta)
              let defParams = charCalcData?.defParams || {}
              defParams = typeof defParams === "function" ? defParams(meta) : defParams || {}
              const originalAttr = DmgAttr.getAttr({
                originalAttr: null,
                id: pd.profile?.id,
                weapon: pd.profile?.weapon,
                attr: pd.profile?.attr,
                char: pd.char,
                game
              })
              const buffsAll = pd.getBuffs(charCalcData?.buffs || [])
              const { attr } = DmgAttr.calcAttr({
                originalAttr,
                buffs: buffsAll,
                meta,
                artis: pd.profile?.artis,
                params: defParams,
                game
              })
              const sampleMap = (m) => {
                const out = {}
                for (const [k, v] of Object.entries(m || {})) {
                  out[k] = v === undefined ? null : v
                  if (Object.keys(out).length >= 8) break
                }
                return out
              }
              talentSample = {
                a: sampleMap(talentPlan?.a),
                e: sampleMap(talentPlan?.e),
                q: sampleMap(talentPlan?.q),
                t: sampleMap(talentPlan?.t)
              }
              const pickNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : v ?? null)
              dmgCtx = {
                kx: pickNum(attr?.kx),
                enemy: {
                  def: pickNum(attr?.enemy?.def),
                  ignore: pickNum(attr?.enemy?.ignore)
                },
                a: {
                  pct: pickNum(attr?.a?.pct),
                  plus: pickNum(attr?.a?.plus),
                  dmg: pickNum(attr?.a?.dmg),
                  enemydmg: pickNum(attr?.a?.enemydmg),
                  cpct: pickNum(attr?.a?.cpct),
                  cdmg: pickNum(attr?.a?.cdmg)
                },
                e: {
                  pct: pickNum(attr?.e?.pct),
                  plus: pickNum(attr?.e?.plus),
                  dmg: pickNum(attr?.e?.dmg),
                  enemydmg: pickNum(attr?.e?.enemydmg),
                  cpct: pickNum(attr?.e?.cpct),
                  cdmg: pickNum(attr?.e?.cdmg)
                },
                q: {
                  pct: pickNum(attr?.q?.pct),
                  plus: pickNum(attr?.q?.plus),
                  dmg: pickNum(attr?.q?.dmg),
                  enemydmg: pickNum(attr?.q?.enemydmg),
                  cpct: pickNum(attr?.q?.cpct),
                  cdmg: pickNum(attr?.q?.cdmg)
                },
                t: {
                  pct: pickNum(attr?.t?.pct),
                  plus: pickNum(attr?.t?.plus),
                  dmg: pickNum(attr?.t?.dmg),
                  enemydmg: pickNum(attr?.t?.enemydmg),
                  cpct: pickNum(attr?.t?.cpct),
                  cdmg: pickNum(attr?.t?.cdmg)
                }
              }
            }
          } catch (e) {
            dmgCtx = { error: e instanceof Error ? (e.stack || e.message) : String(e) }
          }
        }

        avatars.push({
          id: avatar.id,
          name: avatar.name,
          elem: avatar.elem,
          level: avatar.level,
          cons: avatar.cons,
          promote: avatar.promote,
          fetter: avatar.fetter,
          weapon: avatar.weapon,
          artisSet: avatar.artisSet,
          talent: avatar.originalTalent,
          attr: attrSummary,
          talentLv,
          talentTableLen,
          talentSample,
          dmgCtx,
          hasProfile,
          hasDmg,
          calc: calcPath ? { path: calcPath, sha256: calcSha256 } : null,
          dmg: dmgError
            ? { error: dmgError }
            : {
                enemyLv,
                single: dmgSingle,
                profile: dmgProfile
              }
        })
        continue
      }

      // enka raw path
      const char = Character.get(ds.avatarId, game)
      if (!char) {
        avatars.push({
          id: ds.avatarId,
          error: "Character.get returned falsy"
        })
        continue
      }

      // Enka fields are consistent with miao-plugin's EnkaData implementation.
      const promote = Number(ds?.propMap?.["1002"]?.val || 0)
      const level = Number(ds?.propMap?.["4001"]?.val || 1)
      const cons = Array.isArray(ds?.talentIdList) ? ds.talentIdList.length : 0
      const fetter = Number(ds?.fetterInfo?.expLevel || 0)

      // Weapon
      let weaponItem = null
      for (const eq of ds?.equipList || []) {
        if (eq?.flat?.itemType === "ITEM_WEAPON") {
          weaponItem = eq
          break
        }
      }
      const weapon = weaponItem?.weapon
      const weaponMeta = weaponItem?.itemId ? Weapon.get(weaponItem.itemId, game) : null
      const weaponDs = weapon
        ? {
            name: weaponMeta?.name || "",
            level: Number(weapon.level || 1),
            promote: Number(weapon.promoteLevel || 0),
            affix: (Object.values(weapon.affixMap || {})[0] || 0) + 1
          }
        : {}

      // Artifacts
      const artisIdxMap = {
        EQUIP_BRACER: 1,
        EQUIP_NECKLACE: 2,
        EQUIP_SHOES: 3,
        EQUIP_RING: 4,
        EQUIP_DRESS: 5,
        // Some CN clients use translated equipType strings.
        "生之花": 1,
        "死之羽": 2,
        "时之沙": 3,
        "空之杯": 4,
        "理之冠": 5
      }
      const artis = {}
      for (const eq of ds?.equipList || []) {
        const flat = eq?.flat || {}
        const re = eq?.reliquary
        const idx = artisIdxMap[flat.equipType]
        if (!idx || !re) continue
        const artiMeta = eq?.itemId ? Artifact.get(eq.itemId, game) : null
        if (!artiMeta) continue
        artis[idx] = {
          level: Math.min(20, Number((re.level || 0) - 1)),
          name: artiMeta.name,
          star: Number(flat.rankLevel || 5),
          mainId: re.mainPropId,
          attrIds: re.appendPropIdList || []
        }
      }

      // Talents
      const { talentId = {}, talentElem = {} } = char.meta || {}
      let elem = ""
      let idx = 0
      const talent = {}
      for (const [id, lv] of Object.entries(ds?.skillLevelMap || {})) {
        if (talentId[id]) {
          const k = talentId[id]
          elem = elem || talentElem[id]
          talent[k] = Number(lv)
        } else {
          const k = ["a", "e", "q"][idx++]
          if (!talent[k]) talent[k] = Number(lv)
        }
      }

      const avatarDs = {
        uid,
        id: Number(ds.avatarId),
        level,
        fetter,
        promote,
        cons,
        weapon: weaponDs,
        artis,
        elem: elem || char.elem,
        talent,
        _source: "enka",
        _time: Date.now()
      }

      const avatar = new Avatar(avatarDs, game)
      if (!avatar) {
        avatars.push({ id: ds.avatarId, name: char.name, error: "Avatar ctor returned falsy" })
        continue
      }

      // Ensure uid is present for downstream consumers.
      avatar.uid = uid

      const hasProfile = !!avatar.isProfile
      const hasDmg = !!avatar.hasDmg

      const attrSummary = (() => {
        const a = avatar.attr || {}
        const pick = (k) => {
          const v = a?.[k]
          return typeof v === "number" && Number.isFinite(v) ? v : v ?? null
        }
        return {
          atk: pick("atk"),
          atkBase: pick("atkBase"),
          hp: pick("hp"),
          hpBase: pick("hpBase"),
          def: pick("def"),
          defBase: pick("defBase"),
          speed: pick("speed"),
          recharge: pick("recharge"),
          cpct: pick("cpct"),
          cdmg: pick("cdmg"),
          dmg: pick("dmg"),
          enemydmg: pick("enemydmg"),
          effPct: pick("effPct"),
          effDef: pick("effDef"),
          stance: pick("stance")
        }
      })()

      let dmgProfile = null
      let dmgSingle = null
      let dmgError = null
      if (hasProfile && hasDmg) {
        try {
          dmgSingle = await avatar.calcDmg({ enemyLv, mode: "single" })
          dmgProfile = await avatar.calcDmg({ enemyLv, mode: "profile" })
        } catch (e) {
          dmgError = e instanceof Error ? (e.stack || e.message) : String(e)
        }
      }

      // calc.js evidence: which file was actually loaded + hash
      let calcPath = ""
      let calcSha256 = ""
      try {
        let ruleName = avatar.char?.name
        if ([10000005, 10000007, 20000000].includes(Number(avatar.char?.id))) {
          ruleName = `旅行者/${avatar.elem}`
        }
        const calc = ProfileDmg.dmgRulePath(ruleName, game)
        if (calc?.path && fs.existsSync(calc.path)) {
          calcPath = calc.path
          calcSha256 = sha256File(calc.path)
        }
      } catch {}

      let dmgCtx = null
      let talentSample = null
      let talentLv = null
      let talentTableLen = null
      if (hasProfile && hasDmg && !dmgError) {
        try {
          const pd = avatar.dmg
          if (pd && typeof pd.getCalcRule === "function") {
            const charCalcData0 = await pd.getCalcRule()
            let charCalcData = charCalcData0
            if (!Array.isArray(charCalcData?.details) || charCalcData.details.length === 0) {
              const imported = await tryImportCalcModule(calcPath)
              if (imported) charCalcData = imported
            }
            talentLv = pd.profile?.talent || null
            const detail = pd.char?.detail || {}
            const maxTableLen = (tk) => {
              const tables = detail?.talent?.[tk]?.tables
              const list = Array.isArray(tables) ? tables : Object.values(tables || {})
              let max = 0
              for (const ds of list) {
                const len = Array.isArray(ds?.values) ? ds.values.length : 0
                if (len > max) max = len
              }
              return max || null
            }
            talentTableLen = {
              a: maxTableLen("a"),
              e: maxTableLen("e"),
              q: maxTableLen("q"),
              t: maxTableLen("t")
            }
            const talentPlan = pd.talent()
            const meta = {
              charId: pd.char?.id,
              uid: pd.profile?.uid,
              level: pd.profile?.level,
              cons: (pd.profile?.cons || 0) * 1,
              talent: talentPlan,
              trees: pd.trees(),
              weapon: pd.profile?.weapon,
              elem: avatar.elem,
              element: avatar.elem
            }
            dmgProfile = attachRetSig(dmgProfile, charCalcData, meta)
            let defParams = charCalcData?.defParams || {}
            defParams = typeof defParams === "function" ? defParams(meta) : defParams || {}
            const originalAttr = DmgAttr.getAttr({
              originalAttr: null,
              id: pd.profile?.id,
              weapon: pd.profile?.weapon,
              attr: pd.profile?.attr,
              char: pd.char,
              game
            })
            const buffsAll = pd.getBuffs(charCalcData?.buffs || [])
            const { attr } = DmgAttr.calcAttr({
              originalAttr,
              buffs: buffsAll,
              meta,
              artis: pd.profile?.artis,
              params: defParams,
              game
            })
            const sampleMap = (m) => {
              const out = {}
              for (const [k, v] of Object.entries(m || {})) {
                out[k] = v === undefined ? null : v
                if (Object.keys(out).length >= 8) break
              }
              return out
            }
            talentSample = {
              a: sampleMap(talentPlan?.a),
              e: sampleMap(talentPlan?.e),
              q: sampleMap(talentPlan?.q),
              t: sampleMap(talentPlan?.t)
            }
            const pickNum = (v) => (typeof v === "number" && Number.isFinite(v) ? v : v ?? null)
            dmgCtx = {
              kx: pickNum(attr?.kx),
              enemy: {
                def: pickNum(attr?.enemy?.def),
                ignore: pickNum(attr?.enemy?.ignore)
              },
              a: {
                pct: pickNum(attr?.a?.pct),
                plus: pickNum(attr?.a?.plus),
                dmg: pickNum(attr?.a?.dmg),
                enemydmg: pickNum(attr?.a?.enemydmg),
                cpct: pickNum(attr?.a?.cpct),
                cdmg: pickNum(attr?.a?.cdmg)
              },
              e: {
                pct: pickNum(attr?.e?.pct),
                plus: pickNum(attr?.e?.plus),
                dmg: pickNum(attr?.e?.dmg),
                enemydmg: pickNum(attr?.e?.enemydmg),
                cpct: pickNum(attr?.e?.cpct),
                cdmg: pickNum(attr?.e?.cdmg)
              },
              q: {
                pct: pickNum(attr?.q?.pct),
                plus: pickNum(attr?.q?.plus),
                dmg: pickNum(attr?.q?.dmg),
                enemydmg: pickNum(attr?.q?.enemydmg),
                cpct: pickNum(attr?.q?.cpct),
                cdmg: pickNum(attr?.q?.cdmg)
              },
              t: {
                pct: pickNum(attr?.t?.pct),
                plus: pickNum(attr?.t?.plus),
                dmg: pickNum(attr?.t?.dmg),
                enemydmg: pickNum(attr?.t?.enemydmg),
                cpct: pickNum(attr?.t?.cpct),
                cdmg: pickNum(attr?.t?.cdmg)
              }
            }
          }
        } catch (e) {
          dmgCtx = { error: e instanceof Error ? (e.stack || e.message) : String(e) }
        }
      }

      avatars.push({
        id: avatar.id,
        name: avatar.name,
        elem: avatar.elem,
        level: avatar.level,
        cons: avatar.cons,
        promote: avatar.promote,
        fetter: avatar.fetter,
        weapon: avatar.weapon,
        artisSet: avatar.artisSet,
        talent: avatar.originalTalent,
        attr: attrSummary,
        talentLv,
        talentTableLen,
        talentSample,
        dmgCtx,
        hasProfile,
        hasDmg,
        calc: calcPath ? { path: calcPath, sha256: calcSha256 } : null,
        dmg: dmgError
          ? { error: dmgError }
          : {
              enemyLv,
              single: dmgSingle,
              profile: dmgProfile
            }
      })
    } catch (e) {
      errors.push(e instanceof Error ? (e.stack || e.message) : String(e))
    }
  }

  const out = {
    tag,
    game,
    uid,
    enemyLv,
    metaRoot,
    raw: {
      kind: rawKind,
      path: path.relative(repoRoot, rawJsonPath),
      sha256: sha256File(rawJsonPath)
    },
    sandbox: {
      yunzaiRoot: sandboxYunzaiRoot,
      miaoRoot: sandboxMiaoRoot,
      metaGs: sandboxMetaGs,
      metaSr: sandboxMetaSr
    },
    fetchedAt: new Date().toISOString(),
    playerInfo: sanitizePlayerInfo(raw, uid),
    errors,
    avatars
  }

  ensureDir(path.dirname(outFilePath))
  fs.writeFileSync(outFilePath, JSON.stringify(out, null, 2))
  console.log(`[circaltest] panel-worker wrote: ${path.relative(repoRoot, outFilePath)} (${game}${tag ? `/${tag}` : ""})`)
}

main()
  .then(() => {
    // miao-plugin's Cfg uses chokidar watchers; hard-exit to avoid hanging the process.
    process.exit(0)
  })
  .catch((e) => {
    console.error(e instanceof Error ? e.stack || e.message : String(e))
    process.exit(1)
  })
