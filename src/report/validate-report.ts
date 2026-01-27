import fs from 'node:fs'
import path from 'node:path'
import type { ValidateReport } from '../types.js'

function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

function toMarkdown(report: ValidateReport): string {
  const lines: string[] = []
  lines.push(`# meta-gen validate report`)
  lines.push('')
  lines.push(`- generatedAt: ${report.meta.generatedAt}`)
  lines.push(`- baselineRoot: ${report.meta.baselineRoot}`)
  lines.push(`- outputRoot: ${report.meta.outputRoot}`)
  lines.push(`- games: ${report.meta.games.join(', ')}`)
  lines.push(`- types: ${report.meta.types.join(', ')}`)
  lines.push(
    `- sampling: mode=${report.meta.sampling.mode} sampleFiles=${report.meta.sampling.sampleFiles} ` +
      `alwaysIncluded=${report.meta.sampling.alwaysIncluded} seed=${report.meta.sampling.seed}`
  )
  lines.push('')
  lines.push(`## Summary`)
  lines.push('')
  lines.push(`- ok: ${report.summary.ok}`)
  lines.push(`- totalCompared: ${report.summary.totalCompared}`)
  lines.push(`- missing: ${report.summary.missing}`)
  lines.push(`- different: ${report.summary.different}`)
  lines.push(`- extra: ${report.summary.extra}`)
  lines.push('')

  if (report.missingFiles.length) {
    lines.push(`## Missing Files`)
    lines.push('')
    for (const f of report.missingFiles) lines.push(`- ${f}`)
    lines.push('')
  }
  if (report.differentFiles.length) {
    lines.push(`## Different Files`)
    lines.push('')
    for (const d of report.differentFiles) lines.push(`- ${d.file}: ${d.reason}`)
    lines.push('')
  }
  if (report.extraFiles.length) {
    lines.push(`## Extra Files`)
    lines.push('')
    for (const f of report.extraFiles) lines.push(`- ${f}`)
    lines.push('')
  }

  return lines.join('\n')
}

/**
 * Write validate report as JSON + Markdown.
 */
export async function writeValidateReport(reportDir: string, report: ValidateReport): Promise<void> {
  const stamp = safeStamp(report.meta.generatedAt)
  const baseName = `${stamp}-validate`
  const jsonPath = path.join(reportDir, `${baseName}.json`)
  const mdPath = path.join(reportDir, `${baseName}.md`)

  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2), 'utf8')
  fs.writeFileSync(mdPath, toMarkdown(report), 'utf8')

  // Keep reports folder small: remove older validate reports by default.
  // (User requirement: delete old test records; keep only the latest.)
  try {
    const entries = fs.readdirSync(reportDir, { withFileTypes: true })
    for (const ent of entries) {
      if (!ent.isFile()) continue
      if (!ent.name.endsWith('-validate.md') && !ent.name.endsWith('-validate.json')) continue
      if (ent.name.startsWith(baseName)) continue
      fs.rmSync(path.join(reportDir, ent.name), { force: true })
    }
  } catch {
    // Ignore cleanup errors.
  }
}
