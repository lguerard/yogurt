/**
 * Slides: pictures of a screen or window taken while a meeting records (main/slides.ts). Each one is a file in the
 * meeting's folder, slides/slide-<ms>.jpg, where ms is meeting time, the same clock as the transcript's lines, so the
 * Markdown export can put each picture where it was shown. Everything here is pure, for the tests.
 */

/** A saved slide: its file name in the meeting's slides folder and when it was shown, in meeting time */
export type Slide = { file: string; ms: number }

/** A screen or window slides can be taken from; thumbnail: a small picture of it, as a data: URL ('' when there is none) */
export type SlideSource = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string }
/** What the picker shows: denied, a Mac that has not allowed Yogurt to record the screen (System Settings) */
export type SlideSourcesView = { access: 'granted' | 'denied'; sources: SlideSource[] }
/** Slides being taken: of which source, for which meeting, how many so far. problem: the source went away, or saving failed */
export type SlideCaptureView = { meetingId: string; sourceId: string; name: string; count: number; problem?: 'gone' | 'failed' }

/** The folder inside a meeting's folder */
export const SLIDES_DIR = 'slides'
const FILE = /^slide-(\d{1,12})\.(jpg|png)$/

export const slideFileName = (ms: number): string => `slide-${String(Math.max(0, Math.round(ms))).padStart(9, '0')}.jpg`

/** The slides among a folder's file names, in the order they were shown; anything else (a .part being written) is left out */
export function slidesIn(names: string[]): Slide[] {
  return names.flatMap((file) => {
    const m = FILE.exec(file)
    return m ? [{ file, ms: Number(m[1]) }] : []
  }).sort((a, b) => a.ms - b.ms || a.file.localeCompare(b.file))
}

/**
 * Where each slide goes among the transcript's turns: just before the first turn that starts at or after it was shown.
 * before[i] are the slides to put before turn i; after, the ones shown after the last turn began.
 */
export function placeSlides<S extends { ms: number }>(turnStarts: number[], slides: S[]): { before: S[][]; after: S[] } {
  const before: S[][] = turnStarts.map(() => [])
  const after: S[] = []
  for (const s of [...slides].sort((a, b) => a.ms - b.ms)) {
    const i = turnStarts.findIndex((start) => start >= s.ms)
    if (i < 0) after.push(s)
    else before[i].push(s)
  }
  return { before, after }
}

// ---------- telling a new slide from the same one ----------

/** A picture boiled down to GRID×GRID grey levels: enough to see a new slide, too coarse to see a cursor or noise */
export const GRID = 48
/** grey levels two cells must differ by to count as changed (0–255) */
const CELL_STEP = 24
/** the share of cells that must change for a new slide: a bullet appearing is about 1–2 % */
export const CHANGED_SHARE = 0.012

/**
 * A raw bitmap (4 bytes a pixel, as Electron's NativeImage.toBitmap gives: BGRA, or RGBA, which weighs the same here
 * but for red and blue) averaged into GRID×GRID grey cells.
 */
export function signature(bitmap: Uint8Array, width: number, height: number, order: 'bgra' | 'rgba' = 'bgra'): Uint8Array {
  const out = new Uint8Array(GRID * GRID)
  if (width <= 0 || height <= 0 || bitmap.length < width * height * 4) return out
  const [r, b] = order === 'bgra' ? [2, 0] : [0, 2]
  const sums = new Float64Array(GRID * GRID), counts = new Uint32Array(GRID * GRID)
  for (let y = 0; y < height; y++) {
    const row = Math.min(GRID - 1, Math.floor((y * GRID) / height)) * GRID
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4
      const cell = row + Math.min(GRID - 1, Math.floor((x * GRID) / width))
      sums[cell] += 0.299 * bitmap[p + r] + 0.587 * bitmap[p + 1] + 0.114 * bitmap[p + b]
      counts[cell]++
    }
  }
  for (let i = 0; i < out.length; i++) out[i] = counts[i] ? Math.round(sums[i] / counts[i]) : 0
  return out
}

/** The share of cells (0–1) that differ between two signatures */
export function difference(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length || !a.length) return 1
  let changed = 0
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > CELL_STEP) changed++
  return changed / a.length
}

/**
 * Whether the picture just taken is a new slide: it differs from the last one kept, and has stopped changing since
 * the picture before (so a transition or an animation is not kept halfway). The first picture is always kept.
 */
export function isNewSlide(p: { saved: Uint8Array | null; previous: Uint8Array | null; current: Uint8Array; threshold?: number }): boolean {
  const threshold = p.threshold ?? CHANGED_SHARE
  if (!p.saved) return true
  if (difference(p.current, p.saved) <= threshold) return false
  return !!p.previous && difference(p.current, p.previous) <= threshold
}
