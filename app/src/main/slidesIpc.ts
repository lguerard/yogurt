import { BrowserWindow, desktopCapturer, ipcMain, systemPreferences } from 'electron'
import { isId } from './ipcArgs'
import { createSlides, type SlideImage } from './slides'
import type { SlideSource, SlideSourcesView } from '../shared/slides'

/** what a full picture is fitted into: a 16:10 screen at this size reads well, and stays light enough to take every few seconds */
const PICTURE = { width: 1920, height: 1200 }
const kindOf = (id: string): SlideSource['kind'] => (id.startsWith('screen:') ? 'screen' : 'window')

/**
 * A Mac lets an app see other apps' windows only once the person allows Screen Recording (System Settings, Privacy &
 * Security). Not asked yet: listing the sources makes the Mac ask, and what the person answers counts from Yogurt's
 * next start. Windows and Linux ask nothing.
 */
const screenAccess = (): 'granted' | 'denied' | 'unknown' => {
  if (process.platform !== 'darwin') return 'granted'
  const s = systemPreferences.getMediaAccessStatus('screen')
  return s === 'granted' ? 'granted' : s === 'not-determined' ? 'unknown' : 'denied'
}

/**
 * Slides in the note (SlidesMenu): the screens and windows there are, starting and stopping, and "capture slide now".
 * Only the meeting being recorded takes slides, and only from a source the picker just listed.
 */
export function hookSlides(d: {
  dirOf: (id: string) => string
  /** the meeting being recorded, if any */
  recordingId: () => string | null
  /** meeting time now, on the transcript's clock */
  time: () => number
  paused: (id: string) => boolean
  window: () => BrowserWindow | undefined
  /** opens the Mac's Screen Recording settings */
  openSettings: () => void
}) {
  let listed = new Map<string, SlideSource>()
  const slides = createSlides({
    dirOf: d.dirOf, time: d.time, paused: d.paused,
    send: (v) => { const win = d.window(); if (win && !win.isDestroyed()) win.webContents.send('slides:state', v) },
    grab: async (id) => {
      const all = await desktopCapturer.getSources({ types: [kindOf(id)], thumbnailSize: PICTURE, fetchWindowIcons: false })
      return (all.find((s) => s.id === id)?.thumbnail as SlideImage | undefined) ?? null
    },
  })
  const own = () => new Set(BrowserWindow.getAllWindows().flatMap((w) => { try { return [w.getMediaSourceId()] } catch { return [] } }))

  ipcMain.handle('slides:sources', async (): Promise<SlideSourcesView> => {
    if (screenAccess() === 'denied') return { access: 'denied', sources: [] }
    try {
      const mine = own()
      const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: false })
      const sources = all.filter((s) => !mine.has(s.id)).map((s): SlideSource => ({
        id: s.id, name: s.name.trim() || s.id, kind: kindOf(s.id), thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
      }))
      listed = new Map(sources.map((s) => [s.id, s]))
      // the Mac asked just now, or still says no: the pictures would show only the desktop
      if (screenAccess() !== 'granted') return { access: 'denied', sources: [] }
      return { access: 'granted', sources }
    } catch (e) {
      console.error('listing screens and windows failed', e)
      return { access: 'granted', sources: [] }
    }
  })
  ipcMain.handle('slides:start', (_e, meetingId: unknown, sourceId: unknown) => {
    if (!isId(meetingId) || typeof sourceId !== 'string' || d.recordingId() !== meetingId) return false
    const source = listed.get(sourceId)
    if (!source) return false
    slides.start(meetingId, source.id, source.name)
    return true
  })
  ipcMain.handle('slides:stop', () => { slides.stop() })
  ipcMain.handle('slides:capture', () => slides.captureNow())
  ipcMain.handle('slides:state', () => slides.view())
  ipcMain.handle('slides:open-settings', () => { d.openSettings() })
  return slides
}
