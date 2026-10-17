import type { ComponentChildren, JSX } from 'preact'
import { useId, useLayoutEffect, useRef, useState } from 'preact/hooks'
import './sheet.css'

/*
  Sheet: a bottom sheet on phones, a centred panel on wide screens.

  Built on <dialog>.showModal() for the top layer, focus trap and Esc. The dialog itself is a
  transparent full-screen layer holding our own scrim and panel, so the backdrop can follow the finger.
  The open/closed pose lives in CSS (data-state on the dialog); JS only flips the state, drives the
  drag with inline transforms, and waits for the panel's transition before removing anything.
*/

const PHONE = '(max-width: 959px)'
const REDUCED = '(prefers-reduced-motion: reduce)'
const SETTLE_MS = 480 // fallback when a transition never reports back

// ---------------------------------------------------------------- page scroll lock (shared by stacked sheets)

let locks = 0
let saved: { html: string; body: string; gutter: string } | null = null

function lockScroll() {
  if (locks++ > 0) return
  const html = document.documentElement
  const body = document.body
  const bar = window.innerWidth - html.clientWidth
  saved = { html: html.style.overflow, body: body.style.overflow, gutter: html.style.getPropertyValue('scrollbar-gutter') }
  html.style.overflow = 'hidden'
  body.style.overflow = 'hidden'
  // Keep the page from shifting sideways where scrollbars take space (desktop, classic scrollbars).
  if (bar > 0) html.style.setProperty('scrollbar-gutter', 'stable')
}

function unlockScroll() {
  if (locks === 0 || --locks > 0 || !saved) return
  const html = document.documentElement
  html.style.overflow = saved.html
  document.body.style.overflow = saved.body
  if (saved.gutter) html.style.setProperty('scrollbar-gutter', saved.gutter)
  else html.style.removeProperty('scrollbar-gutter')
  saved = null
}

// ---------------------------------------------------------------- stacking

// Sheets open in order; the one beneath the top sheet steps back a little (phones), like iOS.
const stack: HTMLDialogElement[] = []
const topListeners = new Set<(d: HTMLDialogElement | null) => void>()

function pushStack(d: HTMLDialogElement) {
  if (stack.includes(d)) return
  stack[stack.length - 1]?.setAttribute('data-under', '')
  stack.push(d)
  for (const fn of topListeners) fn(d)
}

function popStack(d: HTMLDialogElement) {
  const i = stack.indexOf(d)
  if (i < 0) return
  stack.splice(i, 1)
  d.removeAttribute('data-under')
  if (i === stack.length) {
    stack[stack.length - 1]?.removeAttribute('data-under')
    const top = stack[stack.length - 1] ?? null
    for (const fn of topListeners) fn(top)
  }
}

/** The sheet currently on top, if any. Anything that must stay clickable above a sheet (the toast) lives inside it. */
export function topSheet(): HTMLDialogElement | null {
  return stack[stack.length - 1] ?? null
}

/** Called whenever the top sheet changes (opened, or closing and revealing the one beneath). */
export function onTopSheet(fn: (d: HTMLDialogElement | null) => void): () => void {
  topListeners.add(fn)
  return () => {
    topListeners.delete(fn)
  }
}

// ---------------------------------------------------------------- controller

type Phase = 'idle' | 'enter' | 'open' | 'exit'

interface Els {
  d: HTMLDialogElement
  p: HTMLDivElement // panel
  s: HTMLDivElement // scrim
  sc: HTMLDivElement // scrolling body
}

interface Drag {
  id: number
  x0: number
  y0: number
  head: boolean
  on: boolean
  base: number
  h: number
  off: number
  pts: [number, number][]
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** iOS-style resistance: gives way less and less the further you pull. */
const rubber = (x: number) => (1 - 1 / ((x * 0.55) / 120 + 1)) * 120

function translateY(el: Element): number {
  const t = getComputedStyle(el).transform
  if (!t || t === 'none') return 0
  try {
    return new DOMMatrixReadOnly(t).m42
  } catch {
    return 0
  }
}

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
  return null
}

function createController(gone: (byUser: boolean) => void) {
  let els: Els | null = null
  let phase: Phase = 'idle'
  let byUser = false
  let locked = false
  let drag: Drag | null = null
  let quietUntil = 0
  let openedAt = 0
  let lastKb = 0
  let stopWaiting: (() => void) | null = null

  const phone = () => matchMedia(PHONE).matches
  const reduced = () => matchMedia(REDUCED).matches

  function lock() {
    if (locked) return
    locked = true
    lockScroll()
  }
  function unlock() {
    if (!locked) return
    locked = false
    unlockScroll()
  }

  /** Run `then` when the panel's transition ends (or after a fallback), unless superseded. */
  function wait(then: () => void, ms = SETTLE_MS) {
    stopWaiting?.()
    if (!els) return
    const p = els.p
    const finish = () => {
      stop()
      then()
    }
    const onEnd = (e: TransitionEvent) => {
      if (e.target === p) finish()
    }
    const timer = window.setTimeout(finish, ms)
    const stop = () => {
      clearTimeout(timer)
      p.removeEventListener('transitionend', onEnd)
      if (stopWaiting === stop) stopWaiting = null
    }
    p.addEventListener('transitionend', onEnd)
    stopWaiting = stop
  }

  function clearInline() {
    if (!els) return
    const { p, s } = els
    p.style.removeProperty('transform')
    p.style.removeProperty('transition-duration')
    p.style.removeProperty('transition-timing-function')
    s.style.removeProperty('opacity')
    s.style.removeProperty('transition-duration')
  }

  function show() {
    if (!els) return
    const { d, p } = els
    if (d.open && (phase === 'enter' || phase === 'open')) return
    stopWaiting?.()
    drag = null
    d.removeAttribute('data-drag')
    clearInline()
    if (!d.open) {
      // The second tap of a double tap that opened the sheet must not land on what slid in under it.
      openedAt = performance.now()
      quietUntil = openedAt + 380
      d.removeAttribute('data-state')
      // Unless the content asks for [autofocus], start focus on the panel itself rather than the
      // first control, so opening a sheet never pops the phone keyboard by surprise.
      p.toggleAttribute('autofocus', !els.sc.querySelector('.sheet-body [autofocus]'))
      try {
        d.showModal()
      } catch {
        d.setAttribute('open', '')
      }
      lock()
      fitKeyboard()
      void p.offsetHeight // commit the closed pose so the transition has somewhere to start
    }
    phase = 'enter'
    pushStack(d)
    d.setAttribute('data-state', 'open')
    wait(() => {
      phase = 'open'
    })
  }

  function hide(user: boolean, fling?: { off: number; v: number; h: number }) {
    if (!els || phase === 'idle' || phase === 'exit') return
    const { d, p, s } = els
    phase = 'exit'
    byUser = user
    drag = null
    if (quietUntil === Infinity) quietUntil = performance.now() + 350
    if (fling && !reduced()) {
      // Carry the finger's speed into the exit: shorter when flung hard, never sluggish.
      const ms = Math.round(clamp((fling.h - fling.off) / Math.max(fling.v, 1.1), 140, 300))
      p.style.transitionDuration = `${ms}ms`
      p.style.transitionTimingFunction = 'cubic-bezier(0.25, 0.75, 0.4, 1)'
      s.style.transitionDuration = `${ms}ms`
      p.style.removeProperty('transform')
    } else if (!fling) {
      clearInline()
    }
    // Reduced motion + fling: keep the dragged position and simply fade from there.
    s.style.removeProperty('opacity')
    d.removeAttribute('data-drag')
    d.setAttribute('data-state', 'exit')
    popStack(d) // the sheet beneath steps forward while this one leaves
    wait(done)
  }

  function done() {
    if (!els || phase !== 'exit') return
    const { d } = els
    phase = 'idle'
    clearInline()
    d.removeAttribute('data-state')
    popStack(d)
    if (d.open) d.close()
    unlock()
    gone(byUser)
  }

  /** The browser closed the dialog by itself (e.g. a second Esc Chrome would not let us cancel). */
  function onNativeClose() {
    if (!els || els.d.open || phase === 'idle') return
    stopWaiting?.()
    phase = 'idle'
    drag = null
    clearInline()
    els.d.removeAttribute('data-state')
    els.d.removeAttribute('data-drag')
    popStack(els.d)
    unlock()
    gone(true)
  }

  function onCancel(e: Event) {
    if (!els || e.target !== els.d || !e.cancelable) return
    e.preventDefault()
    hide(true)
  }

  // ------------------------------------------------------------ drag to dismiss

  function onTouchStart(e: TouchEvent) {
    if (!els) return
    if (drag?.on) return // extra fingers don't interrupt a drag
    drag = null
    if (e.touches.length !== 1 || (phase !== 'open' && phase !== 'enter') || !phone()) return
    const { d, p } = els
    const t = e.target as Element
    if (t.closest('dialog') !== d) return // a sheet stacked inside this one
    const head = !!t.closest('.sheet-head')
    if (!head) {
      if (t.closest('input[type="range"], textarea, select, [data-sheet-nodrag]')) return
      for (let n: Element | null = t; n && n !== p; n = n.parentElement) if (n.scrollTop > 0) return
    }
    const pt = e.touches[0]
    drag = { id: pt.identifier, x0: pt.clientX, y0: pt.clientY, head, on: false, base: 0, h: 0, off: 0, pts: [] }
  }

  function onTouchMove(e: TouchEvent) {
    if (!drag || !els) return
    const pt = findTouch(e.touches, drag.id)
    if (!pt) return
    if (!drag.on) {
      const dx = pt.clientX - drag.x0
      const dy = pt.clientY - drag.y0
      const ax = Math.abs(dx)
      const ay = Math.abs(dy)
      // Only a mostly vertical move can become a drag; from the body only a downward one.
      const wants = ay > ax && (drag.head || dy > 0)
      if (ax + ay < 5) {
        // Too small to judge. Holding back a downward nudge at the top costs nothing (there is
        // nothing above to scroll to) and keeps the browser from claiming the gesture first.
        if (wants && e.cancelable) e.preventDefault()
        return
      }
      if (!wants || (!drag.head && els.sc.scrollTop > 0)) {
        drag = null
        return
      }
      begin()
    }
    if (e.cancelable) e.preventDefault()
    move(pt.clientY, e.timeStamp)
  }

  function begin() {
    if (!els || !drag) return
    const { d, p } = els
    stopWaiting?.()
    drag.on = true
    drag.h = p.offsetHeight
    drag.base = Math.max(0, translateY(p)) // can be grabbed mid-entrance
    phase = 'open'
    quietUntil = Infinity
    d.setAttribute('data-drag', '')
    apply(drag.base)
  }

  function move(y: number, t: number) {
    if (!drag) return
    // Measured from where the finger first landed, so the spot you grabbed stays under it.
    const raw = drag.base + (y - drag.y0)
    drag.off = raw >= 0 ? raw : drag.head ? -rubber(-raw) : 0
    drag.pts.push([t, y])
    while (drag.pts.length > 2 && t - drag.pts[0][0] > 100) drag.pts.shift()
    apply(drag.off)
  }

  function apply(off: number) {
    if (!els || !drag) return
    const dpr = window.devicePixelRatio || 1
    els.p.style.transform = `translate3d(0, ${Math.round(off * dpr) / dpr}px, 0)`
    els.s.style.opacity = String(clamp(1 - off / Math.max(drag.h, 1), 0, 1))
  }

  function velocity(g: Drag, now: number): number {
    const pts = g.pts
    if (pts.length < 2) return 0
    const [t1, y1] = pts[pts.length - 1]
    if (now - t1 > 80) return 0 // the finger came to rest before lifting
    const [t0, y0] = pts[0]
    return t1 > t0 ? (y1 - y0) / (t1 - t0) : 0
  }

  function onTouchEnd(e: TouchEvent) {
    if (!drag || !els) return
    if (!findTouch(e.changedTouches, drag.id)) return
    const g = drag
    drag = null
    if (!g.on) return
    quietUntil = performance.now() + 350
    const v = velocity(g, e.timeStamp)
    const far = g.off > Math.min(g.h * 0.25, 110)
    if (e.type !== 'touchcancel' && (v > 0.45 || (far && v > -0.3))) {
      hide(true, { off: g.off, v, h: g.h })
    } else {
      springBack()
    }
  }

  function springBack() {
    if (!els) return
    els.d.removeAttribute('data-drag')
    clearInline()
    phase = 'open'
  }

  /** A drag that started on a button must not also press it. */
  function onClickCapture(e: MouseEvent) {
    if (performance.now() < quietUntil) {
      e.preventDefault()
      e.stopPropagation()
    }
  }

  // ------------------------------------------------------------ chrome

  function onScroll() {
    if (!els) return
    els.p.toggleAttribute('data-scrolled', els.sc.scrollTop > 2)
  }

  /** Keep the sheet above the on-screen keyboard (the layout viewport does not shrink on iOS). */
  function fitKeyboard() {
    if (!els) return
    const { d, p, sc } = els
    const vv = window.visualViewport
    const kb = vv && Math.abs(vv.scale - 1) < 0.01 ? Math.round(window.innerHeight - vv.height - vv.offsetTop) : 0
    if (vv && kb > 60 && phone()) {
      d.style.setProperty('--sheet-kb', `${kb}px`)
      d.style.setProperty('--sheet-vh', `${Math.round(vv.height)}px`)
      d.setAttribute('data-kb', '')
      const changed = kb !== lastKb
      lastKb = kb
      // When the keyboard arrives (or resizes), make sure the focused field is still in view.
      const a = document.activeElement
      if (changed && a instanceof HTMLElement && p.contains(a)) {
        requestAnimationFrame(() => {
          const r = a.getBoundingClientRect()
          const b = sc.getBoundingClientRect()
          const head = sc.querySelector<HTMLElement>('.sheet-head')?.offsetHeight ?? 0
          if (r.bottom > b.bottom - 12) sc.scrollTop += r.bottom - b.bottom + 12
          else if (r.top < b.top + head) sc.scrollTop -= b.top + head - r.top + 8
        })
      }
    } else if (d.hasAttribute('data-kb')) {
      lastKb = 0
      d.style.removeProperty('--sheet-kb')
      d.style.removeProperty('--sheet-vh')
      d.removeAttribute('data-kb')
    }
  }

  // ------------------------------------------------------------ wiring

  function attach(next: Els): () => void {
    els = next
    const { d, p, sc } = next
    const vv = window.visualViewport
    const active = { passive: false } as const
    const passive = { passive: true } as const
    d.addEventListener('cancel', onCancel)
    d.addEventListener('close', onNativeClose)
    p.addEventListener('touchstart', onTouchStart, passive)
    // Registered up front: iOS and Chrome decide at touchstart whether a touch's moves can be
    // cancelled, so adding this only once a drag begins would be too late. It only ever calls
    // preventDefault while the sheet itself is being dragged.
    p.addEventListener('touchmove', onTouchMove, active)
    p.addEventListener('touchend', onTouchEnd, passive)
    p.addEventListener('touchcancel', onTouchEnd, passive)
    p.addEventListener('click', onClickCapture, true)
    sc.addEventListener('scroll', onScroll, passive)
    vv?.addEventListener('resize', fitKeyboard)
    vv?.addEventListener('scroll', fitKeyboard)
    return () => {
      stopWaiting?.()
      drag = null
      d.removeEventListener('cancel', onCancel)
      d.removeEventListener('close', onNativeClose)
      p.removeEventListener('touchstart', onTouchStart)
      p.removeEventListener('touchmove', onTouchMove)
      p.removeEventListener('touchend', onTouchEnd)
      p.removeEventListener('touchcancel', onTouchEnd)
      p.removeEventListener('click', onClickCapture, true)
      sc.removeEventListener('scroll', onScroll)
      vv?.removeEventListener('resize', fitKeyboard)
      vv?.removeEventListener('scroll', fitKeyboard)
      popStack(d)
      // Torn down while still showing (unmounted while open): close quietly, release the page.
      if (d.open) {
        phase = 'idle'
        d.close()
      }
      phase = 'idle'
      unlock()
      els = null
    }
  }

  return {
    attach,
    show,
    hide: (user: boolean) => hide(user),
    backdrop: () => {
      if (performance.now() - openedAt > 380) hide(true)
    },
  }
}

// ---------------------------------------------------------------- component

export function Sheet(props: {
  open: boolean
  onClose: () => void
  title?: ComponentChildren
  actions?: ComponentChildren
  wide?: boolean
  children: ComponentChildren
}): JSX.Element | null {
  const { open } = props
  const [present, setPresent] = useState(open)
  const titleId = useId()

  const live = useRef({ open, onClose: props.onClose })
  live.current = { open, onClose: props.onClose }

  // What is on screen. Frozen while closing, so the exit animation shows the last content
  // even when the parent has already moved on (and passes null children).
  const shown = useRef({ title: props.title, actions: props.actions, children: props.children })
  if (open) shown.current = { title: props.title, actions: props.actions, children: props.children }

  const ctl = useRef<ReturnType<typeof createController> | null>(null)
  if (!ctl.current) {
    ctl.current = createController((byUser) => {
      setPresent(false)
      if (byUser && live.current.open) live.current.onClose()
    })
  }
  const c = ctl.current

  const dRef = useRef<HTMLDialogElement>(null)
  const pRef = useRef<HTMLDivElement>(null)
  const sRef = useRef<HTMLDivElement>(null)
  const scRef = useRef<HTMLDivElement>(null)

  const rendered = open || present

  useLayoutEffect(() => {
    if (!rendered || !dRef.current || !pRef.current || !sRef.current || !scRef.current) return
    return c.attach({ d: dRef.current, p: pRef.current, s: sRef.current, sc: scRef.current })
  }, [rendered])

  useLayoutEffect(() => {
    if (open) {
      if (!present) setPresent(true)
      c.show()
    } else {
      c.hide(false)
    }
  }, [open, present])

  if (!rendered) return null
  const { title, actions, children } = shown.current
  const dismiss = () => c.backdrop()

  return (
    <dialog ref={dRef} class={props.wide ? 'sheet wide' : 'sheet'} aria-labelledby={title ? titleId : undefined}>
      <div ref={sRef} class="sheet-scrim" onClick={dismiss} />
      <div ref={pRef} class="sheet-panel" tabIndex={-1}>
        <div ref={scRef} class="sheet-scroll">
          <div class={title || actions ? 'sheet-head' : 'sheet-head bare'}>
            <span class="sheet-grab" aria-hidden="true" />
            <div class="sheet-bar">
              {title ? (
                <h2 id={titleId} class="sheet-title">
                  {title}
                </h2>
              ) : (
                <span class="sheet-title" />
              )}
              {actions ? <div class="sheet-actions">{actions}</div> : null}
              <button type="button" class="sheet-x" aria-label="Close" onClick={dismiss}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                  <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" />
                </svg>
              </button>
            </div>
          </div>
          <div class="sheet-body">{children}</div>
        </div>
      </div>
    </dialog>
  )
}
