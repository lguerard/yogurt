/**
 * Slides: pictures of a screen or window taken while a meeting records (main/slides.ts). Each one is a file in the
 * meeting's folder, slides/slide-<ms>.jpg, where ms is meeting time, the same clock as the transcript's lines, so the
 * Markdown export can put each picture where it was shown. Everything here is pure, for the tests.
 */

/** A saved slide: its file name in the meeting's slides folder and when it was shown, in meeting time */
export type Slide = { file: string; ms: number }

/** A screen or window slides can be taken from; thumbnail: a small picture of it, icon: its app's icon (a window's title
 * alone can be anonymous: Zoom's call window is just "Meeting"), both as data: URLs ('' when there is none) */
export type SlideSource = { id: string; name: string; kind: 'screen' | 'window'; thumbnail: string; icon?: string }
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

// ---------- Linux: a call window Electron does not list, cut out of its screen ----------

/** x, y, width, height; in physical pixels unless said otherwise */
export type Rect = { x: number; y: number; width: number; height: number }
/** A display as Electron's screen gives it: bounds in DIP, and the scale to physical pixels */
export type DisplayArea = { id: number; bounds: Rect; scaleFactor: number }
/** A screen picture source from desktopCapturer: its id and the display it shows ('' when Electron did not say) */
export type ScreenPick = { id: string; display_id: string }

/** The id slides give a window found by yogurt-system app-windows (main/slidesIpc.ts), not Electron's own "window:…" */
export const XWIN = 'xwin:'
export const xwinId = (xid: number): string => `${XWIN}${xid}`
export const xidOf = (id: string): number | null => {
  const m = /^xwin:(\d{1,10})$/.exec(id)
  return m ? Number(m[1]) : null
}
/** The X window id in Electron's id of a window on Linux ("window:<xid>:0"); null for anything else */
export const electronXid = (id: string): number | null => {
  const m = /^window:(\d{1,10}):/.exec(id)
  return m ? Number(m[1]) : null
}

/** A display's place on the X screen, in physical pixels: X11 counts pixels, Electron's bounds are DIP */
export const physicalBounds = (d: DisplayArea): Rect => {
  const s = d.scaleFactor > 0 ? d.scaleFactor : 1
  return { x: Math.round(d.bounds.x * s), y: Math.round(d.bounds.y * s), width: Math.round(d.bounds.width * s), height: Math.round(d.bounds.height * s) }
}

const overlap = (a: Rect, b: Rect): number =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y))
const holds = (r: Rect, x: number, y: number) => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height
const union = (rs: Rect[]): Rect => {
  const x = Math.min(...rs.map((r) => r.x)), y = Math.min(...rs.map((r) => r.y))
  return { x, y, width: Math.max(...rs.map((r) => r.x + r.width)) - x, height: Math.max(...rs.map((r) => r.y + r.height)) - y }
}

/** The X screen every display is part of, in physical pixels */
export const screenSize = (displays: DisplayArea[]): Rect => (displays.length ? union(displays.map(physicalBounds)) : { x: 0, y: 0, width: 0, height: 0 })

/** The display a window is on: the one holding its centre, else the one it overlaps most; null when it is on none */
export function displayFor(win: Rect, displays: DisplayArea[]): DisplayArea | null {
  const cx = win.x + win.width / 2, cy = win.y + win.height / 2
  const centre = displays.find((d) => holds(physicalBounds(d), cx, cy))
  if (centre) return centre
  let best: DisplayArea | null = null, most = 0
  for (const d of displays) { const o = overlap(win, physicalBounds(d)); if (o > most) { most = o; best = d } }
  return best
}

/**
 * Which screen picture shows a window, and the part of the X screen that picture covers. The screen whose display_id
 * is the window's display; else one picture of every display at once (X11's "Entire screen"); else, as many pictures as
 * displays, the one in the same place. null: no picture can be told to show it.
 */
export function screenFor(win: Rect, displays: DisplayArea[], screens: ScreenPick[]): { source: string; area: Rect } | null {
  const d = displayFor(win, displays)
  if (!d || !screens.length) return null
  const own = screens.find((s) => s.display_id !== '' && s.display_id === String(d.id))
  if (own) return { source: own.id, area: physicalBounds(d) }
  if (screens.length === 1) return { source: screens[0].id, area: union(displays.map(physicalBounds)) }
  if (screens.length === displays.length) return { source: screens[displays.indexOf(d)].id, area: physicalBounds(d) }
  return null
}

/** Too little of the window shows to make a slide of (it is almost all off the screen) */
const MIN_CROP = 16

/**
 * The window's part of a picture of `area` (the X screen's pixels it covers) that came out `picture` big: cut to the
 * picture, scaled when the picture is smaller than the area. null when too little of the window is in it.
 */
export function cropFor(win: Rect, area: Rect, picture: { width: number; height: number }): Rect | null {
  if (area.width <= 0 || area.height <= 0 || picture.width <= 0 || picture.height <= 0) return null
  const sx = picture.width / area.width, sy = picture.height / area.height
  const left = Math.max(0, Math.round((win.x - area.x) * sx)), top = Math.max(0, Math.round((win.y - area.y) * sy))
  const right = Math.min(picture.width, Math.round((win.x + win.width - area.x) * sx))
  const bottom = Math.min(picture.height, Math.round((win.y + win.height - area.y) * sy))
  if (right - left < MIN_CROP || bottom - top < MIN_CROP) return null
  return { x: left, y: top, width: right - left, height: bottom - top }
}

/** A call app's window as yogurt-system app-windows prints it: its X id, the app id it matched, its place on the X screen */
export type AppWindow = { id: number; app: string; title: string; x: number; y: number; w: number; h: number }
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
/** The helper's answer, keeping only well-formed windows */
export function appWindowsOf(raw: unknown): AppWindow[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((w): AppWindow[] => {
    if (!w || typeof w !== 'object') return []
    const { id, app, title, x, y, w: width, h } = w as Record<string, unknown>
    if (!isInt(id) || id <= 0 || typeof app !== 'string' || !isInt(x) || !isInt(y) || !isInt(width) || !isInt(h) || width <= 0 || h <= 0) return []
    return [{ id, app, title: typeof title === 'string' ? title : '', x, y, w: width, h }]
  })
}
export const rectOf = (w: AppWindow): Rect => ({ x: w.x, y: w.y, width: w.w, height: w.h })
/** "Zoom – Meeting": the app's name first, since a call window's title alone can be anonymous */
export const appWindowName = (app: string, title: string): string => (title.trim() ? `${app} – ${title.trim()}` : app)
