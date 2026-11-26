import { BrowserWindow, desktopCapturer, ipcMain, screen, systemPreferences, type DesktopCapturerSource, type NativeImage } from 'electron'
import { isId } from './ipcArgs'
import { createSlides, type SlideImage } from './slides'
import {
  appWindowName, appWindowsOf, cropFor, electronXid, rectOf, screenFor, screenSize, xidOf, xwinId,
  type AppWindow, type DisplayArea, type SlideSource, type SlideSourcesView,
} from '../shared/slides'

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
 * Linux: the call apps' windows, from yogurt-system app-windows. Electron's window list can miss a call's window: KDE
 * leaves Zoom's "Meeting" window unframed, and Chromium's X11 list skips it. Such a window is listed as "xwin:<xid>"
 * and its slides are cut out of a picture of the screen it is on.
 */
export type CallWindows = { ids: string[]; nameOf: (appId: string) => string; read: (ids: string[]) => Promise<unknown> }

const displays = (): DisplayArea[] => screen.getAllDisplays().map((d) => ({ id: d.id, bounds: d.bounds, scaleFactor: d.scaleFactor }))

/** The part of a screen's picture that shows the window; null when it is on no screen Electron pictures */
function cut(win: AppWindow, screens: DesktopCapturerSource[]): NativeImage | null {
  const at = screenFor(rectOf(win), displays(), screens.map((s) => ({ id: s.id, display_id: s.display_id ?? '' })))
  const picture = at && screens.find((s) => s.id === at.source)?.thumbnail
  if (!at || !picture || picture.isEmpty()) return null
  const crop = cropFor(rectOf(win), at.area, picture.getSize())
  return crop ? picture.crop(crop) : null
}

/** a picture no bigger than PICTURE, as Electron's own window pictures are */
function fitted(img: NativeImage): NativeImage {
  const { width, height } = img.getSize()
  const k = Math.min(1, PICTURE.width / width, PICTURE.height / height)
  return k < 1 ? img.resize({ width: Math.max(1, Math.round(width * k)), height: Math.max(1, Math.round(height * k)), quality: 'good' }) : img
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
  /** Linux: the call windows Electron may not list */
  callWindows?: CallWindows
}) {
  let listed = new Map<string, SlideSource>()
  const readWindows = async (): Promise<AppWindow[]> => (d.callWindows ? appWindowsOf(await d.callWindows.read(d.callWindows.ids)) : [])

  /** a window Electron does not list: where it is now (it may have moved), cut out of its screen's full picture */
  async function grabXWindow(xid: number): Promise<SlideImage | null> {
    const win = (await readWindows()).find((w) => w.id === xid)
    if (!win) return null
    const all = displays()
    if (!all.length) return null
    // pictures are fitted into the whole X screen's size, so none comes out smaller than its display, X11's "Entire
    // screen" (every display in one picture) included; cropFor scales to whatever size each came out
    const size = screenSize(all)
    const screens = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: size.width, height: size.height }, fetchWindowIcons: false })
    const img = cut(win, screens)
    return img ? (fitted(img) as SlideImage) : null
  }

  const slides = createSlides({
    dirOf: d.dirOf, time: d.time, paused: d.paused,
    send: (v) => { const win = d.window(); if (win && !win.isDestroyed()) win.webContents.send('slides:state', v) },
    grab: async (id) => {
      const xid = xidOf(id)
      if (xid != null) return grabXWindow(xid)
      const all = await desktopCapturer.getSources({ types: [kindOf(id)], thumbnailSize: PICTURE, fetchWindowIcons: false })
      return (all.find((s) => s.id === id)?.thumbnail as SlideImage | undefined) ?? null
    },
  })
  const own = () => new Set(BrowserWindow.getAllWindows().flatMap((w) => { try { return [w.getMediaSourceId()] } catch { return [] } }))

  /** the call windows missing from Electron's list, each cut out of its screen's thumbnail */
  async function missingWindows(all: DesktopCapturerSource[]): Promise<SlideSource[]> {
    if (!d.callWindows) return []
    const windows = all.filter((s) => kindOf(s.id) === 'window')
    let found: AppWindow[] = []
    try { found = await readWindows() } catch (e) { console.warn('slides: reading the call windows failed', e) }
    const known = new Map(windows.flatMap((s) => { const x = electronXid(s.id); return x == null ? [] : [[x, s] as const] }))
    // an app's icon, from one of its windows Electron did list
    const icons = new Map<string, string>()
    for (const w of found) {
      const icon = known.get(w.id)?.appIcon
      if (icon && !icon.isEmpty() && !icons.has(w.app)) icons.set(w.app, icon.resize({ width: 32, height: 32 }).toDataURL())
    }
    const screens = all.filter((s) => kindOf(s.id) === 'screen')
    const added = found.filter((w) => !known.has(w.id)).map((w): SlideSource => {
      const thumb = cut(w, screens)
      return { id: xwinId(w.id), name: appWindowName(d.callWindows!.nameOf(w.app), w.title), kind: 'window', thumbnail: thumb ? thumb.toDataURL() : '', icon: icons.get(w.app) ?? '' }
    })
    // counts only: main.log is pasted in public, and window titles name meetings
    console.info(`slides: ${windows.length} windows from Electron, ${found.length} call windows from yogurt-system, ${added.length} added`)
    return added
  }

  ipcMain.handle('slides:sources', async (): Promise<SlideSourcesView> => {
    if (screenAccess() === 'denied') return { access: 'denied', sources: [] }
    try {
      const mine = own()
      const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 320, height: 200 }, fetchWindowIcons: true })
      const sources = all.filter((s) => !mine.has(s.id)).map((s): SlideSource => ({
        id: s.id, name: s.name.trim() || s.id, kind: kindOf(s.id), thumbnail: s.thumbnail.isEmpty() ? '' : s.thumbnail.toDataURL(),
        icon: !s.appIcon || s.appIcon.isEmpty() ? '' : s.appIcon.resize({ width: 32, height: 32 }).toDataURL(),
      }))
      // the call's windows first among the windows
      const extra = await missingWindows(all)
      const first = sources.findIndex((s) => s.kind === 'window')
      sources.splice(first < 0 ? sources.length : first, 0, ...extra)
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
