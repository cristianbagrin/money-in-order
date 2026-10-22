import { useEffect, useRef, useState } from 'preact/hooks'
import './sortable.css'

/*
 * Hold-and-drag reordering for lists.
 *
 * Mouse/pen: press and move 5px. Touch: hold still for `longPressMs`, then drag; until then the page
 * scrolls as usual. While dragging, the item follows the pointer and a gap opens where it would land.
 * The gap is a real (empty) spacer element whose height animates, so everything after it, group
 * headers included, slides by itself. On drop every inline style and spacer is removed again before
 * `onDrop` runs, so the app's re-render owns the DOM order.
 *
 * `flow: true` is the same for rows of pills that wrap (FlowSorter): the item floats under the pointer,
 * an empty slot of its size shows where it would land, and the pills around slide to make room.
 */

export interface DropInfo {
  id: string
  fromGroup: string | null
  toGroup: string | null
  beforeId: string | null
  index: number
}

export interface SortableOptions {
  /** Draggable items. Default '[data-sort-id]'. */
  itemSelector?: string
  /** Attribute holding the item's id. Default 'data-sort-id'. */
  idAttr?: string
  /** Containers whose data-sort-group attribute names the group; items may move between them. */
  groupSelector?: string
  /** Only start a drag from this element inside the item. */
  handleSelector?: string
  /** Touch hold delay in ms. Default 260. */
  longPressMs?: number
  /** The items sit in a wrapping row (pills) rather than a column. */
  flow?: boolean
  disabled?: boolean
  onDrop: (info: DropInfo) => void
}

const MOUSE_SLOP = 5
const TOUCH_SLOP = 8
const GAP_MS = 180
const DROP_MS = 160
const LIFT_MS = 140
const LIFT_SCALE = 0.02
const EDGE = 64
const GROUP_REACH = 40
const MAX_SCROLL = 1200 // px/s with the pointer right at the edge
const EASE = 'var(--ease, cubic-bezier(0.2, 0.9, 0.25, 1))'
const NO_DRAG = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [data-no-drag]'

interface Config {
  itemSelector: string
  idAttr: string
  groupSelector?: string
  handleSelector?: string
  longPressMs: number
}

interface Press {
  touch: boolean
  pointer: number
  /** The touched node: touch events keep targeting it, so it must stay in the document. */
  target: Node
  item: HTMLElement
  x0: number
  y0: number
  x: number
  y: number
  timer: number
}

interface Slot {
  top: number
  h: number
}

interface Group {
  el: HTMLElement
  name: string | null
  /** Items of the group except the dragged one, in order. */
  others: HTMLElement[]
  /** Their positions relative to the container with the dragged item taken out. */
  slots: Slot[]
}

interface Spacer {
  el: HTMLElement
  hs: number
  o: number
  gap: number
  timer: number
  closing: boolean
}

interface Gap {
  gi: number
  k: number
  origin: boolean
}

/** What the input handlers need of a drag, whichever kind of list it is in. */
interface DragBase {
  touch: boolean
  pointer: number
  target: Node
  x: number
  y: number
  settling: unknown
}

type ScrollState = Pick<Drag, 'y' | 'y0' | 'scroller' | 'scrollArmed' | 'scrollAcc'>

interface Drag extends DragBase {
  touch: boolean
  pointer: number
  target: Node
  item: HTMLElement
  id: string
  h: number
  mt: number
  mb: number
  mbCollapsed: number
  groups: Group[]
  gi0: number
  i0: number
  gap: Gap
  gapAt: number
  spacers: Map<string, Spacer>
  grabDy: number
  x: number
  y: number
  y0: number
  top: number
  ty: number
  s: number
  t0: number
  last: number
  scroller: HTMLElement | null
  scrollArmed: boolean
  scrollAcc: number
  reduced: boolean
  saved: { transform: string; transition: string; marginBottom: string }
  settling: null | { t0: number; from: number; s0: number; commit: boolean }
  raf: number
}

/* Two instances can share one container (rows inside groups, and the groups themselves).
   The first to see a press marks the event; a deeper item takes the press over. */
const claims = new WeakMap<Event, { item: HTMLElement; release: () => void }>()
let active: Sorter | null = null

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3)
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const keyOf = (gi: number, k: number) => `${gi}:${k}`
const px = (v: string) => parseFloat(v) || 0

function findTouch(list: TouchList, id: number): Touch | null {
  for (let i = 0; i < list.length; i++) if (list[i].identifier === id) return list[i]
  return null
}

function scrollParent(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p && p !== document.body && p !== document.documentElement; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight) return p
  }
  return null
}

/** Swallow the click the browser fires right after a mouse drag ends. */
function swallowClick() {
  const stop = (e: Event) => {
    e.stopPropagation()
    e.preventDefault()
    off()
  }
  const off = () => window.removeEventListener('click', stop, true)
  window.addEventListener('click', stop, true)
  setTimeout(off, 0)
}

/** Flow metrics of a list container: flex/grid lists don't collapse margins but add a row gap. */
function flow(parent: Element) {
  const cs = getComputedStyle(parent)
  const flexish = /flex|grid/.test(cs.display)
  return { flexish, gap: flexish ? px(cs.rowGap) : 0 }
}

class Sorter {
  readonly root: HTMLElement
  protected cfg: Config
  protected opts: { current: SortableOptions }
  protected setDragging: (id: string | null) => void
  protected press: Press | null = null
  protected drag: DragBase | null = null
  private listening = false

  private get dr(): Drag | null {
    return this.drag as Drag | null
  }

  constructor(root: HTMLElement, cfg: Config, opts: { current: SortableOptions }, setDragging: (id: string | null) => void) {
    this.root = root
    this.cfg = cfg
    this.opts = opts
    this.setDragging = setDragging
    root.addEventListener('pointerdown', this.onPointerDown)
    root.addEventListener('touchstart', this.onTouchStart, { passive: true })
    root.addEventListener('touchmove', this.onTouchMove, { passive: false })
    root.addEventListener('touchend', this.onTouchEnd)
    root.addEventListener('touchcancel', this.onTouchCancel)
    root.addEventListener('dragstart', this.onNativeDrag)
  }

  destroy() {
    const root = this.root
    root.removeEventListener('pointerdown', this.onPointerDown)
    root.removeEventListener('touchstart', this.onTouchStart)
    root.removeEventListener('touchmove', this.onTouchMove)
    root.removeEventListener('touchend', this.onTouchEnd)
    root.removeEventListener('touchcancel', this.onTouchCancel)
    root.removeEventListener('dragstart', this.onNativeDrag)
    this.clearPress()
    this.finish(false)
    this.unlisten()
  }

  // ------------------------------------------------------------------ press tracking

  /** The item a press on `target` would drag, or null if this instance should ignore it. */
  private hit(target: EventTarget | null): HTMLElement | null {
    const t = target instanceof Element ? target : target instanceof Node ? target.parentElement : null
    if (!t || !this.root.contains(t)) return null
    const { itemSelector, idAttr, groupSelector, handleSelector } = this.cfg
    const item = t.closest<HTMLElement>(itemSelector)
    if (!item || !this.root.contains(item) || !item.hasAttribute(idAttr)) return null
    if (groupSelector) {
      const g = item.parentElement?.closest(groupSelector)
      if (!g || !this.root.contains(g)) return null
    }
    if (handleSelector) {
      const h = t.closest(handleSelector)
      if (!h || !item.contains(h)) return null
    }
    const block = t.closest(NO_DRAG)
    if (block && item.contains(block) && !(handleSelector && block.matches(handleSelector))) return null
    return item
  }

  private claim(e: Event, item: HTMLElement): boolean {
    const c = claims.get(e)
    if (c) {
      if (c.item === item || !c.item.contains(item)) return false
      c.release()
    }
    claims.set(e, { item, release: () => this.clearPress() })
    return true
  }

  private clearPress() {
    const p = this.press
    if (!p) return
    clearTimeout(p.timer)
    this.press = null
    if (!this.drag) this.unlisten()
  }

  private listen() {
    if (this.listening) return
    this.listening = true
    window.addEventListener('pointermove', this.onPointerMove, true)
    window.addEventListener('pointerup', this.onPointerUp, true)
    window.addEventListener('pointercancel', this.onPointerCancel, true)
    window.addEventListener('keydown', this.onKeyDown, true)
    window.addEventListener('blur', this.onBlur)
    window.addEventListener('contextmenu', this.onContextMenu, true)
    document.addEventListener('selectstart', this.onSelectStart, true)
  }

  protected unlisten() {
    if (!this.listening) return
    this.listening = false
    window.removeEventListener('pointermove', this.onPointerMove, true)
    window.removeEventListener('pointerup', this.onPointerUp, true)
    window.removeEventListener('pointercancel', this.onPointerCancel, true)
    window.removeEventListener('keydown', this.onKeyDown, true)
    window.removeEventListener('blur', this.onBlur)
    window.removeEventListener('contextmenu', this.onContextMenu, true)
    document.removeEventListener('selectstart', this.onSelectStart, true)
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch' || e.button !== 0 || !e.isPrimary || active || this.drag) return
    const item = this.hit(e.target)
    if (!item || !this.claim(e, item)) return
    this.clearPress()
    this.press = { touch: false, pointer: e.pointerId, target: e.target as Node, item, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, timer: 0 }
    this.listen()
  }

  private onPointerMove = (e: PointerEvent) => {
    const d = this.drag
    if (d) {
      if (!d.touch && e.pointerId === d.pointer && !d.settling) {
        d.x = e.clientX
        d.y = e.clientY
        e.preventDefault()
      }
      return
    }
    const p = this.press
    if (!p || p.touch || e.pointerId !== p.pointer) return
    p.x = e.clientX
    p.y = e.clientY
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > MOUSE_SLOP) this.start()
  }

  private onPointerUp = (e: PointerEvent) => {
    const d = this.drag
    if (d) {
      if (!d.touch && e.pointerId === d.pointer && !d.settling) {
        swallowClick()
        this.drop(true)
      }
      return
    }
    const p = this.press
    if (p && !p.touch && e.pointerId === p.pointer) this.clearPress()
  }

  private onPointerCancel = (e: PointerEvent) => {
    const d = this.drag
    if (d) {
      if (!d.touch && e.pointerId === d.pointer) this.drop(false)
      return
    }
    const p = this.press
    if (p && !p.touch && e.pointerId === p.pointer) this.clearPress()
  }

  private onTouchStart = (e: TouchEvent) => {
    if (this.press && !this.press.touch) this.clearPress() // a mouse press whose release we never saw
    if (this.press || this.drag) {
      if (this.press && e.touches.length > 1) this.clearPress()
      return
    }
    if (active || e.touches.length !== 1) return
    const t = e.changedTouches[0]
    if ((t as Touch & { touchType?: string }).touchType === 'stylus') return // a pen goes through pointer events
    const item = this.hit(e.target)
    if (!item || !this.claim(e, item)) return
    this.press = {
      touch: true,
      pointer: t.identifier,
      target: e.target as Node,
      item,
      x0: t.clientX,
      y0: t.clientY,
      x: t.clientX,
      y: t.clientY,
      timer: window.setTimeout(() => this.start(), this.cfg.longPressMs),
    }
    this.listen()
  }

  private onTouchMove = (e: TouchEvent) => {
    const d = this.drag
    if (d) {
      // From the moment the item lifts, the finger moves the item, not the page.
      if (e.cancelable) e.preventDefault()
      if (!d.touch || d.settling) return
      const t = findTouch(e.changedTouches, d.pointer)
      if (t) {
        d.x = t.clientX
        d.y = t.clientY
      }
      return
    }
    const p = this.press
    if (!p || !p.touch) return
    const t = findTouch(e.changedTouches, p.pointer)
    if (!t) return
    p.x = t.clientX
    p.y = t.clientY
    if (Math.hypot(p.x - p.x0, p.y - p.y0) > TOUCH_SLOP) this.clearPress() // it's a scroll
  }

  private onTouchEnd = (e: TouchEvent) => {
    const d = this.drag
    if (d) {
      if (d.touch && findTouch(e.changedTouches, d.pointer)) {
        if (e.cancelable) e.preventDefault() // no click after a drag
        if (!d.settling) this.drop(true)
      }
      return
    }
    const p = this.press
    if (p && p.touch && findTouch(e.changedTouches, p.pointer)) this.clearPress()
  }

  private onTouchCancel = (e: TouchEvent) => {
    const d = this.drag
    if (d) {
      if (d.touch && findTouch(e.changedTouches, d.pointer)) this.drop(false)
      return
    }
    const p = this.press
    if (p && p.touch && findTouch(e.changedTouches, p.pointer)) this.clearPress()
  }

  private onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (this.drag) {
      e.preventDefault()
      e.stopPropagation()
      this.drop(false)
    } else this.clearPress()
  }

  private onBlur = () => {
    if (this.drag) this.drop(false)
    else this.clearPress()
  }

  private onContextMenu = (e: Event) => {
    if (this.drag || this.press?.touch) e.preventDefault()
  }

  private onSelectStart = (e: Event) => {
    if (this.drag) e.preventDefault()
  }

  private onNativeDrag = (e: DragEvent) => {
    if (this.press || this.drag) e.preventDefault()
  }

  // ------------------------------------------------------------------ dragging

  protected start() {
    const p = this.press
    if (!p) return
    clearTimeout(p.timer)
    this.press = null
    const item = p.item
    if (active || !item.isConnected || (p.touch && !p.target.isConnected)) {
      if (!this.drag) this.unlisten()
      return
    }
    const { root, cfg } = this
    const id = item.getAttribute(cfg.idAttr) ?? ''

    // The lists: either the group containers, or the root as one implicit list.
    const groupEls: HTMLElement[] = []
    if (cfg.groupSelector) {
      if (root.matches(cfg.groupSelector)) groupEls.push(root)
      groupEls.push(...Array.from(root.querySelectorAll<HTMLElement>(cfg.groupSelector)))
    } else groupEls.push(root)
    const belongs = (it: HTMLElement, g: HTMLElement) => {
      if (!it.hasAttribute(cfg.idAttr)) return false
      if (cfg.groupSelector) return it.parentElement?.closest(cfg.groupSelector) === g
      const outer = it.parentElement?.closest(cfg.itemSelector)
      return !outer || !root.contains(outer)
    }

    const r = item.getBoundingClientRect()
    const cs = getComputedStyle(item)
    const h = r.height
    const mt = px(cs.marginTop)
    const mb = px(cs.marginBottom)
    const parent = item.parentElement ?? root
    const f = flow(parent)
    const g0 = f.flexish && parent.children.length > 1 ? f.gap : 0
    // Space the item takes in the flow, and the bottom margin that cancels it.
    const room = f.flexish ? mt + h + mb + g0 : h + Math.max(mt, mb)
    const mbCollapsed = f.flexish ? -(mt + h + g0) : -(h + mt)

    let gi0 = -1
    let i0 = -1
    const groups: Group[] = groupEls.map((el, gi) => {
      const all = Array.from(el.querySelectorAll<HTMLElement>(cfg.itemSelector)).filter((it) => belongs(it, el))
      const at = all.indexOf(item)
      if (at >= 0) {
        gi0 = gi
        i0 = at
      }
      const gr = el.getBoundingClientRect()
      const others: HTMLElement[] = []
      const slots: Slot[] = []
      all.forEach((it, j) => {
        if (it === item) return
        const ir = it.getBoundingClientRect()
        others.push(it)
        slots.push({ top: ir.top - gr.top - (at >= 0 && j > at ? room : 0), h: ir.height })
      })
      return { el, name: cfg.groupSelector ? el.getAttribute('data-sort-group') : null, others, slots }
    })
    if (gi0 < 0) {
      this.unlisten()
      return
    }

    const now = performance.now()
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches
    const d: Drag = {
      touch: p.touch,
      pointer: p.pointer,
      target: p.target,
      item,
      id,
      h,
      mt,
      mb,
      mbCollapsed,
      groups,
      gi0,
      i0,
      gap: { gi: gi0, k: i0, origin: true },
      gapAt: 0,
      spacers: new Map(),
      grabDy: p.y0 - r.top, // stay locked to where the item was grabbed
      x: p.x,
      y: p.y,
      y0: p.y,
      top: r.top,
      ty: 0,
      s: 1,
      t0: now,
      last: now,
      scroller: scrollParent(root),
      scrollArmed: false,
      scrollAcc: 0,
      reduced,
      saved: { transform: item.style.transform, transition: item.style.transition, marginBottom: item.style.marginBottom },
      settling: null,
      raf: 0,
    }
    this.drag = d
    active = this

    item.style.transition = reduced
      ? 'none'
      : `margin-bottom ${GAP_MS}ms ${EASE}, box-shadow 200ms ease, background-color 200ms ease`
    item.style.transform = 'translate3d(0px, 0px, 0px)'
    item.classList.add('sort-lifted')
    root.classList.add('sort-active')
    document.body.classList.add('is-sorting')
    window.getSelection()?.removeAllRanges()
    if (p.touch) {
      try {
        navigator.vibrate?.(8)
      } catch {
        /* not allowed here */
      }
    } else {
      try {
        root.setPointerCapture(p.pointer)
      } catch {
        /* pointer already gone */
      }
    }
    d.raf = requestAnimationFrame(this.frame)
    this.setDragging(id)
  }

  private frame = (now: number) => {
    const d = this.dr
    if (!d) return
    if (!d.item.isConnected) {
      this.finish(false)
      return
    }
    const dt = clamp(now - d.last, 0, 64)
    d.last = now
    if (!d.settling && d.touch && !d.target.isConnected) this.drop(false) // its touchend can no longer reach us
    const st = d.settling
    if (!st) {
      this.autoScroll(dt)
      const rr = this.root.getBoundingClientRect()
      d.top = clamp(d.y - d.grabDy, rr.top - d.h / 2, rr.bottom - d.h / 2)
      const lift = d.reduced ? 1 : easeOut(Math.min(1, (now - d.t0) / LIFT_MS))
      const nat = this.natural()
      this.apply(d.top - nat, 1 + LIFT_SCALE * lift)
      this.retarget(nat)
    } else {
      const t = d.reduced ? 1 : Math.min(1, (now - st.t0) / DROP_MS)
      const e = easeOut(t)
      const nat = this.natural()
      let target = nat
      const sp = d.gap.origin ? null : d.spacers.get(keyOf(d.gap.gi, d.gap.k))
      if (sp) target = sp.el.getBoundingClientRect().top + sp.o
      const top = st.from + (target - st.from) * e
      d.top = top
      this.apply(top - nat, st.s0 + (1 - st.s0) * e)
      // Land only once the gap has finished opening, so the hand-off to the re-render is seamless.
      if (t >= 1 && (d.reduced || performance.now() - d.gapAt >= GAP_MS + 20)) {
        this.finish(st.commit)
        return
      }
    }
    d.raf = requestAnimationFrame(this.frame)
  }

  /** Where the item sits in the layout, without our transform. */
  private natural(): number {
    const d = this.dr!
    const r = d.item.getBoundingClientRect()
    return r.top - d.ty + ((d.s - 1) * d.h) / 2
  }

  private apply(ty: number, s: number) {
    const d = this.dr!
    d.ty = ty
    d.s = s
    d.item.style.transform = `translate3d(0px, ${ty.toFixed(2)}px, 0px) scale(${s.toFixed(4)})`
  }

  protected autoScroll(dt: number) {
    const d = (this.drag as ScrollState | null)!
    if (!d.scrollArmed) {
      if (Math.abs(d.y - d.y0) < 12) return
      d.scrollArmed = true
    }
    const sc = d.scroller
    let top = 0
    let bottom = window.innerHeight
    if (sc) {
      const r = sc.getBoundingClientRect()
      top = Math.max(r.top, 0)
      bottom = Math.min(r.bottom, window.innerHeight)
    }
    // A fixed bar at the bottom (the phone tab bar) hides that edge: scroll before the finger reaches it.
    const bar = document.querySelector('.tabbar')
    if (bar) {
      const br = bar.getBoundingClientRect()
      if (br.height && getComputedStyle(bar).position === 'fixed') bottom = Math.min(bottom, br.top)
    }
    // Only scroll while the list itself continues past that edge.
    const rr = this.root.getBoundingClientRect()
    let v = 0
    if (d.y < top + EDGE && rr.top < top + EDGE) v = -MAX_SCROLL * Math.min(1, (top + EDGE - d.y) / EDGE)
    else if (d.y > bottom - EDGE && rr.bottom > bottom - EDGE) v = MAX_SCROLL * Math.min(1, (d.y - (bottom - EDGE)) / EDGE)
    if (!v) {
      d.scrollAcc = 0
      return
    }
    d.scrollAcc += (v * dt) / 1000
    const step = Math.trunc(d.scrollAcc)
    if (!step) return
    d.scrollAcc -= step
    if (sc) sc.scrollTop += step
    else window.scrollBy(0, step)
  }

  /** Pick the group under the pointer and the index the item would land at. */
  private retarget(nat: number) {
    const d = this.dr!
    let gi = d.gap.gi
    if (d.groups.length > 1) {
      // The container under the pointer, or the nearest one within reach (an emptied group can be
      // only a few px tall). Out of reach of all of them, the gap stays where it is.
      let best = -1
      let bestScore = GROUP_REACH
      // A lifted last child's negative margin escapes its container, which then keeps the item's
      // height on paper; its real content ends where the item sits.
      const tail = !d.gap.origin && !d.item.nextElementSibling
      d.groups.forEach((g, i) => {
        const r = g.el.getBoundingClientRect()
        const bottom = tail && i === d.gi0 ? Math.max(r.top, Math.min(r.bottom, nat - d.mt)) : r.bottom
        const dist = d.y < r.top ? r.top - d.y : d.y > bottom ? d.y - bottom : 0
        const score = dist + (d.x >= r.left && d.x <= r.right ? 0 : 0.5)
        if (score <= bestScore) {
          best = i
          bestScore = score
        }
      })
      if (best >= 0) gi = best
    }
    const G = d.groups[gi]
    const rel = d.top - G.el.getBoundingClientRect().top
    let k = 0
    for (const s of G.slots) if (s.top + s.h / 2 < rel) k++
    if (gi !== d.gap.gi || k !== d.gap.k) this.moveGap(gi, k)
  }

  private moveGap(gi: number, k: number) {
    const d = this.dr!
    const prev = d.gap
    const origin = gi === d.gi0 && k === d.i0
    if (!prev.origin) this.closeSpacer(keyOf(prev.gi, prev.k))
    if (origin) d.item.style.marginBottom = d.saved.marginBottom
    else {
      if (prev.origin) d.item.style.marginBottom = `${d.mbCollapsed}px`
      this.openSpacer(gi, k)
    }
    d.gap = { gi, k, origin }
    d.gapAt = performance.now()
  }

  private openSpacer(gi: number, k: number) {
    const d = this.dr!
    const key = keyOf(gi, k)
    let sp = d.spacers.get(key)
    if (!sp) {
      const G = d.groups[gi]
      const before = G.others[k] ?? null
      const after = before ? null : (G.others[G.others.length - 1] ?? null)
      const parent = (before ?? after)?.parentElement ?? G.el
      const f = flow(parent)
      const el = document.createElement(d.item.tagName === 'LI' ? 'li' : 'div')
      el.className = 'sort-gap'
      el.setAttribute('aria-hidden', 'true')
      el.style.height = '0px'
      // A flex/grid gap would appear around even an empty spacer; cancel it until the spacer opens.
      const gap = f.flexish && parent.children.length > 0 ? f.gap : 0
      if (gap) el.style.marginBottom = `${-gap}px`
      if (before) parent.insertBefore(el, before)
      else if (after) after.after(el)
      else parent.appendChild(el)
      void el.offsetHeight
      sp = {
        el,
        hs: f.flexish ? d.mt + d.h + d.mb : d.h + Math.abs(d.mt - d.mb),
        o: f.flexish ? d.mt : Math.max(0, d.mt - d.mb),
        gap,
        timer: 0,
        closing: false,
      }
      d.spacers.set(key, sp)
    }
    clearTimeout(sp.timer)
    sp.closing = false
    sp.el.style.transition = d.reduced ? 'none' : `height ${GAP_MS}ms ${EASE}, margin-bottom ${GAP_MS}ms ${EASE}`
    sp.el.style.height = `${sp.hs}px`
    if (sp.gap) sp.el.style.marginBottom = '0px'
  }

  private closeSpacer(key: string) {
    const d = this.dr!
    const sp = d.spacers.get(key)
    if (!sp) return
    sp.closing = true
    sp.el.style.height = '0px'
    if (sp.gap) sp.el.style.marginBottom = `${-sp.gap}px`
    clearTimeout(sp.timer)
    sp.timer = window.setTimeout(
      () => {
        if (!sp.closing) return
        sp.el.remove()
        if (d.spacers.get(key) === sp) d.spacers.delete(key)
      },
      d.reduced ? 0 : GAP_MS + 40,
    )
  }

  protected drop(commit: boolean) {
    const d = this.dr
    if (!d || d.settling) return
    if (!commit && !d.gap.origin) this.moveGap(d.gi0, d.i0)
    d.settling = { t0: performance.now(), from: d.top, s0: d.s, commit: commit && !d.gap.origin }
    if (!d.reduced)
      d.item.style.transition = `margin-bottom ${GAP_MS}ms ${EASE}, box-shadow ${DROP_MS}ms ease-out, background-color ${DROP_MS}ms ease-out`
    d.item.classList.add('sort-dropping')
  }

  /** Remove every trace of the drag, then report the move (if any). */
  protected finish(commit: boolean) {
    const d = this.dr
    if (!d) return
    cancelAnimationFrame(d.raf)
    let info: DropInfo | null = null
    if (commit) {
      const G = d.groups[d.gap.gi]
      info = {
        id: d.id,
        fromGroup: d.groups[d.gi0].name,
        toGroup: G.name,
        beforeId: G.others[d.gap.k]?.getAttribute(this.cfg.idAttr) ?? null,
        index: d.gap.k,
      }
    }
    for (const sp of d.spacers.values()) {
      clearTimeout(sp.timer)
      sp.el.remove()
    }
    d.spacers.clear()
    const it = d.item
    it.style.transition = 'none'
    it.classList.remove('sort-lifted', 'sort-dropping')
    it.style.transform = d.saved.transform
    it.style.marginBottom = d.saved.marginBottom
    void it.offsetHeight
    it.style.transition = d.saved.transition
    if (!it.getAttribute('style')) it.removeAttribute('style')
    this.root.classList.remove('sort-active')
    document.body.classList.remove('is-sorting')
    if (!d.touch) {
      try {
        if (this.root.hasPointerCapture(d.pointer)) this.root.releasePointerCapture(d.pointer)
      } catch {
        /* already released */
      }
    }
    this.drag = null
    if (active === this) active = null
    this.unlisten()
    this.setDragging(null)
    if (info) this.opts.current.onDrop(info)
  }
}

interface FlowDrag extends DragBase, ScrollState {
  item: HTMLElement
  id: string
  slot: HTMLElement
  /** where the item was when picked up, and how far its fixed position is off from that (a transformed ancestor) */
  r0: DOMRect
  offX: number
  offY: number
  grabX: number
  grabY: number
  i0: number
  index: number
  last: number
  saved: string | null
  reduced: boolean
  raf: number
}

/**
 * Sorter for rows of pills that wrap. The input rules are the same (mouse: press and move; touch: hold, then
 * drag; Escape cancels), but the item is lifted out of the flow and an empty slot of its size travels
 * through the row. The item itself never moves in the DOM, so on drop only the slot is removed before
 * `onDrop` runs.
 */
class FlowSorter extends Sorter {
  private get fd(): FlowDrag | null {
    return this.drag as FlowDrag | null
  }

  /** The draggable items except `item`, in document order. */
  private others(item: HTMLElement): HTMLElement[] {
    const { itemSelector, idAttr } = this.cfg
    return Array.from(this.root.querySelectorAll<HTMLElement>(itemSelector)).filter((it) => it !== item && it.hasAttribute(idAttr))
  }

  protected start() {
    const p = this.press
    if (!p) return
    clearTimeout(p.timer)
    this.press = null
    const item = p.item
    if (active || !item.isConnected || (p.touch && !p.target.isConnected)) {
      if (!this.drag) this.unlisten()
      return
    }
    const r = item.getBoundingClientRect()
    const margin = getComputedStyle(item).margin

    // The slot takes the item's place in the row, so nothing around it jumps when the item floats up.
    const slot = document.createElement('div')
    slot.className = 'sort-slot'
    slot.setAttribute('aria-hidden', 'true')
    slot.style.cssText = `width:${r.width}px;height:${r.height}px;margin:${margin}`
    item.before(slot)
    const i0 = this.others(item).filter((it) => slot.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_PRECEDING).length

    const saved = item.getAttribute('style')
    item.style.cssText += `;position:fixed;left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;margin:0;transition:none;transform:translate3d(0,0,0)`
    // Fixed inside a transformed ancestor is relative to that ancestor: measure where it really landed.
    const at = item.getBoundingClientRect()
    item.classList.add('sort-lifted', 'sort-flow')
    this.root.classList.add('sort-active')
    document.body.classList.add('is-sorting')
    window.getSelection()?.removeAllRanges()
    if (p.touch) {
      try {
        navigator.vibrate?.(8)
      } catch {
        /* not allowed here */
      }
    } else {
      try {
        this.root.setPointerCapture(p.pointer)
      } catch {
        /* pointer already gone */
      }
    }
    const id = item.getAttribute(this.cfg.idAttr) ?? ''
    const d: FlowDrag = {
      touch: p.touch,
      pointer: p.pointer,
      target: p.target,
      item,
      id,
      slot,
      r0: r,
      offX: r.left - at.left,
      offY: r.top - at.top,
      grabX: p.x0 - r.left,
      grabY: p.y0 - r.top,
      x: p.x,
      y: p.y,
      y0: p.y,
      i0,
      index: i0,
      scroller: scrollParent(this.root),
      scrollArmed: false,
      scrollAcc: 0,
      last: performance.now(),
      saved,
      reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
      settling: false,
      raf: 0,
    }
    this.drag = d
    active = this
    this.place(d)
    d.raf = requestAnimationFrame(this.tick)
    this.setDragging(id)
  }

  /** Put the item under the pointer, where it was grabbed. */
  private place(d: FlowDrag) {
    const tx = d.x - d.grabX - d.r0.left + d.offX
    const ty = d.y - d.grabY - d.r0.top + d.offY
    d.item.style.transform = `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(${1 + LIFT_SCALE * 2})`
  }

  private tick = (now: number) => {
    const d = this.fd
    if (!d) return
    if (!d.item.isConnected) {
      this.finish(false)
      return
    }
    const dt = clamp(now - d.last, 0, 64)
    d.last = now
    if (!d.settling) {
      if (d.touch && !d.target.isConnected) this.drop(false) // its touchend can no longer reach us
      else {
        this.autoScroll(dt)
        this.place(d)
        this.chase(d)
      }
    }
    d.raf = requestAnimationFrame(this.tick)
  }

  /**
   * Move the slot past the pill nearest the pointer, once the pointer is past that pill's middle on the way
   * there. (Judging by the middle keeps a wide pill from swapping back and forth as it slides out of the way.)
   */
  private chase(d: FlowDrag) {
    const all = this.others(d.item)
    const box = this.root.getBoundingClientRect()
    if (!all.length || d.x < box.left - 24 || d.x > box.right + 24 || d.y < box.top - 24 || d.y > box.bottom + 24) return
    let best: HTMLElement | null = null
    let bestDist = Infinity
    let rect: DOMRect | null = null
    for (const it of all) {
      const r = it.getBoundingClientRect()
      const dx = Math.max(r.left - d.x, 0, d.x - r.right)
      const dy = Math.max(r.top - d.y, 0, d.y - r.bottom)
      // A row counts first: the empty space right of a row's last pill belongs to that row.
      const dist = dy * 4 + dx
      if (dist < bestDist) {
        best = it
        bestDist = dist
        rect = r
      }
    }
    if (!best || !rect) return
    const forward = !!(d.slot.compareDocumentPosition(best) & Node.DOCUMENT_POSITION_FOLLOWING)
    const sameRow = d.y >= rect.top && d.y <= rect.bottom
    const mid = rect.left + rect.width / 2
    const past = sameRow ? (forward ? d.x > mid : d.x < mid) : forward ? d.y > rect.bottom : d.y < rect.top
    if (!past) return
    // Slide the others: remember where they are, move the slot, and play the difference.
    const before = new Map(all.map((it) => [it, it.getBoundingClientRect()]))
    if (forward) best.after(d.slot)
    else best.before(d.slot)
    d.index = all.filter((it) => d.slot.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_PRECEDING).length
    if (d.reduced) return
    for (const [it, r0] of before) {
      const r1 = it.getBoundingClientRect()
      const dx = r0.left - r1.left
      const dy = r0.top - r1.top
      if ((dx || dy) && typeof it.animate === 'function') {
        it.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: GAP_MS, easing: EASE })
      }
    }
  }

  protected drop(commit: boolean) {
    const d = this.fd
    if (!d || d.settling) return
    d.settling = true
    if (!commit) {
      d.item.before(d.slot) // (back where it was picked up)
      d.index = d.i0
    }
    // Glide into the slot, then hand over to the re-render.
    const to = d.slot.getBoundingClientRect()
    const tx = to.left - d.r0.left + d.offX
    const ty = to.top - d.r0.top + d.offY
    const done = () => this.finish(commit && d.index !== d.i0)
    if (d.reduced || typeof d.item.animate !== 'function') return done()
    const a = d.item.animate([{ transform: d.item.style.transform }, { transform: `translate3d(${tx.toFixed(1)}px, ${ty.toFixed(1)}px, 0) scale(1)` }], {
      duration: DROP_MS,
      easing: 'ease-out',
      fill: 'forwards',
    })
    a.onfinish = done
    a.oncancel = done
  }

  /** Remove every trace of the drag, then report the move (if any). */
  protected finish(commit: boolean) {
    const d = this.fd
    if (!d) return
    cancelAnimationFrame(d.raf)
    let info: DropInfo | null = null
    if (commit) {
      const next = this.others(d.item).find((it) => d.slot.compareDocumentPosition(it) & Node.DOCUMENT_POSITION_FOLLOWING)
      info = { id: d.id, fromGroup: null, toGroup: null, beforeId: next?.getAttribute(this.cfg.idAttr) ?? null, index: d.index }
    }
    d.slot.remove()
    const it = d.item
    for (const a of it.getAnimations?.() ?? []) a.cancel()
    it.classList.remove('sort-lifted', 'sort-flow')
    if (d.saved === null) it.removeAttribute('style')
    else it.setAttribute('style', d.saved)
    this.root.classList.remove('sort-active')
    document.body.classList.remove('is-sorting')
    if (!d.touch) {
      try {
        if (this.root.hasPointerCapture(d.pointer)) this.root.releasePointerCapture(d.pointer)
      } catch {
        /* already released */
      }
    }
    this.drag = null
    if (active === this) active = null
    this.unlisten()
    this.setDragging(null)
    if (info) this.opts.current.onDrop(info)
  }
}

/**
 * Keyboard reordering for a sortable item: Shift + arrow keys move it one place.
 * Call it from the onKeyDown of something inside the item with the item's place in its list;
 * `move(to)` gets the place it should land at (what a drop's `index` is). Focus follows the item to where
 * it re-renders; `focus` names the focusable inside the item when it isn't the item itself.
 * Returns true when the key was ours.
 */
export function sortKey(e: KeyboardEvent, index: number, count: number, move: (to: number) => void, opts: { idAttr?: string; focus?: string } = {}): boolean {
  if (!e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return false
  const dir = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -1 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 1 : 0
  if (!dir) return false
  e.preventDefault()
  const to = index + dir
  if (to < 0 || to >= count) return true
  const idAttr = opts.idAttr ?? 'data-sort-id'
  const item = (e.currentTarget as HTMLElement).closest<HTMLElement>(`[${idAttr}]`)
  const parent = item?.parentElement
  const id = item?.getAttribute(idAttr)
  move(to)
  if (!parent || id == null) return true
  // Re-rendering may move the element in the DOM, which drops its focus.
  const refocus = () => {
    const now = Array.from(parent.querySelectorAll<HTMLElement>(`[${idAttr}]`)).find((n) => n.getAttribute(idAttr) === id)
    const target = opts.focus ? now?.querySelector<HTMLElement>(opts.focus) : now
    if (target && document.activeElement !== target) target.focus()
  }
  requestAnimationFrame(() => requestAnimationFrame(refocus))
  return true
}

/**
 * Hold-and-drag reordering for the items inside `ref`'s element.
 * Mouse: press and move. Touch: hold, then drag. Escape cancels.
 */
export function useSortable(ref: { current: HTMLElement | null }, opts: SortableOptions): { draggingId: string | null } {
  const [draggingId, setDraggingId] = useState<string | null>(null)
  const [attach, setAttach] = useState(0)
  const optsRef = useRef(opts)
  optsRef.current = opts
  const sorter = useRef<Sorter | null>(null)
  const {
    itemSelector = '[data-sort-id]',
    idAttr = 'data-sort-id',
    groupSelector,
    handleSelector,
    longPressMs = 260,
    flow = false,
    disabled = false,
  } = opts

  useEffect(() => {
    const el = ref.current
    if (!el || disabled) return
    const s = new (flow ? FlowSorter : Sorter)(el, { itemSelector, idAttr, groupSelector, handleSelector, longPressMs }, optsRef, setDraggingId)
    sorter.current = s
    return () => {
      s.destroy()
      if (sorter.current === s) sorter.current = null
    }
  }, [disabled, flow, itemSelector, idAttr, groupSelector, handleSelector, longPressMs, attach])

  // Re-attach if the container element itself is swapped or appears later.
  useEffect(() => {
    if (!disabled && (ref.current ?? null) !== (sorter.current?.root ?? null)) setAttach((n) => n + 1)
  })

  return { draggingId }
}
