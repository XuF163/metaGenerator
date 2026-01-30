/**
 * Network defaults (proxy/mirror, user agent).
 *
 * Why a module-level singleton:
 * - metaGenerator is a CLI tool; wiring config through every call site is noisy.
 * - We keep it explicit: `runCli()` initializes once per process.
 *
 * Security note:
 * - This module must never log or echo config values.
 */

import type { ToolConfig } from '../config/config.js'

export interface NetworkDefaults {
  proxy?: string
  httpProxy?: string
  userAgent?: string
}

let proxy: string | undefined
let httpProxy: string | undefined
let userAgent = 'metaGenerator'

function trimStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  return t ? t : undefined
}

export function initNetworkDefaults(config?: ToolConfig | null): void {
  const cfg = config?.network
  proxy = trimStr(cfg?.proxy)
  httpProxy = trimStr(cfg?.httpProxy)
  userAgent = trimStr(cfg?.userAgent) || 'metaGenerator'
}

export function getUserAgent(): string {
  return userAgent
}

export function getHttpProxy(): string | undefined {
  return httpProxy
}

function stripProtocol(url: string): string {
  return url.replace(/^https?:\/\//, '')
}

/**
 * Apply global proxy/mirror rules to an absolute URL.
 */
export function applyProxy(url: string): string {
  const p = proxy
  if (!p) return url

  // If user provided a template, replace placeholders.
  if (p.includes('{')) {
    const urlNoProto = stripProtocol(url)
    return p
      .replaceAll('{encodedUrlNoProto}', encodeURIComponent(urlNoProto))
      .replaceAll('{urlNoProto}', urlNoProto)
      .replaceAll('{encodedUrl}', encodeURIComponent(url))
      .replaceAll('{url}', url)
  }

  // Prefix mode: concatenate.
  return `${p}${url}`
}

