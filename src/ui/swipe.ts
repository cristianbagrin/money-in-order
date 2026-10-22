import { useEffect, useRef } from 'preact/hooks'

interface Swipe {
  id: number
  x0: number
  y0: number
  /** where the row already was when grabbed (non-zero when it is caught mid spring-back) */
  from: number
  drag: boolean
  pts: { t: number; x: number }[]
}

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches

/**
 * Swipe left to delete (touch only), the same everywhere a list row can be deleted.
 *
 * Put `wrap` on the row's outer box (it gets `.swiping` while dragged, so a red `.swipe-del` layer behind
 * can show) and `row` plus the handlers on the part that moves. The row moves with transform only and never
 * re-renders while dragged; a long or fast enough swipe slides it out, closes the gap and calls onDelete.
 * `swallow(e)` is true for the click a swipe ends with, so it doesn't also open the row.
 *
 * `keep`: the row stays (onDelete only asks, e.g. opens a sheet) and springs back instead of closing.
 */
export function useSwipeDelete<W extends HTMLElement = HTMLDivElement, R extends HTMLElement = HTMLElement>(
  onDelete: () => void,
  opts: { keep?: boolean; disabled?: boolean } = {},
) {
  const wrap = useRef<W>(null)
  const row = useRef<R>(null)
  const swipe = useRef<Swipe | null>(null)
  const swallowed = useRef(false)
  const gone = useRef(false)
  const timer = useRef(0)
  const live = useRef({ onDelete, opts })
  live.current = { onDelete, opts }
  useEffect(() => () => clearTimeout(timer.current), [])

  function down(e: PointerEvent) {
    const el = row.current
    if (!el || e.pointerType !== 'touch' || !e.isPrimary || gone.current || live.current.opts.disabled) return
    clearTimeout(timer.current)
    // Catch the row where it is, even mid spring-back, so it can be grabbed again.
    const from = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41
    el.style.transition = 'none'
    el.style.transform = `translateX(${from}px)`
    swipe.current = { id: e.pointerId, x0: e.clientX, y0: e.clientY, from, drag: false, pts: [{ t: e.timeStamp, x: e.clientX }] }
    if (from) start(e.pointerId)
  }

  function start(id: number) {
    swipe.current!.drag = true
    row.current!.setPointerCapture(id)
    wrap.current!.classList.add('swiping')
  }

  function move(e: PointerEvent) {
    const s = swipe.current
    const el = row.current
    if (!s || !el || e.pointerId !== s.id) return
    const dx = e.clientX - s.x0
    if (!s.drag) {
      const dy = e.clientY - s.y0
      // Vertical first (or to the right): it is a scroll, not ours.
      if (Math.abs(dy) >= 10 && Math.abs(dy) > Math.abs(dx)) swipe.current = null
      else if (Math.abs(dx) >= 10) dx < 0 ? start(e.pointerId) : (swipe.current = null)
      if (!swipe.current?.drag) return
    }
    // 1:1 from where it was grabbed.
    el.style.transform = `translateX(${Math.min(0, Math.max(-el.offsetWidth, s.from + dx))}px)`
    s.pts.push({ t: e.timeStamp, x: e.clientX })
    while (s.pts.length > 2 && e.timeStamp - s.pts[0].t > 100) s.pts.shift()
  }

  function up(e: PointerEvent) {
    const s = swipe.current
    const el = row.current
    if (!s || !el || e.pointerId !== s.id) return
    swipe.current = null
    if (!s.drag) return
    swallowed.current = true
    setTimeout(() => (swallowed.current = false), 60)
    const a = s.pts[0]
    const b = s.pts[s.pts.length - 1]
    // px/ms over the last ~100ms; a finger that stopped before lifting is not a flick.
    const v = e.type === 'pointerup' && b.t > a.t && e.timeStamp - b.t < 80 ? (b.x - a.x) / (b.t - a.t) : 0
    const w = el.offsetWidth
    const x = new DOMMatrixReadOnly(getComputedStyle(el).transform).m41
    settle(e.type === 'pointerup' && v < 0.5 && (x <= -0.45 * w || (v <= -0.5 && x < -8)), v, x, w)
  }

  function back() {
    const el = row.current
    const box = wrap.current
    if (!el || !box) return
    const done = () => {
      box.classList.remove('swiping')
      el.style.transition = el.style.transform = ''
    }
    if (reduced()) return done()
    el.style.transition = 'transform 260ms var(--ease)'
    el.style.transform = 'translateX(0)'
    timer.current = window.setTimeout(done, 280)
  }

  function settle(del: boolean, v: number, x: number, w: number) {
    const el = row.current!
    const box = wrap.current!
    if (!del) return back()
    if (live.current.opts.keep) {
      live.current.onDelete()
      return back()
    }
    gone.current = true
    const finish = () => live.current.onDelete()
    if (reduced()) {
      // No slide: the row just fades.
      el.style.transition = 'opacity 150ms linear'
      el.style.opacity = '0'
      timer.current = window.setTimeout(finish, 160)
      return
    }
    // Carry on at the finger's speed (linear, so the speed doesn't change), then close the gap.
    const ms = Math.round(Math.min(260, Math.max(100, (w + x) / Math.max(-v, 0.9))))
    el.style.transition = `transform ${ms}ms linear`
    el.style.transform = `translateX(${-w}px)`
    timer.current = window.setTimeout(() => {
      box.style.height = `${box.offsetHeight}px`
      box.getBoundingClientRect()
      box.style.transition = 'height 180ms var(--ease)'
      box.style.height = '0px'
      timer.current = window.setTimeout(finish, 190)
    }, ms)
  }

  return {
    wrap,
    row,
    handlers: { onPointerDown: down, onPointerMove: move, onPointerUp: up, onPointerCancel: up },
    /** True for the click a swipe ends with: ignore it. */
    swallow: (e?: Event) => {
      if (!swallowed.current) return false
      e?.preventDefault()
      return true
    },
  }
}
