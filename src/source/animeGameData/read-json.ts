import fs from 'node:fs'

/**
 * Read and parse a JSON file from disk.
 *
 * Notes:
 * - Uses UTF-8.
 * - Throws a descriptive error on parse failures.
 */
export function readJsonFile<T = unknown>(filePath: string): T {
  const raw = fs.readFileSync(filePath, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    throw new Error(`[meta-gen] Failed to parse JSON: ${filePath}\n${msg}`)
  }
}

