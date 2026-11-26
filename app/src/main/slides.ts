import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { difference, CHANGED_SHARE, isNewSlide, signature, slideFileName, slidesIn, SLIDES_DIR, type SlideCaptureView } from '../shared/slides'

/**
 * Slides while a meeting records: every few seconds a picture of the screen or window the person chose is taken, and
 * kept as a slide only when it shows something new (shared/slides.ts tells). "Capture slide now" keeps one whatever it
 * shows. Slides are files in the meeting's folder (slides/slide-<ms>.jpg, ms on the transcript's clock), so deleting the
 * meeting and backups take them along with its audio. Electron's side (which sources there are, taking a picture) is
 * handed in, so this runs in tests.
 */

/** The parts of Electron's NativeImage used here */
export interface SlideImage {
  isEmpty(): boolean
  getSize(): { width: number; height: number }
  resize(o: { width: number }): SlideImage
  toBitmap(): Buffer
  toJPEG(quality: number): Buffer
}

/** A picture this small is enough to compare; the full one is what is saved */
const COMPARE_WIDTH = 192
const JPEG_QUALITY = 85
export const SAMPLE_MS = 4000

/** The slides saved for a meeting, in the order shown, with their files */
export function listSlides(meetingDir: string): Array<{ ms: number; path: string; file: string }> {
  const dir = join(meetingDir, SLIDES_DIR)
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  return slidesIn(names).map((s) => ({ ...s, path: join(dir, s.file) }))
}

export function createSlides(d: {
  dirOf: (meetingId: string) => string
  /** a picture of this source now; null when it is gone (a closed window) */
  grab: (sourceId: string) => Promise<SlideImage | null>
  /** meeting time now, on the transcript's clock */
  time: () => number
  /** the recording is paused: nothing is taken but what the person asks for */
  paused: (meetingId: string) => boolean
  /** the view changed (null: not capturing) */
  send: (v: SlideCaptureView | null) => void
  intervalMs?: number
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (timer: unknown) => void
}) {
  const every = d.setInterval ?? ((fn, ms) => setInterval(fn, ms))
  const clear = d.clearInterval ?? ((t) => clearInterval(t as NodeJS.Timeout))
  type Run = { view: SlideCaptureView; saved: Uint8Array | null; previous: Uint8Array | null; changedAt: number | null; timer: unknown; chain: Promise<unknown>; busy: boolean; misses: number }
  let run: Run | null = null

  const tell = () => d.send(run ? { ...run.view } : null)

  function save(r: Run, img: SlideImage, ms: number): boolean {
    const dir = join(d.dirOf(r.view.meetingId), SLIDES_DIR)
    mkdirSync(dir, { recursive: true })
    let at = Math.max(0, Math.round(ms))
    while (existsSync(join(dir, slideFileName(at)))) at++
    const file = join(dir, slideFileName(at)), part = file + '.part'
    try {
      // written aside first: a backup or export never takes half a picture
      writeFileSync(part, img.toJPEG(JPEG_QUALITY))
      renameSync(part, file)
    } catch (e) {
      rmSync(part, { force: true })
      throw e
    }
    r.view.count++
    return true
  }

  /** one picture: kept when manual, or when it is a new slide that has settled */
  async function take(r: Run, manual: boolean): Promise<boolean> {
    if (run !== r) return false
    if (!manual && d.paused(r.view.meetingId)) return false
    let img: SlideImage | null
    try { img = await d.grab(r.view.sourceId) } catch (e) { console.warn('slide capture failed', e); img = null }
    if (run !== r) return false
    if (!img || img.isEmpty()) {
      // a window that closed, or a screen unplugged: said once it has been gone for two tries
      if (++r.misses >= 2 && r.view.problem !== 'gone') { r.view.problem = 'gone'; tell() }
      return false
    }
    r.misses = 0
    const ms = d.time()
    const small = img.resize({ width: COMPARE_WIDTH })
    const { width, height } = small.getSize()
    const current = signature(small.toBitmap(), width, height)
    // a slide is placed where it first showed, not where it had settled
    if (!r.previous || difference(current, r.previous) > CHANGED_SHARE) r.changedAt = ms
    const keep = manual || isNewSlide({ saved: r.saved, previous: r.previous, current })
    r.previous = current
    let changed = r.view.problem != null
    delete r.view.problem
    if (keep) {
      try {
        save(r, img, manual ? ms : r.changedAt ?? ms)
        r.saved = current
        changed = true
      } catch (e) {
        console.error('saving a slide failed', e)
        r.view.problem = 'failed'
        changed = true
      }
    }
    if (changed) tell()
    return keep && r.view.problem == null
  }

  /** one picture at a time; the timer's pictures skip a turn rather than queue up */
  function queue(r: Run, manual: boolean): Promise<boolean> {
    if (!manual && r.busy) return Promise.resolve(false)
    r.busy = true
    const p = r.chain.then(() => take(r, manual)).finally(() => { r.busy = false })
    r.chain = p.catch(() => false)
    return p.catch(() => false)
  }

  return {
    view: (): SlideCaptureView | null => (run ? { ...run.view } : null),
    /** starts taking pictures of this source for this meeting, in place of any other */
    start(meetingId: string, sourceId: string, name: string): void {
      if (run) clear(run.timer)
      const count = listSlides(d.dirOf(meetingId)).length
      const r: Run = { view: { meetingId, sourceId, name, count }, saved: null, previous: null, changedAt: null, timer: undefined, chain: Promise.resolve(), busy: false, misses: 0 }
      run = r
      r.timer = every(() => { void queue(r, false) }, d.intervalMs ?? SAMPLE_MS)
      tell()
      void queue(r, false)
    },
    /** keeps a slide now, whatever it shows; false when not capturing or it could not be taken */
    captureNow(): Promise<boolean> { return run ? queue(run, true) : Promise.resolve(false) },
    /** waits for the picture being taken (tests) */
    settled: (): Promise<unknown> => run?.chain ?? Promise.resolve(),
    stop(meetingId?: string): void {
      if (!run || (meetingId && run.view.meetingId !== meetingId)) return
      clear(run.timer)
      run = null
      tell()
    },
  }
}
export type Slides = ReturnType<typeof createSlides>
