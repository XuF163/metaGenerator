/**
 * Error formatting helpers.
 */

export function formatError(err: unknown): string {
  if (err instanceof Error) {
    const stack = err.stack || String(err)
    return stack
  }
  return String(err)
}

