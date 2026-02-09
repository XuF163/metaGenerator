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

    for (const d of details) {
      const tk = (d as any)?.talent
      if (tk !== 'a' && tk !== 'e' && tk !== 'q') continue
      const key = typeof (d as any)?.key === 'string' ? String((d as any).key).trim().toLowerCase() : ''
      if (key && /nightsoul/.test(key)) hasNightByTalent.add(tk)
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
  }): string | null => {
    if (input.game !== 'sr') return null
    const talent = String(opts.talent || '').trim()
    const table = String(opts.table || '').trim()
    const key = String(opts.key || '').trim()
    const ele = typeof opts.ele === 'string' && opts.ele.trim() ? opts.ele.trim() : ''
    if (!talent || !table) return null

    const allTablesRaw = (input.tables as any)?.[talent]
    const allTables = normalizeTableList(Array.isArray(allTablesRaw) ? allTablesRaw : [])
    if (allTables.length === 0) return null

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
    if (variants.length < 2) return null

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
      new RegExp(`${eqWord}.{0,20}${hpWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,20}${hpWord}`).test(desc)

    const hasDefDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${defWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${defWord}`).test(desc) ||
      new RegExp(`${eqWord}.{0,20}${defWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,20}${defWord}`).test(desc)

    const hasEmDmgCtx =
      new RegExp(`(?:基于|按).{0,20}${emWord}.{0,30}${dmgWord}`).test(desc) ||
      new RegExp(`${dmgWord}.{0,30}(?:基于|按).{0,20}${emWord}`).test(desc) ||
      new RegExp(`${eqWord}.{0,20}${emWord}.{0,30}伤害`).test(desc) ||
      new RegExp(`伤害.{0,30}${eqWord}.{0,20}${emWord}`).test(desc)

    if (hasEmDmgCtx && !emBonusCtx && !emBuffCtx) return 'mastery'
    if (hasHpDmgCtx && !hasHpHealCtx && !hpBonusCtx && !hpBuffCtx && !hpInheritCtx) return 'hp'
    if (hasDefDmgCtx && !defBonusCtx && !defBuffCtx) return 'def'
    return 'atk'
  }

  const inferScaleStatFromDesc = (descRaw: unknown): CalcScaleStat => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'
    if (/(元素精通|精通)/.test(desc)) return 'mastery'
    if (/(基于|按).{0,20}(生命上限|生命值上限|最大生命值|生命值)/.test(desc)) return 'hp'
    if (/(基于|按).{0,20}防御力/.test(desc)) return 'def'
    if (/(基于|按).{0,20}(攻击力|攻击)/.test(desc)) return 'atk'
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
      }
      const data = (b as any).data
      if (data && typeof data === 'object' && !Array.isArray(data)) {
        for (const v of Object.values(data as Record<string, unknown>)) {
          if (typeof v === 'string') collectParamRefs(v)
        }
      }
    }

    const numMax: Record<string, number> = {}
    for (const d of plan.details || []) {
      const p = (d as any).params
      if (!p || typeof p !== 'object' || Array.isArray(p)) continue
      for (const [k0, v] of Object.entries(p as Record<string, unknown>)) {
        const k = String(k0 || '').trim()
        if (!k) continue
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
      const auto = srBuildMixedStatDmgExpr({ talent: talentKey, table: tableName, key, ele })
      if (auto) dmgExpr = auto
    }
    if (dmgExpr) {
      const talentKey = typeof d.talent === 'string' && d.talent ? d.talent : ''
      detailsLines.push('  {')
      detailsLines.push(`    title: ${title},`)
      if (talentKey) {
        detailsLines.push(`    talent: ${jsString(talentKey)},`)
      }
      // For reaction-only rows, baseline calc.js typically omits dmgKey to avoid accidental key-based buffs.
      if (kind !== 'reaction') {
        detailsLines.push(`    dmgKey: ${jsString(d.key || talentKey || 'e')},`)
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
        detailsLines.push(
          `    dmg: ({ talent, attr, calc, params, cons, weapon, trees, currentTalent }, dmg) => (${dmgExpr})`
        )
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

	    const dmgKeyProp = jsString(d.key || talent)
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
    const baseInferred =
      unitBase ||
      textBase ||
      ((input.game === 'gs' && !hasPerTableHint) || looksLikePlainPctUnit || looksLikePlainPctTextSample
        ? 'atk'
        : descBase) ||
      'atk'
    // SR: allow validated plan.stat overrides for HP/DEF-scaling kits.
    // (Tables often lack per-table unit markers; relying only on description heuristics can still miss.)
    const statOverrideRaw = typeof (d as any).stat === 'string' ? String((d as any).stat).trim().toLowerCase() : ''
    const statOverride =
      input.game === 'sr' && kind === 'dmg' && (statOverrideRaw === 'hp' || statOverrideRaw === 'def' || statOverrideRaw === 'atk')
        ? statOverrideRaw
        : ''
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
	      detailsLines.push(`    dmgKey: ${dmgKeyProp},`)
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
	    detailsLines.push(`    dmgKey: ${dmgKeyProp},`)
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
	    detailsLines.push(`    dmg: ({ talent, attr, calc }, dmg) => {`)
	    detailsLines.push(`      const t = talent.${talent}[${table}]`)
	    detailsLines.push(`      if (Array.isArray(t)) {`)
	    if (typeof pick === 'number' && Number.isFinite(pick)) {
	      // Array variant selector (e.g. "低空/高空..." or "X/Y..." tables).
	      detailsLines.push(`        const v = Number(t[${Math.max(0, Math.min(10, pick))}]) || 0`)
	      if (useBasic) {
	        detailsLines.push(`        return dmg.basic(calc(attr.${base}) * toRatio(v), ${keyArg}${eleArg})`)
	      } else {
	        detailsLines.push(`        return dmg(v, ${keyArg}${eleArg})`)
	      }
	    } else {
	      const schema = inferArrayTableSchema(input, talent, tableName)
	      if (schema?.kind === 'statStat') {
	        const [s0, s1] = schema.stats
	        detailsLines.push(
	          `        return dmg.basic(calc(attr.${s0}) * toRatio(t[0]) + calc(attr.${s1}) * toRatio(t[1]), ${keyArg}${eleArg})`
	        )
	      } else if (schema?.kind === 'statTimes') {
	        // e.g. [pct, hits] from `...2` tables where text sample is like "1.41%HP*5".
          // Default to per-hit output unless the title explicitly says "总/合计/一轮...".
          // (Baseline often compares per-hit rows; total rows should opt-in via title wording.)
          const titleHint = String(d.title || '')
          const wantsTotal =
            /(?:合计|总计|总伤|一轮|总)/.test(titleHint) &&
            !/(?:单次|单段|每段|每跳|每次)/.test(titleHint)
          if (wantsTotal) {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg((Number(t[0]) || 0) * (Number(t[1]) || 0), ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(
                `        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]) * (Number(t[1]) || 0), ${keyArg}${eleArg})`
              )
            }
          } else {
            if (schema.stat === 'atk' && !useBasic) {
              detailsLines.push(`        return dmg(Number(t[0]) || 0, ${keyArg}${eleArg})`)
            } else {
              detailsLines.push(`        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]), ${keyArg}${eleArg})`)
            }
          }
	      } else if (schema?.kind === 'pctList') {
	        detailsLines.push(`        const sum = t.reduce((acc, x) => acc + (Number(x) || 0), 0)`)
	        if (schema.stat === 'atk' && !useBasic) {
	          detailsLines.push(`        return dmg(sum, ${keyArg}${eleArg})`)
	        } else {
	          detailsLines.push(`        return dmg.basic(calc(attr.${schema.stat}) * toRatio(sum), ${keyArg}${eleArg})`)
	        }
	      } else if (schema?.kind === 'statFlat') {
          // "[pct, flat]" (e.g. "%HP + 800" / "%ATK + 500"). Always render as a basic damage number.
          // NOTE: miao-plugin's `dmg()` does NOT accept array pctNum; passing arrays can yield NaN damage.
          detailsLines.push(
            `        return dmg.basic(calc(attr.${schema.stat}) * toRatio(t[0]) + (Number(t[1]) || 0), ${keyArg}${eleArg})`
          )
	      } else if (useBasic) {
	        detailsLines.push(`        const base = calc(attr.${base})`)
	        detailsLines.push(`        const v = Number(t[0]) || 0`)
	        detailsLines.push(`        return dmg.basic(base * toRatio(v), ${keyArg}${eleArg})`)
	      } else {
          // Fallback: treat unknown arrays as variant lists and pick the first component as pctNum.
          // (Passing arrays into `dmg()` would yield NaN in miao-plugin runtime.)
          detailsLines.push(`        const v = Number(t[0]) || 0`)
          detailsLines.push(`        return dmg(v, ${keyArg}${eleArg})`)
	      }
	    }
	    detailsLines.push(`      }`)
	    if (useBasic) {
	      detailsLines.push(`      const base = calc(attr.${base})`)
	      detailsLines.push(`      return dmg.basic(base * toRatio(t), ${keyArg}${eleArg})`)
	    } else {
	      detailsLines.push(`      return dmg(t, ${keyArg}${eleArg})`)
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
  const firstKeyIdx = plan.details.findIndex((d) => !!detailKey(d))
  const fallbackIdx = firstKeyIdx >= 0 ? firstKeyIdx : 0
  const defDmgKey =
    (plan.defDmgKey && plan.defDmgKey.trim()) || detailKey(plan.details[fallbackIdx]) || 'e'
  const defDmgIdxRaw = plan.details.findIndex((d) => detailKey(d) === defDmgKey)
  const defDmgIdx = defDmgIdxRaw >= 0 ? defDmgIdxRaw : fallbackIdx

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
