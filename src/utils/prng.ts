import crypto from 'node:crypto'

/**
 * Create a deterministic RNG (xorshift32) from an arbitrary seed string.
 *
 * This is used to make "random sampling" validation reproducible.
 */
export function createRng(seed: string): () => number {
  const hash = crypto.createHash('sha256').update(seed, 'utf8').digest()
  // Use first 4 bytes as uint32 seed
  let state =
    ((hash[0]! << 24) | (hash[1]! << 16) | (hash[2]! << 8) | hash[3]!) >>> 0

  if (state === 0) state = 0x1

  return () => {
    // xorshift32
    state ^= (state << 13) >>> 0
    state ^= state >>> 17
    state ^= (state << 5) >>> 0
    return (state >>> 0) / 0x100000000
  }
}

/**
 * Sample `count` distinct items from `items` (without replacement).
 *
 * When count >= items.length, returns a shallow copy of the input.
 */
export function sampleArray<T>(items: T[], count: number, rand: () => number): T[] {
  if (count >= items.length) return items.slice()
  if (count <= 0) return []

  // Fisher–Yates shuffle, but only to the first `count` positions.
  const arr = items.slice()
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    const tmp = arr[i]!
    arr[i] = arr[j]!
    arr[j] = tmp
  }
  return arr.slice(0, count)
}

