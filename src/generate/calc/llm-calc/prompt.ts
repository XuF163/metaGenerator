import type { ChatMessage } from '../../../llm/openai.js'
import type { CalcSuggestInput } from './types.js'
import { normalizePromptText, normalizeTableList, shortenText } from './utils.js'

export function buildMessages(input: CalcSuggestInput): ChatMessage[] {
  const sortTalentKey = (a: string, b: string): number => {
    const order = [
      'a',
      'a2',
      'a3',
      'e',
      'e1',
      'e2',
      'q',
      'q2',
      't',
      't2',
      'z',
      'me',
      'me2',
      'mt',
      'mt1',
      'mt2'
    ]
    const ia = order.indexOf(a)
    const ib = order.indexOf(b)
    const na = ia === -1 ? 999 : ia
    const nb = ib === -1 ? 999 : ib
    if (na !== nb) return na - nb
    return a.localeCompare(b)
  }

  const tables: Record<string, string[]> = {}
  for (const [k, v] of Object.entries(input.tables || {})) {
    const kk = String(k || '').trim()
    if (!kk) continue
    tables[kk] = normalizeTableList(v as any)
  }

  const allowedTalents = Object.keys(tables)
    .filter((k) => (tables[k] || []).length > 0)
    .sort(sortTalentKey)
  if (allowedTalents.length === 0) {
    // Fallback: should not happen when caller provides `input.tables` correctly.
    allowedTalents.push(...(input.game === 'gs' ? ['a', 'e', 'q'] : ['a', 'e', 'q', 't']))
    allowedTalents.sort(sortTalentKey)
  }

  const descLines: string[] = []
  const desc = input.talentDesc || {}
  for (const k of allowedTalents) {
    const t = normalizePromptText((desc as any)[k])
    if (!t) continue
    descLines.push(`- ${k}: ${shortenText(t, 900)}`)
  }

  const buffHintLines: string[] = []
  const buffHints = Array.isArray(input.buffHints) ? input.buffHints : []
  for (const h of buffHints) {
    const t = normalizePromptText(h)
    if (!t) continue
    buffHintLines.push(`- ${shortenText(t, 520)}`)
  }

  const sampleLines: string[] = []
  const samples = input.tableSamples || {}
  for (const k of allowedTalents) {
    const v = (samples as any)[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length === 0) continue
    sampleLines.push(`- ${k}: ${shortenText(JSON.stringify(v), 500)}`)
  }

  const textSampleLines: string[] = []
  const textSamples = input.tableTextSamples || {}
  for (const k of allowedTalents) {
    const v = (textSamples as any)[k]
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue
    const keys = Object.keys(v as Record<string, unknown>)
    if (keys.length === 0) continue
    textSampleLines.push(`- ${k}: ${shortenText(JSON.stringify(v), 600)}`)
  }

  const unitHintLines: string[] = []
  const unitPick = (u: string): boolean =>
    /(普通攻击伤害|重击伤害|下落攻击伤害|元素战技伤害|元素爆发伤害|战技伤害|终结技伤害|天赋伤害|忆灵技伤害|忆灵天赋伤害)/.test(
      u
    )
  const units = input.tableUnits || {}
  for (const k of allowedTalents) {
    const m = (units as any)[k]
    if (!m || typeof m !== 'object' || Array.isArray(m)) continue
    const pairs: Array<[string, string]> = []
    for (const [name, unitRaw] of Object.entries(m as Record<string, unknown>)) {
      const nameT = String(name || '').trim()
      const u = normalizePromptText(unitRaw)
      if (!nameT || !u) continue
      if (!unitPick(u)) continue
      pairs.push([nameT, shortenText(u, 40)])
      if (pairs.length >= 12) break
    }
    if (pairs.length) unitHintLines.push(`- ${k}: ${JSON.stringify(pairs)}`)
  }

  const buffLikeTableLines: string[] = []
  const pickBuffLikeTables = (arr: string[]): string[] => {
    const out: string[] = []
    for (const t of arr || []) {
      if (!t) continue
      if (/(提升|增加|降低|加成|增伤|原本|倍率|抗性|防御|暴击|暴击率|暴击伤害|反应|月曜|月感电|月绽放|月结晶|夜魂|战意|层|枚|次数|上限)/.test(t)) {
        out.push(t)
      }
      if (out.length >= 12) break
    }
    return out
  }
  const pushBuffLike = (k: string, arr: string[]) => {
    const picks = pickBuffLikeTables(arr)
    if (picks.length) buffLikeTableLines.push(`- ${k}: ${JSON.stringify(picks)}`)
  }
  for (const k of allowedTalents) {
    pushBuffLike(k, tables[k] || [])
  }

  const user = [
    `为 miao-plugin 生成 ${input.game === 'gs' ? '原神(GS)' : '星铁(SR)'} 角色 calc.js 的配置计划（尽量对标基线 calc.js 的“详细程度”）。`,
    '',
    '你只需要输出 JSON（不要 Markdown，不要多余文字）。',
    '',
    '要求：',
    `- 只允许使用 talent 表：${allowedTalents.join(',')}`,
    '- details 建议 6~12 条（最多 20）。尽量覆盖普攻/战技/终结技/天赋等核心伤害项，以及常见变体（点按/长按/多段/追加/反击等），并补齐常见治疗/护盾/反应（如果该角色具备）。',
    '- 如果 Buff 线索（魂/行迹/秘技）中包含明确的“治疗/护盾数值公式”（例如 X%生命上限+Y、X%防御力+Y），可以额外加入 1~3 条独立 detail 行用于展示（可设置 cons/tree/params/check）。不要把这种“单次数值”误写成全局 buff。',
    '- details[i].kind 可选：dmg / heal / shield / reaction；不写默认为 dmg。',
    '- 优先选择“可计算伤害”的表：通常表名包含「伤害」或类似字样；尽量不要选「冷却时间」「能量恢复」「削韧」等非伤害表。',
    '- kind=dmg/heal/shield：必须给出 talent + table；并且 table 必须来自我给出的表名列表，不能编造。',
    '- kind=heal/shield：请给出 stat（atk/hp/def/mastery）表示百分比部分基于哪个面板属性计算。',
    '- 若你选择的表在运行时返回数组并表示多个“变体倍率”（常见于表名含 "/"，且数组每个元素都是一个百分比倍率），可以额外输出 pick（0-based）来选择使用哪个元素；或拆成多条 detail 并分别设置 pick。',
    '- GS 提示：很多治疗/护盾会同时存在 "治疗量" 和 "治疗量2"（或 "护盾吸收量" / "护盾吸收量2"）。优先选择带 2 的表（通常是 [百分比, 固定值]），不带 2 的同名表往往只是展示用的“百分比+固定值”，不能直接乘面板。',
    '- kind=reaction：仅用于“无表/纯剧变反应”计算（不需要 talent/table），例如 swirl/crystallize/bloom/hyperBloom/burgeon/burning/overloaded/electroCharged/superConduct/shatter。',
    '  - 不要用 kind=reaction 表达蒸发/融化/激化/蔓激化：这些请用 kind=dmg + ele="vaporize/melt/aggravate/spread"。',
    '  - GS 月曜反应（月感电/月绽放/月结晶）：不是 kind=reaction；它们通常是“带表的基础伤害 + 月曜反应加成”，应使用 kind=dmg 并设置 ele="lunarCharged/lunarBloom/lunarCrystallize"。',
    '  - 注意：不要把 ele="lunarCharged/lunarBloom/lunarCrystallize" 用在普通技能伤害上；仅当表名/描述明确为月曜反应或月曜相关追加伤害时才使用。',
    '- details 可选字段：params/check/cons 用于描述“状态/变体”（对标基线 calc.js 的复杂度）。',
    '  - params: 仅允许 number/boolean/string；用于给 miao-plugin 传入默认状态（如 Nightsoul/Moonsign/BondOfLife/层数/开关）。',
    '  - check: 仅允许 JS 表达式（不要写 function/箭头函数）；可用变量 talent, attr, calc, params, cons, weapon, trees。不要使用 currentTalent（details 的 check/dmg 中不可用）。',
    '  - 重要：calc(...) 只能写成 calc(attr.xxx)（单参数且参数只能是 attr 的一级字段）；不要写 calc(attr.recharge - 100) / calc(attr.atk * 2)。需要运算请写在 calc(...) 外面，例如 (calc(attr.recharge) - 100) * 0.4。',
    '  - 禁止引用不存在的变量（例如 key/title/index/name）。',
    '  - 禁止使用 talent.key（运行时不存在）；若需要按招式区分（a/e/q/t/a2/a3...），只允许在 buffs.check/buffs.data 中使用 currentTalent 来判断。',
    '  - 禁止使用 calc.xxx / calc.xxx()（calc 是函数，不是对象）。',
    '  - 禁止使用未定义的自由变量（例如 fire/ice/wind/追加攻击/targetHp 等）；只能使用已声明变量 + 字符串常量 + 数字常量。',
    '  - cons: 1..6；用于限制该 detail 只在对应命座生效时展示/计算。',
    '  - 如果某些伤害在特定状态下才成立（例如 夜魂、月兆、Q期间、满层/满战意），请用不同的 detail 行来表达：',
    '    - 通过 key 使用标签（例如 "e,nightsoul" / "q,nightsoul"）来触发对应的增益域；必要时配合 params 设置默认状态。',
    '    - GS params 约定（推荐）：e/q/off_field/halfHp 等；例如 E后状态 detail 写 params: { e: true }；对应 buff 用 params.e 判定；半血阈值用 params.halfHp（≤50%）。',
    '    - 如果描述明确是固定层数（例如 2层/满层），直接按该层数输出，不要额外引入 stack 参数；只有层数可调时才用 params。',
    '    - 若表名/描述出现 "0/1/2/3" 这种档位（例如「汲取0/1/2/3枚...」），并且该表在运行时返回数组，默认按最大档位（最后一个索引）使用，不要额外引入 params。',
    '    - 若机制是可叠加的数值（例如 战意/层数/计数），请用一个数值型 params 表示叠加层数，并至少给出 1 条 detail 用最大值（满层/满战意/上限）。',
    '    - 对于“生命值低于/高于xx%”这类当前血量条件：不要用 attr.hp/hpBase 做判断；可用 params.halfHp 开关表达（仅在对应行/条件下启用）。',
    '- GS key 建议：普攻=a，重击=a2，下落=a3；元素战技=e；元素爆发=q；可在后面追加标签（逗号分隔）。',
    '- GS: 关于 details[i].ele（dmg(...) 的第三参）：',
    '  - ele 是“元素/反应”参数（如 vaporize/melt/... 或 phy）。绝大多数条目不要写 phy（会切换到物伤加成桶，可能丢失通用 dmg 加成），只有明确需要物理体系/物理特化时才写。',
    '  - weapon=catalyst：普攻/重击/下落默认都是元素伤害（不要写 phy）。',
    '  - weapon=bow：普攻/非满蓄力箭在游戏里多为物理；但同样只有需要物理桶时才写 phy。满蓄力/元素箭不要写 phy。',
    '  - 其他近战武器：普攻/重击/下落在游戏里多为物理，但基线 calc.js 经常省略 phy（让其走通用 dmg 加成桶）。只有当该角色明确走物理体系（物伤杯/物理拐/物理主C）或标题/表名明确写“物理”时才写 phy；若存在元素附魔/状态，请用 params+buff/check 表达。',
    '- GS 提示：若你在 talent.e 里看到像普攻一样的表名（例如「一段伤害/五段伤害/重击伤害」），通常表示“E状态下普攻倍率被替换”。此时请用 talent=e 的表作为 table，但 key 仍然用 a/a2（以便吃到普攻/重击相关增益）。',
    '- GS 提示：如果某个表的 unit（单位提示）是「普通攻击伤害/重击伤害/下落攻击伤害/元素战技伤害/元素爆发伤害」等，通常表示“倍率/增益表”，不是直接技能倍率。',
    '  - 这类表不要直接用于 details 的 dmg(...)。',
    '  - 应在 buffs 中表达：',
    '    - “伤害提升/伤害提高/造成的伤害提升” => *Dmg（例如 qDmg）',
    '    - “倍率提高/倍率提升/系数提高” => *Pct（例如 qPct）',
    '    - 只有明确“造成原本X%/倍率变为X%/改为X%”这类“总倍率变更”才用 *Multi（例如 qMulti）',
    '  - 重要：不要在表达式里写 `- 100` 来“换算倍率”。',
    '    - 若表值本身就是“总倍率%”（常见 100~400），请直接输出数字（例如 137.9），本地会自动折算为 Multi 的 delta。',
    '    - 若表值很小（例如 0.3），通常是“每点能量/每层/每次”的系数：应乘上对应的能量/层数（优先用 talent.q["元素能量"] 或 params.num），不要减 100。',
    '    - 常见例子：talent.e 存在「元素爆发伤害提高」（数值很小），且 q 表存在「元素能量」时，通常表示“每点能量提升X%爆发伤害”：buff 应写 qDmg = talent.e["元素爆发伤害提高"] * talent.q["元素能量"]。',
    '    - 常见例子：被动写“元素伤害加成提升程度相当于元素充能效率的20%” => buff 写 dmg = calc(attr.recharge) * 0.2。',
    '    - 常见例子：被动写“基于元素充能效率超过100%的部分，每1%提升0.4%元素伤害加成” => dmg = Math.max(calc(attr.recharge) - 100, 0) * 0.4。',
    '    - 若 q 表存在「伤害加成」这类 buff 表名，通常应写入 buffs（例如 dmg: talent.q["伤害加成"]），不要当作 details 的伤害倍率表。',
    '- GS 提示：若 a 表存在明显的“特殊重击/蓄力形态”表名（例如包含「重击·」/「持续伤害」/「蓄力」），请让“重击伤害/重击”条目优先代表该特殊形态，而不是普通「重击伤害」。',
    '- SR key 建议：普攻=a；战技=e；终结技=q；天赋=t（追击等）；可在后面追加逗号标签。',
    '- SR 重要提示：表名含「提高/提升/增加/加成/增伤/抗性穿透/无视防御/防御降低/概率/效果命中/效果抵抗/击破效率/削韧」通常是 buffs/debuff 表，不要把它当作 details 的“伤害倍率表”用于 dmg(...)；应写入 buffs.data（否则会把 buff 当成伤害倍率，面板回归会出现 1.5x~3x 的离群偏差）。',
    '  - 例：talent.t["伤害提高"] => buffs: { dmg: talent.t["伤害提高"] }（SR 通常还需要 *100 转为百分数点）。',
    '  - 例：talent.q["抗性穿透提高"] => buffs: { kx: talent.q["抗性穿透提高"] }（并建议用 params.qBuff gating）。',
    '  - 例：talent.q["防御力降低"] => buffs: { enemyDef: talent.q["防御力降低"] }。',
    '  - 例："...基础概率..." / "...效果命中..." 不影响伤害，不要写成 dmg/eDmg/qDmg。',
    '  - 例："...能量恢复/能量回复/回能..." 属于能量机制，不是伤害倍率表；不要输出到 details（否则会把回能当作伤害，面板回归会出现离群值）。',
    '- SR 相邻目标：若同一招式存在「X」与「X(2)」，且 detail 标题包含「相邻/次要目标」，优先用「X(2)」。',
    '- SR 标题规范（用于面板对标）：多目标用「主目标/相邻目标/完整」等基线常用词；避免用「单体/群体」这类泛化词导致标题无法匹配。',
    '  - 示例：战技伤害(主目标)、战技伤害(相邻目标)、战技伤害(完整)。',
    '  - 单目标默认直接写「普攻伤害/战技伤害/终结技伤害」，不要额外加「(单目标)」；只有需要与多目标行区分时才加。',
    '- SR 多目标合计：若描述/表名明确存在相邻目标/扩散/弹射/全体等多目标机制，请同时提供“主目标”与“完整多目标合计”两行（必要时用 dmgExpr 合计，并按描述中的重复次数/段数/弹射次数合计）。',
 	    '- details 可选字段：dmgExpr 用于表达复杂公式（当需要多属性混合、多段合计、或多表/条件分支时）。',
 	    '  - dmgExpr: JS 表达式（不要写 function/箭头函数），必须返回 dmg(...) 的结果对象；可用变量 talent, attr, calc, params, cons, weapon, trees, dmg, toRatio；不要使用 currentTalent（detail 运行时不可用）。',
	    '  - 重要：dmgExpr 禁止返回裸数字；必须返回 dmg(...)/dmg.basic(...)/dmg.dynamic(...)/heal(...)/shield(...)/reaction(...) 的返回值，或形如 { dmg: xxx, avg: xxx } 的对象。',
	    '  - 重要：不要写 dmg.e(...)/dmg.q(...) 这类调用（dmg 不是对象）。',
 	    '  - GS: 如果 talent.<a/e/q>["表名2"] 在运行时返回数组（如 [atkPct, masteryPct] 或 [pct, flat]），请在 dmgExpr 中用 [0]/[1] 取值，不要直接把数组传给 dmg(...)。',
 	    '  - GS: 如果“表值文字样本”里出现 "*N"（例如 "57.28%*2" / "1.41%HP*5" / "80%ATK×3"），并且该表的样本值形如 [x, N]，表示“多段/次数倍率”，应使用乘法：base * x/100 * N（不要写成 + N）。',
	    '  - 提示：如果“表值样本”里出现了某个表名，说明该表在运行时返回数组/对象；不在样本里的表通常是 number。',
	    '  - 对于出现在“表值样本”里的表名（通常以 2 结尾），优先选它作为 table；常见 [pct,flat] / [pct,hits] / [%stat + %stat] 由生成器处理，只有复杂合计才用 dmgExpr。',
	    '  - 若同一招式同时存在 X 与 X2 两个表名，且 X2 出现在“表值样本”（数组）里：优先只输出 X2（更准确），不要重复输出 X（避免重复与误判缩放）。',
	    '  - 如需多项/分支/多段合计计算，配合 dmgExpr。',
	    '  - 多属性混合模板（ATK+精通）：dmg.basic(calc(attr.atk) * toRatio(talent.e["表名2"][0]) + calc(attr.mastery) * toRatio(talent.e["表名2"][1]), "e")',
	    '  - GS: 对于“纯倍率伤害”（单表、单倍率、无混合/无额外加法），优先直接用 dmg(talent.<a/e/q>["表名"], "<key>")；不要用 dmg.basic(calc(attr.atk) * toRatio(...)) 重新实现，避免单位/漏算导致离谱偏差。',
	    '  - 注意：dmg(...) / dmg.basic(...) 只允许 2~3 个参数：(倍率或基础数值, key, ele?)；第三参只能是 ele 字符串或省略；禁止传入对象/额外参数。',
	    '  - GS: ele 第三参只能省略（不传，禁止传空字符串 ""）、"phy" 或反应ID（melt/vaporize/aggravate/spread/swirl/burning/overloaded/electroCharged/bloom/burgeon/hyperBloom/crystallize/superConduct/shatter 以及 lunarCharged/lunarBloom/lunarCrystallize）。禁止使用元素名 anemo/geo/electro/dendro/hydro/pyro/cryo 作为 ele。',
	    '  - 即使使用 dmgExpr，也请填写 talent/table/key 作为主表与归类 key（用于 UI 与默认排序）。',
	    '- mainAttr 只输出逗号分隔的属性 key（例如 atk,cpct,cdmg,mastery,recharge,hp,def,heal,stance,speed）。',
	    '- buffs 用于对标基线的增益/减益（天赋/行迹/命座/秘技等），输出一个数组（可为空）。',
	    '- buffs[i].data 的值：数字=常量；字符串=JS 表达式（不是函数，不要写箭头函数/function/return），可用变量 talent, attr, calc, params, cons, weapon, trees, currentTalent（不可用 dmg）。',
	    '- buffs[i].data 的 key：不要给真正的增益 key 加前缀 "_"（例如 _a2Plus/_qPct）；前缀 "_" 仅用于 title 里的占位符展示（例如 [_zy]）。',
	    '- buffs[i].data 的数值单位：*Pct/*Dmg/cpct/cdmg/dmg/enemydmg/recharge/kx/enemyDef/ignore 等用“百分比数值”（+20% -> 20）；*Plus 用“面板数值”（例如 atkPlus: calc(attr.def) * 0.35），不要 *100。不要在 buff.data 里使用 toRatio()。',
	    '- buffs 只写“持续性/常驻”的属性增益、伤害加成、减抗/减防等；不要把「命中后回复/受击触发/施放后额外治疗/追加伤害」这类触发效果写进 buffs.data（尤其不要写 heal: calc(attr.atk)*...）。触发治疗/追加伤害请用 details(kind=heal/dmg) 表达。',
	    '- buffs 尽量写清楚 check/params 以限定生效范围，避免“无条件全局增益”污染其他技能（尤其是 ePlus/qPlus/aPlus 等）。',
	    '- buffs: 若效果只影响某个技能的伤害/暴击（如“终结技暴击率提高/终结技伤害提高/战技伤害提高/天赋反击伤害提高”），优先使用技能前缀 key：aDmg/eDmg/qDmg/tDmg、aCpct/eCpct/qCpct、aCdmg/eCdmg/qCdmg 等；不要误用全局 cpct/cdmg/dmg。',
	    '- buffs: 「受到伤害降低/减伤/伤害减免」等只影响承伤，不影响面板输出伤害的效果，不要写进 buffs.data。',
	    '- buffs: 「无视X%防御」=> ignore / aIgnore/eIgnore/qIgnore/tIgnore；「防御力降低X%」=> enemyDef（不要把无视防御写成 enemyDef）。',
 	    '- buffs: 如果文案包含“处于/在…状态/施放后/持续期间/命中后/满层/上限/至多叠加/初辉/满辉/夜魂/月兆/战意”等状态或层数：',
 	    '  - 必须写 check，并使用 params.<State> / params.<stacks> 做条件；同时确保至少有 1 条 detail 设置对应 params 使该 buff 生效（对标基线展示行通常按满状态/满层）。',
 	    '  - 若文案明确写死层数（例如 300层/3枚/满层），请直接在 buff 表达式里乘上该常量，不要漏乘；只有层数可变时才引入 params.stacks。',
 	    '  - “层数上限提升X/额外获得X层”不要用 qPlus/qMulti 等；应把“每层提供的比例” * X，计入 dmg/healInc 等对应 key。',
	    '  - 重要：若某个“提升/额外提升”表的单位提示包含 生命值/防御力/精通/…(/层)（按属性给出倍率），它不是 *Multi% 增伤；应当作为“追加倍率/追加伤害值”计入 dmg.basic(...) 的倍率里，或用 *Plus 写成 calc(attr.<stat>) * (table/100)（按层再乘层数），不要误做 -100。',
	    '- 如果需要“基于属性追加伤害值”，使用 aPlus/a2Plus/a3Plus/ePlus/qPlus 等 *Plus key；不要误用 aDmg/eDmg/qDmg/dmg。',
 	    '- 如果描述是“提升/提高 X%攻击力(生命值上限/防御力/元素精通) 的伤害/追加值”（例如 640%攻击力），这属于 *Plus：请写成 calc(attr.atk) * (X/100)（例如 640% => calc(attr.atk) * 6.4），不要把 640 当成常量。',
	    '- SR 额外强调（很容易写错）：',
	    '  - 文案「施放普攻/战技/终结技/天赋(反击)时，额外造成等同于自身(生命上限/防御力/攻击力)X%的…属性伤害」=> 这是“追加伤害值”，使用 aPlus/ePlus/qPlus/tPlus：calc(attr.<stat>) * (X/100)，不要误写成 hpPct/defPct/atkPct 或 aDmg/eDmg/qDmg。',
	    '  - 文案「使反击造成的伤害值提高，提高数值等同于防御力的X%」=> tPlus：calc(attr.def) * (X/100)，不是 defPct。',
	    '  - 治疗/护盾通常是「百分比*面板属性 + 固定值」两张表：请用 kind=heal/shield，并在 dmgExpr 中合并两表，例如 heal(calc(attr.hp) * toRatio(talent.e[\"治疗·百分比生命\"]) + (Number(talent.e[\"治疗·固定值\"])||0))；护盾类似 shield(calc(attr.def) * toRatio(talent.e[\"百分比防御\"]) + (Number(talent.e[\"固定值\"])||0))。',
	    '  - 击破/超击破：如果描述/表名出现「击破/超击破/击破伤害比例/超击破伤害比例」，请至少输出 1~2 条击破展示行。',
	    '    - 可用 kind=reaction + reaction=\"<元素>Break|superBreak\"，并可用 dmgExpr 叠乘表倍率：{ dmg: reaction(\"iceBreak\").dmg * toRatio(talent.q[\"击破伤害比例\"]), avg: reaction(\"iceBreak\").avg * toRatio(talent.q[\"击破伤害比例\"]) }。',
	    '    - 元素->Break 映射：物理 physicalBreak；火 fireBreak；冰 iceBreak；雷 lightningBreak；风 windBreak；量子 quantumBreak；虚数 imaginaryBreak；超击破 superBreak。',
	    '  - SR 超击破（很容易漏）：超击破伤害通常与“削韧(韧性伤害/次数)”线性相关。若要对标基线，建议在超击破展示行用 dmgExpr 缩放：({ avg: (reaction(\"superBreak\").avg || 0) / 0.9 * (talent.<a/e/...>[\"削韧\"] || 1) })（削韧是常量表，可直接引用）。',
	    '  - SR 行迹(树)条件：来自「行迹N」的增益必须写入 buffs，并设置 buffs[i].tree=N 作为解锁门槛（不要手写 trees[\"101\"] 这类判断，更不要常驻生效）。',
	    '  - SR 固定暴击：若文案出现「暴击率固定为X%」「暴击伤害固定为Y%」「该伤害必定暴击」且作用于“附加伤害/追加伤害”，请用 dmgExpr + skillDot：({ avg: (dmg(talent.q[\"附加伤害\"], \"\", \"skillDot\").avg || 0) * (1 + (X/100) * (Y/100)) })；必要时结合 cons 分支（例如 cons>=6 时固定暴伤提高）。',
 	    '- 如果这个“追加伤害值”只对某个特定招式/特定表名生效（而不是所有 E/Q/普攻都生效），不要用全局 ePlus/qPlus/aPlus；请在对应 detail 用 dmgExpr 把 extra 直接加到 dmg/avg 上（dmgExpr 只能是表达式，不能写 const/return/function/箭头函数）。可用这种写法（允许重复调用 dmg）：{ dmg: dmg(...).dmg + extra, avg: dmg(...).avg + extra }。',
	    '- GS: kx 用于“敌人抗性降低”；enemyDef/enemyIgnore 用于“防御降低/无视防御”；fypct/fyplus/fybase/fyinc 用于剧变/月曜反应增益，不要把抗性降低误写成 fypct。',
	    '- 如果描述是“造成原本170%的伤害/提高到160%”这类乘区倍率，使用 aMulti/a2Multi/qMulti 等 *Multi key（数值仍用百分比数值，例如 170）。',
	    '- 若是“月曜反应伤害提升”，使用 lunarBloom/lunarCharged/lunarCrystallize 作为 buff.data key（数值为百分比数值）。',
    '- buffs[i].data 的 key 请尽量使用基线常见命名（避免自造）：',
    `  - GS 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,mastery,recharge,heal,healInc,shield,shieldInc,dmg,phy,_shield,kx,enemyDef,fypct,fyplus,fybase,fyinc,lunarBloom,lunarCharged,lunarCrystallize,以及 (a|a2|a3|e|q|nightsoul)(Dmg|Plus|Cpct|Cdmg|Multi|Pct)；反应类：swirl,crystallize,bloom,hyperBloom,burgeon,burning,overloaded,electroCharged,superConduct,shatter`,
    `  - GS 元素伤害加成统一用 dmg（不要用 pyro/hydro/... 等元素名）。`,
    `  - SR 常见：atkPct,atkPlus,hpPct,hpPlus,defPct,defPlus,cpct,cdmg,dmg,aDmg,eDmg,qDmg,tDmg,aPlus,ePlus,qPlus,tPlus,speedPct,speedPlus,effPct,stance,kx,enemyDef`,
    '- buffs 中如果需要引用天赋数值：只能使用 talent.<talentKey>["<表名>"]，其中 talentKey 必须来自下方“可用表名”列表；禁止使用 talent.talent / 动态索引 / 乱写字段。',
    ...(input.game === 'sr'
      ? [
          '- SR：若“可用表名”里包含 me/mt/me2/mt1/mt2 等（忆灵相关），details 应覆盖这些表（至少输出 1-2 条忆灵伤害/机制行）。',
          '- SR：秘技（z）多为开战前一次性效果；不要把“造成100%攻击力伤害”误写成 “攻击力提高100%/atkPct=100”。只有明确写“提高/降低…属性/受到伤害提高”才生成 buffs。'
        ]
      : []),
    '- params 字段名请尽量使用基线常见命名（例如 Nightsoul/Moonsign/BondOfLife）。不要发明需要运行时敌方状态/血量等不可用信息的字段。',
    '- 重要：enemyDef/kx/enemyIgnore/ignore 等“减防/减抗/无视防御”相关数值使用正数表示（不要写成负数）。例如“降低防御力20%” => enemyDef: 20。',
    '- 重要：如果你在 buffs.check / buffs.data 的表达式里引用 params.xxx，则必须保证至少有一条 details.params（或 defParams）提供 params.xxx；否则不要引用它（避免 buff 死亡或掉到低档分支）。',
    '',
    `角色：${input.name} elem=${input.elem}${input.weapon ? ` weapon=${input.weapon}` : ''}${typeof input.star === 'number' ? ` star=${input.star}` : ''}`,
    '',
    ...(descLines.length
      ? ['技能描述摘要（用于判断哪些表是伤害倍率/选择标题，不要复述）：', ...descLines, '']
      : []),
    ...(buffHintLines.length ? ['Buff 线索（用于生成 buffs，不要复述）：', ...buffHintLines, ''] : []),
    ...(buffLikeTableLines.length
      ? ['疑似增益/机制表名（可用于生成 buffs 或确定 params，不要编造）：', ...buffLikeTableLines, '']
      : []),
    ...(unitHintLines.length ? ['表单位提示（重要：用于判断“倍率/增益表”，不要复述）：', ...unitHintLines, ''] : []),
    '可用表名（严格从这里选）：',
    ...allowedTalents.map((k) => `- ${k}: ${JSON.stringify(tables[k] || [])}`),
    '',
    ...(sampleLines.length ? ['表值样本（仅用于判断表是否返回数组）：', ...sampleLines, ''] : []),
    ...(textSampleLines.length
      ? ['表值文字样本（用于理解数组每一项对应的属性含义，不要复述）：', ...textSampleLines, '']
      : []),
    '输出 JSON 结构：',
    '{',
    '  "mainAttr": "atk,cpct,cdmg",',
    '  "defDmgKey": "e",',
    '  "details": [',
    '    { "title": "E伤害(夜魂)", "kind": "dmg", "talent": "e", "table": "技能伤害", "key": "e,nightsoul", "params": { "Nightsoul": true }, "check": "params.Nightsoul === true" },',
    '    { "title": "复杂公式示例", "kind": "dmg", "talent": "e", "table": "技能伤害2", "key": "e", "dmgExpr": "dmg.basic(calc(attr.hp) * toRatio(talent.e[\\\"技能伤害2\\\"][0]) + (Number(talent.e[\\\"技能伤害2\\\"][1]) || 0), \\\"e\\\")" },',
    '    { "title": "Q治疗", "kind": "heal", "talent": "q", "table": "治疗量", "stat": "hp", "key": "q" },',
    '    { "title": "扩散反应伤害", "kind": "reaction", "reaction": "swirl" }',
    '  ],',
    '  "buffs": [',
    '    { "title": "示例：1命提高暴击率[cpct]%", "cons": 1, "data": { "cpct": 12 } }',
    '  ]',
    '}'
  ].join('\n')

  // Some LLM endpoints hard-fail on very large prompts. Keep a compact fallback that
  // drops low-signal sections (samples/hints) and compresses table lists.
  const formatTablesCompact = (arr: string[]): string => {
    const list = normalizeTableList(arr)
    const limit = 40
    const shown = list.slice(0, limit).join(' | ')
    return list.length > limit ? `${shown} ...(+${list.length - limit})` : shown
  }
  const userCompact = [
    `为 miao-plugin 生成 ${input.game === 'gs' ? '原神(GS)' : '星铁(SR)'} 角色 calc.js 的配置计划。只输出 JSON。`,
    '',
    `- 只允许使用 talent 表：${allowedTalents.join(',')}`,
    '- 输出结构：{ "mainAttr": "...", "defDmgKey": "e", "details": [...], "buffs": [...] }',
    '- details 6~12 条为宜（<=20）：覆盖核心伤害与常用变体；若存在治疗/护盾表也要包含。',
    '- 蒸发/融化/激化/蔓激化：用 kind=dmg + ele="vaporize/melt/aggravate/spread"。',
    '- 剧变反应：用 kind=reaction + reaction="swirl/crystallize/bloom/hyperBloom/burgeon/burning/overloaded/electroCharged/superConduct/shatter"。',
    ...(input.game === 'sr'
      ? [
          '- SR 标题：多目标用「主目标/相邻目标/完整」等常用词；单目标通常不写「(单目标)」；避免「单体/群体」。',
          '- SR 多目标：若描述/表名出现相邻目标/扩散/弹射/全体等机制，请输出“主目标”与“完整多目标合计”两行（必要时用 dmgExpr 合计）。',
          '- SR 击破/超击破：用 kind=reaction + reaction="<元素>Break|superBreak"；需要表倍率时用 dmgExpr 叠乘（reaction("iceBreak")...）。',
          '- SR buffs：若 buff 来源于「行迹N」，必须写 tree:N；若来源于「N魂」，必须写 cons:N（否则会常驻导致面板对标离群）。',
          '- SR buffs：技能专属增益优先用 aDmg/eDmg/qDmg/tDmg、qCpct/qCdmg 等；无视防御用 ignore；防御降低用 enemyDef；不要输出“受到伤害降低/减伤”。',
          '- SR dmgExpr：dmg(x,key) 默认按攻击力倍率；若该表/招式是生命/防御缩放，必须写 dmg.basic(calc(attr.hp/def) * toRatio(x), key)（不要用 dmg(x,key)）。'
        ]
      : []),
    '- buffs：从 Buff 线索中提炼 2~8 条常用 buff；表达式仅写 JS 表达式（不要 function/箭头）。如引用 params.xxx，需在 detail.params 或 defParams 提供默认值。',
    '',
    `角色：${input.name} elem=${input.elem}${input.weapon ? ` weapon=${input.weapon}` : ''}${typeof input.star === 'number' ? ` star=${input.star}` : ''}`,
    '',
    ...(descLines.length ? ['技能描述摘要：', ...descLines.slice(0, 10), ''] : []),
    ...(buffHintLines.length ? ['Buff 线索：', ...buffHintLines.slice(0, 14), ''] : []),
    '可用表名（严格从这里选）：',
    ...allowedTalents.map((k) => `- ${k}: ${formatTablesCompact(tables[k] || [])}`),
    ''
  ].join('\n')

  const userText = user.length > 18_000 ? userCompact : user
  const userTextFinal =
    input.game === 'sr'
      ? `${userText}\n\nSR 提示：SR talent 表里的很多“百分比”是比例值（例如 0.4 表示 40%）。details 里的 dmg(...) / dmg.basic(...) 直接使用该比例值（不要乘 100）。但 miao-plugin 的 buffs.data（如 atkPct/cpct/cdmg/dmg/...）按“百分数数值”存储（40），因此从 talent 表取值写入 buffs.data 百分比键时通常需要乘以 100。`
      : userText

  return [
    {
      role: 'system',
      content:
        '你是一个谨慎的 Node.js/JS 工程师，熟悉 miao-plugin 的 calc.js 结构。' +
        ' 你必须严格按要求输出 JSON，不要输出解释、Markdown、代码块。'
    },
    { role: 'user', content: userTextFinal }
  ]
}
