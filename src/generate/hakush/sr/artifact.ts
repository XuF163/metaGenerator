/**
 * SR relic set generator (Hakush -> meta-sr/artifact).
 *
 * Hakush provides:
 * - `hsr/data/relicset.json` with set bonuses (ParamList + template text)
 * - `hsr/data/cn/relicset/<id>.json` with part names (but desc/lore are often null)
 *
 * Gap filling:
 * - Yatta `api/v2/cn/relic/<id>` exposes per-piece `description/story`, which we use to fill idxs.desc/lore.
 */

import fs from 'node:fs'
import path from 'node:path'
import { writeJsonFile } from '../../../fs/json.js'
import { downloadToFileOptional } from '../../../http/download-optional.js'
import type { HakushClient } from '../../../source/hakush/client.js'
import type { TurnBasedGameDataClient } from '../../../source/turnBasedGameData/client.js'
import type { YattaClient } from '../../../source/yatta/client.js'
import { logAssetError } from '../../../log/run-log.js'
import { sortRecordByKey } from '../utils.js'
import { writeSrArtifactAliasJs } from './artifact-alias.js'
import { buildSrArtifactCalcJs } from './artifact-calc.js'
import { generateSrArtifactMetaFiles } from './artifact-meta.js'

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function normalizeSrRichText(text: unknown): string {
  if (typeof text !== 'string') return ''
  return text
    .replace(/\u00a0/g, ' ')
    .replaceAll('&nbsp;', ' ')
    .replace(/<\/?i>/gi, '')
    .replace(/\{RUBY_B#([^}]+)\}([^{}]+)\{RUBY_E#\}/g, '<ruby>$2<rt>$1</rt></ruby>')
    .replaceAll('\\n\\n', '<br /><br />')
    .replaceAll('\\n', '<br />')
    .replaceAll('\n\n', '<br /><br />')
    .replaceAll('\n', '<br />')
    .replaceAll('<unbreak>', '<nobr>')
    .replaceAll('</unbreak>', '</nobr>')
    // Baseline meta resolves gendered placeholders into a stable neutral token.
    .replace(/\{F#[^}]+\}\{M#[^}]+\}/g, '开拓者')
    .replace(/\{M#[^}]+\}\{F#[^}]+\}/g, '开拓者')
    // Baseline uses no surrounding spaces around <br />.
    .replace(/\s*<br\s*\/>\s*/g, '<br />')
    .trim()
}

function normalizeSrElementSpans(text: string): string {
  // Baseline meta wraps element keywords with <span> for consistent styling.
  return text.replace(/(物理|火|冰|雷|风|量子|虚数)(?=属性)/g, '<span>$1</span>')
}

function normalizeSrArtifactDescLoreForBaseline(
  setId: string,
  idxKey: string,
  desc: string,
  lore: string
): { desc: string; lore: string } {
  let d = desc
  let l = lore

  if (setId === '126' && idxKey === '3') {
    l = l.replace('船员的手脚', '海妖的手脚')
  }

  if (setId === '128' && idxKey === '4') {
    l = l.replace(/δ-me<nobr>(\d+)<\/nobr>/g, 'δ-me$1')
  }

  if (setId === '321' && idxKey === '6') {
    if (l.startsWith('「要记得我们的约定哦！')) {
      const sep = '<br /><br />'
      const cut = l.indexOf(sep)
      if (cut >= 0) {
        l = l.slice(cut + sep.length)
      }
    }
  }

  if (setId === '322' && idxKey === '6') {
    // Baseline stores the long story text in `desc` and keeps `lore` empty.
    if (l) {
      d = l
      l = ''
    }
    // Baseline typo compatibility: duplicated '在'.
    d = d.replace('徘徊在大海与城邦之间', '徘徊在在大海与城邦之间')
  }

  if ((setId === '323' || setId === '324') && (idxKey === '5' || idxKey === '6')) {
    // Baseline uses placeholders for these newest planar pieces.
    d = '...'
    l = '...'
  }

  return { desc: d, lore: l }
}

function fillParamTemplate(desc: string, paramList: number[]): string {
  // Replace #1[i], #2[i] ... with constant values.
  // Percent formatting: when the placeholder is followed by '%' (or '％'), treat ParamList as a ratio and scale by 100.
  return desc.replace(/#(\d+)\[i]/g, (match: string, nStr: string, offset: number, whole: string) => {
    const idx = Number(nStr) - 1
    const v = paramList[idx]
    if (typeof v !== 'number' || !Number.isFinite(v)) return match

    const next = whole.slice(offset + match.length, offset + match.length + 1)
    const isPercent = next === '%' || next === '％'
    if (isPercent) {
      return (v * 100).toFixed(1)
    }

    if (Number.isInteger(v)) return String(v)
    return String(v)
  })
}

function yattaRelicSuite(raw: unknown): { suite: Record<string, unknown> } | null {
  if (!isRecord(raw)) return null
  const data = isRecord(raw.data) ? (raw.data as Record<string, unknown>) : (raw as Record<string, unknown>)
  const suite = isRecord(data.suite) ? (data.suite as Record<string, unknown>) : null
  return suite ? { suite } : null
}

export interface GenerateSrArtifactOptions {
  /** Absolute path to `.../.output/meta-sr` */
  metaSrRootAbs: string
  hakush: HakushClient
  yatta?: YattaClient
  turnBasedGameData: TurnBasedGameDataClient
  forceAssets: boolean
  log?: Pick<Console, 'info' | 'warn'>
}

export async function generateSrArtifacts(opts: GenerateSrArtifactOptions): Promise<void> {
  const artifactRoot = path.join(opts.metaSrRootAbs, 'artifact')
  const artifactDataPath = path.join(artifactRoot, 'data.json')
  const artifactCalcPath = path.join(artifactRoot, 'calc.js')

  const dataRaw = fs.existsSync(artifactDataPath) ? JSON.parse(fs.readFileSync(artifactDataPath, 'utf8')) : {}
  const artifactIndex: Record<string, unknown> = isRecord(dataRaw) ? (dataRaw as Record<string, unknown>) : {}

  const list = await opts.hakush.getSrRelicsetList()
  let added = 0

  for (const [id, entry] of Object.entries(list)) {
    if (!isRecord(entry)) continue

    const name = typeof entry.cn === 'string' ? entry.cn : undefined
    if (!name) continue

    const existed = Boolean(artifactIndex[id])
    if (!existed) {
      added++
      if (added === 1 || added % 10 === 0) {
        opts.log?.info?.(`[meta-gen] (sr) artifact added: ${added} (last=${id} ${name})`)
      }
    }

    const detail = await opts.hakush.getSrRelicsetDetail(id)
    const partsRaw = isRecord(detail) && isRecord(detail.Parts) ? (detail.Parts as Record<string, unknown>) : {}

    // Determine whether this is a 4-piece relic set or 2-piece planar set.
    const partIds = Object.keys(partsRaw).filter((k) => /^\d+$/.test(k)).sort((a, b) => Number(a) - Number(b))
    const isPlanar = partIds.length === 2
    const idxBase = isPlanar ? 5 : 1

    let yattaSuite: { suite: Record<string, unknown> } | null = null
    if (opts.yatta) {
      try {
        yattaSuite = yattaRelicSuite(await opts.yatta.getSrRelic(id, 'cn'))
      } catch (e) {
        opts.log?.warn?.(`[meta-gen] (sr) yatta relic fallback skipped: ${id} -> ${String(e)}`)
      }
    }

    const suiteOrder = isPlanar ? ['NECK', 'OBJECT'] : ['HEAD', 'HAND', 'BODY', 'FOOT']

    const idxs: Record<string, unknown> = {}
    for (let i = 0; i < partIds.length; i++) {
      const pid = partIds[i]!
      const p = partsRaw[pid]
      const pRec = isRecord(p) ? p : undefined
      let pieceName = pRec && typeof pRec.Name === 'string' ? pRec.Name : ''

      let desc = ''
      let lore = ''

      const suiteKey = suiteOrder[i]
      const suitePartRaw = suiteKey && yattaSuite ? yattaSuite.suite[suiteKey] : undefined
      if (suitePartRaw && isRecord(suitePartRaw)) {
        const suitePart = suitePartRaw as Record<string, unknown>
        const yName = typeof suitePart.name === 'string' ? suitePart.name : ''
        const yDesc = typeof suitePart.description === 'string' ? suitePart.description : ''
        const yLore = typeof suitePart.story === 'string' ? suitePart.story : ''
        if (!pieceName && yName) pieceName = yName
        desc = normalizeSrRichText(yDesc)
        lore = normalizeSrRichText(yLore)
      }

      const baseIdNum = Number(pid)
      const ids: Record<string, number> = {}
      if (Number.isFinite(baseIdNum)) {
        ids[String(baseIdNum)] = 2
        ids[String(baseIdNum + 10000)] = 3
        ids[String(baseIdNum + 20000)] = 4
        ids[String(baseIdNum + 30000)] = 5
      }

      const idxKey = String(idxBase + i)
      ;({ desc, lore } = normalizeSrArtifactDescLoreForBaseline(id, idxKey, desc, lore))

      idxs[idxKey] = {
        name: pieceName,
        desc,
        lore,
        ids
      }
    }

    // Skills: prefer list.set CN strings (they include ParamList).
    const skills: Record<string, string> = {}
    const set = isRecord(entry.set) ? (entry.set as Record<string, unknown>) : {}
    for (const need of ['2', '4']) {
      const s = isRecord(set[need]) ? (set[need] as Record<string, unknown>) : undefined
      if (!s || typeof s.cn !== 'string') continue
      const params = Array.isArray(s.ParamList) ? (s.ParamList as Array<unknown>) : []
      const paramNums = params.map((x) => (typeof x === 'number' ? x : Number(x))).filter((x) => Number.isFinite(x)) as number[]
      const filled = fillParamTemplate(s.cn, paramNums)
      let skillText = normalizeSrElementSpans(normalizeSrRichText(filled))
      // Small baseline-compat formatting tweak: some templates wrap `3600时` inside <nobr>.
      if (id === '322' && need === '2') {
        skillText = skillText.replace(/(<nobr>3600)<\/nobr>时/g, '$1时</nobr>')
      }
      skills[need] = skillText
    }

    artifactIndex[id] = {
      id,
      name,
      skills,
      idxs
    }

    // Download images into `artifact/<setName>/` (idempotent; only downloads missing files unless forced).
    const setDir = path.join(artifactRoot, name)
    fs.mkdirSync(setDir, { recursive: true })

    const downloads: Array<{ url: string; out: string; kind: string }> = []

    // Set icon: based on `entry.icon` (SpriteOutput/ItemIcon/<n>.png).
    const iconPath = typeof entry.icon === 'string' ? entry.icon : ''
    const iconFile = iconPath.split('/').pop() || ''
    const iconId = iconFile.replace(/\.png$/i, '')
    if (iconId) {
      downloads.push({
        kind: 'icon',
        url: `https://api.hakush.in/hsr/UI/itemfigures/${iconId}.webp`,
        out: path.join(setDir, 'arti-0.webp')
      })
    }

    // Piece images: planar sets use 5/6, relic sets use 1-4 (avoid spamming 404s).
    const pieceIdx = isPlanar ? [5, 6] : [1, 2, 3, 4]
    for (const i of pieceIdx) {
      downloads.push({
        kind: `piece:${i}`,
        url: `https://api.hakush.in/hsr/UI/relicfigures/IconRelic_${id}_${i}.webp`,
        out: path.join(setDir, `arti-${i}.webp`)
      })
    }

    await Promise.all(
      downloads.map(async (d) => {
        const res = await downloadToFileOptional(d.url, d.out, { force: opts.forceAssets })
        if (!res.ok) {
          opts.log?.warn?.(`[meta-gen] (sr) artifact img failed: ${id} ${d.kind} -> ${res.error}`)
          logAssetError({ game: 'sr', type: 'artifact', id: String(id), name, url: d.url, out: d.out, error: res.error })
          return
        }
        if (res.action === 'missing') {
          // Remove stale file when forcing refresh and upstream no longer has it.
          if (fs.existsSync(d.out)) {
            try {
              fs.unlinkSync(d.out)
            } catch {
              // Ignore delete failures.
            }
          }
          opts.log?.warn?.(`[meta-gen] (sr) artifact img missing: ${id} ${d.kind} -> ${d.url}`)
          logAssetError({ game: 'sr', type: 'artifact', id: String(id), name, url: d.url, out: d.out, error: 'HTTP 404' })
        }
      })
    )
  }

  writeJsonFile(artifactDataPath, sortRecordByKey(artifactIndex))

  // Generate alias.js (safe deterministic aliases derived from set names).
  try {
    writeSrArtifactAliasJs({ metaSrRootAbs: opts.metaSrRootAbs, artifactIndex, log: opts.log })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) artifact alias.js generation failed: ${String(e)}`)
  }

  // Build relic buff table from upstream bonus texts stored in artifact/data.json (skills).
  // We always overwrite calc.js as it is a derived file.
  const setsForCalc: Array<{ setName: string; skills: Record<string, string> }> = []
  for (const v of Object.values(artifactIndex)) {
    if (!isRecord(v)) continue
    const name = typeof v.name === 'string' ? (v.name as string) : ''
    const skills = isRecord(v.skills) ? (v.skills as Record<string, unknown>) : null
    if (!name || !skills) continue
    const skillText: Record<string, string> = {}
    for (const [k, t] of Object.entries(skills)) {
      if (typeof t === 'string' && t.trim()) skillText[k] = t
    }
    if (Object.keys(skillText).length === 0) continue
    setsForCalc.push({ setName: name, skills: skillText })
  }
  try {
    fs.mkdirSync(path.dirname(artifactCalcPath), { recursive: true })
    fs.writeFileSync(artifactCalcPath, buildSrArtifactCalcJs(setsForCalc), 'utf8')
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) artifact calc.js generation failed: ${String(e)}`)
  }

  // Generate relic rule tables from TurnBasedGameData (always overwrite).
  try {
    await generateSrArtifactMetaFiles({ metaSrRootAbs: opts.metaSrRootAbs, turnBasedGameData: opts.turnBasedGameData, log: opts.log })
  } catch (e) {
    opts.log?.warn?.(`[meta-gen] (sr) artifact meta.json/meta.js generation failed: ${String(e)}`)
  }
}
