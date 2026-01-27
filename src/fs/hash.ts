import fs from 'node:fs'
import crypto from 'node:crypto'

/**
 * SHA256 helper used for binary/text file parity checks.
 */
export async function sha256File(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256')
  const data = fs.readFileSync(filePath)
  hash.update(data)
  return hash.digest('hex')
}

