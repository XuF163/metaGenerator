import type { CalcSuggestInput } from './types.js'
import { normalizeTableList } from './utils.js'

export function validateCalcJsText(js: string): void {
  // Validate that the generated calc.js:
  // - is syntactically valid
  // - does not reference undefined vars at module top-level (e.g. `params.xxx`)
  //
  // We intentionally avoid importing from disk to keep this fast and deterministic.
  // `calc.js` uses only `export const ...` so we can strip ESM exports for evaluation.
  const body = js.replace(/^\s*export\s+const\s+/gm, 'const ')
  try {
    const fn = new Function(body)
    fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[meta-gen] Generated calc.js is invalid: ${msg}`)
  }
}

export function validateCalcJsRuntime(js: string, input: CalcSuggestInput): void {
  const game = input.game
  // Best-effort runtime validation:
  // - catches ReferenceError inside detail/buff functions (e.g. using `mastery` instead of `attr.mastery`)
  // - avoids importing from disk; evaluates the module body in a local function scope
  const body = js.replace(/^\s*export\s+const\s+/gm, 'const ')

  let mod: any
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${body}\nreturn { details, buffs }`)
    mod = fn()
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`[meta-gen] Generated calc.js runtime extract failed: ${msg}`)
  }

  const mkDeepSample = (primitiveNum = 100): any => {
    const baseFn = function () {
      return primitiveNum
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => primitiveNum
        if (prop === 'valueOf') return () => primitiveNum
        if (prop === 'toString') return () => String(primitiveNum)
        if (prop === 'toJSON') return () => primitiveNum
        return proxy
      },
      apply() {
        return primitiveNum
      }
    }
    proxy = new Proxy(baseFn, handler)
    return proxy
  }

  const mkScalarTalentSample = (primitiveNum = 100): any => {
    // SR talent tables are scalar at runtime; indexing into them like `talent.e["技能伤害"][0]` is almost
    // always a model hallucination that silently turns into 0 damage. Throw early so the generator retries.
    const baseFn = function () {
      return primitiveNum
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => primitiveNum
        if (prop === 'valueOf') return () => primitiveNum
        if (prop === 'toString') return () => String(primitiveNum)
        if (prop === 'toJSON') return () => primitiveNum
        if (typeof prop === 'string' && /^(0|[1-9]\d*)$/.test(prop)) {
          throw new Error(`unexpected numeric index access on scalar talent table value: [${prop}]`)
        }
        return undefined
      },
      apply() {
        return primitiveNum
      }
    }
    proxy = new Proxy(baseFn, handler)
    return proxy
  }

  const mkParamsSample = (): any => {
    // Provide common stack/state params so we can catch unit mistakes like
    // `talent.xxx * params.stacks` without `/100`.
    const base: Record<string, number | boolean> = {
      q: true,
      e: true,
      half: true,
      halfHp: true,
      // Common state toggles used in baseline meta (GS/SR):
      // - lowHp: below-threshold showcase rows / conditional passives
      // - weak: weakness-broken / debuffed state (SR technique / special effects)
      // - shield: shielded state checks (some SR/GS passives)
      lowHp: true,
      weak: true,
      shield: true,
      // Common guard flag for "once per" effects.
      triggered: false,
      // Common baseline naming for low-HP heal buffs (SR).
      tBuff: true,
      stacks: 60,
      stack: 4,
      wish: 60,
      // SR common params used by baseline meta.
      debuffCount: 3,
      tArtisBuffCount: 8,
      Memosprite: true
    }
    let proxy: any
    const handler: ProxyHandler<any> = {
      get(_t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        if (typeof prop === 'string' && prop in base) return (base as any)[prop]
        return 0
      }
    }
    proxy = new Proxy({}, handler)
    return proxy
  }

  const mkAttrItem = (base: number): any => ({
    base,
    plus: 0,
    pct: 0,
    inc: 0,
    toString() {
      const b = Number((this as any).base) || 0
      const p = Number((this as any).plus) || 0
      const pct = Number((this as any).pct) || 0
      return String(b + p + (b * pct) / 100)
    }
  })

  const mkAttrSample = (): any => {
    const base: Record<string, any> = {
      atk: mkAttrItem(2000),
      hp: mkAttrItem(40_000),
      def: mkAttrItem(1000),
      mastery: mkAttrItem(800),
      recharge: mkAttrItem(120),
      heal: mkAttrItem(0),
      shield: mkAttrItem(100),
      cpct: mkAttrItem(50),
      cdmg: mkAttrItem(100),
      dmg: mkAttrItem(0),
      phy: mkAttrItem(0),
      // SR-only buckets (keep to avoid false positives in cross-game prompts/expressions).
      speed: mkAttrItem(100),
      enemydmg: mkAttrItem(0),
      effPct: mkAttrItem(0),
      effDef: mkAttrItem(0),
      stance: mkAttrItem(0)
    }
    const handler: ProxyHandler<any> = {
      get(t, prop) {
        if (prop === Symbol.toPrimitive) return () => 0
        if (prop === 'valueOf') return () => 0
        if (prop === 'toString') return () => '0'
        if (prop === 'toJSON') return () => 0
        if (typeof prop === 'string' && prop in t) return (t as any)[prop]
        return 0
      }
    }
    return new Proxy(base, handler)
  }

  const mkTalentSample = (primitiveNum = 100): any => {
    const out: Record<string, any> = {}
    const allowedTalents = Object.keys(input.tables || {})
      .map((k) => String(k || '').trim())
      .filter(Boolean)
    if (allowedTalents.length === 0) {
      // Fallback: should not happen when caller provides `input.tables` correctly.
      allowedTalents.push(...(game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']))
    }
    const tableSamples = input.tableSamples || {}
    for (const tk of allowedTalents) {
      const names = normalizeTableList((input.tables as any)?.[tk])
      const blk: Record<string, any> = {}
      const sampleMap = (tableSamples as any)?.[tk]
      for (const name of names) {
        const s = sampleMap && typeof sampleMap === 'object' ? (sampleMap as any)[name] : undefined
        if (Array.isArray(s)) {
          blk[name] = s.map(() => primitiveNum)
        } else if (s && typeof s === 'object') {
          // Keep it numeric-only to avoid hiding type errors; most calc.js expects scalar/array.
          const obj: Record<string, any> = {}
          for (const [k, v] of Object.entries(s as any)) {
            if (typeof v === 'number' && Number.isFinite(v)) obj[k] = v
            else if (Array.isArray(v)) obj[k] = v.map(() => primitiveNum)
          }
          blk[name] = Object.keys(obj).length ? obj : primitiveNum
        } else {
          blk[name] = game === 'sr' ? mkScalarTalentSample(primitiveNum) : primitiveNum
        }
      }
      out[tk] = blk
    }
    return out
  }

  const mkWeaponSample = (): any => ({
    name: input.weapon || '武器',
    star: typeof input.star === 'number' && Number.isFinite(input.star) ? input.star : 5,
    affix: 1,
    type: input.weapon || ''
  })

  const mkTreesSample = (): any => ({})

  // Use a moderate sample for buff validation: too-large samples can false-positive on valid expressions like
  // `talent.xxx * talent.yyy` (e.g. per-energy coefficient * energy cost).
  // A smaller primitive sample catches common LLM mistakes like `x - 100` when x is actually a small percent per stack/energy.
  const P = mkParamsSample()
  const A = mkAttrSample()
  const mkCtx = (primitiveNum = 100): any => ({
    talent: mkTalentSample(primitiveNum),
    attr: A,
    calc: (ds: any) => {
      if (!ds || typeof ds !== 'object') {
        throw new Error(`calc() expects AttrItem-like object`)
      }
      const b = Number((ds as any).base) || 0
      const p = Number((ds as any).plus) || 0
      const pct = Number((ds as any).pct) || 0
      return b + p + (b * pct) / 100
    },
    params: P,
    cons: 6,
    weapon: mkWeaponSample(),
    trees: mkTreesSample(),
    // Provide a default element so element-gated buffs can be exercised in validation.
    // (GS uses Chinese elem names at runtime; SR uses ids like "shock"/"burn".)
    element: game === 'gs' ? '雷' : 'shock',
    currentTalent: ''
  })
  // SR talent multipliers are mostly ratios (0~2) rather than percent-like numbers. Using 100 here can
  // false-positive on correct multi-hit/multi-target showcase rows (e.g. "×28 忆质" totals). Keep SR
  // smaller while still catching obvious x100 unit explosions.
  const ctx = mkCtx(game === 'sr' ? 10 : 100)

  const gsEleOk = new Set([
    // non-reaction markers
    'phy',
    'scene',
    // amp reactions
    'vaporize',
    'melt',
    '蒸发',
    '融化',
    // transformative / catalyze / lunar
    'crystallize',
    'burning',
    'superConduct',
    'swirl',
    'electroCharged',
    'shatter',
    'overloaded',
    'bloom',
    'burgeon',
    'hyperBloom',
    'aggravate',
    'spread',
    '结晶',
    '燃烧',
    '超导',
    '扩散',
    '感电',
    '碎冰',
    '超载',
    '绽放',
    '烈绽放',
    '超绽放',
    '超激化',
    '蔓激化',
    // lunar
    'lunarCharged',
    'lunarBloom',
    'lunarCrystallize',
    '月感电',
    '月绽放',
    '月结晶'
  ])

  const srEleOk = new Set([
    'shock',
    'burn',
    'windShear',
    'bleed',
    'entanglement',
    // miao-plugin SR DOT damage kind (used as the 3rd arg of dmg(..., "dot", "skillDot"))
    'skillDot',
    'lightningBreak',
    'fireBreak',
    'windBreak',
    'physicalBreak',
    'quantumBreak',
    'imaginaryBreak',
    'iceBreak',
    'superBreak',
    'elation',
    'scene'
  ])

  const validateEle = (ele: unknown): void => {
    if (ele === undefined || ele === null || ele === false) return
    if (typeof ele !== 'string') return
    const t = ele.trim()
    if (!t) {
      throw new Error(`invalid ele arg: empty string`)
    }
    if (t === 'scene' || /(^|,)scene(,|$)/.test(t)) return

    const ok = game === 'sr' ? srEleOk : gsEleOk
    if (!ok.has(t)) {
      throw new Error(`invalid ele arg: ${t}`)
    }
  }

  const toNum = (v: unknown): number => {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }

  // Showcase-scale validation only (not real damage).
  //
  // Notes:
  // - We validate *inputs* to dmg()/dmg.basic()/dmg.dynamic() more strictly to catch unit mistakes early.
  // - SR has more "multi-hit / multi-target / full" showcase rows where the final displayed total can be
  //   large even when each individual hit is reasonable. Allow a looser bound for the final detail return.
  const MAX_SHOWCASE_CALL = 20_000_000
  const MAX_SHOWCASE_DETAIL = game === 'sr' ? 60_000_000 : MAX_SHOWCASE_CALL
  const assertShowcaseNum = (n: unknown, where: string, maxAbs = MAX_SHOWCASE_CALL): void => {
    if (typeof n !== 'number') return
    if (!Number.isFinite(n)) throw new Error(`${where} returned non-finite number`)
    if (Math.abs(n) > maxAbs) {
      throw new Error(`${where} returned unreasonable showcase value: ${n}`)
    }
  }

  const dmgFn: any = function (pctNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    const n = toNum(pctNum)
    assertShowcaseNum(n, 'dmg()')
    return { dmg: n, avg: n }
  }
  dmgFn.basic = function (basicNum = 0, _talent = false, ele = false) {
    validateEle(ele)
    const n = toNum(basicNum)
    assertShowcaseNum(n, 'dmg.basic()')
    return { dmg: n, avg: n }
  }
  dmgFn.dynamic = function (pctNum = 0, _talent = false, _dynamicData = false, ele = false) {
    validateEle(ele)
    const n = toNum(pctNum)
    assertShowcaseNum(n, 'dmg.dynamic()')
    return { dmg: n, avg: n }
  }
  dmgFn.reaction = function (ele = false) {
    validateEle(ele)
    return { dmg: 1000, avg: 1000 }
  }
  dmgFn.swirl = function () {
    validateEle('swirl')
    return { dmg: 1000, avg: 1000 }
  }
  dmgFn.heal = function (n = 0) {
    const v = toNum(n)
    assertShowcaseNum(v, 'dmg.heal()')
    return { avg: v }
  }
  dmgFn.shield = function (n = 0) {
    const v = toNum(n)
    assertShowcaseNum(v, 'dmg.shield()')
    return { avg: v }
  }
  dmgFn.elation = function () {
    return { dmg: 1000, avg: 1000 }
  }

  const talentVariants: string[] = (() => {
    const base = Object.keys(input.tables || {})
      .map((k) => String(k || '').trim())
      .filter(Boolean)
    if (game === 'gs') {
      // `currentTalent` may be used in buffs for distinguishing NA/CA/PA rows.
      const set = new Set(['a', 'a2', 'a3', 'e', 'q', ...base])
      return Array.from(set)
    }
    return base.length ? base : ['a', 'e', 'q', 't']
  })()

  const details = Array.isArray(mod?.details) ? mod.details : []
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (typeof (d as any).dmg !== 'function') continue
    try {
      if (typeof (d as any).check === 'function') {
        const prev = ctx.currentTalent
        for (const ct of talentVariants) {
          ctx.currentTalent = ct
          ;(d as any).check(ctx)
        }
        ctx.currentTalent = prev
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid detail.check(): ${msg}`)
    }
    try {
      const prev = ctx.currentTalent
      const tk = typeof (d as any).talent === 'string' ? String((d as any).talent) : ''
      ctx.currentTalent = tk && talentVariants.includes(tk) ? tk : prev
      const ret = (d as any).dmg(ctx, dmgFn)
      ctx.currentTalent = prev
      if (!ret || typeof ret !== 'object') {
        throw new Error(`detail.dmg() returned non-object (${typeof ret})`)
      }
      // Numeric sanity check (showcase-scale only, not real damage).
      assertShowcaseNum((ret as any).dmg, 'detail.dmg()', MAX_SHOWCASE_DETAIL)
      assertShowcaseNum((ret as any).avg, 'detail.dmg()', MAX_SHOWCASE_DETAIL)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      throw new Error(`[meta-gen] Generated calc.js invalid detail.dmg(): ${msg}`)
    }
  }

  const buffs = Array.isArray(mod?.buffs) ? mod.buffs : []
  const isCritRateKey = (k: string): boolean => k === 'cpct' || /Cpct$/.test(k)
  const isPercentLikeKey = (k: string): boolean => {
    // underscore keys are typically "display-only" helper fields in baseline meta.
    if (!k || k.startsWith('_')) return false
    // Inc/Multi keys are percent-like multipliers in miao-plugin (e.g. healInc/shieldInc/aMulti...).
    if (k.endsWith('Inc')) return true
    if (k.endsWith('Multi')) return true
    // Flat additions (can be large).
    if (
      k.endsWith('Plus') ||
      k === 'atkPlus' ||
      k === 'hpPlus' ||
      k === 'defPlus' ||
      k === 'fyplus' ||
      k === 'fybase'
    ) {
      return false
    }
    if (k.endsWith('Pct')) return true
    if (k.endsWith('Dmg')) return true
    if (k.endsWith('Cdmg')) return true
    if (k.endsWith('Cpct')) return true
    if (k === 'cpct' || k === 'cdmg' || k === 'dmg' || k === 'phy' || k === 'heal' || k === 'shield') return true
    if (k === 'recharge' || k === 'kx' || k === 'enemyDef' || k === 'fypct' || k === 'fyinc') return true
    return false
  }

  const eleVariants: string[] =
    game === 'gs'
      ? ['火', '水', '雷', '冰', '风', '岩', '草']
      : ['shock', 'burn', 'windShear', 'bleed', 'entanglement', 'fireBreak', 'iceBreak']

  const validateOneBuffPass = (ctx0: any, passLabel: string): void => {
    const validateBuffNumber = (keyRaw: unknown, ret: number): void => {
      if (!Number.isFinite(ret)) throw new Error(`buff.data() returned non-finite number`)
      const key = String(keyRaw || '')
      const isBigDmgKey = key === 'dmg' || /Dmg$/.test(key)
      if (isCritRateKey(key) && Math.abs(ret) > 100) {
        throw new Error(`buff.data() returned unreasonable cpct-like value: ${key}=${ret}`)
      }
      const maxPercentLike = game === 'sr' ? (isBigDmgKey ? 5000 : 500) : 500
      if (isPercentLikeKey(key) && Math.abs(ret) > maxPercentLike) {
        throw new Error(`buff.data() returned unreasonable percent-like value: ${key}=${ret}`)
      }
      // SR: tighten sanity bounds for common debuff buckets.
      // Large values are almost always a unit mistake (e.g. 3% -> 300).
      if (game === 'sr') {
        const abs = Math.abs(ret)
        if (key === 'kx' && abs > 100) {
          throw new Error(`buff.data() returned unreasonable kx value: ${key}=${ret}`)
        }
        if ((key === 'enemyDef' || key === 'enemyIgnore' || key === 'ignore') && abs > 120) {
          throw new Error(`buff.data() returned unreasonable shred/ignore value: ${key}=${ret}`)
        }
        if (key === 'enemydmg' && abs > 250) {
          throw new Error(`buff.data() returned unreasonable enemydmg value: ${key}=${ret}`)
        }
      }
      // Extremely negative percent-like values almost always mean a unit/semantics mistake
      // (e.g. `talent.xxx - 100` when talent.xxx is actually a small percent per stack/energy).
      if (isPercentLikeKey(key) && ret < -80) {
        throw new Error(`buff.data() returned suspicious negative percent-like value: ${key}=${ret}`)
      }
    }

    for (const b of buffs) {
      if (!b || typeof b !== 'object') continue
      try {
        if (typeof (b as any).check === 'function') {
          const prev = ctx0.currentTalent
          const prevEle = ctx0.element
          for (const ele of eleVariants) {
            ctx0.element = ele
            for (const ct of talentVariants) {
              ctx0.currentTalent = ct
              ;(b as any).check(ctx0)
            }
          }
          ctx0.element = prevEle
          ctx0.currentTalent = prev
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        throw new Error(`[meta-gen] Generated calc.js invalid buff.check() (${passLabel}): ${msg}`)
      }
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const [k, v] of Object.entries(data)) {
          if (typeof v === 'number') {
            validateBuffNumber(k, v)
            continue
          }
          if (typeof v !== 'function') continue
          try {
            const prev = ctx0.currentTalent
            const prevEle = ctx0.element
            for (const ele of eleVariants) {
              ctx0.element = ele
              for (const ct of talentVariants) {
                ctx0.currentTalent = ct

                // Mimic miao-plugin: only evaluate data when check passes.
                const ok = typeof (b as any).check === 'function' ? !!(b as any).check(ctx0) : true
                if (!ok) continue

                const ret = v(ctx0)
                if (typeof ret === 'number') {
                  validateBuffNumber(k, ret)
                } else if (ret === undefined || ret === null || ret === false || ret === '') {
                  // ok (skipped by miao-plugin runtime)
                } else if (ret === true) {
                  throw new Error(`buff.data() returned boolean true`)
                } else {
                  throw new Error(`buff.data() returned non-number (${typeof ret})`)
                }
              }
            }
            ctx0.element = prevEle
            ctx0.currentTalent = prev
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            throw new Error(`[meta-gen] Generated calc.js invalid buff.data() (${passLabel}): ${msg}`)
          }
        }
      }
    }
  }

  // Validate buffs with two different talent/weapon samples:
  // - moderate sample catches missing `/100` style unit bugs (values explode)
  // - small sample catches `- 100` style conversion bugs (values collapse to ~-100)
  // Note: SR talent tables store many percentages as ratios (0~1). Use a smaller scalar sample there,
  // otherwise correct `*100` conversions will be falsely flagged as "unreasonable percent-like values".
  const buffNModerate = game === 'sr' ? 0.2 : 20
  const buffNSmall = game === 'sr' ? 0.01 : 1
  validateOneBuffPass(mkCtx(buffNModerate), `N=${buffNModerate}`)
  validateOneBuffPass(mkCtx(buffNSmall), `N=${buffNSmall}`)
}
