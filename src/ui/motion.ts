import { useLayoutEffect, useRef, useState } from 'preact/hooks'
import './motion.css'

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
