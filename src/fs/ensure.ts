import fs from 'node:fs'

/**
 * Ensure a directory exists (mkdir -p).
 */
export function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true })
}

