import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import './motion.css'

const EASE = 'cubic-bezier(.2,.9,.25,1)'

const reducedQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null
const reducedMotion = () => reducedQuery?.matches ?? false

// iOS Safari only applies :active (and so `.press`) when a touch listener exists up the tree.
if (typeof document !== 'undefined') document.addEventListener('touchstart', () => {}, { passive: true })

/* ---------- useCountUp ---------- */

const easeOutCubic = (t: number) => 1 - (1 - t) ** 3

/** Animates from the number on screen to `value` (integer minor units), ease-out cubic. */
export function useCountUp(value: number, ms = 420): number {
  const target = Math.round(value)
  const [shown, setShown] = useState(target)
  const current = useRef(target)
  const reduced = reducedMotion()

  useLayoutEffect(() => {
    const show = (v: number) => {
      current.current = v
      setShown(v)
    }
    if (current.current === target) return
    if (reduced || ms <= 0 || typeof requestAnimationFrame !== 'function') return show(target)

    const from = current.current
    const start = performance.now()
    let frame = requestAnimationFrame(function step(now) {
      const t = Math.min(1, Math.max(0, (now - start) / ms))
      const v = t >= 1 ? target : Math.round(from + (target - from) * easeOutCubic(t))
      if (v !== current.current) show(v)
      if (t < 1) frame = requestAnimationFrame(step)
    })
    // Background tabs pause rAF; never leave a stale number behind.
    const settle = setTimeout(() => show(target), ms + 250)
    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(settle)
    }
  }, [target, ms, reduced])

  return reduced ? target : shown
}

/* ---------- useFlip ---------- */

type Rects = Map<string, DOMRect>

const running = new WeakMap<Element, Animation>()

function keyAttr(selector: string): string {
  const m = /^\s*\[\s*([\w-]+)\s*(?:[~|^$*]?=[^\]]*)?\]\s*$/.exec(selector)
  return m ? m[1] : 'data-flip'
}

function collect(root: HTMLElement, selector: string): Map<string, HTMLElement> {
  const attr = keyAttr(selector)
  const out = new Map<string, HTMLElement>()
  root.querySelectorAll<HTMLElement>(selector).forEach((el, i) => {
    const key = el.getAttribute(attr) || el.id || `#${i}`
    if (!out.has(key)) out.set(key, el)
  })
  return out
}

function measure(root: HTMLElement, selector: string): Rects {
  const rects: Rects = new Map()
  for (const [key, el] of collect(root, selector)) rects.set(key, el.getBoundingClientRect())
  return rects
}

const visible = (r: DOMRect) => r.width > 0 || r.height > 0

function animateFrom(root: HTMLElement, selector: string, before: Rects, ms: number) {
  const els = collect(root, selector)
  // Measure the settled layout, not a half-finished previous move.
  for (const el of els.values()) running.get(el)?.cancel()

  type Plan = { el: HTMLElement; dx: number; dy: number; enter: boolean }
  const plans = new Map<Element, Plan>()
  for (const [key, el] of els) {
    const now = el.getBoundingClientRect()
    if (!visible(now)) continue
    const was = before.get(key)
    if (was && visible(was)) plans.set(el, { el, dx: was.left - now.left, dy: was.top - now.top, enter: false })
    else plans.set(el, { el, dx: 0, dy: 0, enter: true })
  }

  for (const plan of plans.values()) {
    // A nested match rides along with its moving parent: only animate the difference.
    let up = plan.el.parentElement?.closest(selector)
    while (up && root.contains(up) && up !== root && !plans.has(up)) up = up.parentElement?.closest(selector)
    const parent = up && up !== root ? plans.get(up) : undefined
    if (parent?.enter) continue
    const dx = plan.dx - (parent?.dx ?? 0)
    const dy = plan.dy - (parent?.dy ?? 0)

    let keyframes: Keyframe[]
    if (plan.enter) keyframes = [{ opacity: 0, transform: 'scale(.96)' }, { opacity: 1, transform: 'none' }]
    else if (Math.abs(dx) >= 0.5 || Math.abs(dy) >= 0.5) keyframes = [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }]
    else continue

    if (typeof plan.el.animate !== 'function') continue
    const anim = plan.el.animate(keyframes, { duration: ms, easing: EASE })
    running.set(plan.el, anim)
    anim.onfinish = anim.oncancel = () => {
      if (running.get(plan.el) === anim) running.delete(plan.el)
    }
  }
}

/**
 * FLIP: when `deps` change, elements under `ref` matching `selector` (keyed by the attribute value)
 * glide from where they were to where they are now; new keys fade and scale in.
 */
export function useFlip(
  ref: { current: HTMLElement | null },
  deps: unknown[],
  opts?: { selector?: string; ms?: number },
): void {
  const selector = opts?.selector ?? '[data-flip]'
  const ms = opts?.ms ?? 240
  const lastDeps = useRef<unknown[] | null>(null)
  const first = useRef<Rects | null>(null)

  // Runs during render, i.e. before this render's DOM changes are committed: the "First" in FLIP.
  const prev = lastDeps.current
  if (prev && (prev.length !== deps.length || deps.some((d, i) => d !== prev[i]))) {
    const root = ref.current
    first.current = root?.isConnected && !reducedMotion() ? measure(root, selector) : null
  }
  lastDeps.current = deps

  useLayoutEffect(() => {
    const before = first.current
    first.current = null
    if (before && ref.current) animateFrom(ref.current, selector, before, ms)
  }, deps)
}

/* ---------- flash ---------- */

const flashing = new WeakMap<Element, () => void>()

const list = (v: string) => v.split(',').map((x) => x.trim())
const seconds = (v: string) => (v.endsWith('ms') ? parseFloat(v) / 1000 : parseFloat(v)) || 0

/** Replays a one-shot CSS animation class (default `pulse-once`) on `el`, then removes it. */
export function flash(el: Element | null, cls = 'pulse-once'): void {
  if (!el) return
  flashing.get(el)?.()
  const style = getComputedStyle(el)
  el.classList.remove(cls)
  void el.getBoundingClientRect() // reflow, so adding the class back restarts the animation
  const before = list(style.animationName)
  el.classList.add(cls)

  // Only listen for the animations this class brought in, not ones already on the element.
  const names = list(style.animationName)
  const durations = list(style.animationDuration)
  const delays = list(style.animationDelay)
  const ours = new Set<string>()
  let longest = 0
  names.forEach((n, i) => {
    const j = before.indexOf(n)
    if (j >= 0) before.splice(j, 1)
    else if (n !== 'none') {
      ours.add(n)
      longest = Math.max(longest, seconds(durations[i % durations.length]) + seconds(delays[i % delays.length]))
    }
  })
  if (!ours.size) {
    el.classList.remove(cls) // reduced motion, or a class without an animation
    return
  }

  const onEnd = (e: Event) => {
    const a = e as AnimationEvent
    if (a.target === el && ours.has(a.animationName)) done()
  }
  const done = () => {
    el.removeEventListener('animationend', onEnd)
    clearTimeout(timer)
    if (flashing.get(el) === done) flashing.delete(el)
    el.classList.remove(cls)
  }
  el.addEventListener('animationend', onEnd)
  // Safety net when no event arrives (element hidden or detached mid-animation).
  const timer = setTimeout(done, Math.min(longest * 1000, 10000) + 200)
  flashing.set(el, done)
}
