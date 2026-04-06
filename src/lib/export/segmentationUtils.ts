// ── Segmentation pure utility functions ────────────────────────────────
// No external dependencies — safe for unit testing without env vars.

export interface Boundary {
  start: number
  end: number
}

/**
 * Merge segments shorter than minDuration with their neighbor.
 * Strategy: merge short segment with whichever adjacent segment is shorter.
 */
export function mergeShortSegments(
  boundaries: Boundary[],
  minDuration: number,
): Boundary[] {
  if (boundaries.length <= 1) return boundaries.map((b) => ({ ...b }))

  const result: Boundary[] = boundaries.map((b) => ({ ...b }))

  let merged = true
  while (merged) {
    merged = false
    for (let i = 0; i < result.length; i++) {
      const dur = result[i].end - result[i].start
      if (dur >= minDuration) continue

      if (result.length === 1) break

      if (i === 0) {
        result[1] = { start: result[0].start, end: result[1].end }
        result.splice(0, 1)
      } else if (i === result.length - 1) {
        result[i - 1] = { start: result[i - 1].start, end: result[i].end }
        result.splice(i, 1)
      } else {
        const prevDur = result[i - 1].end - result[i - 1].start
        const nextDur = result[i + 1].end - result[i + 1].start
        if (prevDur <= nextDur) {
          result[i - 1] = { start: result[i - 1].start, end: result[i].end }
          result.splice(i, 1)
        } else {
          result[i + 1] = { start: result[i].start, end: result[i + 1].end }
          result.splice(i, 1)
        }
      }

      merged = true
      break
    }
  }

  return result
}

/**
 * Split segments longer than maxDuration into roughly equal sub-segments.
 */
export function splitLongSegments(
  boundaries: Boundary[],
  maxDuration: number,
): Boundary[] {
  const result: Boundary[] = []

  for (const seg of boundaries) {
    const dur = seg.end - seg.start
    if (dur <= maxDuration) {
      result.push({ ...seg })
      continue
    }

    const numParts = Math.ceil(dur / maxDuration)
    const partDur = dur / numParts

    for (let j = 0; j < numParts; j++) {
      const start = seg.start + j * partDur
      const end = j === numParts - 1 ? seg.end : seg.start + (j + 1) * partDur
      result.push({ start, end })
    }
  }

  return result
}
