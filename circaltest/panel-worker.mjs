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
  const sandboxMetaLink = path.join(sandboxMiaoRoot, "resources", `meta-${game}`)
  const sandboxMetaLinkSr = path.join(sandboxMiaoRoot, "resources", "meta-sr")

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

  // Point sandbox miao-plugin to the requested meta root.
  rmPath(sandboxMetaLink)
  ensureDir(path.dirname(sandboxMetaLink))
  fs.symlinkSync(metaRoot, sandboxMetaLink, "junction")
  console.log(`[circaltest] panel-worker meta link: ${sandboxMetaLink} -> ${metaRoot}`)

  // Ensure meta-sr exists too, otherwise miao-plugin's installMeta/installPromise will hang or try to clone.
  const metaRootSr = toAbsPath(repoRoot, process.env.CIRCALTEST_META_ROOT_SR || path.join("temp", "metaBaselineRef", "meta-sr"))
  if (!fs.existsSync(metaRootSr)) {
    throw new Error(`[circaltest] panel-worker missing meta-sr root (set CIRCALTEST_META_ROOT_SR): ${metaRootSr}`)
  }
  rmPath(sandboxMetaLinkSr)
  ensureDir(path.dirname(sandboxMetaLinkSr))
  fs.symlinkSync(metaRootSr, sandboxMetaLinkSr, "junction")
  console.log(`[circaltest] panel-worker meta link: ${sandboxMetaLinkSr} -> ${metaRootSr}`)

  const raw = JSON.parse(fs.readFileSync(rawJsonPath, "utf8"))
  const uid = String(raw?.playerInfo?.uid || raw?.uid || process.env.CIRCALTEST_UID || "")

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
  console.log(`[circaltest] panel-worker initMeta (game=${game})...`)
  await models.initMeta({ games: [game], types: ["artifact", "character", "weapon"] })
  console.log(`[circaltest] panel-worker initMeta done`)
  const { Avatar, ProfileDmg, Character, Weapon, Artifact } = models
  if (!Avatar || !ProfileDmg || !Character || !Weapon || !Artifact) {
    throw new Error("[circaltest] miao-plugin models/index.js missing expected exports")
  }
  console.log(`[circaltest] panel-worker imports ready`)

  const avatarInfoList = raw?.avatarInfoList || []
  const errors = []

  const avatars = []
  for (const ds of avatarInfoList) {
    try {
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
    sandbox: {
      yunzaiRoot: sandboxYunzaiRoot,
      miaoRoot: sandboxMiaoRoot,
      metaLink: sandboxMetaLink
    },
    fetchedAt: new Date().toISOString(),
    playerInfo: raw?.playerInfo || null,
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
