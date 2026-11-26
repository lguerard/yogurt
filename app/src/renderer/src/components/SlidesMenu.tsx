import { usePopoverPresence } from '../motion'
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { Check, ChevronDown, Monitor, Plus, Square } from './Icons'
import type { SlideCaptureView, SlideSource, SlideSourcesView } from '../../../shared/slides'
import { t } from '../../../shared/i18n'

/**
 * Slides under the note's bar while it records: pick a screen or window and Yogurt keeps a picture of it each time it
 * shows something new, on the transcript's clock, so Save Markdown puts the slides where they were shown. While on, the
 * menu also takes one now, or stops.
 */
export function SlidesMenu({ meetingId }: { meetingId: string }) {
  const [view, setView] = useState<SlideCaptureView | null>(null)
  const [list, setList] = useState<SlideSourcesView>()
  const [open, setOpen] = useState<false | 'pointer' | 'keyboard'>(false)
  const [flash, setFlash] = useState(false)
  const presence = usePopoverPresence(open)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const load = useCallback(() => window.yogurt.slides.sources().then(setList).catch(() => setList({ access: 'granted', sources: [] })), [])

  useEffect(() => {
    void window.yogurt.slides.state().then(setView).catch(() => {})
    return window.yogurt.slides.onState(setView)
  }, [])
  useEffect(() => {
    if (!open) return
    void load()
    const away = (e: MouseEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', away)
    return () => document.removeEventListener('mousedown', away)
  }, [open, load])
  useEffect(() => {
    if (open) root.current?.querySelector<HTMLButtonElement>('[role^="menuitem"][aria-checked="true"], [role^="menuitem"]')?.focus()
  }, [open, list])
  useEffect(() => {
    if (!flash) return
    const timer = setTimeout(() => setFlash(false), 1500)
    return () => clearTimeout(timer)
  }, [flash])

  const mine = view?.meetingId === meetingId ? view : null
  const close = () => { setOpen(false); button.current?.focus() }
  const choose = async (s: SlideSource) => { close(); await window.yogurt.slides.start(meetingId, s.id).catch(() => false) }
  const captureNow = async () => { close(); if (await window.yogurt.slides.capture().catch(() => false)) setFlash(true) }
  const stop = async () => { close(); await window.yogurt.slides.stop().catch(() => {}) }
  const onKey = (e: KeyboardEvent) => {
    const items = Array.from(root.current?.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]') ?? [])
    const at = items.indexOf(document.activeElement as HTMLButtonElement)
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(at + 1) % items.length]?.focus() }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(at - 1 + items.length) % items.length]?.focus() }
    else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus() }
    else if (e.key === 'End') { e.preventDefault(); items.at(-1)?.focus() }
    else if (e.key === 'Tab') setOpen(false)
  }

  const row = 'flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-start text-sm hover:bg-[var(--line)] focus-visible:bg-[var(--line)] focus-visible:outline-none'
  const group = (kind: SlideSource['kind'], label: string) => {
    const sources = list?.sources.filter((s) => s.kind === kind) ?? []
    if (!sources.length) return null
    return <>
      <p className="px-3 pb-1 pt-2 text-xs text-muted">{label}</p>
      {sources.map((s) => (
        <button key={s.id} role="menuitemradio" aria-checked={mine?.sourceId === s.id} data-testid="slides-source" data-id={s.id} onClick={() => void choose(s)} className={row}>
          <span className="relative flex-none">
            {s.thumbnail
              ? <img src={s.thumbnail} alt="" className="h-9 w-14 rounded border border-line object-contain" />
              : <span className="flex h-9 w-14 items-center justify-center rounded border border-line text-muted"><Monitor size={14} /></span>}
            {s.icon ? <img src={s.icon} alt="" className="absolute -bottom-1 -right-1 h-4 w-4 rounded-sm" /> : null}
          </span>
          <span className="min-w-0 flex-1 truncate">{s.name}</span>
          <Check size={15} aria-hidden="true" className={`shrink-0 ${mine?.sourceId === s.id ? '' : 'invisible'}`} />
        </button>
      ))}
    </>
  }
  const problem = mine?.problem === 'gone' ? t('The screen or window is no longer available.') : mine?.problem === 'failed' ? t("Couldn't capture slides") : null
  return (
    <div ref={root} className="relative flex min-w-0 items-center gap-1.5">
      <button ref={button} data-testid="slides-chip" data-on={!!mine} aria-haspopup="menu" aria-expanded={!!open}
        title={mine ? t('Slides from {name}', { name: mine.name }) : t('Slides')}
        onClick={(e) => setOpen((o) => o ? false : e.detail > 0 ? 'pointer' : 'keyboard')}
        className={`bar-btn flex max-w-[200px] items-center gap-1.5 rounded-md px-1.5 py-0.5 hover:text-ink aria-expanded:text-ink ${mine ? 'text-ink' : ''}`}>
        <Monitor size={11} aria-hidden="true" />
        <span className="truncate">{mine ? mine.name : t('Slides')}</span>
        {mine && <span data-testid="slides-count" className="tabular-nums text-muted">{mine.count}</span>}
        <ChevronDown size={11} aria-hidden="true" className="shrink-0" />
      </button>
      {flash && <span role="status" className="text-ink"><Check size={11} aria-hidden="true" /></span>}
      {problem && <span data-testid="slides-problem" role="status" className="text-danger">{problem}</span>}
      {presence.value && (
        <div data-testid="slides-menu" {...presence.props} data-anchor="bottom-start" role="menu" aria-label={t('Slides')} onKeyDown={onKey}
          className="menu-entry absolute bottom-full start-0 z-30 mb-2 max-h-[60vh] w-80 overflow-y-auto rounded-xl border border-line bg-float p-1.5 text-ink shadow-[var(--shadow)]">
          {mine && <>
            <button role="menuitem" data-testid="slides-capture" onClick={() => void captureNow()} className={row}>
              <Plus size={15} aria-hidden="true" className="flex-none text-muted" />{t('Capture slide now')}
            </button>
            <button role="menuitem" data-testid="slides-stop" onClick={() => void stop()} className={row}>
              <Square size={15} aria-hidden="true" className="flex-none text-muted" />{t('Stop capturing slides')}
            </button>
            <div aria-hidden="true" className="mx-2 my-1 h-px bg-[var(--line)]" />
          </>}
          {list?.access === 'denied' && (
            <div data-testid="slides-denied" className="px-3 py-2 text-sm">
              <p className="text-muted">{t('Allow Yogurt to record your screen in System Settings, then reopen Yogurt to capture slides.')}</p>
              <button role="menuitem" onClick={() => { close(); void window.yogurt.slides.openSettings() }} className="workspace-button mt-2">{t('Open System Settings')}</button>
            </div>
          )}
          {list?.access === 'granted' && !list.sources.length && <p className="px-3 py-2 text-sm text-muted">{t('No screens or windows found')}</p>}
          {group('screen', t('Screens'))}
          {group('window', t('Windows'))}
        </div>
      )}
    </div>
  )
}
