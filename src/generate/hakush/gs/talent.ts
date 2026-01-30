/**
 * GI (GS) talent table helpers.
 *
 * Hakush GI character detail provides:
 * - `Skills[].Desc` (rich text with <color> tags and \\n)
 * - `Skills[].Promote[]` containing:
 *   - Desc: comma-separated "Label|{paramN:Fmt}[+...]" templates
 *   - Param: a numeric array for each talent level
 *
 * miao-plugin expects (in meta-gs/character/<name>/data.json):
 * - `talent.<key>.desc`: string[] (with <h3> headings)
 * - `talent.<key>.tables`: formatted string tables (for wiki display)
 * - `talentData.<key>`: numeric tables used by damage calc runtime
 *
 * This module builds those structures deterministically for *new* characters.
 */

type SkillKey = 'a' | 'e' | 'q'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function toNum(v: unknown): number | null {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : null
}

function normalizeGiRichText(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  // Hakush GI strings often include literal "\\n" sequences.
  return raw
    // Strip inline link markers like `{LINK#N11130005}` while keeping visible text.
    .replace(/\{LINK#[^}]*\}/g, '')
    .replace(/\{\/LINK\}/g, '')
    .replaceAll('\\n', '\n')
    .replaceAll('\r\n', '\n')
    .trim()
}

type GiLinkTextMapRef = { titleTextMapHash: number; contentTextMapHash: number }

// Baseline-compat: expand a small set of `{LINK#...}` markers into extra sections.
// These ids are stable text-map entries (pure API-driven), but Hakush skill desc may omit them.
const GI_LINK_TEXTMAP_COMPAT: Record<string, GiLinkTextMapRef> = {
  // 伊法: 夜魂加持/援护射击/镇静标记
  N11130003: { titleTextMapHash: 3284198516, contentTextMapHash: 330935505 },
  N11130001: { titleTextMapHash: 2801914512, contentTextMapHash: 3973375625 },
  N11130004: { titleTextMapHash: 1342298756, contentTextMapHash: 2960663985 },

  // 丝柯克: 蛇之狡谋/七相一闪/理外之理
  N11130005: { titleTextMapHash: 641292044, contentTextMapHash: 884928113 },
  N11130006: { titleTextMapHash: 2296872847, contentTextMapHash: 252803585 },
  N11130007: { titleTextMapHash: 1667685149, contentTextMapHash: 3338484225 },

  // 伊涅芙: 薇尔琪塔
  N11160001: { titleTextMapHash: 1290068140, contentTextMapHash: 1674651673 },

  // 茜特菈莉: 霜林圣域/月咏/苍色祷歌/草露
  N11190001: { titleTextMapHash: 2163547644, contentTextMapHash: 898770961 },
  N11190002: { titleTextMapHash: 3527709012, contentTextMapHash: 1454123745 },
  N11190003: { titleTextMapHash: 1279960324, contentTextMapHash: 21783753 },
  N11190008: { titleTextMapHash: 600323204, contentTextMapHash: 3366567793 },

  // 菲林斯: 雷霆交响
  N11200001: { titleTextMapHash: 2561807660, contentTextMapHash: 3456386481 },

  // 爱可菲: 即兴烹饪模式
  N11120002: { titleTextMapHash: 4236130820, contentTextMapHash: 1107663393 },

  // 奈芙尔: 影舞/幻戏/伪秘之帷
  N11220001: { titleTextMapHash: 2557823260, contentTextMapHash: 1154340481 },
  N11220002: { titleTextMapHash: 116276348, contentTextMapHash: 3223480113 },
  N11220003: { titleTextMapHash: 920705116, contentTextMapHash: 1464886697 },

  // 杜林: 精质转变
  N11230001: { titleTextMapHash: 3957323148, contentTextMapHash: 2228792649 },

  // 雅珂达: 呼噜噜秘藏瓶/猫型家用互助协调器
  N11240001: { titleTextMapHash: 2643347796, contentTextMapHash: 1637635753 },
  N11240002: { titleTextMapHash: 4150078052, contentTextMapHash: 4232334737 },

  // 露娜缇: 引力涟漪/月之领域
  N11250001: { titleTextMapHash: 142051724, contentTextMapHash: 4284706753 },
  N11250002: { titleTextMapHash: 3239829836, contentTextMapHash: 1024015393 },

  // 兹白: 月转时隙
  N11260001: { titleTextMapHash: 474835052, contentTextMapHash: 886612721 },

  // 叶洛亚: 「夜莺之歌」
  N11270001: { titleTextMapHash: 3891824484, contentTextMapHash: 322290433 }
}

function extractGiLinkIds(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return []
  const out: string[] = []
  const seen = new Set<string>()
  const re = /\{LINK#([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(raw)) !== null) {
    const id = String(m[1] || '').trim()
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

export interface GiSkillDescOptions {
  /**
   * Optional CHS text map (`TextMap/TextMapCHS.json`), used to expand `{LINK#...}` markers.
   * When omitted, we keep Hakush desc as-is (no expansion).
   */
  textMap?: Record<string, string>
  /**
   * Optional ProudSkill param map (`ExcelBinOutput/ProudSkillExcelConfigData.json`), used to resolve
   * TextMap placeholders like `{PARAM#P1263201|4S1}` inside expanded LINK contents.
   */
  proudSkillParamMap?: Map<number, number[]>
  /** Internal: avoid recursive LINK expansion. */
  expandLinks?: boolean
  /**
   * Convert standalone golden `<color=#FFD780FF>...</color>` lines into `<h3>` headings.
   *
   * Default: true
   */
  convertHeadings?: boolean
  /**
   * When converting golden headings, require the line to have no leading/trailing whitespace.
   *
   * Baseline-compat: some TextMap LINK contents contain lines like `<color=#FFD780FF>xxx</color> `
   * (note the trailing space). Baseline keeps those as plain lines, not headings.
   *
   * Default: false
   */
  strictHeadings?: boolean
}

function formatGiTextMapParamValue(value: number): string {
  if (!Number.isFinite(value)) return ''
  // Baseline-style: keep at most 2 decimals, trim trailing zeros.
  return value.toFixed(2).replace(/\.?0+$/, '')
}

function replaceGiTextMapParams(text: string, opts?: GiSkillDescOptions): string {
  const paramMap = opts?.proudSkillParamMap
  if (!paramMap) return text
  return text.replace(/\{PARAM#P(\d+)\|(\d+)S(\d+)\}/g, (m, pidStr: string, idxStr: string, scaleStr: string) => {
    const pid = Number(pidStr)
    const idx = Number(idxStr)
    const scale = Number(scaleStr)
    if (!Number.isFinite(pid) || !Number.isFinite(idx) || idx <= 0) return m
    const list = paramMap.get(pid)
    if (!list) return m
    const base = list[idx - 1]
    if (typeof base !== 'number' || !Number.isFinite(base)) return m
    const mult = Number.isFinite(scale) ? scale : 1
    const replaced = formatGiTextMapParamValue(base * mult)
    return replaced ? replaced : m
  })
}

/**
 * Convert Hakush GI skill description to miao-plugin "desc array".
 *
 * - Convert golden <color> headings to <h3>
 * - Strip other <color> tags
 * - Split by newline, drop empty lines
 * - Optionally expand LINK markers using TextMap compat ids
 */
export function giSkillDescToLines(rawDesc: unknown, opts?: GiSkillDescOptions): string[] {
  const expandLinks = opts?.expandLinks !== false
  const convertHeadings = opts?.convertHeadings !== false
  const strictHeadings = opts?.strictHeadings === true
  const linkIds = expandLinks && opts?.textMap ? extractGiLinkIds(rawDesc) : []

  const text = replaceGiTextMapParams(normalizeGiRichText(rawDesc), opts)
  if (!text) return []

  const out: string[] = []
  let italicOpen = false

  for (const rawLine of text.split('\n')) {
    const trimmed = rawLine.trim()
    if (!trimmed) continue

    // Headings are usually golden `<color=#FFD780FF>...` as a standalone line.
    if (convertHeadings) {
      const headingMatch = trimmed.match(/^<color=#FFD780FF>(.*?)<\/color>$/)
      if (headingMatch) {
        if (strictHeadings && rawLine !== trimmed) {
          // Treat it as a plain line (strip <color> below), matching baseline behavior.
        } else {
        const heading = headingMatch[1].replace(/<[^>]+>/g, '').trim()
        const h3 = `<h3>${heading}</h3>`
        out.push(h3)
        continue
        }
      }
    }

    // Strip rich-text but keep the visible text.
    let line = trimmed
    line = line.replace(/<color=[^>]+>/g, '').replace(/<\/color>/g, '')
    // Keep <i>...</i> (baseline uses it for flavor lines), strip other tags.
    line = line.replace(/<i[^>]*>/g, '<i>').replace(/<\/i>/g, '</i>')
    line = line.replace(/<(?!\/?i\b)[^>]+>/g, '').trim()
    if (!line) continue

    // Baseline-compat: some skill blocks use plain text section titles (no golden <color>).
    if (convertHeadings) {
      const plainHeadings = new Set(['普通攻击', '重击', '下落攻击'])
      if (plainHeadings.has(line)) {
        const h3 = `<h3>${line}</h3>`
        out.push(h3)
        continue
      }
    }

    // Baseline-compat: Hakush sometimes uses a single multi-line <i>...</i> block.
    // Baseline meta stores each line as its own "<i>...</i>" entry.
    const startedItalic = line.includes('<i>')
    const endedItalic = line.includes('</i>')

    if (!startedItalic && endedItalic) {
      line = `<i>${line}`
    } else if (italicOpen && !startedItalic) {
      line = `<i>${line}`
    }

    const hasClose = line.includes('</i>')
    if ((italicOpen || startedItalic) && !hasClose) {
      line = `${line}</i>`
    }

    out.push(line)

    // Update state based on original line markers (not auto-inserted balancing).
    if (endedItalic) italicOpen = false
    else if (startedItalic) italicOpen = true
  }

  // Expand selected LINK markers into extra sections (baseline parity for new/Natlan mechanics).
  const textMap = opts?.textMap
  if (expandLinks && textMap && linkIds.length > 0) {
    for (const linkId of linkIds) {
      const ref = GI_LINK_TEXTMAP_COMPAT[linkId]
      if (!ref) continue

      const title = (textMap[String(ref.titleTextMapHash)] || '').replace(/<[^>]+>/g, '').trim()
      const content = textMap[String(ref.contentTextMapHash)] || ''
      if (title) {
        const heading = `<h3>${title}</h3>`
        out.push(heading)
      }
      if (content) {
        const lines = giSkillDescToLines(content, { ...opts, textMap, expandLinks: false, strictHeadings: true })
        for (const l of lines) out.push(l)
      }
    }
  }

  return out
}

function formatGiParam(value: number, format: string): string {
  // Keep behavior aligned with existing meta outputs:
  // - Percent formats multiply by 100 and keep up to 2 decimals (trim trailing zeros)
  // - F1 keeps 1 decimal (trim trailing zeros)
  // - I keeps integer-ish
  const num = Number(value)
  if (!Number.isFinite(num)) return ''

  const fmt = String(format || '')
  const isPercent = fmt.includes('P')
  if (isPercent) {
    const v = parseFloat((num * 100).toFixed(2))
    return `${v}%`
  }

  const fMatch = fmt.match(/^F(\d+)$/)
  if (fMatch) {
    const digits = Number(fMatch[1])
    if (Number.isFinite(digits) && digits >= 0 && digits <= 6) {
      // Baseline meta keeps up to 2 decimals even when upstream marks it as F1 (notably fixed healing parts).
      const keepDigits = digits === 1 ? 2 : digits
      return String(parseFloat(num.toFixed(keepDigits)))
    }
  }

  if (fmt === 'I') {
    // Hakush uses `I` for some "plain number" params that are NOT always integers
    // (e.g. fixed healing amounts). Baseline keeps up to 2 decimals.
    return String(parseFloat(num.toFixed(2)))
  }

  // Fallback: keep a reasonable precision.
  return String(parseFloat(num.toFixed(2)))
}

function shouldForceGiPercent(tableName: string | undefined, rawTemplate: string, fmt: string): boolean {
  // Baseline-compat: some Hakush promote templates miss `P` even though the param is a ratio.
  // Example: 雷电将军 - 积攒愿力层数|每点元素能量{param4:F2} should output 15% (and talentData=15), not 0.15.
  if (tableName === '积攒愿力层数' && fmt === 'F2' && rawTemplate.includes('每点元素能量')) return true
  return false
}

function shouldKeepGiFixed2WhenZero(tableName: string | undefined, rawTemplate: string, fmt: string): boolean {
  if (fmt !== 'F1' && fmt !== 'F2') return false
  // Baseline-compat: some F1 templates expect 2 decimals when the value is an integer.
  if (tableName === '持续时间' && rawTemplate.includes('每个猫爪')) return true
  if (tableName === '元素能量恢复' && rawTemplate.includes('每个') && rawTemplate.endsWith('点')) return true
  return false
}

function renderGiTemplate(template: string, params: number[], opts?: { tableName?: string; rawTemplate?: string }): string {
  let out = template
  out = out.replace(/\{param(\d+):([^}]+)\}/g, (_m, idxStr: string, fmt: string) => {
    const idx = Number(idxStr) - 1
    const v = params?.[idx]
    if (typeof v !== 'number' || !Number.isFinite(v)) return ''
    const rawTemplate = opts?.rawTemplate ?? template
    const effectiveFmt = shouldForceGiPercent(opts?.tableName, rawTemplate, fmt) ? `${fmt}P` : fmt
    if (shouldKeepGiFixed2WhenZero(opts?.tableName, rawTemplate, fmt)) {
      const fixed = Number(v).toFixed(2)
      if (fixed.endsWith('.00')) return fixed
    }
    return formatGiParam(v, effectiveFmt)
  })

  // Baseline convention: use short stat labels inside formulas.
  out = out.replaceAll('攻击力', '攻击')
  out = out.replaceAll('防御力', '防御')
  out = out.replaceAll('最大生命值', 'HP')
  if (out.includes('+') || out.includes('*')) out = out.replaceAll('生命值上限', 'HP')
  out = out.replaceAll('元素精通', '精通')

  // Baseline exceptions: keep full labels for certain conversion texts.
  const rawTemplate = opts?.rawTemplate ?? template
  const isSingleStatConversion = !/[+*]/.test(rawTemplate)
  if (isSingleStatConversion && rawTemplate.includes('夜魂值') && rawTemplate.includes('攻击力')) {
    out = out.replace(/%攻击\b/g, '%攻击力')
  }
  if (rawTemplate.includes('生命之契')) {
    out = out.replace(/%攻击\b/g, '%攻击力')
  }

  // Normalize separators to match baseline style.
  out = out.replace(/\s*\+\s*/g, ' + ').trim()
  // Normalize slashes:
  // - Percent lists prefer spaced delimiters: "98.23% / 115.56% / ...".
  // - Time/stack lists keep compact delimiters: "5/7.5/10秒", "21层".
  // - Textual slashes like "每个岩造物/5层" keep no spaces.
  out = out.replace(/\s*\/\s*/g, '/')
  const slashCount = (out.match(/\//g) || []).length
  const hasPercent = out.includes('%')
  const endsWithCompactUnit = /(?:秒|点|层|次)$/.test(out)
  const keepCompactPercentList =
    hasPercent && out.startsWith('0%/') && slashCount === 2 && (out.endsWith('生命之契') || out.endsWith('%'))
  if (!keepCompactPercentList && !endsWithCompactUnit) {
    if (hasPercent) out = out.replace(/\/(?=\d)/g, ' / ')
    else if (slashCount === 1) out = out.replace(/(?<=\d)\/(?=\d)/g, ' / ')
  }
  return out.trim()
}

function parsePromoteDescTemplate(desc: unknown): Array<{ name: string; template: string }> {
  if (typeof desc !== 'string') return []
  const parts = desc
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const out: Array<{ name: string; template: string }> = []
  for (const p of parts) {
    const idx = p.indexOf('|')
    if (idx === -1) continue
    const name = p.slice(0, idx).trim()
    const template = p.slice(idx + 1).trim()
    if (!name || !template) continue
    out.push({ name, template })
  }
  return out
}

function promoteLevels(promotes: Array<unknown>): Array<{ level: number; params: number[]; templateDesc: string }> {
  const rows: Array<{ level: number; params: number[]; templateDesc: string }> = []
  for (const p of promotes) {
    if (!isRecord(p)) continue
    const level = toNum(p.Level)
    const desc =
      typeof p.Desc === 'string'
        ? p.Desc
        : Array.isArray(p.Desc)
          ? (p.Desc as Array<unknown>).filter((x) => typeof x === 'string' && x.trim()).join(',')
          : ''
    const params = Array.isArray(p.Param)
      ? (p.Param as Array<unknown>).map((x) => (typeof x === 'number' ? x : Number(x))).filter((n) => Number.isFinite(n))
      : []
    if (!level || !desc || params.length === 0) continue
    rows.push({ level, params: params as number[], templateDesc: desc })
  }
  rows.sort((a, b) => a.level - b.level)
  return rows
}

export function normalizePromoteList(promoteRaw: unknown): Array<unknown> {
  if (Array.isArray(promoteRaw)) return promoteRaw
  if (isRecord(promoteRaw)) {
    // Hakush sometimes uses an object keyed by 0..N instead of an array.
    return Object.keys(promoteRaw)
      .map((k) => Number(k))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b)
      .map((n) => promoteRaw[String(n)] as unknown)
  }
  return []
}

export interface GiTalentBlock {
  id: number
  name: string
  desc: string[]
  tables: Array<{ name: string; unit: string; isSame: boolean; values: string[]; name2?: string }>
}

export type GiTalentDataValue = number[] | number[][]

export type GiTalentDataBlock = Record<string, GiTalentDataValue>

export function buildGiTablesFromPromote(
  promotes: Array<unknown>
): Array<{ name: string; unit: string; isSame: boolean; values: string[]; name2?: string }> {
  const rows = promoteLevels(promotes)
  if (rows.length === 0) return []

  const templates = parsePromoteDescTemplate(rows[0]!.templateDesc)
  if (templates.length === 0) return []

  // Units that baseline keeps as a separate `unit` field (when `isSame=false`).
  // Note: baseline never has `isSame=true` with a non-empty `unit`.
  const unitFieldAllow = new Set<string>([
    '生命值上限',
    '防御力',
    '元素精通',
    '攻击力',
    '普通攻击伤害',
    '每个',
    '1名角色',
    '2名角色',
    '秒',
    '生命值上限/层',
    '每点元素能量',
    '点',
    '每层伪秘之帷',
    '攻击力/层',
    '重击伤害',
    '最大生命值',
    '每朵',
    '当前生命值',
    '/层'
  ])

  const normalizeStarUnit = (unit: string): string => {
    // Baseline uses abbreviated stat labels inside formula-like units such as `HP*3`, `(精通)*2`, etc.
    if (!unit.includes('*') || unit.includes('/')) return unit
    return unit
      .replaceAll('攻击力', '攻击')
      .replaceAll('防御力', '防御')
      .replaceAll('最大生命值', 'HP')
      .replaceAll('生命值上限', 'HP')
      .replaceAll('元素精通', '精通')
  }

  const normalizeUnitForBaseline = (unit: string): string => {
    // Baseline uses full stat names as `unit` labels (while short labels appear inside mixed formulas).
    if (!unit) return unit
    // Exact mappings for Hakush short labels.
    if (unit === '攻击') return '攻击力'
    if (unit === '防御') return '防御力'
    if (unit === '精通') return '元素精通'
    if (unit === 'HP') return '生命值上限'

    // Suffix variants (e.g. "攻击/层").
    const out = unit
      .replaceAll('攻击/层', '攻击力/层')
      .replaceAll('防御/层', '防御力/层')
      .replaceAll('HP/层', '生命值上限/层')
      .replaceAll('精通/层', '元素精通/层')

    return out
  }

  const splitUnit = (template: string): { valueTemplate: string; unit: string } => {
    // Extract constant prefix/suffix around `{paramN:Fmt}` placeholders.
    // Baseline sometimes stores these constants as `unit`, and sometimes keeps them inside `values`.
    const re = /\{param\d+:[^}]+\}/g
    let first: RegExpExecArray | null = null
    let last: RegExpExecArray | null = null
    let count = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(template)) !== null) {
      if (!first) first = m
      last = m
      count++
    }
    if (!first || !last) return { valueTemplate: template, unit: '' }

    const prefix = template.slice(0, first.index).trim()
    // Some templates prefix a role count like "1名角色{param...}秒" (Nahida Q). Baseline stores it in unit.
    if (count === 1 && /^(\d+)名角色/.test(prefix)) {
      const valueTemplate = template.slice(first.index).trimStart()
      return { valueTemplate, unit: prefix }
    }

    const suffix = template.slice(last.index + last[0].length).trim()
    if (suffix) {
      const suffixKeepInValueWhenPrefixed = new Set(['秒', '点', '次', '元素精通'])

      // Baseline-compat: templates like "{param}防御力/{param}防御力" keep the unit on the second value
      // (as abbreviated "防御") but still carry `unit: "防御力"`.
      if (count === 2) {
        const midRaw = template.slice(first.index + first[0].length, last.index)
        const midFlat = midRaw.replace(/\s+/g, '')
        const sufFlat = suffix.replace(/\s+/g, '')
        if (midFlat === `${sufFlat}/`) {
          // Baseline keeps duration lists like "10秒/15秒" inside the single value (unit="").
          if (suffix === '秒' || suffix === '次') return { valueTemplate: template, unit: '' }
          const firstEnd = first.index + first[0].length
          const valueTemplate = `${template.slice(0, firstEnd)}/${template.slice(last.index)}`
          return { valueTemplate, unit: suffix }
        }
        if (midFlat === `${sufFlat}+`) {
          const firstPlaceholder = template.slice(first.index, first.index + first[0].length)
          const lastPlaceholder = template.slice(last.index, last.index + last[0].length)
          const valueTemplate = `${firstPlaceholder} + ${lastPlaceholder}`
          return { valueTemplate, unit: suffix }
        }
      }

      // Baseline-compat: when the value contains a textual prefix (e.g. "每个猫爪{param}秒",
      // "每点战意/{param:P}", "每层{param:P} / {param:P}攻击力"), keep the suffix inside `values`
      // instead of splitting it into the separate `unit` field.
      const suffixLooksLikeStat = new Set(['生命值上限', '最大生命值', '攻击力', '防御力', '元素精通', '攻击', '防御', 'HP', '精通'])
      if (prefix && prefix.startsWith('每层') && template.includes('/') && suffixLooksLikeStat.has(suffix)) {
        return { valueTemplate: template, unit: '' }
      }
      if (prefix && suffixKeepInValueWhenPrefixed.has(suffix) && !/[+*]/.test(prefix)) {
        return { valueTemplate: template, unit: '' }
      }
      // Baseline-compat: mixed ATK/EM formulas keep "精通" inside values (not as a shared unit).
      if ((suffix === '元素精通' || suffix === '精通') && template.includes('+')) {
        return { valueTemplate: template, unit: '' }
      }

      const valueTemplate = template.slice(0, last.index + last[0].length).trimEnd()
      return { valueTemplate, unit: suffix }
    }

    // Some templates use a constant prefix like "每个{param...}".
    // Baseline stores that prefix as `unit`, with `{param...}` rendered into `values`.
    if (prefix === '每个') {
      const valueTemplate = template.slice(first.index).trimStart()
      return { valueTemplate, unit: prefix }
    }
    if (prefix === '每朵') {
      const valueTemplate = template.slice(first.index).trimStart()
      return { valueTemplate, unit: prefix }
    }
    // Some templates prefix a role count like "1名角色{param...}" (Nahida Q). Baseline stores it in unit.
    if (count === 1 && /^(\d+)名角色$/.test(prefix)) {
      const valueTemplate = template.slice(first.index).trimStart()
      return { valueTemplate, unit: prefix }
    }
    // Some templates use a longer constant prefix like "每点元素能量{param...}".
    // Baseline stores the prefix as unit, keeping `{param...}` rendered into `values`.
    if (count === 1 && prefix === '每点元素能量') {
      const valueTemplate = template.slice(first.index).trimStart()
      return { valueTemplate, unit: prefix }
    }

    return { valueTemplate: template, unit: '' }
  }

  const buildRoleName2 = (name: string, unit: string): string | undefined => {
    const um = unit.match(/^(\d+)名角色$/)
    if (!um) return undefined
    const parts = name.split('：')
    if (parts.length !== 2) return undefined
    const elem = parts[0]?.trim()
    const label = parts[1]?.trim()
    if (!elem || !label) return undefined
    return `${elem}${um[1]}${label}`
  }

  const tables: Array<{ name: string; unit: string; isSame: boolean; values: string[]; name2?: string }> = []
  for (const t of templates) {
    const { valueTemplate, unit: unitRaw } = splitUnit(t.template)
    const unit = normalizeUnitForBaseline(unitRaw)
    const name2 = buildRoleName2(t.name, unit)
    const values: string[] = []
    for (const row of rows) {
      values.push(renderGiTemplate(valueTemplate, row.params, { tableName: t.name, rawTemplate: t.template }))
    }
    const isSame = values.length > 0 && values.every((v) => v === values[0])

    if (isSame) {
      // Baseline: `isSame=true` always implies `unit=''` (the unit is merged into the single value).
      const v0 = values[0] ?? ''
      if (!unit) {
        tables.push({ name: t.name, unit: '', isSame: true, values: [v0], ...(name2 ? { name2 } : {}) })
        continue
      }
      const u = normalizeStarUnit(unit)
      const mergedValue = unit.startsWith('每') ? `${u}${v0}` : `${v0}${u}`
      tables.push({ name: t.name, unit: '', isSame: true, values: [mergedValue], ...(name2 ? { name2 } : {}) })
      continue
    }

    if (!unit) {
      tables.push({ name: t.name, unit: '', isSame: false, values, ...(name2 ? { name2 } : {}) })
      continue
    }

    if (unit.includes('*')) {
      const u = normalizeStarUnit(unit)
      tables.push({ name: t.name, unit: '', isSame: false, values: values.map((v) => `${v}${u}`), ...(name2 ? { name2 } : {}) })
      continue
    }

    if (unitFieldAllow.has(unit)) {
      tables.push({ name: t.name, unit, isSame: false, values, ...(name2 ? { name2 } : {}) })
      continue
    }

    // Unknown units: baseline keeps them inside `values` (not in the separate `unit` field).
    const outValues = unit.startsWith('每') ? values.map((v) => `${unit}${v}`) : values.map((v) => `${v}${unit}`)
    tables.push({ name: t.name, unit: '', isSame: false, values: outValues, ...(name2 ? { name2 } : {}) })
  }
  return tables
}

function extractParamRefs(template: string): Array<{ index: number; fmt: string }> {
  const refs: Array<{ index: number; fmt: string }> = []
  const re = /\{param(\d+):([^}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(template)) !== null) {
    const idx = Number(m[1]) - 1
    const fmt = m[2] ?? ''
    if (Number.isFinite(idx) && idx >= 0) refs.push({ index: idx, fmt })
  }
  return refs
}

function numericParam(value: number, fmt: string): number {
  const isPercent = String(fmt || '').includes('P')
  const v = isPercent ? value * 100 : value

  // Baseline meta rounds individual params based on format, but keeps JS float artifacts
  // in subsequent arithmetic (e.g. sum of rounded parts).
  if (isPercent) return parseFloat(v.toFixed(2))
  // Baseline keeps up to 2 decimals even when upstream marks it as F1 (notably fixed healing parts).
  if (fmt === 'F1') return parseFloat(v.toFixed(2))
  if (fmt === 'I') return parseFloat(v.toFixed(2))
  return parseFloat(v.toFixed(2))
}

export function buildGiTalentDataFromPromote(promotes: Array<unknown>): GiTalentDataBlock {
  const rows = promoteLevels(promotes)
  if (rows.length === 0) return {}

  const templates = parsePromoteDescTemplate(rows[0]!.templateDesc)
  if (templates.length === 0) return {}

  const out: GiTalentDataBlock = {}

  const keyName = (name: string, template: string): string => {
    // Baseline-compat: Nahida Q splits keys by "1名角色/2名角色" into e.g. 火1伤害提升 / 火2伤害提升.
    const m = template.match(/^(\d+)名角色/)
    if (m) {
      const parts = name.split('：')
      if (parts.length === 2) {
        const elem = parts[0]?.trim()
        const label = parts[1]?.trim()
        if (elem && label) return `${elem}${m[1]}${label}`
      }
    }
    return name
  }

  for (const t of templates) {
    const refs = extractParamRefs(t.template)
    if (refs.length === 0) continue

    const k = keyName(t.name, t.template)
    const wantsSlash = t.template.includes('/')
    const wantsPlus = t.template.includes('+')
    const mulMatch = t.template.match(/\*(\d+)\s*$/)
    const mul = mulMatch ? Number(mulMatch[1]) : null

    if (wantsSlash && refs.length >= 2) {
      const vals: number[][] = []
      for (const row of rows) {
        const arr = refs.map((r) => {
          const fmt = shouldForceGiPercent(t.name, t.template, r.fmt) ? `${r.fmt}P` : r.fmt
          return numericParam(row.params[r.index] ?? 0, fmt)
        })
        vals.push(arr)
      }
      out[k] = vals
      out[`${k}2`] = vals
      continue
    }

    if (wantsPlus && refs.length >= 2) {
      const sumVals: number[] = []
      const partsVals: number[][] = []
      for (const row of rows) {
        const arr = refs.map((r) => {
          const fmt = shouldForceGiPercent(t.name, t.template, r.fmt) ? `${r.fmt}P` : r.fmt
          return numericParam(row.params[r.index] ?? 0, fmt)
        })
        partsVals.push(arr)
        sumVals.push(arr.reduce((a, b) => a + b, 0))
      }
      out[k] = sumVals
      out[`${k}2`] = partsVals
      continue
    }

    if (mul != null && refs.length >= 1) {
      const main: number[] = []
      const parts: number[][] = []
      for (const row of rows) {
        const baseFmt = shouldForceGiPercent(t.name, t.template, refs[0]!.fmt) ? `${refs[0]!.fmt}P` : refs[0]!.fmt
        const base = numericParam(row.params[refs[0]!.index] ?? 0, baseFmt)
        main.push(base * mul)
        parts.push([base, mul])
      }
      out[k] = main
      out[`${k}2`] = parts
      continue
    }

    if (refs.length === 1) {
      const main: number[] = []
      for (const row of rows) {
        const fmt = shouldForceGiPercent(t.name, t.template, refs[0]!.fmt) ? `${refs[0]!.fmt}P` : refs[0]!.fmt
        main.push(numericParam(row.params[refs[0]!.index] ?? 0, fmt))
      }
      out[k] = main
      continue
    }

    // Multiple params but no operator: keep arrays for maximum fidelity.
    const vals: number[][] = []
    for (const row of rows) {
      const arr = refs.map((r) => {
        const fmt = shouldForceGiPercent(t.name, t.template, r.fmt) ? `${r.fmt}P` : r.fmt
        return numericParam(row.params[r.index] ?? 0, fmt)
      })
      vals.push(arr)
    }
    out[k] = vals
    out[`${k}2`] = vals
  }

  return out
}

export interface BuildGiTalentResult {
  talent: Record<SkillKey, GiTalentBlock>
  talentData: Record<SkillKey, GiTalentDataBlock>
  talentId: Record<string, SkillKey>
}

/**
 * Build a/e/q talent blocks from Hakush `Skills` array.
 *
 * @param skillsRaw Hakush `Skills` array
 * @param qIdx Index of Q skill in the array (some characters have an extra sprint skill)
 * @param opts Optional description render options (e.g. TextMap LINK expansion)
 */
export function buildGiTalent(skillsRaw: Array<unknown>, qIdx: number, opts?: GiSkillDescOptions): BuildGiTalentResult | null {
  if (!Array.isArray(skillsRaw) || skillsRaw.length < 3) return null
  const skills = skillsRaw.map((s) => (isRecord(s) ? (s as Record<string, unknown>) : null))

  const pick = (idx: number): Record<string, unknown> | null => (idx >= 0 && idx < skills.length ? skills[idx] : null) as any
  const a = pick(0)
  const e = pick(1)
  const q = pick(qIdx)
  if (!a || !e || !q) return null

  const descScore = (raw: unknown): number => {
    const text = normalizeGiRichText(raw)
    return text.replace(/<[^>]+>/g, '').trim().length
  }

  const preferBetterDesc = (obj: Record<string, unknown>): unknown => {
    const s = obj.SpecialDesc
    const d = obj.Desc
    const sScore = descScore(s)
    const dScore = descScore(d)
    if (!sScore) return d
    if (!dScore) return s
    return sScore >= dScore ? s : d
  }

  const skillBlock = (s: Record<string, unknown>): GiTalentBlock | null => {
    const id = toNum(s.Id)
    const name = typeof s.Name === 'string' ? s.Name : ''
    if (!id || !name) return null
    const rawDesc = preferBetterDesc(s)
    const desc = giSkillDescToLines(rawDesc, opts)
    const promotes = normalizePromoteList(s.Promote)
    const tables = buildGiTablesFromPromote(promotes)
    return { id, name, desc, tables }
  }

  const aBlock = skillBlock(a)
  const eBlock = skillBlock(e)
  const qBlock = skillBlock(q)
  if (!aBlock || !eBlock || !qBlock) return null

  const dataBlock = (s: Record<string, unknown>): GiTalentDataBlock => {
    const promotes = normalizePromoteList(s.Promote)
    return buildGiTalentDataFromPromote(promotes)
  }

  const talentData: Record<SkillKey, GiTalentDataBlock> = {
    a: dataBlock(a),
    e: dataBlock(e),
    q: dataBlock(q)
  }

  const talentId: Record<string, SkillKey> = {
    [String(aBlock.id)]: 'a',
    [String(eBlock.id)]: 'e',
    [String(qBlock.id)]: 'q'
  }

  return {
    talent: { a: aBlock, e: eBlock, q: qBlock },
    talentData,
    talentId
  }
}
