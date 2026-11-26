import { describe, expect, it } from 'vitest'
import { difference, GRID, isNewSlide, signature, slideFileName, slidesIn } from '../src/shared/slides'

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
