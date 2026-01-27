/**
 * Run log writer.
 *
 * Requirement:
 * - Do not use placeholder images as a fallback.
 * - When upstream assets are missing/blocked, write error logs to:
 *   `<projectRoot>/logs`.
 *
 * Notes:
 * - This module is intentionally "append-only" and synchronous to keep it simple
 *   and safe across concurrent asset download tasks.
 * - Never log secrets (LLM API keys, etc.). Call sites must avoid including them.
 */

import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from '../fs/ensure.js'

let logFilePath: string | undefined

function safeStamp(iso: string): string {
  return iso.replace(/[:.]/g, '-')
}

export function initRunLog(opts: { projectRoot: string; now: Date; command: string }): void {
  const dir = path.join(opts.projectRoot, 'logs')
  ensureDir(dir)

  const stamp = safeStamp(opts.now.toISOString())
  logFilePath = path.join(dir, `${stamp}-${opts.command}.log`)

  try {
    fs.appendFileSync(logFilePath, `# meta-gen ${opts.command} ${opts.now.toISOString()}\n`, 'utf8')
  } catch {
    // If logging fails (disk permissions), we still want the tool to function.
    logFilePath = undefined
  }
}

export function appendRunLog(line: string): void {
  if (!logFilePath) return
  try {
    fs.appendFileSync(logFilePath, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // Ignore logging failures.
  }
}

export function logAssetError(opts: {
  game: 'gs' | 'sr'
  type: string
  name?: string
  id?: string
  url?: string
  out?: string
  error?: string
}): void {
  const parts: string[] = []
  parts.push(`asset-error game=${opts.game} type=${opts.type}`)
  if (opts.id) parts.push(`id=${opts.id}`)
  if (opts.name) parts.push(`name=${opts.name}`)
  if (opts.out) parts.push(`out=${opts.out}`)
  if (opts.url) parts.push(`url=${opts.url}`)
  if (opts.error) parts.push(`error=${opts.error}`)
  appendRunLog(parts.join(' '))
}

