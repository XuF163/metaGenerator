import path from 'node:path'

/**
 * Ensure a path is printed in a stable, relative form when possible.
 * This helps make reports deterministic across machines.
 */
export function toPosixRelativePath(root: string, filePath: string): string {
  const rel = path.relative(root, filePath)
  return rel.split(path.sep).join('/')
}

