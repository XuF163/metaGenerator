/**
 * LLM-assisted calc.js generation.
 *
 * Strategy (safe for weak/slow models):
 * - Ask the model to output a small JSON plan (no JS code).
 * - Validate the plan locally.
 * - Render deterministic JS from the plan.
 *
 * If LLM is unavailable or returns invalid output, we fall back to a heuristic plan.
 */

import type { LlmService } from '../../llm/service.js'
import type { ChatMessage } from '../../llm/openai.js'
import { parseJsonFromLlmText } from '../../llm/json.js'
import type { LlmDiskCacheOptions } from '../../llm/disk-cache.js'
import { chatWithDiskCacheValidated } from '../../llm/disk-cache.js'

type TalentKeyGs = 'a' | 'e' | 'q'
type TalentKeySr = 'a' | 'e' | 'q' | 't'
type TalentKey = TalentKeyGs | TalentKeySr

// Requirement: generated calc.js should have a consistent signature.
const DEFAULT_CREATED_BY = 'awesome-gpt5.2-xhigh'

export interface CalcSuggestInput {
  game: 'gs' | 'sr'
  name: string
  elem: string
  weapon?: string
  star?: number
  // Candidate talent table names (must match keys available at runtime).
  tables: Partial<Record<TalentKey, string[]>>
  // Optional skill description text (helps LLM/heuristics pick correct damage tables).
  talentDesc?: Partial<Record<TalentKey, string>>
  /**
   * Optional extra text hints for buffs generation.
   * Keep each entry as a single line (passives/cons/traces/technique).
   */
  buffHints?: string[]
}

export interface CalcSuggestDetail {
  title: string
  talent: TalentKey
  table: string
  /**
   * The second argument passed to dmg() in calc.js.
   * - For GS: typically a/e/q/a2/a3...
   * - For SR: a/e/q/t...
   */
  key?: string
  /**
   * Optional third argument passed to dmg() (e.g. "phy", "vaporize").
   * Keep empty for normal elemental skills.
   */
  ele?: string
}

export interface CalcSuggestBuff {
  title: string
  /** Sort order (higher first in UI). */
  sort?: number
  /** Constellation / Eidolon requirement (1..6). */
  cons?: number
  /** SR major trace index (1..3/4) when applicable. */
  tree?: number
  /**
   * Optional condition expression (JS expression, NOT a function).
   * Rendered as: ({ talent, attr, calc, params, cons, weapon, trees }) => (<expr>)
   */
  check?: string
  /**
   * Buff data mapping:
   * - number: direct value
   * - string: JS expression (NOT a function), rendered into an arrow fn returning number
   */
  data?: Record<string, number | string>
}

export interface CalcSuggestResult {
  mainAttr: string
  defDmgKey?: string
  details: CalcSuggestDetail[]
  buffs?: CalcSuggestBuff[]
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

function normalizeTableList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return uniq(list.map((s) => String(s || '').trim()).filter(Boolean))
}

function clampDetails(details: CalcSuggestDetail[], max = 20): CalcSuggestDetail[] {
  const out: CalcSuggestDetail[] = []
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (out.length >= max) break
    if (!d.title || !d.talent || !d.table) continue
    out.push(d)
  }
  return out
}

function clampBuffs(buffs: Array<unknown>, max = 30): Array<unknown> {
  const out: Array<unknown> = []
  for (const b of buffs) {
    if (!b || typeof b !== 'object') continue
    if (out.length >= max) break
    if (!(b as any).title) continue
    out.push(b)
  }
  return out
}

function normalizePromptText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u00a0/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('\\n', ' ')
    .replaceAll('\n', ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function shortenText(text: string, maxLen: number): string {
  if (!text) return ''
  if (text.length <= maxLen) return text
  return `${text.slice(0, maxLen)}…`
}

function pickDamageTable(tables: string[]): string | undefined {
  const list = normalizeTableList(tables)
  // Prefer explicit damage tables; avoid cooldown/energy/toughness-only tables.
  const dmg = list.find((t) => /伤害/.test(t))
  if (dmg) return dmg
  // If no obvious damage table exists, skip (prevents generating nonsense like "战技伤害" -> "生命上限提高").
  return undefined
}

function heuristicPlan(input: CalcSuggestInput): CalcSuggestResult {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const details: CalcSuggestDetail[] = []

  if (input.game === 'gs') {
    const e = pickDamageTable(eTables)
    const q = pickDamageTable(qTables)
    const a = pickDamageTable(aTables)
    if (e) details.push({ title: 'E伤害', talent: 'e', table: e, key: 'e' })
    if (q) details.push({ title: 'Q伤害', talent: 'q', table: q, key: 'q' })
    if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a', ele: 'phy' })
    return {
      mainAttr: 'atk,cpct,cdmg',
      defDmgKey: e ? 'e' : q ? 'q' : 'a',
      details,
      buffs: []
    }
  }

  // sr
  const a = pickDamageTable(aTables)
  const e = pickDamageTable(eTables)
  const q = pickDamageTable(qTables)
  const t = pickDamageTable(tTables)
  if (a) details.push({ title: '普攻伤害', talent: 'a', table: a, key: 'a' })
  if (e) details.push({ title: '战技伤害', talent: 'e', table: e, key: 'e' })
  if (q) details.push({ title: '终结技伤害', talent: 'q', table: q, key: 'q' })
  if (t) details.push({ title: '天赋伤害', talent: 't', table: t, key: 't' })
  return {
    mainAttr: 'atk,cpct,cdmg',
    defDmgKey: e ? 'e' : q ? 'q' : a ? 'a' : 'e',
    details,
    buffs: []
  }
}

function buildMessages(input: CalcSuggestInput): ChatMessage[] {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const allowedTalents = input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']

  const descLines: string[] = []
  const desc = input.talentDesc || {}
  for (const k of allowedTalents as TalentKey[]) {
    const t = normalizePromptText((desc as any)[k])
    if (!t) continue
    descLines.push(`- ${k}: ${shortenText(t, 260)}`)
  }

  const buffHintLines: string[] = []
  const buffHints = Array.isArray(input.buffHints) ? input.buffHints : []
  for (const h of buffHints) {
    const t = normalizePromptText(h)
    if (!t) continue
    buffHintLines.push(`- ${shortenText(t, 260)}`)
  }

  const user = [
    `为 miao-plugin 生成 ${input.game === 'gs' ? '原神(GS)' : '星铁(SR)'} 角色 calc.js 的配置计划（尽量对标基线 calc.js 的“详细程度”）。`,
    '',
    '你只需要输出 JSON（不要 Markdown，不要多余文字）。',
    '',
    '要求：',
    `- 只允许使用 talent 表：${allowedTalents.join(',')}`,
    '- details 建议 6~12 条（最多 20）。尽量覆盖普攻/战技/终结技/天赋等核心伤害项，以及常见变体（点按/长按/多段/追加/反击等）。',
    '- 优先选择“可计算伤害”的表：通常表名包含「伤害」或类似字样；尽量不要选「冷却时间」「能量恢复」「削韧」等非伤害表。',
    '- 每条 detail 的 table 必须来自我给出的表名列表，不能编造。',
    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal）。',
    '- buffs 用于对标基线的增益/减益（天赋/行迹/命座/秘技等），输出一个数组（可为空）。',
    '- buffs[i].data 的值：数字=常量；字符串=JS 表达式（不是函数），可用变量 talent, attr, calc, params, cons, weapon, trees。',
    '- buffs[i].data 的 key 请尽量使用基线常见命名（避免自造）：',
    `  - GS 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,mastery,recharge,heal,dmg,phy,aDmg,eDmg,qDmg,kx,enemyDef`,
    `  - SR 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,dmg,aDmg,eDmg,qDmg,tDmg,speedPct,speedPlus,effPct,kx,enemyDef`,
    '- buffs 中如果需要引用天赋数值：只能使用 talent.a/e/q/t["<表名>"]，并且 <表名> 必须来自下方“可用表名”列表；禁止使用 talent.q2 / talent.talent / 乱写字段。',
    '- 不要发明 params 字段名（例如 targetHp）。如果条件依赖敌方状态/血量等运行时不可用信息，基线通常也不写 condition：直接给出常量 buff 或用 cons/tree 限制即可。',
    '',
    `角色：${input.name} elem=${input.elem}${input.weapon ? ` weapon=${input.weapon}` : ''}${typeof input.star === 'number' ? ` star=${input.star}` : ''}`,
    '',
    ...(descLines.length
      ? ['技能描述摘要（用于判断哪些表是伤害倍率/选择标题，不要复述）：', ...descLines, '']
      : []),
    ...(buffHintLines.length ? ['Buff 线索（用于生成 buffs，不要复述）：', ...buffHintLines, ''] : []),
    '可用表名（严格从这里选）：',
    `- a: ${JSON.stringify(aTables)}`,
    `- e: ${JSON.stringify(eTables)}`,
    `- q: ${JSON.stringify(qTables)}`,
    ...(input.game === 'sr' ? [`- t: ${JSON.stringify(tTables)}`] : []),
    '',
    '输出 JSON 结构：',
    '{',
    '  "mainAttr": "atk,cpct,cdmg",',
    '  "defDmgKey": "e",',
    '  "details": [',
    '    { "title": "E伤害", "talent": "e", "table": "技能伤害", "key": "e" }',
    '  ],',
    '  "buffs": [',
    '    { "title": "示例：1命提高暴击率[cpct]%", "cons": 1, "data": { "cpct": 12 } }',
    '  ]',
    '}'
  ].join('\n')

  return [
    {
      role: 'system',
      content:
        '你是一个谨慎的 Node.js/JS 工程师，熟悉 miao-plugin 的 calc.js 结构。' +
        ' 你必须严格按要求输出 JSON，不要输出解释、Markdown、代码块。'
    },
    { role: 'user', content: user }
  ]
}

function validatePlan(input: CalcSuggestInput, plan: CalcSuggestResult): CalcSuggestResult {
  const okTalents = new Set<TalentKey>(input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't'])
  const tables: Record<string, string[]> = {}
  for (const k of Object.keys(input.tables)) {
    tables[k] = normalizeTableList((input.tables as any)[k])
  }

  const mainAttr = typeof plan.mainAttr === 'string' ? plan.mainAttr.trim() : ''
  if (!mainAttr) {
    throw new Error(`[meta-gen] invalid LLM plan: mainAttr is empty`)
  }

  const detailsRaw = Array.isArray(plan.details) ? plan.details : []
  const details = clampDetails(detailsRaw, 20).filter((d) => {
    if (!okTalents.has(d.talent)) return false
    const allowed = tables[d.talent] || []
    if (!allowed.includes(d.table)) return false
    return true
  })
  if (details.length === 0) {
    throw new Error(`[meta-gen] invalid LLM plan: no valid details`)
  }

  const defDmgKey = typeof plan.defDmgKey === 'string' ? plan.defDmgKey.trim() : undefined

  const buffsOut: CalcSuggestBuff[] = []
  const buffsRaw = Array.isArray((plan as any).buffs) ? ((plan as any).buffs as Array<unknown>) : []
  for (const bRaw of clampBuffs(buffsRaw, 30)) {
    if (!bRaw || typeof bRaw !== 'object') continue
    const b = bRaw as Record<string, unknown>
    const title = typeof b.title === 'string' ? b.title.trim() : ''
    if (!title) continue

    const sort = typeof b.sort === 'number' && Number.isFinite(b.sort) ? Math.trunc(b.sort) : undefined
    const consRaw = typeof b.cons === 'number' && Number.isFinite(b.cons) ? Math.trunc(b.cons) : undefined
    const cons = consRaw && consRaw >= 1 && consRaw <= 6 ? consRaw : undefined
    const treeRaw = typeof b.tree === 'number' && Number.isFinite(b.tree) ? Math.trunc(b.tree) : undefined
    const tree = treeRaw && treeRaw >= 1 && treeRaw <= 10 ? treeRaw : undefined
    const check = typeof b.check === 'string' ? b.check.trim() : undefined

    let data: Record<string, number | string> | undefined
    const dataRaw = b.data
    if (dataRaw && typeof dataRaw === 'object' && !Array.isArray(dataRaw)) {
      const out: Record<string, number | string> = {}
      let n = 0
      for (const [k, v] of Object.entries(dataRaw as Record<string, unknown>)) {
        const kk = String(k || '').trim()
        if (!kk) continue
        if (n >= 50) break
        if (typeof v === 'number' && Number.isFinite(v)) {
          out[kk] = v
          n++
        } else if (typeof v === 'string') {
          const vv = v.trim()
          if (!vv) continue
          out[kk] = vv
          n++
        }
      }
      if (Object.keys(out).length) data = out
    }

    const out: CalcSuggestBuff = { title }
    if (typeof sort === 'number') out.sort = sort
    if (typeof cons === 'number') out.cons = cons
    if (typeof tree === 'number') out.tree = tree
    if (check) out.check = check
    if (data) out.data = data
    buffsOut.push(out)
  }

  return { mainAttr, defDmgKey, details, buffs: buffsOut }
}

export async function suggestCalcPlan(
  llm: LlmService,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
): Promise<CalcSuggestResult> {
  const messagesBase = buildMessages(input)
  const attempts: Array<{ temperature: number; messages: ChatMessage[] }> = [
    { temperature: 0.2, messages: messagesBase },
    {
      temperature: 0,
      messages: messagesBase.concat({
        role: 'user',
        content:
          '上一次输出可能不是严格 JSON。请重新输出：\n' +
          '- 只能输出一个 JSON 对象\n' +
          '- 所有 key 必须使用双引号\n' +
          '- 禁止尾随逗号\n' +
          '- 禁止输出任何 JSON 之外的文字'
      })
    }
  ]

  let lastErr: string | undefined
  for (let i = 0; i < attempts.length; i++) {
    const { temperature, messages } = attempts[i]!

    const text = cache
      ? await chatWithDiskCacheValidated(
          llm,
          messages,
          { temperature },
          { ...cache, purpose: `calc-plan.v2.${i}` },
          (t) => {
            try {
              const json = parseJsonFromLlmText(t)
              if (!json || typeof json !== 'object') return false
              const plan = json as Partial<CalcSuggestResult>
              const parsed: CalcSuggestResult = {
                mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
                defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
                details: Array.isArray(plan.details) ? (plan.details as any) : [],
                buffs: Array.isArray((plan as any).buffs) ? ((plan as any).buffs as any) : []
              }
              validatePlan(input, parsed)
              return true
            } catch {
              return false
            }
          }
        )
      : await llm.chat(messages, { temperature })

    try {
      const json = parseJsonFromLlmText(text)
      if (!json || typeof json !== 'object') {
        throw new Error(`[meta-gen] LLM output is not an object`)
      }

      const plan = json as Partial<CalcSuggestResult>
      const parsed: CalcSuggestResult = {
        mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
        defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
        details: Array.isArray(plan.details) ? (plan.details as any) : [],
        buffs: Array.isArray((plan as any).buffs) ? ((plan as any).buffs as any) : []
      }
      return validatePlan(input, parsed)
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
    }
  }

  throw new Error(lastErr || `[meta-gen] LLM calc plan failed`)
}

export function renderCalcJs(input: CalcSuggestInput, plan: CalcSuggestResult, createdBy: string): string {
  const inferDmgBase = (descRaw: unknown): 'atk' | 'hp' | 'def' => {
    const desc = normalizePromptText(descRaw)
    if (!desc) return 'atk'
    // Avoid mis-detecting buff-only skills by requiring damage wording.
    if (!/伤害/.test(desc)) return 'atk'
    if (/(生命上限|生命值上限|最大生命值|生命值)/.test(desc)) return 'hp'
    if (/防御力/.test(desc)) return 'def'
    return 'atk'
  }

  const ratioFnLine =
    input.game === 'gs'
      ? 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n / 100 : 0 }\n'
      : 'const toRatio = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0 }\n'

  const detailsLines: string[] = []
  detailsLines.push(ratioFnLine.trimEnd())
  detailsLines.push('export const details = [')

  plan.details.forEach((d, idx) => {
    const title = JSON.stringify(d.title)
    const talent = d.talent
    const table = JSON.stringify(d.table)

    const key = JSON.stringify(d.key || talent)
    const ele = typeof d.ele === 'string' && d.ele.trim() ? JSON.stringify(d.ele.trim()) : ''

    // Heuristic default: GS 普攻按物理计算（大多数角色）。
    const eleArg = ele ? `, ${ele}` : input.game === 'gs' && talent === 'a' ? `, "phy"` : ''

    const base = inferDmgBase((input.talentDesc as any)?.[talent])
    const useBasic = base !== 'atk' && /伤害/.test(d.table)

    detailsLines.push('  {')
    detailsLines.push(`    title: ${title},`)
    detailsLines.push(`    dmgKey: ${JSON.stringify(d.key || talent)},`)
    detailsLines.push(
      useBasic
        ? `    dmg: ({ talent, attr, calc }, dmg) => dmg.basic(calc(attr.${base}) * toRatio(talent.${talent}[${table}]), ${key}${eleArg})`
        : `    dmg: ({ talent }, dmg) => dmg(talent.${talent}[${table}], ${key}${eleArg})`
    )
    detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
  })

  detailsLines.push(']')

  const defDmgKey = (plan.defDmgKey && plan.defDmgKey.trim()) || (plan.details[0]?.key || plan.details[0]?.talent || 'e')
  const defDmgIdx = Math.max(
    0,
    plan.details.findIndex((d) => (d.key || d.talent) === defDmgKey)
  )

  const isIdent = (k: string): boolean => /^[$A-Z_][0-9A-Z_$]*$/i.test(k)
  const renderProp = (k: string): string => (isIdent(k) ? k : JSON.stringify(k))
  const isFnExpr = (s: string): boolean => /=>/.test(s) || /^function\b/.test(s)
  const wrapExpr = (expr: string): string =>
    `({ talent, attr, calc, params, cons, weapon, trees }) => (${expr})`

  const renderBuffValue = (v: unknown): string | undefined => {
    if (typeof v === 'number' && Number.isFinite(v)) return String(v)
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExpr(t)
  }

  const renderBuffCheck = (v: unknown): string | undefined => {
    if (typeof v !== 'string') return undefined
    const t = v.trim()
    if (!t) return undefined
    return isFnExpr(t) ? t : wrapExpr(t)
  }

  const buffs = Array.isArray(plan.buffs) ? (plan.buffs as CalcSuggestBuff[]) : []
  const buffsLines: string[] = []
  if (buffs.length === 0) {
    buffsLines.push('export const buffs = []')
  } else {
    buffsLines.push('export const buffs = [')
    buffs.forEach((b, idx) => {
      buffsLines.push('  {')
      buffsLines.push(`    title: ${JSON.stringify(b.title)},`)
      if (typeof b.sort === 'number' && Number.isFinite(b.sort)) {
        buffsLines.push(`    sort: ${Math.trunc(b.sort)},`)
      }
      if (typeof b.cons === 'number' && Number.isFinite(b.cons)) {
        buffsLines.push(`    cons: ${Math.trunc(b.cons)},`)
      }
      if (typeof b.tree === 'number' && Number.isFinite(b.tree)) {
        buffsLines.push(`    tree: ${Math.trunc(b.tree)},`)
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

      buffsLines.push(idx === buffs.length - 1 ? '  }' : '  },')
    })
    buffsLines.push(']')
  }

  return [
    `// Auto-generated by ${createdBy}.`,
    detailsLines.join('\n'),
    '',
    `export const defDmgIdx = ${defDmgIdx}`,
    `export const defDmgKey = ${JSON.stringify(defDmgKey)}`,
    `export const mainAttr = ${JSON.stringify(plan.mainAttr)}`,
    '',
    buffsLines.join('\n'),
    '',
    `export const createdBy = ${JSON.stringify(createdBy)}`,
    ''
  ].join('\n')
}

export async function buildCalcJsWithLlmOrHeuristic(
  llm: LlmService | undefined,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
): Promise<{ js: string; usedLlm: boolean; error?: string }> {
  if (!llm) {
    const plan = heuristicPlan(input)
    return { js: renderCalcJs(input, plan, DEFAULT_CREATED_BY), usedLlm: false }
  }

  try {
    const plan = await suggestCalcPlan(llm, input, cache)
    return { js: renderCalcJs(input, plan, DEFAULT_CREATED_BY), usedLlm: true }
  } catch (e) {
    const plan = heuristicPlan(input)
    return {
      js: renderCalcJs(input, plan, DEFAULT_CREATED_BY),
      usedLlm: false,
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
