import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { difference, GRID, isNewSlide, placeSlides, signature, slideFileName, slidesIn } from '../src/shared/slides'
import { slideHref, toMarkdownFile, transcriptMarkdown } from '../src/shared/exportNotes'
import { docToMd } from '../src/shared/markdown'
import { transcriptDoc } from '../src/shared/exportNotes'
import { createSlides, listSlides, type SlideImage } from '../src/main/slides'
import type { Meeting, Segment } from '../src/shared/types'

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

describe('placeSlides', () => {
  it('puts each slide before the first turn starting at or after it, the late ones at the end', () => {
    const r = placeSlides([0, 5000, 10_000], [{ ms: 12_000 }, { ms: 0 }, { ms: 5000 }, { ms: 4999 }, { ms: 1 }])
    expect(r.before).toEqual([[{ ms: 0 }], [{ ms: 1 }, { ms: 4999 }, { ms: 5000 }], []])
    expect(r.after).toEqual([{ ms: 12_000 }])
  })
  it('puts everything at the end without turns', () => {
    expect(placeSlides([], [{ ms: 3 }])).toEqual({ before: [], after: [{ ms: 3 }] })
  })
})

const meeting: Meeting = { id: 'm1', title: 'Review', startedAt: new Date(2026, 9, 29, 10).getTime(), endedAt: null, eventId: null, app: null, attendees: [], state: 'done', language: null, titleSource: 'user' }
const seg = (track: 'me' | 'them', startMs: number, text: string): Segment => ({ id: startMs, meetingId: 'm1', track, startMs, endMs: startMs + 2000, text, speaker: null })
const segments = [seg('me', 0, 'Welcome.'), seg('them', 20_000, 'First slide.'), seg('me', 60_000, 'Next one.')]

describe('Markdown with slides', () => {
  it('is the transcript unchanged without slides', () => {
    expect(transcriptMarkdown(segments)).toBe(docToMd(transcriptDoc(segments, { gap: true })))
    expect(toMarkdownFile(meeting, 'notes', segments, false, [])).toBe(toMarkdownFile(meeting, 'notes', segments, false))
  })
  it('puts the summary first, then the transcript with each slide where it was shown', () => {
    const file = toMarkdownFile(meeting, '## Summary\n- shipped', segments, false, [
      { ms: 15_000, href: 'a/slide-001.jpg' }, { ms: 61_000, href: 'a/slide-003.jpg' }, { ms: 20_000, href: 'a/slide-002.jpg' },
    ])
    const at = ['## Summary', '## Transcript', '**You** (0:00)', '![Slide 1](a/slide-001.jpg)', '![Slide 2](a/slide-002.jpg)', '**Them** (0:20)', '**You** (1:00)', '![Slide 3](a/slide-003.jpg)'].map((s) => file.indexOf(s))
    expect(at.every((i) => i >= 0)).toBe(true)
    expect([...at].sort((a, b) => a - b)).toEqual(at)
    expect(file.trimEnd().endsWith('![Slide 3](a/slide-003.jpg)')).toBe(true)
  })
  it('keeps a transcript section for slides even when nothing was heard', () => {
    expect(toMarkdownFile(meeting, 'x', [], false, [{ ms: 0, href: 's.jpg' }])).toContain('## Transcript\n\n![Slide 1](s.jpg)')
  })
  it('escapes spaces and brackets in links', () => {
    expect(slideHref('Review (draft) 2026-10-29_slides', 'slide-001.jpg')).toBe('Review%20%28draft%29%202026-10-29_slides/slide-001.jpg')
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
