import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appWindowName, appWindowsOf, cropFor, difference, displayFor, electronXid, GRID, isNewSlide, physicalBounds, screenFor, screenSize, signature, slideFileName, slidesIn, xidOf, xwinId, type DisplayArea } from '../src/shared/slides'
import { createSlides, listSlides, type SlideImage } from '../src/main/slides'

/** a w×h BGRA picture: white with a black band from row top to row bottom (fractions of the height) */
function picture(w: number, h: number, bands: Array<[number, number]> = [], cols: [number, number] = [0, 1]): Uint8Array {
  const px = new Uint8Array(w * h * 4).fill(255)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (!bands.some(([a, b]) => y >= a * h && y < b * h) || x < cols[0] * w || x >= cols[1] * w) continue
    const p = (y * w + x) * 4
    px[p] = px[p + 1] = px[p + 2] = 0
  }
  return px
}
const sig = (bands: Array<[number, number]> = [], cols?: [number, number]) => signature(picture(192, 108, bands, cols), 192, 108)

describe('signature and difference', () => {
  it('boils any size down to the same grid', () => {
    expect(signature(picture(192, 108), 192, 108)).toHaveLength(GRID * GRID)
    expect(signature(picture(17, 9), 17, 9)).toHaveLength(GRID * GRID)
    expect(signature(new Uint8Array(3), 10, 10).every((v) => v === 0)).toBe(true)
  })
  it('is nothing for the same picture and all for opposite ones', () => {
    expect(difference(sig(), sig())).toBe(0)
    expect(difference(sig(), sig([[0, 1]]))).toBe(1)
    expect(difference(new Uint8Array(4), new Uint8Array(5))).toBe(1)
  })
  it('sees a new line of text but not a few stray pixels', () => {
    const slide = sig([[0.1, 0.2]])
    // a bullet appearing: a band across most of the width, about a line high
    const bullet = sig([[0.1, 0.2], [0.5, 0.54]], [0.1, 0.7])
    expect(difference(slide, bullet)).toBeGreaterThan(0.012)
    const noise = new Uint8Array(slide)
    noise[5] = 255 - noise[5]
    expect(difference(slide, noise)).toBeLessThan(0.012)
  })
})

describe('isNewSlide', () => {
  const a = sig([[0.1, 0.2]]), b = sig([[0.4, 0.8]])
  it('keeps the first picture', () => expect(isNewSlide({ saved: null, previous: null, current: a })).toBe(true))
  it('skips the slide already kept', () => expect(isNewSlide({ saved: a, previous: a, current: a })).toBe(false))
  it('waits for a change to settle before keeping it', () => {
    expect(isNewSlide({ saved: a, previous: a, current: b })).toBe(false)
    expect(isNewSlide({ saved: a, previous: b, current: b })).toBe(true)
  })
})

describe('slide files', () => {
  it('names files by meeting time and reads them back in order, skipping anything else', () => {
    expect(slideFileName(1234.6)).toBe('slide-000001235.jpg')
    expect(slidesIn(['slide-000090000.jpg', 'notes.txt', 'slide-000001000.jpg', 'slide-000002000.jpg.part', 'slide-5.png']))
      .toEqual([{ file: 'slide-5.png', ms: 5 }, { file: 'slide-000001000.jpg', ms: 1000 }, { file: 'slide-000090000.jpg', ms: 90000 }])
  })
})

describe('createSlides', () => {
  let dir: string
  let shown: Uint8Array
  let gone = false
  let now = 0
  let paused = false
  const views: unknown[] = []
  let tick: (() => void) | undefined
  const image = (): SlideImage => {
    const px = shown
    const img: SlideImage = {
      isEmpty: () => false, getSize: () => ({ width: 192, height: 108 }), resize: () => img,
      toBitmap: () => Buffer.from(px), toJPEG: () => Buffer.from('jpeg'),
    }
    return img
  }
  const make = () => createSlides({
    dirOf: (id) => join(dir, id), grab: async () => (gone ? null : image()), time: () => now, paused: () => paused,
    send: (v) => views.push(v), setInterval: (fn) => { tick = fn; return 1 }, clearInterval: () => { tick = undefined },
  })
  const files = () => { try { return readdirSync(join(dir, 'm', 'slides')).sort() } catch { return [] } }
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'yogurt-slides-')); shown = picture(192, 108, [[0.1, 0.2]]); gone = false; now = 0; paused = false; views.length = 0 })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('keeps the first picture, then only new slides once they settle, at the moment they first showed', async () => {
    const s = make()
    now = 1000
    s.start('m', 'screen:1', 'Screen')
    await s.settled()
    expect(files()).toEqual(['slide-000001000.jpg'])
    now = 5000; tick!(); await s.settled()
    expect(files()).toHaveLength(1)
    shown = picture(192, 108, [[0.5, 0.9]])
    now = 9000; tick!(); await s.settled()
    expect(files()).toHaveLength(1)
    now = 13_000; tick!(); await s.settled()
    expect(files()).toEqual(['slide-000001000.jpg', 'slide-000009000.jpg'])
    expect(s.view()).toMatchObject({ meetingId: 'm', sourceId: 'screen:1', count: 2 })
    expect(readdirSync(join(dir, 'm', 'slides')).some((f) => f.endsWith('.part'))).toBe(false)
  })

  it('takes one on request whatever it shows, even while paused, and nothing by timer while paused', async () => {
    const s = make()
    s.start('m', 'window:1', 'Deck')
    await s.settled()
    paused = true
    shown = picture(192, 108, [[0.5, 0.9]])
    tick!(); await s.settled(); tick!(); await s.settled()
    expect(files()).toHaveLength(1)
    now = 2000
    expect(await s.captureNow()).toBe(true)
    expect(await s.captureNow()).toBe(true)
    expect(files()).toEqual(['slide-000000000.jpg', 'slide-000002000.jpg', 'slide-000002001.jpg'])
  })

  it('says when the source has gone, and stops for good on stop', async () => {
    const s = make()
    s.start('m', 'window:1', 'Deck')
    await s.settled()
    gone = true
    tick!(); await s.settled()
    expect(s.view()?.problem).toBeUndefined()
    tick!(); await s.settled()
    expect(s.view()?.problem).toBe('gone')
    s.stop('other')
    expect(s.view()).not.toBeNull()
    s.stop('m')
    expect(s.view()).toBeNull()
    expect(views.at(-1)).toBeNull()
    expect(tick).toBeUndefined()
    expect(await s.captureNow()).toBe(false)
  })

  it('counts the slides a resumed meeting already has, and lists them with their paths', async () => {
    mkdirSync(join(dir, 'm', 'slides'), { recursive: true })
    writeFileSync(join(dir, 'm', 'slides', slideFileName(500)), 'x')
    const s = make()
    s.start('m', 'screen:1', 'Screen')
    expect(s.view()?.count).toBe(1)
    await s.settled()
    expect(listSlides(join(dir, 'm')).map((x) => [x.ms, x.path])).toEqual([[0, join(dir, 'm', 'slides', slideFileName(0))], [500, join(dir, 'm', 'slides', slideFileName(500))]])
    expect(listSlides(join(dir, 'none'))).toEqual([])
  })
})

describe('a call window Electron does not list (Linux)', () => {
  // two monitors side by side, X11 pixels; Zoom's "Meeting" window as the user's KDE had it
  const left: DisplayArea = { id: 11, bounds: { x: 0, y: 0, width: 2560, height: 1440 }, scaleFactor: 1 }
  const right: DisplayArea = { id: 22, bounds: { x: 2560, y: 0, width: 1920, height: 1080 }, scaleFactor: 1 }
  const meeting = { x: 3156, y: 261, width: 1188, height: 761 }

  it('reads the helper\'s windows and skips malformed ones', () => {
    expect(appWindowsOf([{ id: 144704238, app: 'zoom', title: 'Meeting', x: 3156, y: 261, w: 1188, h: 761 }, { id: 'x' }, null, { id: 5, app: 'zoom', x: 0, y: 0, w: 0, h: 10 }, { id: 6, app: 'zoom', x: -5, y: 0, w: 300, h: 200 }]))
      .toEqual([{ id: 144704238, app: 'zoom', title: 'Meeting', x: 3156, y: 261, w: 1188, h: 761 }, { id: 6, app: 'zoom', title: '', x: -5, y: 0, w: 300, h: 200 }])
    expect(appWindowsOf({ error: 'no' })).toEqual([])
  })
  it('names it after its app, and tells its ids from Electron\'s', () => {
    expect(appWindowName('Zoom', ' Meeting ')).toBe('Zoom – Meeting')
    expect(appWindowName('Zoom', '')).toBe('Zoom')
    expect(xidOf(xwinId(144704238))).toBe(144704238)
    expect(xidOf('window:144704238:0')).toBeNull()
    expect(electronXid('window:144704238:0')).toBe(144704238)
    expect(electronXid('screen:0:0')).toBeNull()
    expect(electronXid('xwin:5')).toBeNull()
  })
  it('finds the display holding the window\'s centre, else the one it overlaps most', () => {
    expect(displayFor(meeting, [left, right])).toBe(right)
    // centre off every screen (below the right one), still mostly on it
    expect(displayFor({ x: 2600, y: 800, width: 1000, height: 600 }, [left, right])).toBe(right)
    expect(displayFor({ x: 9000, y: 0, width: 100, height: 100 }, [left, right])).toBeNull()
  })
  it('cuts the window out of its own display\'s picture', () => {
    const at = screenFor(meeting, [left, right], [{ id: 'screen:1:0', display_id: '11' }, { id: 'screen:2:0', display_id: '22' }])
    expect(at).toEqual({ source: 'screen:2:0', area: { x: 2560, y: 0, width: 1920, height: 1080 } })
    expect(cropFor(meeting, at!.area, { width: 1920, height: 1080 })).toEqual({ x: 596, y: 261, width: 1188, height: 761 })
    // a smaller picture (the picker's thumbnail): the same part, scaled
    expect(cropFor(meeting, at!.area, { width: 320, height: 180 })).toEqual({ x: 99, y: 44, width: 198, height: 126 })
  })
  it('cuts it out of X11\'s one picture of every display', () => {
    const at = screenFor(meeting, [left, right], [{ id: 'screen:0:0', display_id: '' }])
    expect(at).toEqual({ source: 'screen:0:0', area: { x: 0, y: 0, width: 4480, height: 1440 } })
    expect(cropFor(meeting, at!.area, { width: 4480, height: 1440 })).toEqual({ x: 3156, y: 261, width: 1188, height: 761 })
    expect(screenSize([left, right])).toEqual({ x: 0, y: 0, width: 4480, height: 1440 })
  })
  it('falls back to the screens\' order, and gives up when nothing says', () => {
    expect(screenFor(meeting, [left, right], [{ id: 'a', display_id: '' }, { id: 'b', display_id: '' }])?.source).toBe('b')
    expect(screenFor(meeting, [left, right], [{ id: 'a', display_id: '' }, { id: 'b', display_id: '' }, { id: 'c', display_id: '' }])).toBeNull()
    expect(screenFor(meeting, [left, right], [])).toBeNull()
  })
  it('clamps a window partly off its screen, and skips one that barely shows', () => {
    const area = physicalBounds(right)
    // hanging off the right edge and the top
    expect(cropFor({ x: 4000, y: -100, width: 800, height: 500 }, area, { width: 1920, height: 1080 })).toEqual({ x: 1440, y: 0, width: 480, height: 400 })
    expect(cropFor({ x: 4470, y: 0, width: 800, height: 500 }, area, { width: 1920, height: 1080 })).toBeNull()
    expect(cropFor({ x: 0, y: 0, width: 800, height: 500 }, area, { width: 1920, height: 1080 })).toBeNull()
  })
  it('scales DIP bounds to X11 pixels (scale factor 2)', () => {
    const hiLeft: DisplayArea = { id: 1, bounds: { x: 0, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }
    const hiRight: DisplayArea = { id: 2, bounds: { x: 1280, y: 0, width: 1280, height: 720 }, scaleFactor: 2 }
    expect(physicalBounds(hiRight)).toEqual({ x: 2560, y: 0, width: 2560, height: 1440 })
    const at = screenFor(meeting, [hiLeft, hiRight], [{ id: 's1', display_id: '1' }, { id: 's2', display_id: '2' }])
    expect(at).toEqual({ source: 's2', area: { x: 2560, y: 0, width: 2560, height: 1440 } })
    expect(cropFor(meeting, at!.area, { width: 2560, height: 1440 })).toEqual({ x: 596, y: 261, width: 1188, height: 761 })
    // the picture came out at DIP size: the cut is halved
    expect(cropFor(meeting, at!.area, { width: 1280, height: 720 })).toEqual({ x: 298, y: 131, width: 594, height: 380 })
  })
})
