/*
  Little sounds and haptics that make the app feel alive.

  Every sound is synthesized with Web Audio: no files to load, a handful of nodes per sound, all
  disconnected when it ends. Browsers keep audio locked until the first tap or key press, so the
  AudioContext is only created then (until that moment play() quietly does nothing). After 30 s
  of quiet, or when the page is hidden, the context is suspended so nothing runs while idle.

  The tuned sounds share one key (C major) so whatever follows whatever still agrees:
    key      a soft, short "tock": a breath of filtered noise over a falling low sine
    tap      a tiny water-drop tick, pitch falling
    toggle   a small rounded "pop", pitch rising
    log      coin "ka-ching": a quick G5 then a ringing C6 with a faint bell glint
    income   brighter, rising chime: C6 then G6, triangle with octave shimmer
    delete   a soft downward whoosh
    undo     the same whoosh played backwards, rising, with a hint of tone
    lift     a light high blip, rising
    drop     a soft low thunk, falling
    success  a quick C-E-G arpeggio
    error    two low, soft notes stepping down (G4, E4)
    open     a faint airy swish up;  close: the same swish down
*/

export type Sound =
  | 'key'
  | 'tap'
  | 'toggle'
  | 'log'
  | 'income'
  | 'delete'
  | 'undo'
  | 'lift'
  | 'drop'
  | 'success'
  | 'error'
  | 'open'
  | 'close'

// ------------------------------------------------------------------ preference

const PREF = 'mio-sound'
let enabled: boolean | undefined

export function soundOn(): boolean {
  if (enabled === undefined) {
    enabled = true
    try {
      enabled = localStorage.getItem(PREF) !== '0'
    } catch {
      // Storage blocked: stay with the default.
    }
  }
  return enabled
}

export function setSoundOn(on: boolean): void {
  enabled = on
  try {
    localStorage.setItem(PREF, on ? '1' : '0')
  } catch {
    // Storage blocked: the choice lasts for this visit.
  }
  try {
    if (!on) sleep()
    update()
  } catch {
    // Never let sound bookkeeping break the caller.
  }
}

// ------------------------------------------------------------------ engine

type Ctor = new (options?: AudioContextOptions) => AudioContext

let ctx: AudioContext | null = null
let master: GainNode | null = null
let noiseBuf: AudioBuffer | null = null
let gestured = false
let broken = false
let armed = false
let voices = 0
let nap: ReturnType<typeof setTimeout> | undefined
const last: Partial<Record<Sound, number>> = {}
const noop = () => {}

const GESTURES = ['pointerdown', 'touchend', 'keydown', 'click'] as const
const CAPTURE: AddEventListenerOptions = { capture: true, passive: true }
/** Identical sounds closer together than this collapse into one; keys may run faster. */
const COLLAPSE_MS = 30
const KEY_COLLAPSE_MS = 12
/** A sound that has to wait this long for the context to wake would land after the tap. */
const STALE_MS = 150
const IDLE_MS = 30_000
const MAX_VOICES = 12

/** Listen for gestures while one is still needed: before the first, or to wake a sleeping context. */
function update() {
  if (typeof window === 'undefined') return
  const want = !gestured || (soundOn() && !broken && ctx?.state !== 'running')
  if (want === armed) return
  armed = want
  for (const t of GESTURES) {
    if (want) window.addEventListener(t, onGesture, CAPTURE)
    else window.removeEventListener(t, onGesture, CAPTURE)
  }
}

function onGesture() {
  try {
    gestured = true
    if (soundOn()) wake()
    update()
  } catch {
    // Ignore: sound is decoration.
  }
}

/** Create the context if needed and ask it to run. Inside a gesture this unlocks audio. */
function wake(): AudioContext | null {
  if (ctx?.state === 'closed') ctx = null
  if (!ctx && !broken) ctx = create()
  if (ctx && ctx.state !== 'running') ctx.resume().catch(noop)
  return ctx
}

function create(): AudioContext | null {
  const g = globalThis as { AudioContext?: Ctor; webkitAudioContext?: Ctor }
  const C = g.AudioContext ?? g.webkitAudioContext
  if (!C) {
    broken = true
    return null
  }
  // Safari 17+: mix with the user's music and respect the silent switch.
  try {
    const session = (navigator as Navigator & { audioSession?: { type: string } }).audioSession
    if (session && session.type !== 'ambient') session.type = 'ambient'
  } catch {
    // Not supported.
  }
  const c = construct(C)
  if (!c) {
    broken = true
    return null
  }
  master = c.createGain()
  master.connect(c.destination)
  c.onstatechange = update
  // Older iOS only unlocks once something actually starts inside the gesture.
  try {
    const b = c.createBufferSource()
    b.buffer = c.createBuffer(1, 1, c.sampleRate)
    b.connect(c.destination)
    b.onended = () => b.disconnect()
    b.start()
  } catch {
    // Not needed elsewhere.
  }
  return c
}

function construct(C: Ctor): AudioContext | null {
  try {
    return new C({ latencyHint: 'interactive' })
  } catch {
    try {
      return new C()
    } catch {
      return null
    }
  }
}

function sleep() {
  clearTimeout(nap)
  if (ctx?.state === 'running') ctx.suspend().catch(noop)
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) sleep()
  })
  update()
}

export function play(s: Sound): void {
  try {
    if (!gestured || broken || !soundOn() || document.hidden) return
    const now = performance.now()
    if (now - (last[s] ?? -Infinity) < (s === 'key' ? KEY_COLLAPSE_MS : COLLAPSE_MS)) return
    last[s] = now
    if (voices >= MAX_VOICES) return
    const c = wake()
    if (!c) return
    if (c.state === 'running') render(c, s)
    else
      c.resume().then(() => {
        if (c.state === 'running' && performance.now() - now < STALE_MS) render(c, s)
      }, noop)
  } catch {
    // Sound is decoration: never let it break a tap.
  }
}

function render(c: AudioContext, s: Sound) {
  if (!master || !soundOn() || document.hidden) return
  // A few ms ahead so the attack is never clipped by the render quantum already in flight.
  const v = new Voice(c, master)
  RECIPES[s](v, c.currentTime + 0.008)
  v.done()
  clearTimeout(nap)
  nap = setTimeout(() => {
    if (!voices) sleep()
  }, IDLE_MS)
}

// ------------------------------------------------------------------ synthesis

interface Tone {
  f: number
  /** Glide exponentially to this frequency over `glide` seconds. */
  to?: number
  glide?: number
  type?: OscillatorType
  peak: number
  /** Attack and decay, in seconds. The decay falls to silence (-60 dB or lower). */
  a?: number
  d: number
  /** Optional low-pass cutoff to round off the triangle's upper harmonics. */
  lp?: number
}

interface Noise {
  type: BiquadFilterType
  f: number
  to?: number
  sweep?: number
  q?: number
  peak: number
  a?: number
  d: number
  /** Exponential (reversed-decay) attack instead of linear. */
  swell?: boolean
}

class Voice {
  private nodes: AudioNode[] = []
  private end = 0
  private tail: AudioScheduledSourceNode | null = null
  private readonly c: BaseAudioContext
  private readonly out: AudioNode

  constructor(c: BaseAudioContext, out: AudioNode) {
    this.c = c
    this.out = out
  }

  tone(t: number, o: Tone) {
    const { a = 0.003, glide = 0.03 } = o
    const osc = this.c.createOscillator()
    osc.type = o.type ?? 'sine'
    osc.frequency.setValueAtTime(o.f, t)
    if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t + glide)
    const g = this.env(t, o.peak, a, o.d, false)
    osc.connect(o.lp ? this.filter('lowpass', o.lp, 0.7, g) : g)
    this.start(osc, t, t + a + o.d)
  }

  noise(t: number, o: Noise) {
    const { a = 0.002, q = 1 } = o
    const src = this.c.createBufferSource()
    src.buffer = noise(this.c)
    src.loop = true
    const g = this.env(t, o.peak, a, o.d, !!o.swell)
    const f = this.filter(o.type, o.f, q, g)
    f.frequency.setValueAtTime(o.f, t)
    if (o.to) f.frequency.exponentialRampToValueAtTime(o.to, t + (o.sweep ?? a + o.d))
    src.connect(f)
    // A random start point so repeated whooshes never sound copy-pasted.
    this.start(src, t, t + a + o.d, Math.random() * 0.5)
  }

  /** Disconnect everything once the last source has stopped. */
  done() {
    const tail = this.tail
    if (!tail) return
    voices++
    tail.onended = () => {
      voices--
      for (const n of this.nodes) n.disconnect()
      this.nodes = []
    }
  }

  private env(t: number, peak: number, a: number, d: number, swell: boolean): GainNode {
    const g = this.c.createGain()
    const p = g.gain
    if (swell) {
      p.setValueAtTime(0.0001, t)
      p.exponentialRampToValueAtTime(peak, t + a)
    } else {
      p.setValueAtTime(0, t)
      p.linearRampToValueAtTime(peak, t + a)
    }
    p.exponentialRampToValueAtTime(0.0001, t + a + d)
    p.setValueAtTime(0, t + a + d + 0.002)
    g.connect(this.out)
    this.nodes.push(g)
    return g
  }

  private filter(type: BiquadFilterType, f: number, q: number, into: AudioNode): BiquadFilterNode {
    const b = this.c.createBiquadFilter()
    b.type = type
    b.frequency.value = f
    b.Q.value = q
    b.connect(into)
    this.nodes.push(b)
    return b
  }

  private start(n: AudioScheduledSourceNode, t: number, end: number, offset?: number) {
    if (offset !== undefined) (n as AudioBufferSourceNode).start(t, offset)
    else n.start(t)
    n.stop(end + 0.005)
    this.nodes.push(n)
    if (end >= this.end) {
      this.end = end
      this.tail = n
    }
  }
}

/** One second of white noise, made once and shared by every whoosh and tock. */
function noise(c: BaseAudioContext): AudioBuffer {
  if (noiseBuf && noiseBuf.sampleRate === c.sampleRate) return noiseBuf
  const b = c.createBuffer(1, c.sampleRate, c.sampleRate)
  const d = b.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  return (noiseBuf = b)
}

/** A small random factor (1 ± r) so repeated taps feel played, not stamped. */
const wobble = (r: number) => 1 + (Math.random() * 2 - 1) * r

const G4 = 392.0
const E4 = 329.63
const G5 = 783.99
const C6 = 1046.5
const E6 = 1318.51
const G6 = 1567.98

const RECIPES: Record<Sound, (v: Voice, t: number) => void> = {
  key(v, t) {
    const n = wobble(0.05)
    v.noise(t, { type: 'bandpass', f: 2100 * n, q: 1.3, peak: 0.1, a: 0.001, d: 0.02 })
    v.tone(t, { f: 440 * n, to: 300 * n, glide: 0.025, peak: 0.04, a: 0.0015, d: 0.028 })
  },

  tap(v, t) {
    const n = wobble(0.03)
    v.tone(t, { f: 1500 * n, to: 950 * n, glide: 0.035, peak: 0.085, a: 0.002, d: 0.05 })
  },

  toggle(v, t) {
    const n = wobble(0.02)
    v.tone(t, { f: 520 * n, to: 840 * n, glide: 0.03, peak: 0.1, a: 0.003, d: 0.07 })
    v.tone(t, { f: 1040 * n, to: 1680 * n, glide: 0.03, type: 'triangle', peak: 0.014, a: 0.003, d: 0.04 })
  },

  log(v, t) {
    // "ka": a short G5 with the faint click of a coin.
    v.noise(t, { type: 'bandpass', f: 5200, q: 0.9, peak: 0.05, a: 0.001, d: 0.014 })
    v.tone(t, { f: G5, peak: 0.09, a: 0.002, d: 0.09 })
    v.tone(t, { f: G5 * 2, peak: 0.02, a: 0.002, d: 0.05 })
    // "ching": a ringing C6 with an octave and a little inharmonic bell glint.
    const t2 = t + 0.07
    v.tone(t2, { f: C6, peak: 0.11, a: 0.003, d: 0.19 })
    v.tone(t2, { f: C6 * 2, peak: 0.026, a: 0.003, d: 0.1 })
    v.tone(t2, { f: C6 * 2.76, peak: 0.012, a: 0.002, d: 0.05 })
  },

  income(v, t) {
    v.tone(t, { f: C6, type: 'triangle', peak: 0.095, a: 0.003, d: 0.1 })
    v.tone(t, { f: C6 * 2, peak: 0.022, a: 0.003, d: 0.06 })
    const t2 = t + 0.075
    v.tone(t2, { f: G6, type: 'triangle', peak: 0.1, a: 0.003, d: 0.17 })
    // A hair-detuned twin: the slow beat between them makes the chime shimmer.
    v.tone(t2, { f: G6 * 1.004, peak: 0.035, a: 0.003, d: 0.17 })
    v.tone(t2, { f: G6 * 2, peak: 0.022, a: 0.003, d: 0.09 })
  },

  delete(v, t) {
    v.noise(t, { type: 'bandpass', f: 2600, to: 380, sweep: 0.2, q: 0.9, peak: 0.3, a: 0.022, d: 0.19 })
  },

  undo(v, t) {
    v.noise(t, { type: 'bandpass', f: 420, to: 2600, sweep: 0.19, q: 0.9, peak: 0.34, a: 0.16, d: 0.05, swell: true })
    v.tone(t, { f: 440, to: 880, glide: 0.18, peak: 0.03, a: 0.14, d: 0.06 })
  },

  lift(v, t) {
    const n = wobble(0.015)
    v.tone(t, { f: 990 * n, to: 1480 * n, glide: 0.05, peak: 0.09, a: 0.006, d: 0.075 })
  },

  drop(v, t) {
    // Weight for headphones and laptops, plus a mid "knock" so phone speakers carry it too.
    v.tone(t, { f: 280, to: 130, glide: 0.06, type: 'triangle', peak: 0.13, a: 0.002, d: 0.11, lp: 1500 })
    v.tone(t, { f: 640, to: 420, glide: 0.03, peak: 0.06, a: 0.002, d: 0.045 })
    v.noise(t, { type: 'bandpass', f: 1000, q: 0.8, peak: 0.08, a: 0.001, d: 0.022 })
  },

  success(v, t) {
    const notes = [C6, E6, G6]
    notes.forEach((f, i) => {
      const at = t + i * 0.06
      const d = i === notes.length - 1 ? 0.15 : 0.1
      v.tone(at, { f, peak: 0.11, a: 0.003, d })
      v.tone(at, { f, type: 'triangle', peak: 0.025, a: 0.003, d: d * 0.6 })
    })
    v.tone(t + 0.12, { f: G6 * 2, peak: 0.016, a: 0.003, d: 0.08 })
  },

  error(v, t) {
    for (const [i, f] of [G4, E4].entries()) {
      const at = t + i * 0.11
      const d = i ? 0.13 : 0.11
      v.tone(at, { f, type: 'triangle', peak: 0.12, a: 0.006, d, lp: 1800 })
      // A soft octave so small phone speakers still hear it.
      v.tone(at, { f: f * 2, peak: 0.03, a: 0.006, d: d * 0.7 })
    }
  },

  open(v, t) {
    v.noise(t, { type: 'bandpass', f: 1300, to: 4200, sweep: 0.17, q: 0.6, peak: 0.12, a: 0.05, d: 0.13 })
  },

  close(v, t) {
    v.noise(t, { type: 'bandpass', f: 4200, to: 1300, sweep: 0.14, q: 0.6, peak: 0.11, a: 0.015, d: 0.12 })
  },
}

// ------------------------------------------------------------------ haptics

let hapticSwitch: HTMLLabelElement | null | undefined

export function haptic(strength: 'light' | 'medium' = 'light'): void {
  try {
    if (typeof document === 'undefined' || typeof navigator === 'undefined' || document.hidden) return
    if (typeof navigator.vibrate === 'function') {
      // Chrome refuses (and complains in the console) before the first tap.
      const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation
      if (ua && !ua.hasBeenActive) return
      navigator.vibrate(strength === 'medium' ? 16 : 8)
      return
    }
    // iOS Safari 18+ has no vibrate(), but toggling an <input switch> plays the system tick.
    const label = switchLabel()
    if (!label) return
    // A modal <dialog> makes the rest of the page inert, so click from inside the open one.
    const active = document.activeElement
    const host = (active && active.closest('dialog[open]')) || document.body
    if (label.parentNode !== host) host.append(label)
    label.click()
    if (host !== document.body) document.body.append(label)
  } catch {
    // Haptics are a nicety.
  }
}

function switchLabel(): HTMLLabelElement | null {
  if (hapticSwitch !== undefined) return hapticSwitch
  if (!document.body) return null
  if (typeof matchMedia !== 'function' || !matchMedia('(pointer: coarse)').matches) return (hapticSwitch = null)
  const label = document.createElement('label')
  label.setAttribute('aria-hidden', 'true')
  // Never rendered, so it can't take focus, show up, or move the page.
  label.style.display = 'none'
  const input = document.createElement('input')
  input.type = 'checkbox'
  input.setAttribute('switch', '')
  input.tabIndex = -1
  label.append(input)
  // Keep the synthetic click, and the change it causes, away from the app's own listeners.
  for (const t of ['click', 'input', 'change']) label.addEventListener(t, (e) => e.stopPropagation())
  document.body.append(label)
  return (hapticSwitch = label)
}
