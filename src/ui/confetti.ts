// A small, quick burst of paper from one spot on screen: the reward for giving every bit of money a job.
// One canvas for the burst's lifetime, transform-free 2D drawing, gone after about a second and a half.

const COLORS = ['#ffd800', '#ffd800', '#1d58a8', '#0a7f5a', '#e5edf8']
const COUNT = 34
const LIFE_MS = 1500

interface Bit {
  x: number
  y: number
  vx: number
  vy: number
  w: number
  h: number
  rot: number
  spin: number
  color: string
}

export function confetti(from: Element | null) {
  if (typeof document === 'undefined' || matchMedia('(prefers-reduced-motion: reduce)').matches) return
  const r = from?.getBoundingClientRect()
  const ox = r ? r.left + r.width / 2 : innerWidth / 2
  const oy = r ? r.top + r.height / 2 : innerHeight / 3

  const dpr = Math.min(2, devicePixelRatio || 1)
  const canvas = document.createElement('canvas')
  canvas.setAttribute('aria-hidden', 'true')
  canvas.className = 'confetti'
  canvas.width = innerWidth * dpr
  canvas.height = innerHeight * dpr
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.scale(dpr, dpr)
  document.body.append(canvas)

  // Mostly up and out, a fan rather than a fountain, so it stays near the number it celebrates.
  const bits: Bit[] = Array.from({ length: COUNT }, () => {
    const angle = -Math.PI / 2 + (Math.random() - 0.5) * Math.PI * 0.9
    const speed = 260 + Math.random() * 260
    return {
      x: ox + (Math.random() - 0.5) * (r ? r.width * 0.6 : 40),
      y: oy,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      w: 4 + Math.random() * 3,
      h: 7 + Math.random() * 4,
      rot: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 14,
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
    }
  })

  const t0 = performance.now()
  let prev = t0
  const frame = (now: number) => {
    const dt = Math.min(0.032, (now - prev) / 1000)
    prev = now
    const age = (now - t0) / LIFE_MS
    if (age >= 1) return canvas.remove()
    ctx.clearRect(0, 0, innerWidth, innerHeight)
    // Fade out over the last third, so nothing pops away.
    ctx.globalAlpha = age < 0.66 ? 1 : 1 - (age - 0.66) / 0.34
    for (const b of bits) {
      // Air drag, then gravity: paper floats down instead of falling like a stone.
      b.vx *= 1 - 2.6 * dt
      b.vy = b.vy * (1 - 2.6 * dt) + 900 * dt
      b.x += b.vx * dt
      b.y += b.vy * dt
      b.rot += b.spin * dt
      ctx.save()
      ctx.translate(b.x, b.y)
      ctx.rotate(b.rot)
      // A flutter: the paper turns, so its width breathes.
      ctx.scale(Math.cos(b.rot * 1.7), 1)
      ctx.fillStyle = b.color
      ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h)
      ctx.restore()
    }
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}
