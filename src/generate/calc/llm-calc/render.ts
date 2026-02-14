import type {
  CalcDetailKind,
  CalcScaleStat,
  CalcSuggestBuff,
  CalcSuggestDetail,
  CalcSuggestInput,
  CalcSuggestResult,
  TalentKey,
  TalentKeyGs
} from './types.js'
import { jsString, normalizePromptText, normalizeTableList, uniq } from './utils.js'
import { inferArrayTableSchema } from './table-schema.js'

export function renderCalcJs(input: CalcSuggestInput, plan: CalcSuggestResult, createdBy: string): string {
  // Final guardrail: ensure GS Natlan "夜魂" tag is applied consistently to dmgKey buckets.
  // Some LLM plans mix tagged/untagged keys for the same talent, which routes buffs incorrectly and causes
  // large regression drift. Keep this in render() as a last pass so any later plan mutations are covered.
  if (input.game === 'gs') {
    const details = Array.isArray(plan.details) ? (plan.details as CalcSuggestDetail[]) : []
    const hasNightByTalent = new Set<TalentKeyGs>()
    const stripNightTitle = (titleRaw: unknown): string | null => {
      const t0 = typeof titleRaw === 'string' ? titleRaw.trim() : ''
      if (!t0) return null
      if (!/\u591c\u9b42/.test(t0)) return null
      let t = t0
      t = t.replace(/\(\s*\u591c\u9b42\s*\)/g, '')
      t = t.replace(/\u591c\u9b42/g, '')
      t = t.replace(/\(\s*\)/g, '')
      return t.trim() || null
    }

    for (const d of details) {
      const tk = (d as any)?.talent
      if (tk !== 'a' && tk !== 'e' && tk !== 'q') continue
      const key = typeof (d as any)?.key === 'string' ? String((d as any).key).trim().toLowerCase() : ''
      if (key && /nightsoul/.test(key)) hasNightByTalent.add(tk)
    }

    // Heuristic/Upstream-direct plans often set `defParams.Nightsoul=true` but do not tag detail keys.
    // When the kit text clearly indicates "夜魂" mechanics, force-tag all dmg buckets for this character.
    const wantsNight = (() => {
      const hit = (s: unknown): boolean => typeof s === 'string' && /(夜魂|nightsoul)/i.test(s)
      for (const v of Object.values((input as any)?.talentDesc || {})) if (hit(v)) return true
      for (const v of (input as any)?.buffHints || []) if (hit(v)) return true
      for (const d of details) if (hit((d as any)?.title)) return true
      return false
    })()
    if (wantsNight) {
      for (const d of details) {
        const tk = (d as any)?.talent
        if (tk === 'a' || tk === 'e' || tk === 'q') hasNightByTalent.add(tk)
      }
    }

    if (hasNightByTalent.size) {
      for (const d of details) {
        const tk = (d as any)?.talent
        if (tk !== 'a' && tk !== 'e' && tk !== 'q') continue
        if (!hasNightByTalent.has(tk)) continue

        // Do not force nightsoul buckets for lunar reaction rows (baseline uses empty dmgKey there).
        const ele = typeof (d as any)?.ele === 'string' ? String((d as any).ele).trim() : ''
        if (ele && /^lunar/i.test(ele)) continue
        const kind = typeof (d as any)?.kind === 'string' ? String((d as any).kind).trim().toLowerCase() : ''
        if (kind === 'reaction') continue

        const keyRaw = typeof (d as any)?.key === 'string' ? String((d as any).key).trim() : ''
        // Baseline titles typically do not include "(夜魂)" suffixes; keep the state in dmgKey/params instead.
        const titleStripped = stripNightTitle((d as any)?.title)
        if (titleStripped) (d as any).title = titleStripped
        if (!keyRaw) {
          ;(d as any).key = `${tk},nightsoul`
          continue
        }
        if (/nightsoul/i.test(keyRaw)) continue
        ;(d as any).key = `${keyRaw},nightsoul`
      }
    }
  }

  const inferDmgBaseFromUnit = (unitRaw: unknown): 'hp' | 'def' | 'mastery' | null => {
    const unit = normalizePromptText(unitRaw)
    if (!unit) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值)/.test(unit)) return 'hp'
    if (/防御力/.test(unit)) return 'def'
    return null
  }

  const inferScaleStatFromUnit = (unitRaw: unknown): CalcScaleStat | null => {
    const unit = normalizePromptText(unitRaw)
    if (!unit) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(unit)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(unit)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(unit)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(unit)) return 'atk'
    return null
  }

  type SrMixedStat = 'atk' | 'hp' | 'def' | 'lostHp'

  const srParseVariantName = (tableNameRaw: string): { base: string; idx: number } => {
    const tableName = String(tableNameRaw || '').trim()
    if (!tableName) return { base: '', idx: 1 }

    // Common patterns:
    // - "技能伤害(2)" / "技能伤害（2）"
    // - Some upstream text loses the opening paren in certain encodings: "技能伤害2)"
    let m = /^(.*?)[（(]?\s*(\d{1,2})\s*[)）]$/.exec(tableName)
    if (m) {
      const idx = Number(m[2])
      return { base: String(m[1] || '').trim(), idx: Number.isFinite(idx) && idx >= 1 ? Math.trunc(idx) : 1 }
    }

    m = /^(.*?)(\d{1,2})$/.exec(tableName)
    if (m) {
      const idx = Number(m[2])
      // Avoid stripping digits from purely numeric table names (should not happen in meta).
      if (String(m[1] || '').trim()) {
        return { base: String(m[1] || '').trim(), idx: Number.isFinite(idx) && idx >= 1 ? Math.trunc(idx) : 1 }
      }
    }

    return { base: tableName, idx: 1 }
  }

  const srPickAdjacentSegment = (descRaw: unknown, wantAdjacent: boolean): string => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return ''
    const idx = desc.indexOf('相邻')
    if (idx === -1) return desc
    return wantAdjacent ? desc.slice(idx) : desc.slice(0, idx)
  }

  const srInferMixedStatOrder = (descSegRaw: string): SrMixedStat[] => {
    const descSeg = String(descSegRaw || '')
    if (!descSeg) return []
    const out: SrMixedStat[] = []
    const re =
      /\$\d+\[[^\]]*\][^$]{0,40}?(累计已损失生命值|已损失生命值|攻击力|防御力|生命上限|生命值上限|生命值)/g
    for (const m of descSeg.matchAll(re)) {
      const t = String(m[1] || '')
      if (!t) continue
      if (t.includes('已损失')) out.push('lostHp')
      else if (t.includes('攻击')) out.push('atk')
      else if (t.includes('防御')) out.push('def')
      else out.push('hp')
      if (out.length >= 6) break
    }
    return out
  }

  const srPickLostHpCapRatio = (descRaw: unknown): number | null => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return null
    // e.g. "...累计已损失生命值最高不超过...生命上限的90%..."
    const m = /最高不超过[^%]{0,80}生命[^%]{0,80}?([0-9]+(?:\.[0-9]+)?)\s*[%％]/.exec(desc)
    if (!m) return null
    const n = Number(m[1])
    const r = Number.isFinite(n) ? n / 100 : NaN
    if (!Number.isFinite(r) || r <= 0 || r > 1.5) return null
    return r
  }

  const srBuildMixedStatDmgExpr = (opts: {
    talent: string
    table: string
    key: string
    ele?: string
    title?: string
  }): string | null => {
    if (input.game !== 'sr') return null
    const talent = String(opts.talent || '').trim()
    const table = String(opts.table || '').trim()
    const key = String(opts.key || '').trim()
    const ele = typeof opts.ele === 'string' && opts.ele.trim() ? opts.ele.trim() : ''
    const title = typeof opts.title === 'string' ? normalizePromptText(opts.title) : ''
    if (!talent || !table) return null

    const allTablesRaw = (input.tables as any)?.[talent]
    const allTables = normalizeTableList(Array.isArray(allTablesRaw) ? allTablesRaw : [])
    if (allTables.length === 0) return null

    // Explicit component ratio tables (common in SR meta):
    // - 攻击倍率 / 生命倍率 / 防御倍率 / 已损失生命值倍率 ...
    // These do not follow the "...2/...3" variant naming convention, but still represent mixed-stat damage.
    const srBuildExplicitRatioDmgExpr = (): string | null => {
      const wantBlastTotal = /(扩散|完整|全体)/.test(title)

      const normKey = (s: string): string => normalizePromptText(s).replace(/\s+/g, '')
      const isAdj = (s: string): boolean => /相邻目标/.test(normKey(s))

      const pick = (kw: string, adjacent: boolean): string | null => {
        for (const tn of allTables) {
          const n = normKey(tn)
          if (!n.includes(kw)) continue
          if (adjacent !== isAdj(tn)) continue
          return tn
        }
        return null
      }

      const pickLostHp = (adjacent: boolean): string | null =>
        pick('已损失生命值倍率', adjacent) || pick('累计已损失生命值倍率', adjacent)

      const atkMain = pick('攻击倍率', false)
      const hpMain = pick('生命倍率', false)
      const defMain = pick('防御倍率', false)
      const lostMain = pickLostHp(false)

      const atkAdj = pick('攻击倍率', true)
      const hpAdj = pick('生命倍率', true)
      const defAdj = pick('防御倍率', true)
      const lostAdj = pickLostHp(true)

      const hasAny = atkMain || hpMain || defMain || lostMain
      if (!hasAny) return null

      const ratioAcc = (tn: string): string => `talent.${talent}[${jsString(tn)}]`
      const ratioExpr = (tn: string): string => {
        const acc = ratioAcc(tn)
        return `toRatio(Array.isArray(${acc}) ? ${acc}[0] : ${acc})`
      }

      const sumRatio = (main: string | null, adj: string | null): string | null => {
        if (!main && !adj) return null
        const a = main ? ratioExpr(main) : '0'
        if (!wantBlastTotal || !adj) return a
        return `(${a} + ((${ratioExpr(adj)}) * 2))`
      }

      const terms: string[] = []

      const atkRatio = sumRatio(atkMain, atkAdj)
      if (atkRatio) terms.push(`calc(attr.atk) * (${atkRatio})`)

      const hpRatio = sumRatio(hpMain, hpAdj)
      if (hpRatio) terms.push(`calc(attr.hp) * (${hpRatio})`)

      const defRatio = sumRatio(defMain, defAdj)
      if (defRatio) terms.push(`calc(attr.def) * (${defRatio})`)

      const lostRatio = sumRatio(lostMain, lostAdj)
      if (lostRatio) {
        const descRaw = (input.talentDesc as any)?.[talent]
        const cap0 = srPickLostHpCapRatio(descRaw)
        const cap = typeof cap0 === 'number' && Number.isFinite(cap0) && cap0 > 0 ? Math.min(2, Math.max(0, cap0)) : 1
        terms.push(`(calc(attr.hp) * ${cap.toFixed(6)}) * (${lostRatio})`)
      }

      if (terms.length === 0) return null
      const keyArg = jsString(key || talent)
      const eleArg = ele ? `, ${jsString(ele)}` : ''
      return `dmg.basic(${terms.join(' + ')}, ${keyArg}${eleArg})`
    }

    const { base: baseNameRaw } = srParseVariantName(table)
    const baseName = baseNameRaw.trim()
    if (!baseName) return null

    const variants: Array<{ idx: number; name: string }> = []
    const seenIdx = new Set<number>()
    for (const tn of allTables) {
      const { base, idx } = srParseVariantName(tn)
      if (base.trim() !== baseName) continue
      if (!Number.isFinite(idx) || idx < 1 || idx > 6) continue
      if (seenIdx.has(idx)) continue
      seenIdx.add(idx)
      variants.push({ idx, name: tn })
    }
    variants.sort((a, b) => a.idx - b.idx)
    if (variants.length < 2) return srBuildExplicitRatioDmgExpr()

    const descRaw = (input.talentDesc as any)?.[talent]
    const wantAdjacent = /相邻/.test(baseName)
    const seg = srPickAdjacentSegment(descRaw, wantAdjacent)
    const statOrder = srInferMixedStatOrder(seg)
    if (statOrder.length < variants.length) return null

    const statOrderUsed = statOrder.slice(0, variants.length)
    const uniq = new Set(statOrderUsed)
    if (uniq.size <= 1) return null

    // Do not auto-generate for non-scalar tables (would require additional branching).
    const sampleMap = (input.tableSamples as any)?.[talent]
    if (sampleMap && typeof sampleMap === 'object' && !Array.isArray(sampleMap)) {
      for (const v of variants) {
        if (Object.prototype.hasOwnProperty.call(sampleMap, v.name)) return null
      }
    }

    const cap = statOrderUsed.includes('lostHp') ? srPickLostHpCapRatio(descRaw) : null
    if (statOrderUsed.includes('lostHp') && (!cap || !Number.isFinite(cap))) return null

    const terms: string[] = []
    for (let i = 0; i < variants.length; i++) {
      const v = variants[i]!
      const st = statOrderUsed[i] || 'atk'
      const ratio = `toRatio(talent.${talent}[${jsString(v.name)}])`
      const base = st === 'lostHp' ? `calc(attr.hp) * ${Number(cap).toFixed(6)}` : `calc(attr.${st})`
      terms.push(`${base} * ${ratio}`)
    }

    const keyArg = jsString(key || talent)
    const eleArg = ele ? `, ${jsString(ele)}` : ''
    return `dmg.basic(${terms.join(' + ')}, ${keyArg}${eleArg})`
  }

  const inferDmgBase = (descRaw: unknown): 'atk' | 'hp' | 'def' | 'mastery' => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'
    // Avoid mis-detecting buff-only skills by requiring damage wording.
    if (!/伤害/.test(desc)) return 'atk'
    // Be conservative: only treat it as HP/DEF/EM scaling when the description explicitly ties
    // that stat to *damage* (not healing/restore text).
    const dmgWord = '(?:伤害|造成|提高|提升|增加|加成|转化)'
    const healWord = '(?:治疗|恢复)'
    const hpWord = '(?:生命上限|生命值上限|最大生命值|生命值)'
    const defWord = '(?:防御力)'
    const emWord = '(?:元素精通|精通)'
    const eqWord = '(?:等同于|相当于|同等于|视为|基于|按)'

    // Many skills/passives are ATK-scaling but have an *additive* bonus like:
    // - "伤害提高，提高值相当于生命值上限的X%"
    // In this case we MUST NOT flip the whole dmg base to HP/DEF/EM.
    const bonusValWord = '(?:提高|提升|增加|加成)(?:的)?值'
    const hpBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${hpWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${hpWord}`).test(desc)
    const hpBuffCtx = new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)
    // Summons/decoys often "inherit max HP" which should NOT flip dmg base to HP.
    const hpInheritCtx =
      new RegExp(`(?:继承|取决于).{0,20}${hpWord}`).test(desc) || new RegExp(`${hpWord}.{0,20}(?:继承|取决于)`).test(desc)
    const defBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${defWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${defWord}`).test(desc)
    const defBuffCtx = new RegExp(`(?:基于|按).{0,20}${defWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)
    const emBonusCtx =
      new RegExp(`${bonusValWord}.{0,20}${emWord}`).test(desc) ||
      new RegExp(`(?:提高|提升|增加|加成).{0,12}(?:相当于|等同于).{0,8}${emWord}`).test(desc)
    const emBuffCtx = new RegExp(`(?:基于|按).{0,20}${emWord}.{0,10}(?:提高|提升|增加|加成)`).test(desc)

    const hasHpHealCtx =
      new RegExp(`${healWord}.{0,30}(?:基于|按).{0,20}${hpWord}`).test(desc) ||
      new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,30}${healWord}`).test(desc) ||
      new RegExp(`${healWord}.{0,30}${eqWord}.{0,20}${hpWord}`).test(desc) ||
      new RegExp(`${eqWord}.{0,20}${hpWord}.{0,30}${healWord}`).test(desc)
    const hasHpDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${hpWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${hpWord}`).test(desc) ||
      // Allow a longer window to tolerate placeholder noise like "$1[f1]% 和 $2[f1]%".
      new RegExp(`${eqWord}.{0,60}${hpWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,60}${hpWord}`).test(desc)

    const hasDefDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${defWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${defWord}`).test(desc) ||
      new RegExp(`${eqWord}.{0,60}${defWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,60}${defWord}`).test(desc)

    const hasEmDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${emWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${emWord}`).test(desc) ||
      new RegExp(`${eqWord}.{0,60}${emWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,60}${emWord}`).test(desc)

    if (hasEmDmgCtx && !emBonusCtx && !emBuffCtx) return 'mastery'
    if (hasHpDmgCtx && !hasHpHealCtx && !hpBonusCtx && !hpBuffCtx && !hpInheritCtx) return 'hp'
    if (hasDefDmgCtx && !defBonusCtx && !defBuffCtx) return 'def'
    return 'atk'
  }

  const inferScaleStatFromDesc = (descRaw: unknown): CalcScaleStat => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'

    const verbs = '(?:基于|按(?:照)?|受益于|取决于|根据|依据)'
    const hpWord = '(?:生命上限|生命值上限|最大生命值|生命值|\\bhp\\b)'
    const defWord = '(?:防御力|防御|\\bdef\\b)'
    const atkWord = '(?:攻击力|\\batk\\b)'
    const emWord = '(?:元素精通|精通|mastery|elemental mastery|\\bem\\b)'

    const hasScalingHint = (statWord: string): boolean =>
      new RegExp(`${verbs}.{0,40}${statWord}`, 'i').test(desc) ||
      new RegExp(`受.{0,10}${statWord}.{0,10}(?:影响|决定)`, 'i').test(desc) ||
      new RegExp(`${statWord}.{0,20}(?:决定|影响|相关|为基础|为基准|为依据)`, 'i').test(desc) ||
      new RegExp(`以.{0,40}${statWord}.{0,20}(?:为基础|为基准|为依据)`, 'i').test(desc)

    const hp = hasScalingHint(hpWord)
    const def = hasScalingHint(defWord)
    const mastery = hasScalingHint(emWord)
    const atk = hasScalingHint(atkWord)

    const hits = Number(hp) + Number(def) + Number(mastery) + Number(atk)
    if (hits === 1) return hp ? 'hp' : def ? 'def' : mastery ? 'mastery' : 'atk'

    // Mixed descriptions are common (damage + heal/shield in one talent). Bias towards non-ATK scaling.
    if (hp) return 'hp'
    if (def) return 'def'
    if (mastery) return 'mastery'
    if (atk) return 'atk'
    return 'atk'
  }

  const inferDmgBaseFromTextSample = (textRaw: unknown): CalcScaleStat | null => {
    const text = normalizePromptText(textRaw)
    if (!text) return null
    if (/(元素精通|精通|mastery|elemental mastery|\bem\b)/i.test(text)) return 'mastery'
    if (/(生命上限|生命值上限|最大生命值|生命值|\bhp\b)/i.test(text)) return 'hp'
    if (/(防御力|\bdef\b)/i.test(text)) return 'def'
    if (/(攻击力|攻击|\batk\b)/i.test(text)) return 'atk'
    // Plain percentage without explicit stat tag (e.g. "130.4%") is ATK-based in most GS talent damage tables.
    if (/[%％]/.test(text)) return 'atk'
    return null
  }

	  const ratioFnLine =
	    input.game === 'gs'
	      ? 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n / 100 : 0 }\n'
	      : 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }\n'

  const inferDefParams = (): Record<string, unknown> | undefined => {
    if (input.game === 'sr') {
      const out: Record<string, unknown> = {}

      const scan = (s: unknown): void => {
        if (typeof s !== 'string') return
        if (!s) return
        if (!('Memosprite' in out) && /(忆灵|Memosprite)/i.test(s)) out.Memosprite = true
      }

      const tableKeys = Object.keys(input.tables || {})
        .map((k) => String(k || '').trim())
        .filter(Boolean)
      const hasMemospriteTables = tableKeys.some((k) => k === 'me' || k === 'mt' || k.startsWith('me') || k.startsWith('mt'))
      if (hasMemospriteTables) out.Memosprite = true

      for (const v of Object.values(input.talentDesc || {})) scan(v)
      for (const v of input.buffHints || []) scan(v)
      for (const d of plan.details || []) {
        const tk = typeof (d as any)?.talent === 'string' ? String((d as any).talent) : ''
        if (tk && (tk === 'me' || tk === 'mt' || tk.startsWith('me') || tk.startsWith('mt'))) out.Memosprite = true
        scan((d as any)?.title)
      }

      const paramKeysInBuff = new Set<string>()
      const minRequired: Record<string, number> = {}
      const checkStrings: string[] = []
      const escapeRegExp = (s: string): string => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const stripHtml = (s: unknown): string =>
        typeof s === 'string' ? String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''
      const hintLines = (input.buffHints || []).map(stripHtml).filter(Boolean)
      const perStackPctByParam: Record<string, number> = {}
      const perStackCapByPct: Record<string, number> = {}

      const collectParamRefs = (expr: string): void => {
        const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g
        let m: RegExpExecArray | null
        while ((m = re.exec(expr))) {
          const k = m[1]
          if (!k) continue
          paramKeysInBuff.add(k)
        }
      }
      const collectLinearStackPct = (expr: string): void => {
        // Detect common stack expressions like `params.fooStacks * 30` and infer a default cap
        // from hint lines such as "...伤害提高30%，最高叠加6层".
        const src = String(expr || '')
        const re1 = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\*\s*(\d+(?:\.\d+)?)/g
        const re2 = /(\d+(?:\.\d+)?)\s*\*\s*params\.([A-Za-z_][A-Za-z0-9_]*)\b/g
        const push = (k: string, perRaw: string): void => {
          if (!k) return
          const per = Number(perRaw)
          if (!Number.isFinite(per) || per <= 0 || per > 1000) return
          const key = String(per)
          // Keep the largest per-stack pct seen for this param (more likely the real one).
          perStackPctByParam[k] = Math.max(perStackPctByParam[k] ?? -Infinity, per)

          if (key in perStackCapByPct) return
          const reCap = /(?:最高|最多)(?:叠加)?\\s*(\\d{1,2})\\s*层/
          const rePct = /(\\d+(?:\\.\\d+)?)\\s*[%％]/g
          let best = 0
          for (const h of hintLines) {
            if (!/(层|叠加)/.test(h)) continue
            const m = reCap.exec(h)
            if (!m) continue
            rePct.lastIndex = 0
            let hasPer = false
            for (const pm of h.matchAll(rePct)) {
              const p = Number(pm[1])
              if (!Number.isFinite(p)) continue
              if (Math.abs(p - per) < 1e-9) {
                hasPer = true
                break
              }
            }
            if (!hasPer) continue
            const cap = Number(m[1])
            if (!Number.isFinite(cap) || cap <= 0 || cap > 50) continue
            best = Math.max(best, Math.trunc(cap))
          }
          perStackCapByPct[key] = best
        }
        for (const m of src.matchAll(re1)) push(String(m[1] || ''), String(m[2] || ''))
        for (const m of src.matchAll(re2)) push(String(m[2] || ''), String(m[1] || ''))
      }
      const collectParamThresholds = (expr: string): void => {
        const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|>)\s*(\d{1,3})\b/g
        let m: RegExpExecArray | null
        while ((m = re.exec(expr))) {
          const k = m[1]
          const op = m[2]
          const n = Number(m[3])
          if (!k || !Number.isFinite(n)) continue
          if (n < 0 || n > 50) continue
          const need = op === '>' ? Math.trunc(n) + 1 : Math.trunc(n)
          if (need < 1 || need > 50) continue
          minRequired[k] = Math.max(minRequired[k] ?? -Infinity, need)
        }
      }

      for (const b of plan.buffs || []) {
        const check = typeof (b as any)?.check === 'string' ? String((b as any).check) : ''
        if (check) {
          checkStrings.push(check)
          collectParamRefs(check)
          collectParamThresholds(check)
        }
        const data = (b as any).data
        if (data && typeof data === 'object' && !Array.isArray(data)) {
          for (const v of Object.values(data as Record<string, unknown>)) {
            if (typeof v === 'string') {
              collectParamRefs(v)
              collectLinearStackPct(v)
            }
          }
        }
      }

      const numMax: Record<string, number> = {}
      const keysInDetails = new Set<string>()
      for (const d of plan.details || []) {
        const p = (d as any)?.params
        if (!p || typeof p !== 'object' || Array.isArray(p)) continue
        for (const [k0, v] of Object.entries(p as Record<string, unknown>)) {
          const k = String(k0 || '').trim()
          if (!k) continue
          keysInDetails.add(k)
          if (typeof v === 'number' && Number.isFinite(v)) {
            numMax[k] = Math.max(numMax[k] ?? -Infinity, v)
          }
        }
      }

      for (const k0 of Array.from(paramKeysInBuff)) {
        const k = String(k0 || '').trim()
        if (!k || k in out) continue
        if (keysInDetails.has(k)) continue

        if (k === 'Memosprite') {
          out.Memosprite = true
          continue
        }

        if (k === 'type' || k === 'idx' || k === 'index') {
          out[k] = 0
          continue
        }

        // IMPORTANT (SR): do NOT default boolean gate params to true.
        // Flags like `e/q/qBuff/break/...` must be enabled per-detail via `detail.params`,
        // otherwise they inflate unrelated rows (and drift far from baseline regression).

        const isCountLike = /(?:layer|layers|stack|stacks|count|cnt|num|times)$/i.test(k)
        const n = numMax[k]
        const nOk = Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 0 && n <= 50
        const need = minRequired[k]
        const needOk = Number.isFinite(need) && need > 0 && need <= 50

        if (isCountLike) {
          if (nOk) {
            out[k] = Math.trunc(n)
            continue
          }
          if (needOk) {
            out[k] = Math.trunc(need)
            continue
          }
          const per = perStackPctByParam[k]
          if (Number.isFinite(per) && per > 0) {
            const cap = perStackCapByPct[String(per)]
            if (Number.isFinite(cap) && cap > 0) {
              out[k] = Math.trunc(cap)
              continue
            }
          }
          if (k === 'debuffCount') {
            out[k] = 3
            continue
          }
          if (k === 'tArtisBuffCount') {
            out[k] = 6
            continue
          }
        }
      }

      return Object.keys(out).length ? out : undefined
    }

    if (input.game !== 'gs') return undefined
    const out: Record<string, unknown> = {}

    const scan = (s: unknown): void => {
      if (typeof s !== 'string') return
      if (!s) return
      if (!('Nightsoul' in out) && /夜魂/i.test(s)) out.Nightsoul = true
      if (!('Hexenzirkel' in out) && /(魔女会|Hexenzirkel)/i.test(s)) out.Hexenzirkel = true
      // Lunar system (Moonsign) used by some characters / reactions.
      if (
        !('Moonsign' in out) &&
        /(月兆|月曜|月辉|月感电|月绽放|月结晶|Moonsign)/i.test(s)
      ) {
        // Heuristic: default to 2, bump to 3 when explicitly mentioned.
        // (Some characters use 2, some use 3; baseline often sets it to max stacks.)
        out.Moonsign = /(月兆|月曜|月辉|Moonsign).{0,20}(3|三)/i.test(s)
          ? 3
          : /(月兆|月曜|月辉|Moonsign).{0,20}(2|二)/i.test(s)
            ? 2
            : 2
      }
    }

    for (const arr of Object.values(input.tables || {})) {
      if (!Array.isArray(arr)) continue
      for (const t of arr) scan(t)
    }
    for (const v of Object.values(input.talentDesc || {})) scan(v)
    for (const v of input.buffHints || []) scan(v)

    // Infer additional showcase defaults from the generated plan itself (helps matching baseline diffs):
    // - Enable boolean state flags referenced by buffs when they appear in any detail params
    // - For simple numeric stack params, default to the max numeric value present in any detail params
    const paramKeysInBuff = new Set<string>()
    const boolDefaultFalseKeys = new Set<string>()
    const minRequired: Record<string, number> = {}
    const collectParamRefs = (expr: string): void => {
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = m[1]
        if (!k) continue
        paramKeysInBuff.add(k)
      }
    }
    const collectBoolDefaultFalse = (exprRaw: unknown): void => {
      const expr = typeof exprRaw === 'string' ? String(exprRaw) : ''
      if (!expr) return
      const patterns: RegExp[] = [
        /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\)*\s*\?/g,
        /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\)*\s*&&/g,
        /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\)*\s*\|\|/g,
        /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\)*\s*===\s*true\b/g,
        /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\b\s*\)*\s*==\s*true\b/g
      ]
      for (const re of patterns) {
        for (const m of expr.matchAll(re)) {
          const k = String(m[1] || '').trim()
          if (!k) continue
          boolDefaultFalseKeys.add(k)
        }
      }
    }
    const collectParamThresholds = (expr: string): void => {
      // Extract simple numeric thresholds like `params.stack >= 5` to auto-enable "满层" showcase defaults.
      const re = /\bparams\.([A-Za-z_][A-Za-z0-9_]*)\s*(>=|>)\s*(\d{1,3})\b/g
      let m: RegExpExecArray | null
      while ((m = re.exec(expr))) {
        const k = m[1]
        const op = m[2]
        const n = Number(m[3])
        if (!k || !Number.isFinite(n)) continue
        if (n < 0 || n > 20) continue
        const need = op === '>' ? Math.trunc(n) + 1 : Math.trunc(n)
        if (need < 1 || need > 20) continue
        minRequired[k] = Math.max(minRequired[k] ?? -Infinity, need)
      }
    }
    for (const b of plan.buffs || []) {
      if (typeof (b as any).check === 'string') {
        collectParamRefs((b as any).check)
        collectParamThresholds((b as any).check)
        collectBoolDefaultFalse((b as any).check)
      }
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const v of Object.values(data as Record<string, unknown>)) {
          if (typeof v === 'string') {
            collectParamRefs(v)
            collectBoolDefaultFalse(v)
          }
        }
      }
    }

    const keysInDetails = new Set<string>()
    const numMax: Record<string, number> = {}
    for (const d of plan.details || []) {
      const p = (d as any).params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const [k0, v] of Object.entries(p as Record<string, unknown>)) {
        const k = String(k0 || '').trim()
        if (!k) continue
        keysInDetails.add(k)
        if (typeof v === 'number' && Number.isFinite(v)) {
          numMax[k] = Math.max(numMax[k] ?? -Infinity, v)
        }
      }
    }

    // Only set defaults for keys that are actually referenced by some buff logic.
    for (const k of paramKeysInBuff) {
      if (k in out) continue

      // Team-composition style params used by some baseline calcs (e.g. Yelan A1: 4元素类型 => hpPct 30).
      // These are not controllable via per-row params, so default to the max-tier showcase value.
      if (k === 'elementTypes') {
        out[k] = 4
        continue
      }
      if (k === 'team_element_count' || k === 'teamElementCount') {
        out[k] = 4
        continue
      }

      // Generic enum-like selectors used by some stack-indexed buffs, e.g.
      //   talent.q["xxx加成"][params.type] * params.num
      // Default to the first variant to keep the buff non-dead in showcases.
      if (k === 'type' || k === 'idx' || k === 'index') {
        out[k] = 0
        continue
      }

      // Conservative numeric defaults: only for obvious stack/count params within a small bound.
      const n = numMax[k]
      const isCountLike =
        /(?:layer|layers|stack|stacks|count|cnt|num|cracks|drops)$/i.test(k) ||
        /^(?:hunterstacks|glory_stacks|veil_of_falsehood|hpabove50count)$/i.test(k)
      const nOk = Number.isFinite(n) && Math.abs(n - Math.round(n)) < 1e-9 && n > 0 && n <= 20
      if (isCountLike && nOk) {
        out[k] = Math.trunc(n)
        continue
      }

      // If no detail sets the stack param, but some buff check requires a minimum threshold (e.g. ">= 5"),
      // default to that threshold so the showcase output matches baseline-like "满层" assumptions.
      const need = minRequired[k]
      if (isCountLike && Number.isFinite(need) && need > 0 && need <= 20) {
        out[k] = Math.trunc(need)
        continue
      }
    }

    // Default some state-like boolean params to true when upstream-derived buffs gate on `params.xxx ? ... : 0`
    // but no detail provides `params.xxx`, otherwise those buffs are permanently dead in showcases.
    if (boolDefaultFalseKeys.size) {
      const banned = new Set([
        'half',
        'halfHp',
        'lowHp',
        'targetHp50',
        'targetHp80',
        'hpBelow50',
        'hpAbove50',
        'hpAbove50Count',
        'Moonsign',
        'Nightsoul',
        'Hexenzirkel',
        'elementTypes',
        'team_element_count',
        'teamElementCount',
        'type',
        'idx',
        'index'
      ])
      const isStateLike = (k: string): boolean =>
        /(?:state|buff|mode|stance|field|eye|enhanced|infus|active)/i.test(k) || /^skillEye$/i.test(k)

      for (const k0 of boolDefaultFalseKeys) {
        const k = String(k0 || '').trim()
        if (!k) continue
        if (k in out) continue
        if (banned.has(k)) continue
        if (k === 'e' || k === 'q') continue
        if (/^c\d+$/i.test(k)) continue
        if (keysInDetails.has(k)) continue
        if (!isStateLike(k)) continue
        out[k] = true
      }
    }

    // Moonsign is a special "state" param that can also affect artifact-set buffs.
    // If any detail already sets Moonsign explicitly, do NOT default it globally via defParams,
    // otherwise unrelated rows (e.g. mastery-scaling E) may be inflated.
    const hasDetailMoonsign = (plan.details || []).some((d) => {
      const p = (d as any)?.params
      return p && typeof p === 'object' && !Array.isArray(p) && Object.prototype.hasOwnProperty.call(p, 'Moonsign')
    })
    const moonsignNeededByBuff = paramKeysInBuff.has('Moonsign')
    if ('Moonsign' in out) {
      if (hasDetailMoonsign || !moonsignNeededByBuff) delete out.Moonsign
    } else if (moonsignNeededByBuff && !hasDetailMoonsign) {
      // Fallback: some lunar characters gate buffs by params.Moonsign but forget to set it in detail.params.
      out.Moonsign = 2
    }

    return Object.keys(out).length ? out : undefined
  }

  const srInferRepeatHitsExpr = (opts: { talent: string; tableName: string; title: string }): string | null => {
    if (input.game !== 'sr') return null
    const talent = String(opts.talent || '').trim()
    const tableName = String(opts.tableName || '').trim()
    const titleNorm = normalizePromptText(opts.title)
    const tableNorm = normalizePromptText(tableName)
    if (!talent || !tableName) return null

    const hint = `${titleNorm} ${tableNorm}`
    if (!/伤害/.test(hint)) return null
    // Per-hit rows should stay per-hit unless explicitly marked as total.
    if (/(?:单次|单段|每次|每段|每跳|每次伤害|每段伤害)/.test(titleNorm)) return null
    // SR memosprite kits: rows explicitly labeled "随机单体" are per-hit instances, not totals.
    // (Totals should be provided as dedicated "(完整/合计/总计)" rows.)
    if (/^m[et]\d*$/.test(talent) && /随机单体/.test(titleNorm)) return null

    // Array/object tables (e.g. [pct, hits]) are handled by table schema logic; do not double-count here.
    const sampleMap = (input.tableSamples as any)?.[talent]
    const sample = sampleMap && typeof sampleMap === 'object' && !Array.isArray(sampleMap) ? sampleMap[tableName] : undefined
    if (Array.isArray(sample) || (sample && typeof sample === 'object')) return null

    const dmgTableCount = (() => {
      const allTablesRaw = (input.tables as any)?.[talent]
      const allTables = Array.isArray(allTablesRaw) ? allTablesRaw.map(String) : []
      const dmgTables = allTables.filter((name) => {
        const t = normalizePromptText(name)
        if (!t) return false
        if (!/伤害/.test(t)) return false
        if (/(削韧|回复|治疗|护盾|固定值)/.test(t)) return false
        return true
      })
      return dmgTables.length
    })()

    const isRepeatComponentHint = /(随机|额外|追加|弹跳|追击|溅射)/.test(hint)

    const desc = normalizePromptText((input.talentDesc as any)?.[talent])
    if (!desc) return null

    const pickBaseHits = (): number | null => {
      // 1) Explicit "...额外造成 N 次伤害": common for multi-hit skills (1 + N) and for repeated sub-components (N).
      const mExtra = /额外造成\s*([0-9]+)\s*次(?:伤害|攻击)/.exec(desc)
      if (mExtra) {
        const n = Number(mExtra[1])
        if (Number.isFinite(n) && n >= 1 && n <= 30) {
          if (isRepeatComponentHint) return n
          if (dmgTableCount === 1) return 1 + n
        }
      }

      // 2) Generic "造成 N 次/段…" wording:
      // - allow for explicit repeat-component rows even when the talent has multiple damage tables;
      // - otherwise only apply when the talent has a single damage table to avoid over-counting mixed kits.
      const allowGeneric = isRepeatComponentHint || dmgTableCount === 1
      if (!allowGeneric) return null

      const re = /造成\s*([0-9]+)\s*(?:次|段)\s*(?:伤害|攻击)/g
      for (const m of desc.matchAll(re)) {
        const idx = typeof (m as any).index === 'number' ? ((m as any).index as number) : -1
        if (idx > 0) {
          const prev = desc.slice(Math.max(0, idx - 2), idx)
          if (prev.includes('额外') || prev.includes('追加')) continue
        }
        const n = Number(m[1])
        if (Number.isFinite(n) && n >= 2 && n <= 30) return n
      }

      const reAtk = /攻击\s*([0-9]+)\s*次/g
      for (const m of desc.matchAll(reAtk)) {
        const n = Number(m[1])
        if (Number.isFinite(n) && n >= 2 && n <= 30) return n
      }

      return null
    }

    const baseHits0 = pickBaseHits()
    if (typeof baseHits0 !== 'number' || !Number.isFinite(baseHits0) || baseHits0 < 2 || baseHits0 > 30) return null
    const baseHits = baseHits0

    const core = (() => {
      const src = titleNorm || tableNorm
      const head = src.split(/[·•]/)[0] || ''
      const t = head.replace(/[\s()（）【】[\]{}，,。.!！?？\-]/g, '').trim()
      if (t.length >= 3) return t.slice(0, 4)
      if (t.length >= 2) return t.slice(0, 2)
      return ''
    })()

    const extraTerms: string[] = []
    for (const h0 of input.buffHints || []) {
      const h = normalizePromptText(h0)
      const mCons = /([1-6])\s*(?:魂|命|星魂)\s*[:：]/.exec(h)
      if (!mCons) continue
      const consReq = Number(mCons[1])
      if (!Number.isFinite(consReq) || consReq < 1 || consReq > 6) continue

      // Only apply when the hint text looks related to this skill name (avoid global hit-count drift).
      if (core) {
        const short = core.slice(0, 2)
        if (!h.includes(core) && (!short || !h.includes(short))) continue
      }

      const mDelta =
        /额外.*?次数.*?增加\s*([0-9]+)\s*次/.exec(h) ||
        /次数增加\s*([0-9]+)\s*次/.exec(h) ||
        /额外造成.*?增加\s*([0-9]+)\s*次/.exec(h) ||
        /攻击次数.*?增加\s*([0-9]+)\s*次/.exec(h)
      if (!mDelta) continue
      const delta = Number(mDelta[1])
      if (!Number.isFinite(delta) || delta <= 0 || delta > 30) continue
      extraTerms.push(`(cons >= ${Math.trunc(consReq)} ? ${Math.trunc(delta)} : 0)`)
      if (extraTerms.length >= 3) break
    }

    if (!extraTerms.length) return String(Math.trunc(baseHits))
    return `(${Math.trunc(baseHits)} + ${extraTerms.join(' + ')})`
  }

  const detailsLines: string[] = []
  detailsLines.push(ratioFnLine.trimEnd())
  detailsLines.push('export const details = [')

  const isCatalyst = input.game === 'gs' && input.weapon === 'catalyst'
  const isBow = input.game === 'gs' && input.weapon === 'bow'

  plan.details.forEach((d, idx) => {
    const kind: CalcDetailKind = typeof d.kind === 'string' && d.kind ? d.kind : 'dmg'
    const title = jsString(d.title)

    let dmgExpr = typeof d.dmgExpr === 'string' ? d.dmgExpr.trim() : ''
    if (!dmgExpr && kind === 'dmg' && input.game === 'sr') {
      const talentKey = typeof d.talent === 'string' && d.talent ? d.talent.trim() : ''
      const tableName = typeof d.table === 'string' && d.table ? d.table.trim() : ''
      const key = typeof d.key === 'string' && d.key.trim() ? d.key.trim() : talentKey || 'e'
      const ele = typeof d.ele === 'string' && d.ele.trim() ? d.ele.trim() : ''
      const auto = srBuildMixedStatDmgExpr({ talent: talentKey, table: tableName, key, ele, title: String(d.title || '') })
      if (auto) dmgExpr = auto
    }
    if (dmgExpr) {
      const talentKey = typeof d.talent === 'string' && d.talent ? d.talent : ''
      detailsLines.push('  {')
      detailsLines.push(`    title: ${title},`)
      if (talentKey) {
        detailsLines.push(`    talent: ${jsString(talentKey)},`)
      }
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      // When dmgExpr is used, render the callback signature based on the detail kind
      // so the expression can directly call heal()/shield()/reaction() when needed.
      if (kind === 'heal') {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, { heal }) => (${dmgExpr})`
        )
      } else if (kind === 'shield') {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, { shield }) => (${dmgExpr})`
        )
      } else if (kind === 'reaction') {
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, { reaction }) => (${dmgExpr})`
        )
      } else {
        detailsLines.push(`    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (${dmgExpr})`)
      }
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

    if (kind === 'reaction') {
      const reaction = typeof d.reaction === 'string' && d.reaction.trim() ? d.reaction.trim() : 'swirl'
      detailsLines.push('  {')
      detailsLines.push(`    title: ${title},`)
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      detailsLines.push(`    dmg: ({}, { reaction }) => reaction(${jsString(reaction)})`)
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

	    const talent = d.talent as TalentKey
	    const tableName = d.table as string
	    const table = jsString(tableName)
	    const pick = typeof (d as any).pick === 'number' && Number.isFinite((d as any).pick) ? Math.trunc((d as any).pick) : undefined
	    const keyArgRaw = typeof d.key === 'string' ? d.key : undefined
	    const eleRaw = typeof d.ele === 'string' ? d.ele.trim() : ''
	    const ele = eleRaw ? jsString(eleRaw) : ''

    const inferGsSpecialEle = (): string | null => {
      if (input.game !== 'gs') return null
      const hint = `${d.title || ''} ${tableName || ''}`
      if (/月感电/.test(hint)) return 'lunarCharged'
      if (/月绽放/.test(hint)) return 'lunarBloom'
      if (/月结晶/.test(hint)) return 'lunarCrystallize'
      return null
    }
    const inferredEle = !ele ? inferGsSpecialEle() : null

	    // IMPORTANT: do NOT auto-infer "phy" here. In miao-plugin, passing `ele="phy"` switches the dmg bonus
	    // bucket to `attr.phy` and will drop generic `dmg` bonuses (e.g. set/weapon "造成的伤害提升"). Baseline
	    // calc.js commonly omits `phy` and relies on miao-plugin defaults + buffs, so auto-forcing phy causes
	    // systematic underestimation in regression comparisons.
	    const eleArg = ele ? `, ${ele}` : inferredEle ? `, ${jsString(inferredEle)}` : ''

	    const isLunarEle =
	      input.game === 'gs' &&
	      (inferredEle === 'lunarCharged' ||
	        inferredEle === 'lunarBloom' ||
	        inferredEle === 'lunarCrystallize' ||
	        eleRaw === 'lunarCharged' ||
	        eleRaw === 'lunarBloom' ||
	        eleRaw === 'lunarCrystallize')
	    const sanitizeKeyArg = (k: string): string => {
	      const banned = new Set([
	        'vaporize',
	        'melt',
	        'crystallize',
	        'burning',
	        'superconduct',
	        'swirl',
	        'electrocharged',
	        'shatter',
	        'overloaded',
	        'bloom',
	        'burgeon',
	        'hyperbloom',
	        'aggravate',
	        'spread',
	        'lunarcharged',
	        'lunarbloom',
	        'lunarcrystallize',
	        // Avoid invalid talent keys accidentally emitted by LLMs (phy is an element override, not a talent bucket).
	        'phy',
	        'physical',
	        'phys'
	      ])
	      const parts = k
	        .split(',')
	        .map((s) => s.trim())
	        .filter(Boolean)
	        .filter((s) => !banned.has(s.toLowerCase()))
	      return parts.join(',')
	    }
	    const keyArgSanitized = typeof keyArgRaw === 'string' ? sanitizeKeyArg(keyArgRaw) : ''

	    // IMPORTANT: lunar* uses the reaction system with a custom base damage. Baseline uses empty talent key
	    // to avoid accidentally treating e/q bonuses (or other numeric attrs like lunarBloom) as talent modifiers.
	    const keyArg = jsString(isLunarEle ? '' : keyArgSanitized ? keyArgSanitized : talent)

    // Infer scaling base:
    // - Prefer unit hints when they explicitly indicate HP/DEF.
    // - Otherwise fall back to a conservative description match ("based on HP/DEF").
    const unitMap = input.tableUnits?.[talent]
    const baseTableName = tableName.endsWith('2') ? tableName.slice(0, -1) : tableName
    const unit = unitMap ? unitMap[tableName] || unitMap[baseTableName] : undefined
    const unitBase0 = inferDmgBaseFromUnit(unit)
    const textSample =
      (input.tableTextSamples as any)?.[talent]?.[tableName] ??
      (input.tableTextSamples as any)?.[talent]?.[baseTableName]
    const textBase = inferDmgBaseFromTextSample(textSample)
    const textNorm = normalizePromptText(textSample)
    // For GS talent.a, descriptions often mix multiple mechanics (e.g. special arrows scaling with HP).
    // Prefer per-table text sample hints, and only fall back to description for non-a talents.
    const inferDescBaseFor = (tkRaw: unknown): 'atk' | 'hp' | 'def' | 'mastery' => {
      const tk = String(tkRaw || '').trim()
      if (!tk) return 'atk'
      // GS normal attacks often have the broadest/least-structured descriptions (and can mention other mechanics
      // that do not affect the basic scaling table). Default to ATK unless per-table hints override it.
      //
      // SR basic attacks are usually ATK-scaling too, but some kits are explicitly HP/DEF-scaling in their A text
      // while upstream tables may omit per-table unit hints. Allow desc inference for SR to avoid systematic undercount.
      if (input.game === 'gs' && tk === 'a') return 'atk'
      return inferDmgBase((input.talentDesc as any)?.[tk])
    }
    const baseTalentOf = (tkRaw: unknown): string | null => {
      const tk = String(tkRaw || '').trim()
      if (!tk) return null
      const m = tk.match(/^(a|e|q|t|z|me|mt)\d+$/)
      if (!m) return null
      const base = m[1]
      return base && base !== tk ? base : null
    }
    let descBase = inferDescBaseFor(talent)
    // Enhanced skill blocks (e2/q2/mt1/...) often omit meaningful descriptions in data sources.
    // Fall back to their base key when there is no per-table hint (prevents systematic atk-default undercount).
    const descNorm = normalizePromptText((input.talentDesc as any)?.[talent])
    const descMentionsStat =
      !!descNorm &&
      /(生命|防御|精通|\bhp\b|\bdef\b|mastery|\bem\b|攻击力|攻击|\batk\b)/i.test(descNorm)
    if (descBase === 'atk' && !descMentionsStat) {
      const baseTk = baseTalentOf(talent)
      if (baseTk) {
        const b2 = inferDescBaseFor(baseTk)
        if (b2 !== 'atk') descBase = b2
      }
    }
    // If the table unit is just a plain percentage (no HP/DEF/EM marker), prefer ATK over a broad description
    // match. Some skills mention EM/HP bonuses in the description but only specific sub-tables actually scale
    // with those stats (e.g. 纳西妲 E：灭净三业是 atk+em，但点按/长按仍是 atk%).
    const unitNorm = normalizePromptText(unit)
    // Mixed-scaling tables sometimes label unit as HP/DEF but omit that stat in the value text (e.g. "98.7%攻击 + 1.69%").
    // In such cases, do NOT force HP/DEF base for scalar rendering; prefer per-table text/schema or desc fallback.
    const unitMentionsNonAtk = !!unitBase0
    const textMentionsAtk = !!textNorm && /(攻击力|攻击|\batk\b)/i.test(textNorm)
    const textMentionsHpDefEm =
      !!textNorm && /(生命|防御|精通|\bhp\b|\bdef\b|mastery|\bem\b)/i.test(textNorm)
    const looksLikeMixedScale = unitMentionsNonAtk && !!textNorm && /[+＋]/.test(textNorm) && textMentionsAtk && !textMentionsHpDefEm
    const unitBase = looksLikeMixedScale ? null : unitBase0
    const looksLikePlainPctUnit =
      !!unitNorm &&
      /[%％]/.test(unitNorm) &&
      !/(生命上限|生命值上限|最大生命值|生命值|hp|防御力|防御|def|精通|元素精通|mastery|\bem\b)/i.test(unitNorm)
    const looksLikePlainPctTextSample =
      !!textNorm &&
      /[%％]/.test(textNorm) &&
      !/[+*/xX×]/.test(textNorm) &&
      !/(生命|防御|精通|hp|def|mastery|\bem\b)/i.test(textNorm)
    // IMPORTANT: In GS, many scalar talent tables have an empty unit (damage % is implicit) and do NOT have a
    // per-table text sample in our prompt input. In that case, falling back to a broad skill description can
    // easily mis-detect HP/DEF/EM scaling and explode damage numbers (e.g. mixed-scaling skills where only one
    // sub-table uses HP/DEF/EM).
    const hasPerTableHint = !!unitNorm || !!textNorm
    let baseInferred =
      unitBase ||
      textBase ||
      ((input.game === 'gs' && !hasPerTableHint) || looksLikePlainPctUnit || looksLikePlainPctTextSample
        ? 'atk'
        : descBase) ||
      'atk'
    // SR: Remembrance/memosprite rows (me/mt) sometimes scale with HP/DEF, but not always (e.g. TB Memory memosprite is ATK-based).
    // When per-table unit hints are missing, only bias away from ATK if the *description* strongly suggests HP/DEF scaling.
    if (input.game === 'sr' && kind === 'dmg' && !hasPerTableHint) {
      const tk = String(talent || '').trim()
      const isMem = /^m[et]/.test(tk)
      if (isMem) {
        const path = normalizePromptText(input.weapon)
        if (/记忆/.test(path) && baseInferred === 'atk') {
          if (/(生命上限|生命值上限|最大生命值|生命值)/.test(descNorm)) baseInferred = 'hp'
          else if (/防御/.test(descNorm)) baseInferred = 'def'
        }
      }
    }
    // SR: Basic attacks are ATK-scaling for the vast majority of kits. Some descriptions mention HP/DEF for other
    // parts of the kit, and upstream tables often lack per-table unit hints. To avoid exploding/imploding A-dmg by
    // over-trusting broad descriptions, default talent.a to ATK unless the path strongly suggests non-ATK scaling
    // (Preservation/Abundance/Memory).
    if (input.game === 'sr' && kind === 'dmg' && talent === 'a' && !hasPerTableHint) {
      const path = normalizePromptText(input.weapon)
      const allowNonAtk = /(存护|丰饶|记忆)/.test(path)
      if (!allowNonAtk && baseInferred !== 'atk') {
        // Basic attack descriptions are usually specific enough: if they explicitly state HP/DEF-scaling,
        // keep it even for non-Preservation/Abundance/Memory paths (rare kits exist).
        const strongNonAtkFromDesc =
          descBase !== 'atk' && !!descNorm && /(生命上限|生命值上限|最大生命值|生命值|防御)/.test(descNorm)
        if (!strongNonAtkFromDesc) baseInferred = 'atk'
      }
    }
    // SR: allow validated plan.stat overrides for HP/DEF-scaling kits.
    // (Tables often lack per-table unit markers; relying only on description heuristics can still miss.)
    const statOverrideRaw = typeof (d as any).stat === 'string' ? String((d as any).stat).trim().toLowerCase() : ''
    let statOverride =
      input.game === 'sr' && kind === 'dmg' && (statOverrideRaw === 'hp' || statOverrideRaw === 'def' || statOverrideRaw === 'atk')
        ? statOverrideRaw
        : ''
    if (input.game === 'sr' && kind === 'dmg' && talent === 'a' && !hasPerTableHint) {
      const path = normalizePromptText(input.weapon)
      const allowNonAtk = /(存护|丰饶|记忆)/.test(path)
      if (!allowNonAtk && statOverride && statOverride !== 'atk') {
        const strongNonAtkFromDesc =
          descBase !== 'atk' && !!descNorm && /(生命上限|生命值上限|最大生命值|生命值|防御)/.test(descNorm)
        if (!strongNonAtkFromDesc) statOverride = ''
      }
    }
    const base = (statOverride || baseInferred) as 'atk' | 'hp' | 'def' | 'mastery'
    const useBasic = base !== 'atk'

	    if (kind === 'heal' || kind === 'shield') {
      const method = kind === 'heal' ? 'heal' : 'shield'
      const stat = (d.stat ||
        inferScaleStatFromUnit(unit) ||
        inferScaleStatFromDesc((input.talentDesc as any)?.[talent])) as CalcScaleStat

      // Some GS heal/shield formulas are split into a flat "基础..." + a percent "附加..." table,
      // instead of providing a single `[pct, flat]` table.
      const findPairGs = (): { baseTable: string; addTable: string } | null => {
        if (input.game !== 'gs') return null
        const all = (input.tables as any)?.[talent]
        const list = Array.isArray(all) ? all : []
        const has = (name: string): boolean => list.includes(name)
        const t0 = tableName
        // 例：护盾基础吸收量 + 护盾附加吸收量
        if (/基础/.test(t0)) {
          const add = t0.replace(/基础/g, '附加')
          if (add !== t0 && has(add)) return { baseTable: t0, addTable: add }
        }
        if (/附加/.test(t0)) {
          const base = t0.replace(/附加/g, '基础')
          if (base !== t0 && has(base)) return { baseTable: base, addTable: t0 }
        }
        return null
      }

      // SR heal/shield formulas are commonly split into a percent table + a flat table.
      const findPairSr = (stat: CalcScaleStat): { pctTable: string; flatTable: string } | null => {
        if (input.game !== 'sr') return null
        const all = (input.tables as any)?.[talent]
        const list = Array.isArray(all) ? all : []
        const has = (name: string): boolean => list.includes(name)
        const t0 = tableName

        const pickFlat = (): string | null => list.find((x) => /固定值/.test(String(x || ''))) || null
        const pickPctByStat = (): string | null => {
          if (stat === 'hp') return list.find((x) => /(百分比生命|生命值百分比)/.test(String(x || ''))) || null
          if (stat === 'def') return list.find((x) => /(百分比防御|防御力百分比)/.test(String(x || ''))) || null
          if (stat === 'atk') return list.find((x) => /攻击力百分比/.test(String(x || ''))) || null
          return list.find((x) => /百分比/.test(String(x || ''))) || null
        }

        if (/百分比/.test(t0) && !/固定值/.test(t0)) {
          const flatCand = t0.replace(/百分比生命|生命值百分比|百分比防御|防御力百分比|攻击力百分比/g, '固定值')
          if (flatCand !== t0 && has(flatCand)) return { pctTable: t0, flatTable: flatCand }
          const flat = pickFlat()
          if (flat) return { pctTable: t0, flatTable: flat }
        }

        if (/固定值/.test(t0)) {
          const pctToken = stat === 'hp' ? '百分比生命' : stat === 'def' ? '百分比防御' : stat === 'atk' ? '攻击力百分比' : '百分比生命'
          const pctCand = t0.replace(/固定值/g, pctToken)
          if (pctCand !== t0 && has(pctCand)) return { pctTable: pctCand, flatTable: t0 }
          const pct = pickPctByStat()
          if (pct) return { pctTable: pct, flatTable: t0 }
        }

        // Variant "(2)" tables: some SR upstream uses "X" (pct) + "X(2)" (flat) without "百分比/固定值" tokens.
        // Keep this conservative: do not treat obvious multi-target variants (主目标/相邻目标/副目标) as pct+flat pairs.
        const looksLikeMultiTarget = (s: string): boolean => /(主目标|相邻目标|次要|副目标)/.test(String(s || ''))
        const m2 = /^(.*?)[（(]\s*2\s*[)）]$/.exec(t0)
        if (m2) {
          const base = String(m2[1] || '').trim()
          if (base && has(base) && !looksLikeMultiTarget(base) && !looksLikeMultiTarget(t0)) {
            return { pctTable: base, flatTable: t0 }
          }
        } else {
          const cand = `${t0}(2)`
          if (cand !== t0 && has(cand) && !looksLikeMultiTarget(t0)) return { pctTable: t0, flatTable: cand }
          const cand2 = `${t0}（2）`
          if (cand2 !== t0 && has(cand2) && !looksLikeMultiTarget(t0)) return { pctTable: t0, flatTable: cand2 }
        }

        return null
      }

	      detailsLines.push('  {')
	      detailsLines.push(`    title: ${title},`)
	      detailsLines.push(`    talent: ${jsString(talent)},`)
      if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
        detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
      }
      if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
        detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
      }
      if (typeof d.check === 'string' && d.check.trim()) {
        detailsLines.push(
          `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
        )
      }
      detailsLines.push(`    dmg: ({ attr, talent, calc }, { ${method} }) => {`)

      const pairGs = findPairGs()
      const pairSr = findPairSr(stat)
      if (pairGs) {
        const baseTable = jsString(pairGs.baseTable)
        const addTable = jsString(pairGs.addTable)
        detailsLines.push(`      const tBase = talent.${talent}[${baseTable}]`)
        detailsLines.push(`      const tAdd = talent.${talent}[${addTable}]`)
        detailsLines.push(`      const flat = Array.isArray(tBase) ? (Number(tBase[1]) || 0) : (Number(tBase) || 0)`)
        detailsLines.push(`      const pct = Array.isArray(tAdd) ? (Number(tAdd[0]) || 0) : (Number(tAdd) || 0)`)
        detailsLines.push(`      const flat2 = Array.isArray(tAdd) ? (Number(tAdd[1]) || 0) : 0`)
        detailsLines.push(`      const base = calc(attr.${stat})`)
        detailsLines.push(`      return ${method}(flat + base * toRatio(pct) + flat2)`)
      } else if (pairSr) {
        const pctTable = jsString(pairSr.pctTable)
        const flatTable = jsString(pairSr.flatTable)
        detailsLines.push(`      const tPct = talent.${talent}[${pctTable}]`)
        detailsLines.push(`      const tFlat = talent.${talent}[${flatTable}]`)
        detailsLines.push(`      const pct = Array.isArray(tPct) ? (Number(tPct[0]) || 0) : (Number(tPct) || 0)`)
        detailsLines.push(`      const flat = Array.isArray(tFlat) ? (Number(tFlat[1] ?? tFlat[0]) || 0) : (Number(tFlat) || 0)`)
        detailsLines.push(`      const base = calc(attr.${stat})`)
        detailsLines.push(`      return ${method}(base * toRatio(pct) + flat)`)
      } else {
        detailsLines.push(`      const t = talent.${talent}[${table}]`)
        detailsLines.push(`      const base = calc(attr.${stat})`)

        // If unit hints explicitly mention a stat, this is almost always a percentage table.
        // Otherwise, prefer treating large values as flat (e.g. Zhongli "护盾基础吸收量" is ~1k-3k).
        const unitScale = inferScaleStatFromUnit(unit)
        const scalarMode = unitScale ? 'pct' : 'auto'
        if (scalarMode === 'pct') {
          detailsLines.push(`      if (Array.isArray(t)) return ${method}(base * toRatio(t[0]) + (Number(t[1]) || 0))`)
          detailsLines.push(`      return ${method}(base * toRatio(t))`)
        } else {
          detailsLines.push(`      if (Array.isArray(t)) return ${method}(base * toRatio(t[0]) + (Number(t[1]) || 0))`)
          detailsLines.push(`      const n = Number(t) || 0`)
          const flatThreshold = input.game === 'sr' ? 5 : 200
          detailsLines.push(`      if (n > ${flatThreshold}) return ${method}(n)`)
          detailsLines.push(`      return ${method}(base * toRatio(n))`)
        }
      }
      detailsLines.push('    }')
      detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
      return
    }

	    detailsLines.push('  {')
	    detailsLines.push(`    title: ${title},`)
	    detailsLines.push(`    talent: ${jsString(talent)},`)
    if (typeof d.cons === 'number' && Number.isFinite(d.cons)) {
      detailsLines.push(`    cons: ${Math.trunc(d.cons)},`)
    }
    if (d.params && typeof d.params === 'object' && !Array.isArray(d.params)) {
      detailsLines.push(`    params: ${JSON.stringify(d.params)},`)
    }
    if (typeof d.check === 'string' && d.check.trim()) {
      detailsLines.push(
        `    check: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }) => (${d.check.trim()}),`
      )
    }

    const hitMulExpr =
      kind === 'dmg' && input.game === 'sr'
        ? srInferRepeatHitsExpr({ talent: String(talent || ''), tableName, title: String(d.title || '') })
        : null
    const wantsHitMul = typeof hitMulExpr === 'string' && !!hitMulExpr.trim()
    const mul = wantsHitMul ? ' * hitMul' : ''

	    detailsLines.push(
      wantsHitMul
        ? `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => {`
        : `    dmg: ({ talent, attr, calc }, dmg) => {`
    )
	    detailsLines.push(`      const { basic } = dmg`)
	    detailsLines.push(`      const t = talent.${talent}[${table}]`)
    if (wantsHitMul) detailsLines.push(`      const hitMul = Math.max(1, ${hitMulExpr.trim()})`)
	    detailsLines.push(`      if (Array.isArray(t)) {`)
	    if (typeof pick === 'number' && Number.isFinite(pick)) {
	      // Array variant selector (e.g. "低空/高空..." or "X/Y..." tables).
	      detailsLines.push(`        const v = Number(t[${Math.max(0, Math.min(10, pick))}]) || 0`)
	      if (useBasic) {
	        detailsLines.push(`        return basic(calc(attr.${base}) * toRatio(v)${mul}, ${keyArg}${eleArg})`)
	      } else {
	        detailsLines.push(`        return dmg(v${mul}, ${keyArg}${eleArg})`)
	      }
	    } else {
	      const schema = inferArrayTableSchema(input, talent, tableName)
	      if (schema?.kind === 'statStat') {
	        const [s0, s1] = schema.stats
	        detailsLines.push(
	          `        return basic((calc(attr.${s0}) * toRatio(t[0]) + calc(attr.${s1}) * toRatio(t[1]))${mul}, ${keyArg}${eleArg})`
	        )
	      } else if (schema?.kind === 'statTimes') {
          // e.g. [pct, hits] from `...2` tables where text sample is like "1.41%HP*5".
          // Default to per-hit output unless the title explicitly says "总/合计/一轮...".
          // (Baseline often compares per-hit rows; total rows should opt-in via title wording.)
          const titleHint = String(d.title || '')
          const wantsTotal =
            /(?:合计|总计|总伤|一轮|总|完整)/.test(titleHint) &&
            !/(?:单次|单段|每段|每跳|每次)/.test(titleHint)
          if (wantsTotal) {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg(((Number(t[0]) || 0) * (Number(t[1]) || 0))${mul}, ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(
                `        return basic(calc(attr.${schema.stat}) * toRatio(t[0]) * (Number(t[1]) || 0)${mul}, ${keyArg}${eleArg})`
              )
            }
          } else {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg((Number(t[0]) || 0)${mul}, ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(`        return basic(calc(attr.${schema.stat}) * toRatio(t[0])${mul}, ${keyArg}${eleArg})`)
            }
          }
	      } else if (schema?.kind === 'pctList') {
	        detailsLines.push(`        const sum = t.reduce((acc, x) => acc + (Number(x) || 0), 0)`)
	        if (schema.stat === 'atk' && !useBasic) {
	          detailsLines.push(`        return dmg(sum${mul}, ${keyArg}${eleArg})`)
	        } else {
	          detailsLines.push(`        return basic(calc(attr.${schema.stat}) * toRatio(sum)${mul}, ${keyArg}${eleArg})`)
	        }
	      } else if (schema?.kind === 'statFlat') {
          // "[pct, flat]" (e.g. "%HP + 800" / "%ATK + 500"). Always render as a basic damage number.
          // NOTE: miao-plugin's `dmg()` does NOT accept array pctNum; passing arrays can yield NaN damage.
          detailsLines.push(
            `        return basic((calc(attr.${schema.stat}) * toRatio(t[0]) + (Number(t[1]) || 0))${mul}, ${keyArg}${eleArg})`
          )
	      } else if (useBasic) {
	        detailsLines.push(`        const base = calc(attr.${base})`)
	        detailsLines.push(`        const v = Number(t[0]) || 0`)
	        detailsLines.push(`        return basic(base * toRatio(v)${mul}, ${keyArg}${eleArg})`)
	      } else {
          // Fallback: treat unknown arrays as variant lists and pick the first component as pctNum.
          // (Passing arrays into `dmg()` would yield NaN in miao-plugin runtime.)
          detailsLines.push(`        const v = Number(t[0]) || 0`)
          detailsLines.push(`        return dmg(v${mul}, ${keyArg}${eleArg})`)
	      }
	    }
	    detailsLines.push(`      }`)
	    if (useBasic) {
	      detailsLines.push(`      const base = calc(attr.${base})`)
	      detailsLines.push(`      return basic(base * toRatio(t)${mul}, ${keyArg}${eleArg})`)
	    } else {
	      detailsLines.push(`      return dmg(t${mul}, ${keyArg}${eleArg})`)
	    }
	    detailsLines.push(`    }`)
	    detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
	  })

  detailsLines.push(']')

  const detailKey = (d: CalcSuggestDetail | undefined): string => {
    if (!d) return ''
    if (typeof d.key === 'string' && d.key.trim()) return d.key.trim()
    if (typeof d.talent === 'string' && d.talent) return d.talent
    return ''
  }

  // Choose a stable default damage row (defDmgIdx) that is closer to baseline behavior.
  // NOTE: baseline often points defDmgIdx at a "总伤/完整/合计" style row (not the first row of a key bucket),
  // and SR Memory kits typically use memosprite totals as the default showcase.
  const detailsArr = Array.isArray(plan.details) ? (plan.details as CalcSuggestDetail[]) : []
  const validIdxs: number[] = []
  for (let i = 0; i < detailsArr.length; i++) {
    if (detailKey(detailsArr[i])) validIdxs.push(i)
  }
  const scoreAsDefault = (d: CalcSuggestDetail, idx: number): number => {
    const title = normalizePromptText((d as any)?.title)
    const kind = typeof (d as any)?.kind === 'string' ? String((d as any).kind).trim().toLowerCase() : 'dmg'
    const talent = typeof (d as any)?.talent === 'string' ? String((d as any).talent).trim() : ''
    const hasParams = (() => {
      const p: any = (d as any)?.params
      return p && typeof p === 'object' && !Array.isArray(p) && Object.keys(p).length > 0
    })()

    let s = 0
    if (kind === 'dmg') s += 100
    else if (kind === 'heal' || kind === 'shield') s += 35

    const isTotal = /(合计|总计|总伤|完整)/.test(title) && !/(单次|单段|每次|每段|每跳)/.test(title)
    if (isTotal) s += 30
    if (hasParams) s += 6

    if (input.game === 'gs') {
      if (talent === 'q') s += 14
      else if (talent === 'e') s += 8
      else if (talent === 'a') s -= 4
    } else {
      // sr
      if (/^m[et]\d*$/.test(talent)) s += 18
      else if (talent === 'q') s += 10
      else if (talent === 'e') s += 6
      else if (talent === 'a') s -= 2
    }

    // Prefer earlier rows when the score ties (stable ordering).
    return s * 1000 - idx
  }
  const pickBestIdx = (idxs: number[]): number | null => {
    let bestIdx: number | null = null
    let bestScore = Number.NEGATIVE_INFINITY
    for (const idx of idxs) {
      const d = detailsArr[idx]
      if (!d) continue
      const sc = scoreAsDefault(d, idx)
      if (sc > bestScore) {
        bestScore = sc
        bestIdx = idx
      }
    }
    return bestIdx
  }

  const prefKey = typeof plan.defDmgKey === 'string' ? plan.defDmgKey.trim() : ''
  const idxsByPref = prefKey ? validIdxs.filter((i) => detailKey(detailsArr[i]) === prefKey) : []

  // SR Memory kits: prefer a memosprite "总伤/完整" row as default showcase when present.
  const srMemTotalIdxs =
    input.game === 'sr'
      ? validIdxs.filter((i) => {
          const d: any = detailsArr[i]
          const tk = typeof d?.talent === 'string' ? String(d.talent).trim() : ''
          if (!/^m[et]\d*$/.test(tk)) return false
          const title = normalizePromptText(d?.title)
          return /(合计|总计|总伤|完整)/.test(title) && !/(单次|单段|每次|每段|每跳)/.test(title)
        })
      : []

  const defDmgIdx =
    pickBestIdx(srMemTotalIdxs) ?? pickBestIdx(idxsByPref) ?? pickBestIdx(validIdxs) ?? (detailsArr.length ? 0 : 0)
  const defDmgKey = detailKey(detailsArr[defDmgIdx]) || prefKey || detailKey(detailsArr[0]) || 'e'

  const isIdent = (k: string): boolean => /^[$A-Z_][0-9A-Z_$]*$/i.test(k)
  const renderProp = (k: string): string => (isIdent(k) ? k : jsString(k))
  const isFnExpr = (s: string): boolean => /=>/.test(s) || /^function\b/.test(s)
  const wrapExpr = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => (${expr})`
  const wrapExprNumber = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees, element, currentTalent }) => {` +
    ` const v = (${expr});` +
    ` if (typeof v === "number") return Number.isFinite(v) ? v : 0;` +
    ` if (v === undefined || v === null || v === false || v === "") return v;` +
    ` return 0 }`

  const renderBuffValue = (v: unknown): string | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExprNumber(t)
  }

  const renderBuffCheck = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExpr(t)
  }

  const buffsRaw = Array.isArray(plan.buffs) ? (plan.buffs as Array<CalcSuggestBuff | string>) : []
  const buffs: Array<CalcSuggestBuff | string> = []
  for (const b of buffsRaw) {
    if (typeof b === 'string') {
      const t = b.trim()
      if (t) buffs.push(t)
      continue
    }
    if (!b || typeof b !== 'object') continue
    if (!(b as any).title) continue
    buffs.push(b)
  }
  const buffsLines: string[] = []
  if (buffs.length === 0) {
    buffsLines.push('export const buffs = []')
  } else {
    buffsLines.push('export const buffs = [')
    buffs.forEach((b, idx) => {
      const isLast = idx === buffs.length - 1
      if (typeof b === 'string') {
        buffsLines.push(`  ${jsString(b)}${isLast ? '' : ','}`)
        return
      }
      buffsLines.push('  {')
      buffsLines.push(`    title: ${jsString((b as CalcSuggestBuff).title)},`)
      if (typeof (b as CalcSuggestBuff).sort === 'number' && Number.isFinite((b as CalcSuggestBuff).sort)) {
        buffsLines.push(`    sort: ${Math.trunc((b as CalcSuggestBuff).sort!)},`)
      }
      if (typeof (b as CalcSuggestBuff).cons === 'number' && Number.isFinite((b as CalcSuggestBuff).cons)) {
        buffsLines.push(`    cons: ${Math.trunc((b as CalcSuggestBuff).cons!)},`)
      }
      if (typeof (b as CalcSuggestBuff).tree === 'number' && Number.isFinite((b as CalcSuggestBuff).tree)) {
        buffsLines.push(`    tree: ${Math.trunc((b as CalcSuggestBuff).tree!)},`)
      }

      const check = renderBuffCheck((b as any).check)
      if (check) {
        buffsLines.push(`    check: ${check},`)
      }

      const dataRaw = (b as any).data
      if (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) {
        const entries: Array<[string, string]> = []
        for (const [k, v] of Object.entries(dataRaw as Record<string, unknown>)) {
          const kk = String(k || '').trim()
          if (!kk) continue
          const vv = renderBuffValue(v)
          if (!vv) continue
          entries.push([kk, vv])
        }
        if (entries.length) {
          buffsLines.push('    data: {')
          entries.forEach(([k, v], j) => {
            const comma = j === entries.length - 1 ? '' : ','
            buffsLines.push(`      ${renderProp(k)}: ${v}${comma}`)
          })
          buffsLines.push('    }')
        }
      }

      buffsLines.push(isLast ? '  }' : '  },')
    })
    buffsLines.push(']')
  }

  const defParams = inferDefParams()
  const defParamsLine = defParams ? `export const defParams = ${JSON.stringify(defParams)}` : ''

  return [
    `// Auto-generated by ${createdBy}.`,
    detailsLines.join('\n'),
    '',
    `export const defDmgIdx = ${defDmgIdx}`,
    `export const defDmgKey = ${jsString(defDmgKey)}`,
    `export const mainAttr = ${jsString(plan.mainAttr)}`,
    '',
    ...(defParamsLine ? [defParamsLine, ''] : []),
    buffsLines.join('\n'),
    '',
    `export const createdBy = ${jsString(createdBy)}`,
    ''
  ].join('\n')
}
