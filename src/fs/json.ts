import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './ensure.js'

/**
 * Write JSON with stable formatting:
 * - 2-space indentation
 * - UTF-8
 * - trailing newline
 */
export function writeJsonFile(filePath: string, data: unknown): void {
  ensureDir(path.dirname(filePath))
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

