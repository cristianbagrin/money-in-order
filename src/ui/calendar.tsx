import { createContext } from 'preact'
import type { JSX } from 'preact'
import { createPortal } from 'preact/compat'
import { useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { addDays, addMonths, dateLabel, daysInMonth, isoDate, monthName, monthOf, pad } from '../lib/dates'
import './calendar.css'

// Dates are local calendar strings 'YYYY-MM-DD'; ISO order is calendar order, so plain string comparison works.

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']

/** Lets DatePill hand its `today` to the Calendar inside it; a standalone Calendar reads the clock. */
const TodayContext = createContext<string | null>(null)

/** 0 = Monday … 6 = Sunday. */
function weekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number)
  return (new Date(y, m - 1, d).getDay() + 6) % 7
}

function fullLabel(date: string): string {
  return `${DAYS[weekday(date)]}, ${Number(date.slice(8))} ${monthName(monthOf(date))} ${date.slice(0, 4)}`
}

/** The same day-of-month in another month, clamped to that month's length. */
function sameDayIn(month: string, day: number): string {
  return `${month}-${pad(Math.min(day, daysInMonth(month)))}`
}

function clamp(date: string, min?: string, max?: string): string {
  if (min && date < min) return min
  if (max && date > max) return max
  return date
}

function reducedMotion(): boolean {
  return typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
}

function Chevron(props: { dir: 'left' | 'right' }) {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true">
      <path
        d={props.dir === 'left' ? 'M12.5 4.5 7 10l5.5 5.5' : 'M7.5 4.5 13 10l-5.5 5.5'}
        fill="none"
        stroke="currentColor"
        stroke-width="2"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  )
}

// ---------------------------------------------------------------- calendar

/** Month grid, week starting Monday. Arrow keys, PageUp/PageDown, Home/End, Enter/Space; swipe sideways on touch. */
export function Calendar(props: { value: string; onChange: (date: string) => void; max?: string; min?: string }): JSX.Element {
  const { min, max } = props
  const today = useContext(TodayContext) ?? isoDate()
  const value = props.value || today
  const [view, setView] = useState(() => monthOf(value))
  const [dir, setDir] = useState(0) // direction of the last month change; drives the slide
  const [focus, setFocus] = useState(value) // the roving-tabindex day
  const [popped, setPopped] = useState<string | null>(null)
  const rows = useRef<HTMLDivElement>(null)
  const wantFocus = useRef(false)
  const drag = useRef<{ x: number; y: number; t: number; axis: 0 | 1 | 2 } | null>(null)
  const titleId = useId()

  const canPrev = !min || monthOf(min) < view
  const canNext = !max || monthOf(max) > view
  const off = (d: string) => (!!min && d < min) || (!!max && d > max)

  function show(month: string) {
    if (month === view) return
    setDir(month > view ? 1 : -1)
    setView(month)
    setPopped(null)
  }

  function step(n: number) {
    const m = addMonths(view, n)
    show(m)
    setFocus(clamp(sameDayIn(m, Number(focus.slice(8))), min, max))
  }

  function pick(d: string) {
    if (off(d)) return
    setFocus(d)
    setPopped(d)
    props.onChange(d)
  }

  // Follow the value when it changes (from outside, or after picking a neighbouring month's day).
  useEffect(() => {
    show(monthOf(value))
    setFocus(value)
  }, [value])

  // After keyboard navigation, move DOM focus to the new day (the grid may have been re-mounted).
  useLayoutEffect(() => {
    if (!wantFocus.current) return
    wantFocus.current = false
    rows.current?.querySelector<HTMLElement>(`[data-date="${focus}"]`)?.focus({ preventScroll: true })
  })

  function onKeyDown(e: KeyboardEvent) {
    let next: string
    switch (e.key) {
      case 'ArrowLeft':
        next = addDays(focus, -1)
        break
      case 'ArrowRight':
        next = addDays(focus, 1)
        break
      case 'ArrowUp':
        next = addDays(focus, -7)
        break
      case 'ArrowDown':
        next = addDays(focus, 7)
        break
      case 'PageUp':
      case 'PageDown':
        next = sameDayIn(addMonths(monthOf(focus), (e.key === 'PageUp' ? -1 : 1) * (e.shiftKey ? 12 : 1)), Number(focus.slice(8)))
        break
      case 'Home':
        next = addDays(focus, -weekday(focus))
        break
      case 'End':
        next = addDays(focus, 6 - weekday(focus))
        break
      case 'Enter':
      case ' ':
        e.preventDefault()
        pick(focus)
        return
      default:
        return
    }
    e.preventDefault()
    next = clamp(next, min, max)
    wantFocus.current = true
    setFocus(next)
    show(monthOf(next))
  }

  // ---- swipe: the grid follows the finger, then slides to the next/previous month
  function resetDrag(animate: boolean) {
    const el = rows.current
    if (!el) return
    el.style.transition = animate ? 'transform .28s cubic-bezier(.2,.8,.2,1), opacity .28s' : ''
    el.style.transform = ''
    el.style.opacity = ''
  }
  function onTouchStart(e: TouchEvent) {
    const t = e.touches[0]
    drag.current = e.touches.length === 1 ? { x: t.clientX, y: t.clientY, t: e.timeStamp, axis: 0 } : null
  }
  function onTouchMove(e: TouchEvent) {
    const d = drag.current
    const el = rows.current
    if (!d || !el) return
    const t = e.touches[0]
    const dx = t.clientX - d.x
    const dy = t.clientY - d.y
    if (d.axis === 0 && Math.hypot(dx, dy) > 8) d.axis = Math.abs(dx) > Math.abs(dy) ? 1 : 2
    if (d.axis !== 1) return
    if (e.cancelable) e.preventDefault()
    const blocked = dx < 0 ? !canNext : !canPrev
    const shift = dx * (blocked ? 0.12 : 0.45)
    el.style.transition = 'none'
    el.style.transform = `translateX(${shift}px)`
    el.style.opacity = String(1 - Math.min(Math.abs(shift) / 140, 0.45))
  }
  function onTouchEnd(e: TouchEvent) {
    const d = drag.current
    drag.current = null
    if (!d || d.axis !== 1) return
    e.preventDefault() // a horizontal drag is never a tap on a day
    const dx = e.changedTouches[0].clientX - d.x
    const n = dx < 0 ? 1 : -1
    const fast = Math.abs(dx) > 24 && e.timeStamp - d.t < 250
    if ((Math.abs(dx) > 48 || fast) && (n > 0 ? canNext : canPrev)) step(n)
    else resetDrag(true)
  }

  // ---- grid
  const first = `${view}-01`
  const start = addDays(first, -weekday(first))
  const cells = Array.from({ length: 42 }, (_, i) => addDays(start, i))
  const tabDate = cells.includes(focus) ? focus : cells.find((d) => monthOf(d) === view && !off(d)) ?? cells[0]

  return (
    <div class="cal">
      <div class="cal-head">
        <div class="cal-title" id={titleId} aria-live="polite">
          <span key={view} class="cal-title-in" data-dir={dir}>
            {monthName(view)} <span class="cal-year">{view.slice(0, 4)}</span>
          </span>
        </div>
        <div class="cal-nav">
          <button type="button" class="cal-arrow" aria-label="Previous month" disabled={!canPrev} onClick={() => step(-1)}>
            <Chevron dir="left" />
          </button>
          <button type="button" class="cal-arrow" aria-label="Next month" disabled={!canNext} onClick={() => step(1)}>
            <Chevron dir="right" />
          </button>
        </div>
      </div>
      <div role="grid" aria-labelledby={titleId} class="cal-grid" onKeyDown={onKeyDown}>
        <div role="row" class="cal-week">
          {DAYS.map((name) => (
            <div role="columnheader" aria-label={name} key={name}>
              {name[0]}
            </div>
          ))}
        </div>
        <div
          class="cal-clip"
          onTouchStart={onTouchStart}
          onTouchMove={onTouchMove}
          onTouchEnd={onTouchEnd}
          onTouchCancel={() => {
            drag.current = null
            resetDrag(true)
          }}
        >
          <div
            role="rowgroup"
            key={view}
            ref={rows}
            class="cal-rows"
            data-dir={dir}
            onFocusIn={(e) => {
              const d = (e.target as HTMLElement).dataset.date
              if (d && d !== focus) setFocus(d)
            }}
          >
            {[0, 1, 2, 3, 4, 5].map((r) => (
              <div role="row" class="cal-row" key={r}>
                {cells.slice(r * 7, r * 7 + 7).map((d) => {
                  const sel = d === value
                  const cls =
                    'cal-day' +
                    (monthOf(d) !== view ? ' is-out' : '') +
                    (off(d) ? ' is-off' : '') +
                    (d === today ? ' is-today' : '') +
                    (sel && popped === d ? ' is-pop' : '')
                  return (
                    <div
                      role="gridcell"
                      key={d}
                      class={cls}
                      data-date={d}
                      tabIndex={d === tabDate ? 0 : -1}
                      aria-selected={sel ? 'true' : 'false'}
                      aria-disabled={off(d) ? 'true' : undefined}
                      aria-current={d === today ? 'date' : undefined}
                      aria-label={fullLabel(d)}
                      onClick={() => pick(d)}
                    >
                      <span>{Number(d.slice(8))}</span>
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- date pill

type PillState = 'closed' | 'open' | 'picked' | 'dismissed'

/** A pill showing "Today" / "Yesterday" / "Mon 12 Oct" that opens a calendar popover. */
export function DatePill(props: { value: string; today: string; onChange: (date: string) => void; max?: string; class?: string }): JSX.Element {
  const pill = useRef<HTMLButtonElement>(null)
  const host = useRef<HTMLElement | null>(null)
  const viaKeyboard = useRef(false)
  const [state, setState] = useState<PillState>('closed')

  function open(keyboard: boolean) {
    const p = pill.current
    if (!p) return
    if (!host.current) {
      // Inside a modal <dialog> everything outside it is inert, so the layer goes in the dialog there.
      const layer = document.createElement('div')
      layer.className = 'dp-layer'
      ;(p.closest('dialog') ?? document.body).appendChild(layer)
      host.current = layer
    }
    viaKeyboard.current = keyboard
    setState('open')
  }

  function close(how: 'picked' | 'dismissed', refocus: boolean) {
    if (refocus) pill.current?.focus({ preventScroll: true })
    setState((s) => (s !== 'open' ? s : reducedMotion() ? 'closed' : how))
  }

  useEffect(() => {
    if (state === 'closed' && host.current) {
      host.current.remove()
      host.current = null
    }
  }, [state])
  useEffect(() => () => host.current?.remove(), [])

  const label = dateLabel(props.value, props.today)
  return (
    <>
      <button
        ref={pill}
        type="button"
        class={`pill datepill${props.class ? ' ' + props.class : ''}`}
        aria-pressed={props.value !== props.today ? 'true' : 'false'}
        aria-haspopup="dialog"
        aria-expanded={state === 'open' ? 'true' : 'false'}
        aria-label={`Date: ${label}`}
        onClick={(e) => (state === 'open' ? close('dismissed', true) : open(e.detail === 0))}
      >
        {label}
      </button>
      {state !== 'closed' &&
        host.current &&
        pill.current &&
        createPortal(
          <Popover
            anchor={pill.current}
            closing={state === 'open' ? null : state}
            keyboard={viaKeyboard.current}
            value={props.value}
            today={props.today}
            max={props.max}
            onPick={(d) => {
              props.onChange(d)
              close('picked', true)
            }}
            onDismiss={(refocus) => close('dismissed', refocus)}
            onClosed={() => setState((s) => (s === 'open' ? s : 'closed'))}
          />,
          host.current,
        )}
    </>
  )
}

const EDGE = 8 // min distance from the viewport edges
const GAP = 8 // between pill and card

function Popover(props: {
  anchor: HTMLElement
  closing: 'picked' | 'dismissed' | null
  keyboard: boolean
  value: string
  today: string
  max?: string
  onPick: (date: string) => void
  onDismiss: (refocus: boolean) => void
  onClosed: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const card = useRef<HTMLDivElement>(null)
  const { anchor, closing, today, max } = props
  const yesterday = addDays(today, -1)

  // Position (fixed, clamped to the viewport, flipped above when there's no room below) before first paint.
  useLayoutEffect(() => {
    // Promote to the top layer where supported, so no ancestor's overflow, transform or stacking can clip or cover it.
    const el = box.current
    if (el && typeof el.showPopover === 'function') {
      el.setAttribute('popover', 'manual')
      try {
        el.showPopover()
      } catch {
        el.removeAttribute('popover')
      }
    }
    const place = () => {
      const el = box.current
      const c = card.current
      if (!el || !c) return
      const a = anchor.getBoundingClientRect()
      const vw = document.documentElement.clientWidth || window.innerWidth
      const vh = window.innerHeight
      const w = el.offsetWidth
      const h = el.offsetHeight
      const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - w / 2, vw - EDGE - w))
      const roomBelow = vh - a.bottom - GAP - EDGE
      const roomAbove = a.top - GAP - EDGE
      const below = h <= roomBelow || roomBelow >= roomAbove
      const top = Math.max(EDGE, Math.min(below ? a.bottom + GAP : a.top - GAP - h, vh - EDGE - h))
      el.style.left = `${left}px`
      el.style.top = `${top}px`
      // A transformed ancestor (e.g. an animating sheet) shifts fixed positioning; correct for it.
      const r = el.getBoundingClientRect()
      if (Math.abs(r.left - left) > 0.5) el.style.left = `${2 * left - r.left}px`
      if (Math.abs(r.top - top) > 0.5) el.style.top = `${2 * top - r.top}px`
      el.dataset.side = below ? 'below' : 'above'
      const ox = Math.max(16, Math.min(a.left + a.width / 2 - left, w - 16))
      c.style.transformOrigin = `${ox}px ${below ? a.bottom - top : a.top - top}px`
      c.style.setProperty('--dp-dy', below ? '-6px' : '6px')
    }
    place()
    if (props.keyboard) card.current?.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]')?.focus({ preventScroll: true })
    else card.current?.focus({ preventScroll: true })
    const vv = window.visualViewport
    window.addEventListener('resize', place)
    window.addEventListener('scroll', place, true)
    vv?.addEventListener('resize', place)
    vv?.addEventListener('scroll', place)
    return () => {
      window.removeEventListener('resize', place)
      window.removeEventListener('scroll', place, true)
      vv?.removeEventListener('resize', place)
      vv?.removeEventListener('scroll', place)
    }
  }, [])

  // Outside tap / Esc close it while open.
  useEffect(() => {
    if (closing) return
    const down = (e: PointerEvent) => {
      const t = e.target as Node
      if (box.current?.contains(t) || anchor.contains(t)) return
      props.onDismiss(false)
    }
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      e.preventDefault() // keep an enclosing <dialog> open
      e.stopPropagation()
      props.onDismiss(true)
    }
    document.addEventListener('pointerdown', down, true)
    document.addEventListener('keydown', key, true)
    return () => {
      document.removeEventListener('pointerdown', down, true)
      document.removeEventListener('keydown', key, true)
    }
  }, [closing])

  // Unmount after the closing animation (with a fallback in case animationend never fires).
  useEffect(() => {
    if (!closing) return
    const t = setTimeout(props.onClosed, 450)
    return () => clearTimeout(t)
  }, [closing])

  const quick = (d: string, label: string) => (
    <button type="button" class="pill" aria-pressed={props.value === d ? 'true' : 'false'} disabled={!!max && d > max} onClick={() => props.onPick(d)}>
      {label}
    </button>
  )

  return (
    <div class="dp-pop" ref={box}>
      <div
        ref={card}
        class={'dp-card' + (closing ? ' is-out' : '') + (closing === 'picked' ? ' is-picked' : '')}
        role="dialog"
        aria-label="Choose date"
        tabIndex={-1}
        onAnimationEnd={(e) => {
          if (closing && e.target === card.current) props.onClosed()
        }}
        onFocusOut={(e) => {
          const to = e.relatedTarget as Node | null
          if (!closing && to && !box.current?.contains(to) && !anchor.contains(to)) props.onDismiss(false)
        }}
      >
        <div class="dp-quick">
          {quick(today, 'Today')}
          {quick(yesterday, 'Yesterday')}
        </div>
        <TodayContext.Provider value={today}>
          <Calendar value={props.value} max={max} onChange={props.onPick} />
        </TodayContext.Provider>
      </div>
    </div>
  )
}
