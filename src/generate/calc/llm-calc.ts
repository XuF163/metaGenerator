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
import { chatWithDiskCache } from '../../llm/disk-cache.js'

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

export interface CalcSuggestResult {
  mainAttr: string
  defDmgKey?: string
  details: CalcSuggestDetail[]
}

function uniq(arr: string[]): string[] {
  return Array.from(new Set(arr))
}

function normalizeTableList(list: string[] | undefined): string[] {
  if (!Array.isArray(list)) return []
  return uniq(list.map((s) => String(s || '').trim()).filter(Boolean))
}

function clampDetails(details: CalcSuggestDetail[], max = 10): CalcSuggestDetail[] {
  const out: CalcSuggestDetail[] = []
  for (const d of details) {
    if (!d || typeof d !== 'object') continue
    if (out.length >= max) break
    if (!d.title || !d.talent || !d.table) continue
    out.push(d)
  }
  return out
}

function heuristicPlan(input: CalcSuggestInput): CalcSuggestResult {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const details: CalcSuggestDetail[] = []

  if (input.game === 'gs') {
    if (eTables[0]) details.push({ title: 'E伤害', talent: 'e', table: eTables[0], key: 'e' })
    if (qTables[0]) details.push({ title: 'Q伤害', talent: 'q', table: qTables[0], key: 'q' })
    if (aTables[0]) details.push({ title: '普攻伤害', talent: 'a', table: aTables[0], key: 'a', ele: 'phy' })
    return {
      mainAttr: 'atk,cpct,cdmg',
      defDmgKey: eTables[0] ? 'e' : qTables[0] ? 'q' : 'a',
      details
    }
  }

  // sr
  if (aTables[0]) details.push({ title: '普攻伤害', talent: 'a', table: aTables[0], key: 'a' })
  if (eTables[0]) details.push({ title: '战技伤害', talent: 'e', table: eTables[0], key: 'e' })
  if (qTables[0]) details.push({ title: '终结技伤害', talent: 'q', table: qTables[0], key: 'q' })
  if (tTables[0]) details.push({ title: '天赋伤害', talent: 't', table: tTables[0], key: 't' })
  return {
    mainAttr: 'atk,cpct,cdmg',
    defDmgKey: eTables[0] ? 'e' : qTables[0] ? 'q' : aTables[0] ? 'a' : 'e',
    details
  }
}

function buildMessages(input: CalcSuggestInput): ChatMessage[] {
  const aTables = normalizeTableList(input.tables.a)
  const eTables = normalizeTableList(input.tables.e)
  const qTables = normalizeTableList(input.tables.q)
  const tTables = normalizeTableList((input.tables as any).t)

  const allowedTalents = input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']

  const user = [
    `为 miao-plugin 生成 ${input.game === 'gs' ? '原神(GS)' : '星铁(SR)'} 角色 calc.js 的“最小可用”配置计划。`,
    '',
    '你只需要输出 JSON（不要 Markdown，不要多余文字）。',
    '',
    '要求：',
    `- 只允许使用 talent 表：${allowedTalents.join(',')}`,
    '- details 选择 3~8 条最常用的伤害项（不要太多）。',
    '- 每条 detail 的 table 必须来自我给出的表名列表，不能编造。',
    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal）。',
    '',
    `角色：${input.name} elem=${input.elem}${input.weapon ? ` weapon=${input.weapon}` : ''}${typeof input.star === 'number' ? ` star=${input.star}` : ''}`,
    '',
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
  const details = clampDetails(detailsRaw, 10).filter((d) => {
    if (!okTalents.has(d.talent)) return false
    const allowed = tables[d.talent] || []
    if (!allowed.includes(d.table)) return false
    return true
  })
  if (details.length === 0) {
    throw new Error(`[meta-gen] invalid LLM plan: no valid details`)
  }

  const defDmgKey = typeof plan.defDmgKey === 'string' ? plan.defDmgKey.trim() : undefined

  return { mainAttr, defDmgKey, details }
}

export async function suggestCalcPlan(
  llm: LlmService,
  input: CalcSuggestInput,
  cache?: Omit<LlmDiskCacheOptions, 'purpose'>
): Promise<CalcSuggestResult> {
  const messages = buildMessages(input)
  const text = cache
    ? await chatWithDiskCache(llm, messages, { temperature: 0.2 }, { ...cache, purpose: 'calc-plan' })
    : await llm.chat(messages, { temperature: 0.2 })
  const json = parseJsonFromLlmText(text)
  if (!json || typeof json !== 'object') {
    throw new Error(`[meta-gen] LLM output is not an object`)
  }

  const plan = json as Partial<CalcSuggestResult>
  const parsed: CalcSuggestResult = {
    mainAttr: typeof plan.mainAttr === 'string' ? plan.mainAttr : '',
    defDmgKey: typeof plan.defDmgKey === 'string' ? plan.defDmgKey : undefined,
    details: Array.isArray(plan.details) ? (plan.details as any) : []
  }
  return validatePlan(input, parsed)
}

export function renderCalcJs(input: CalcSuggestInput, plan: CalcSuggestResult, createdBy: string): string {
  const detailsLines: string[] = []
  detailsLines.push('export const details = [')

  plan.details.forEach((d, idx) => {
    const title = JSON.stringify(d.title)
    const talent = d.talent
    const table = JSON.stringify(d.table)

    const key = JSON.stringify(d.key || talent)
    const ele = typeof d.ele === 'string' && d.ele.trim() ? JSON.stringify(d.ele.trim()) : ''

    // Heuristic default: GS 普攻按物理计算（大多数角色）。
    const eleArg = ele ? `, ${ele}` : input.game === 'gs' && talent === 'a' ? `, "phy"` : ''

    detailsLines.push('  {')
    detailsLines.push(`    title: ${title},`)
    detailsLines.push(`    dmgKey: ${JSON.stringify(d.key || talent)},`)
    detailsLines.push(`    dmg: ({ talent }, dmg) => dmg(talent.${talent}[${table}], ${key}${eleArg})`)
    detailsLines.push(idx === plan.details.length - 1 ? '  }' : '  },')
  })

  detailsLines.push(']')

  const defDmgKey = (plan.defDmgKey && plan.defDmgKey.trim()) || (plan.details[0]?.key || plan.details[0]?.talent || 'e')
  const defDmgIdx = 0

  return [
    `// Auto-generated by ${createdBy}.`,
    detailsLines.join('\n'),
    '',
    `export const defDmgIdx = ${defDmgIdx}`,
    `export const defDmgKey = ${JSON.stringify(defDmgKey)}`,
    `export const mainAttr = ${JSON.stringify(plan.mainAttr)}`,
    '',
    'export const buffs = []',
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
