// Small, quiet SVG charts for Review. Thin marks, hairline grid, one axis, ink-colored text.
// Everything that matters is written on the chart; a readout under the pointer (or tap-and-drag on touch,
// or arrow keys when focused) only adds detail.

import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { WealthPoint } from '../lib/accounts'
import { monthName } from '../lib/dates'
import { fmt } from '../lib/money'
import './charts.css'

// ---------------------------------------------------------------- shared

/** 1234500 (minor) -> "12k". Bare amounts for axis labels; `fine` keeps three figures for a value written on a mark (2.02M). */
function compact(minor: number, fine = false): string {
  const v = Math.abs(minor) / 100
  const sign = minor < 0 ? '−' : ''
  const short = (x: number, unit: string) =>
    sign + (fine ? Number(x.toPrecision(3)) : x >= 100 || Number.isInteger(x) ? Math.round(x) : Math.round(x * 10) / 10) + unit
  if (v >= 1e9) return short(v / 1e9, 'B')
  if (v >= 1e6) return short(v / 1e6, 'M')
  if (v >= 1e3) return short(v / 1e3, 'k')
  return sign + Math.round(v)
}

/** A y-axis around the data, not from zero: three or four round gridlines that hold `lo` to `hi`. */
function span(lo: number, hi: number): { lo: number; hi: number; ticks: number[] } {
  if (hi - lo < 100) {
    const pad = Math.max(100, Math.abs(hi) * 0.05)
    lo -= pad
    hi += pad
  }
  const raw = (hi - lo) / 3
  const mag = 10 ** Math.floor(Math.log10(raw))
  const step = Math.max(100, [1, 2, 2.5, 5, 10].map((f) => f * mag).find((v) => v >= raw)!)
  const bottom = Math.floor(lo / step) * step
  const top = Math.ceil(hi / step) * step
  const ticks: number[] = []
  for (let v = bottom; v <= top + 1e-9; v += step) ticks.push(v)
  return { lo: bottom, hi: top, ticks }
}

/** Room on the right for y labels: 11px column voice, Recursive mono ≈ 0.6em per character. */
const gutterFor = (ticks: number[]) => 10 + Math.max(2, ...ticks.map((t) => compact(t).length)) * 6.7

function useWidth(ref: { current: HTMLElement | null }): number {
  const [w, setW] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    setW(Math.round(el.clientWidth))
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const next = Math.round(entries[0].contentRect.width)
      setW((prev) => (prev === next ? prev : next))
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  return w
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))

/**
 * Pointer, touch and keyboard scrubbing over a chart.
 * Mouse: hover shows, leaving hides. Touch: press or drag scrubs, and the readout stays until you tap elsewhere.
 * Keyboard: focus shows the readout, ← → move it, Escape hides it.
 */
function useScrub(n: number, indexAt: (px: number) => number, start: () => number) {
  const ref = useRef<HTMLDivElement>(null)
  const [i, setI] = useState<number | null>(null)
  const pinned = useRef(false)
  const showing = i !== null

  useEffect(() => {
    if (!showing || !pinned.current) return
    const away = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        pinned.current = false
        setI(null)
      }
    }
    document.addEventListener('pointerdown', away, true)
    return () => document.removeEventListener('pointerdown', away, true)
  }, [showing])

  const at = (e: PointerEvent) => {
    const r = ref.current!.getBoundingClientRect()
    return clamp(indexAt(e.clientX - r.left), 0, n - 1)
  }

  const handlers = {
    onPointerDown(e: PointerEvent) {
      if (e.pointerType !== 'mouse') {
        pinned.current = true
        try {
          ref.current?.setPointerCapture(e.pointerId)
        } catch {
          /* not capturable: fine */
        }
      }
      setI(at(e))
    },
    onPointerMove(e: PointerEvent) {
      if (e.pointerType === 'mouse' || e.buttons || pinned.current) setI(at(e))
    },
    onPointerLeave(e: PointerEvent) {
      if (e.pointerType === 'mouse') setI(null)
    },
    onPointerCancel() {
      pinned.current = false
      setI(null)
    },
    onKeyDown(e: KeyboardEvent) {
      const cur = i ?? start()
      let next: number | null
      if (e.key === 'ArrowLeft') next = cur - 1
      else if (e.key === 'ArrowRight') next = cur + 1
      else if (e.key === 'Home') next = 0
      else if (e.key === 'End') next = n - 1
      else if (e.key === 'Escape' && i !== null) next = null
      else return
      e.preventDefault()
      e.stopPropagation()
      setI(next === null ? null : clamp(next, 0, n - 1))
    },
    onFocus(e: FocusEvent) {
      const el = e.currentTarget as HTMLElement
      if (el.matches(':focus-visible')) setI(start())
    },
    onBlur() {
      pinned.current = false
      setI(null)
    },
  }
  return { ref, i, setI, handlers }
}

interface Row {
  key: 'line' | 'box' | 'none'
  tone?: 'pen' | 'cash' | 'invest'
  value: string
  label: string
}

/** The readout card: values lead, labels follow, short strokes key the series. Stays inside the chart. */
function Tip(props: { x: number; w: number; title: string; rows: Row[] }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const tw = el.offsetWidth
    const gap = 10
    let left: number
    if (props.x + gap + tw <= props.w) left = props.x + gap
    else if (props.x - gap - tw >= 0) left = props.x - gap - tw
    else left = clamp(props.x - tw / 2, 0, Math.max(0, props.w - tw))
    el.style.transform = `translateX(${Math.round(left)}px)`
    el.style.visibility = 'visible'
  })
  return (
    <div ref={ref} class="ch-tip" style={{ left: 0, visibility: 'hidden' }}>
      <div class="ch-tip-title">{props.title}</div>
      {props.rows.map((r) => (
        <div class="ch-tip-row" key={r.label}>
          <i class={`ch-key ${r.key} ${r.tone ?? ''}`} aria-hidden="true" />
          <b>{r.value}</b>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  )
}

/** "M x y L ..." through the points. */
function linePath(pts: [number, number][]): string {
  return pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('')
}

/** Right-hand y labels and hairline gridlines. */
function Grid(props: { ticks: number[]; y: (v: number) => number; x0: number; x1: number }) {
  return (
    <g>
      {props.ticks.map((t) => {
        const yy = Math.round(props.y(t)) + 0.5
        return (
          <g key={t}>
            <line class="ch-grid" x1={props.x0} x2={props.x1} y1={yy} y2={yy} />
            <text class="ch-t ch-num" x={props.x1 + 8} y={yy} dy="0.35em">
              {compact(t)}
            </text>
          </g>
        )
      })}
    </g>
  )
}

function SrTable(props: { caption: string; head: string[]; rows: string[][] }) {
  return (
    <div class="ch-sr">
      <table>
      <caption>{props.caption}</caption>
      <thead>
        <tr>
          {props.head.map((h) => (
            <th key={h} scope="col">
              {h}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {props.rows.map((r, k) => (
          <tr key={k}>
            {r.map((c, j) => (j ? <td key={j}>{c}</td> : <th key={j} scope="row">{c}</th>))}
          </tr>
        ))}
      </tbody>
      </table>
    </div>
  )
}


/** Text widths for laying out labels: measured in the print voice, estimated where there's no canvas. */
let measurer: CanvasRenderingContext2D | null | undefined
function textWidth(s: string, px: number, weight = 450): number {
  if (measurer === undefined) measurer = typeof document === 'undefined' ? null : document.createElement('canvas').getContext('2d')
  if (!measurer) return s.length * px * 0.58
  measurer.font = `${weight} ${px}px 'Recursive Variable', system-ui, sans-serif`
  return measurer.measureText(s).width
}
/** Figures in the column voice: Recursive mono is 0.6em a character. */
const figWidth = (s: string, px: number) => s.length * px * 0.6

/** The text, shortened with an ellipsis until it fits `max` pixels. */
function fit(s: string, px: number, max: number, weight?: number): string {
  if (textWidth(s, px, weight) <= max) return s
  let t = s
  while (t.length > 1 && textWidth(`${t}…`, px, weight) > max) t = t.slice(0, -1)
  return `${t.trimEnd()}…`
}

/** 0.324 -> "32%", with "<1%" rather than a misleading 0. */
export function share(x: number): string {
  return x > 0 && x < 0.005 ? '<1%' : `${Math.round(x * 100)}%`
}

// ---------------------------------------------------------------- where the money went

/** Slice colours. Neighbours in this order stay apart for colour-blind eyes too, the wrap from last to first included. */
export const SERIES = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)', 'var(--s6)']
/** Everything too small to name. */
export const REST = 'var(--s-rest)'
export const REST_ID = '\u0000rest'

export interface Part {
  id: string
  name: string
  amount: number
}
export interface Slice extends Part {
  color: string
  /** of the total, 0..1 */
  share: number
}

/**
 * The biggest parts get a colour and a slice of their own (up to `max`, each at least `min` of the total);
 * the rest share one grey slice, "Everything else", unless that would be a single part. Parts with nothing are left out.
 * `colors` says what each part wears, grey for the ones in the rest.
 */
export function slicesOf(parts: Part[], max = SERIES.length, min = 0.03): { slices: Slice[]; colors: Map<string, string>; total: number } {
  const pos = parts.filter((p) => p.amount > 0).sort((a, b) => b.amount - a.amount)
  const total = pos.reduce((s, p) => s + p.amount, 0)
  const named = pos.filter((p, k) => k < max && p.amount >= total * min)
  const rest = pos.slice(named.length)
  const colors = new Map<string, string>()
  const slices: Slice[] = named.map((p, k) => {
    colors.set(p.id, SERIES[k])
    return { ...p, color: SERIES[k], share: p.amount / total }
  })
  for (const p of rest) colors.set(p.id, REST)
  if (rest.length === 1) slices.push({ ...rest[0], color: REST, share: rest[0].amount / total })
  else if (rest.length) {
    const amount = rest.reduce((s, p) => s + p.amount, 0)
    slices.push({ id: REST_ID, name: 'Everything else', amount, color: REST, share: amount / total })
  }
  return { slices, colors, total }
}

const RING = 0.64 // inner radius, of the outer
const LEAD = 14 // leader line, ring to label
const LINE = 32 // one two-line label, with the space under it
const NAME_PX = 12
const DETAIL_PX = 11

/**
 * A donut of the month's spending with the total in its hole. The big slices are labelled beside the ring
 * (name, share, amount), so nothing needs a pointer to read. Tapping a slice opens it; hovering one lights it.
 */
export function SpendDonut(props: {
  slices: Slice[]
  total: number
  base: string
  hot: string | null
  onHot: (id: string | null) => void
  onOpen: (id: string) => void
}): JSX.Element {
  const { slices, total, base, hot } = props
  const ref = useRef<HTMLDivElement>(null)
  const w = useWidth(ref)

  // angles run clockwise from the top
  let a = 0
  const arcs = slices.map((s) => {
    const a0 = a
    a += (s.amount / total) * Math.PI * 2
    return { s, a0, a1: a }
  })
  const maxW = w < 420 ? 100 : 124
  const labels = arcs
    .filter(({ s }) => s.share >= 0.05)
    .map(({ s, a0, a1 }) => {
      const name = fit(s.name, NAME_PX, maxW, 560)
      const detail = `${share(s.share)} · ${compact(s.amount)}`
      const mid = (a0 + a1) / 2
      return { s, name, detail, mid, side: Math.sin(mid) >= 0 ? 1 : -1, width: Math.max(textWidth(name, NAME_PX, 560), figWidth(detail, DETAIL_PX)), y: 0 }
    })
  // the ring takes what the labels on each side leave, and sits between them
  const room = (side: number) => {
    const ws = labels.filter((l) => l.side === side).map((l) => l.width)
    return ws.length ? Math.min(maxW, Math.max(...ws)) + LEAD + 8 : 6
  }
  const left = room(-1)
  const right = room(1)
  let r = Math.min(104, (w - left - right) / 2)
  const labelled = r >= 56 && labels.length > 0
  if (!labelled) r = Math.min(104, w / 2 - 4)
  const placed = labelled ? labels : []
  const perSide = Math.max(placed.filter((p) => p.side > 0).length, placed.filter((p) => p.side < 0).length)
  const H = Math.max(Math.round(2 * r + 24), perSide * LINE + 8)
  const cx = labelled ? left + r + (w - left - right - 2 * r) / 2 : w / 2
  const cy = H / 2
  const at = (a: number, rad: number): [number, number] => [cx + rad * Math.sin(a), cy - rad * Math.cos(a)]
  // each side: labels at their slice's height, pushed apart where they would touch, and kept inside
  for (const side of [1, -1]) {
    const col = placed.filter((p) => p.side === side)
    for (const p of col) p.y = at(p.mid, r + LEAD * 0.6)[1]
    col.sort((x, y) => x.y - y.y)
    const top = LINE / 2
    const bottom = H - LINE / 2 + 4
    for (let k = 0; k < col.length; k++) col[k].y = Math.max(col[k].y, top, k ? col[k - 1].y + LINE : -Infinity)
    for (let k = col.length - 1; k >= 0; k--) col[k].y = Math.min(col[k].y, bottom, k < col.length - 1 ? col[k + 1].y - LINE : Infinity)
  }

  const r0 = r * RING
  const ring = (a0: number, a1: number) => {
    const end = Math.min(a1, a0 + Math.PI * 2 - 1e-4)
    const large = end - a0 > Math.PI ? 1 : 0
    const [x0, y0] = at(a0, r)
    const [x1, y1] = at(end, r)
    const [x2, y2] = at(end, r0)
    const [x3, y3] = at(a0, r0)
    const f = (v: number) => v.toFixed(2)
    return `M${f(x0)},${f(y0)}A${f(r)},${f(r)} 0 ${large} 1 ${f(x1)},${f(y1)}L${f(x2)},${f(y2)}A${f(r0)},${f(r0)} 0 ${large} 0 ${f(x3)},${f(y3)}Z`
  }

  const amount = fmt(total, base)
  const amountPx = Math.min(19, (2 * r0 - 16) / (amount.length * 0.6))
  const summary = `Total spending ${amount}: ${slices.map((s) => `${s.name} ${fmt(s.amount, base)} (${share(s.share)})`).join(', ')}.`

  return (
    <div ref={ref} class="ch ch-donut" role="img" aria-label={summary}>
      {w > 0 && (
        <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
          <g class="ch-spin">
            {arcs.map(({ s, a0, a1 }) => (
              <path
                key={s.id}
                class={`ch-slice${hot && hot !== s.id ? ' dim' : ''}${slices.length > 1 ? ' gap' : ''}`}
                d={ring(a0, a1)}
                style={{ fill: s.color }}
                onClick={() => props.onOpen(s.id)}
                onPointerEnter={(e) => e.pointerType === 'mouse' && props.onHot(s.id)}
                onPointerLeave={(e) => e.pointerType === 'mouse' && props.onHot(null)}
              />
            ))}
          </g>
          {placed.map((p) => {
            const [x0, y0] = at(p.mid, r + 3)
            const [x1, y1] = at(p.mid, r + LEAD * 0.6)
            const ex = cx + p.side * (r + LEAD)
            const tx = ex + p.side * 4
            const anchor = p.side > 0 ? 'start' : 'end'
            return (
              <g key={p.s.id} class={`ch-callout${hot && hot !== p.s.id ? ' dim' : ''}`} onClick={() => props.onOpen(p.s.id)}>
                <polyline class="ch-leader" points={`${x0.toFixed(1)},${y0.toFixed(1)} ${x1.toFixed(1)},${y1.toFixed(1)} ${ex.toFixed(1)},${(p.y - 4).toFixed(1)}`} />
                <text class="ch-label" x={tx} y={p.y} text-anchor={anchor}>
                  {p.name}
                </text>
                <text class="ch-t ch-num" x={tx} y={p.y + 14} text-anchor={anchor}>
                  {p.detail}
                </text>
              </g>
            )
          })}
          <text class="ch-t ch-word" x={cx} y={cy - amountPx * 0.55} text-anchor="middle">
            {textWidth('Total spending', 11) <= 2 * r0 - 16 ? 'Total spending' : 'Total'}
          </text>
          <text class="ch-total" x={cx} y={cy + amountPx * 0.75} text-anchor="middle" style={{ fontSize: `${amountPx.toFixed(1)}px` }}>
            {amount}
          </text>
        </svg>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- net worth over time

const NW_H = 176
const NW_TOP = 24 // room for the value over the first and last bar
const NW_BOTTOM = 22

/** A column with a rounded top, from `y0` (baseline) up to `y1`. */
function column(x: number, y0: number, y1: number, w: number, r: number): string {
  if (y0 - y1 < 0.5) return ''
  const rr = Math.min(r, w / 2, y0 - y1)
  const f = (v: number) => v.toFixed(1)
  return `M${f(x)},${f(y0)}V${f(y1 + rr)}Q${f(x)},${f(y1)} ${f(x + rr)},${f(y1)}H${f(x + w - rr)}Q${f(x + w)},${f(y1)} ${f(x + w)},${f(y1 + rr)}V${f(y0)}Z`
}

/**
 * What you own at each month end: a column per month from zero, cash at the bottom and investments stacked on top,
 * so the height is the net worth. The first and last are labelled; the readout gives any month's split.
 */
export function NetWorthChart(props: { points: WealthPoint[]; base: string }): JSX.Element {
  const { points, base } = props
  const n = points.length
  const invested = points.some((p) => p.invest > 0)
  const ax = span(Math.min(0, ...points.map((p) => Math.min(p.cash, p.total))), Math.max(...points.map((p) => Math.max(p.cash, p.total))))
  const gutter = gutterFor(ax.ticks)
  const x0 = 0
  const scrub = useScrub(
    n,
    (px) => Math.floor((px - x0) / slot),
    () => n - 1,
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const slot = (x1 - x0) / n
  const bw = slot >= 6 ? Math.min(24, slot * 0.64) : Math.max(1, slot - 1)
  const X = (k: number) => x0 + slot * (k + 0.5)
  const baseY = NW_H - NW_BOTTOM
  const Y = (v: number) => NW_TOP + (1 - (v - ax.lo) / (ax.hi - ax.lo)) * (baseY - NW_TOP)
  const zero = Y(0)
  const gap = bw >= 4 ? 2 : 1

  const last = points[n - 1].month
  const label = (m: string, short = true) => monthName(m, { short, year: m.slice(0, 4) !== last.slice(0, 4) || !short })
  // under the columns: years at each January over long spans; the ends (and the middle) otherwise
  const ticks: { k: number; text: string }[] = []
  if (n > 13) {
    for (let k = 0; k < n; k++) if (points[k].month.endsWith('-01') && (!ticks.length || X(k) - X(ticks[ticks.length - 1].k) > 40)) ticks.push({ k, text: points[k].month.slice(0, 4) })
  } else {
    for (const k of [0, ...(n >= 7 && w >= 300 ? [Math.round((n - 1) / 2)] : []), n - 1]) if (!ticks.some((t) => t.k === k)) ticks.push({ k, text: label(points[k].month) })
  }

  const i = scrub.i
  let tip: JSX.Element | null = null
  if (i !== null && w > 0) {
    const p = points[i]
    const rows: Row[] = [{ key: 'none', value: fmt(p.total, base), label: 'net worth' }]
    if (invested) {
      rows.push({ key: 'box', tone: 'cash', value: fmt(p.cash, base), label: 'cash' })
      rows.push({ key: 'box', tone: 'invest', value: fmt(p.invest, base), label: 'investments' })
    }
    if (i > 0) rows.push({ key: 'none', value: fmt(p.total - points[i - 1].total, base, { sign: true }), label: 'that month' })
    tip = <Tip x={X(i)} w={w} title={monthName(p.month, { year: true })} rows={rows} />
  }

  const ends = n > 1 ? [0, n - 1] : [0]
  const summary =
    n > 1
      ? `Net worth from ${label(points[0].month, false)} to ${label(last, false)}: ${fmt(points[0].total, base)} to ${fmt(points[n - 1].total, base)}.`
      : `Net worth at the end of ${label(last, false)}: ${fmt(points[0].total, base)}.`

  return (
    <div class="ch">
      <div ref={scrub.ref} class="ch-plot" style={{ height: `${NW_H}px` }} tabIndex={0} role="group" aria-label={summary} {...scrub.handlers}>
        {w > 0 && (
          <svg width={w} height={NW_H} viewBox={`0 0 ${w} ${NW_H}`} aria-hidden="true">
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} />
            <g class="ch-grow" style={{ transformOrigin: `0 ${zero}px` }}>
              {points.map((p, k) => {
                const x = X(k) - bw / 2
                const cashTop = Y(Math.max(0, p.cash))
                const top = Y(Math.max(0, p.cash) + Math.max(0, p.invest))
                const dim = i !== null && i !== k ? ' dim' : ''
                return (
                  <g key={p.month} class={dim}>
                    {p.cash < 0 ? (
                      <rect class="ch-cash" x={x} y={zero} width={bw} height={Y(p.cash) - zero} />
                    ) : (
                      <path class="ch-cash" d={column(x, zero, cashTop, bw, p.invest > 0 ? 0 : 4)} />
                    )}
                    {p.invest > 0 && <path class="ch-invest" d={column(x, p.cash > 0 ? cashTop - gap : zero, top, bw, 4)} />}
                  </g>
                )
              })}
            </g>
            {ends.map((k) => {
              const p = points[k]
              const top = Y(Math.max(0, p.cash) + Math.max(0, p.invest))
              const first = k === 0 && n > 1
              return (
                <text
                  key={k}
                  class={`ch-t ch-num${first ? '' : ' ch-strong'}`}
                  x={first ? X(k) - bw / 2 : X(k) + bw / 2}
                  y={top - 7}
                  text-anchor={first ? 'start' : 'end'}
                >
                  {compact(p.total, true)}
                </text>
              )
            })}
            {ticks.map((t) => (
              <text
                key={t.k}
                class={`ch-t ch-word${t.k === n - 1 ? ' ch-strong' : ''}`}
                x={n > 13 ? X(t.k) - bw / 2 : t.k === 0 ? X(t.k) - bw / 2 : t.k === n - 1 ? X(t.k) + bw / 2 : X(t.k)}
                y={NW_H - 6}
                text-anchor={n > 13 ? 'start' : t.k === 0 && n > 1 ? 'start' : t.k === n - 1 ? 'end' : 'middle'}
              >
                {t.text}
              </text>
            ))}
          </svg>
        )}
        {tip}
      </div>
      <SrTable
        caption={summary}
        head={invested ? ['Month', 'Net worth', 'Cash', 'Investments'] : ['Month', 'Net worth']}
        rows={points.map((p) => [label(p.month, false), fmt(p.total, base), ...(invested ? [fmt(p.cash, base), fmt(p.invest, base)] : [])])}
      />
    </div>
  )
}

// ---------------------------------------------------------------- a small trend

const SPARK_H = 64
const SPARK_TOP = 18 // room for the end labels

/**
 * A quiet line for one figure over months: no axis, the first and last values written at their ends.
 * Months without a value yet are left out of the line but keep their place.
 */
export function Spark(props: { values: (number | null)[]; unit?: string; label: string }): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const w = useWidth(ref)
  const { values } = props
  const n = values.length
  const known = values.map((v, k) => [k, v] as const).filter((e): e is readonly [number, number] => e[1] !== null)
  const hi = Math.max(1, ...known.map(([, v]) => v)) * 1.08
  const pad = 4
  const X = (k: number) => (n > 1 ? pad + (k * (w - 2 * pad)) / (n - 1) : w - pad)
  const Y = (v: number) => SPARK_TOP + (1 - v / hi) * (SPARK_H - SPARK_TOP - 3)
  const pts: [number, number][] = known.map(([k, v]) => [X(k), Y(v)])
  const line = pts.length > 1 ? linePath(pts) : ''
  const area = line ? `${line}L${pts[pts.length - 1][0].toFixed(1)},${SPARK_H}L${pts[0][0].toFixed(1)},${SPARK_H}Z` : ''
  const first = known[0]
  const end = known[known.length - 1]
  return (
    <div ref={ref} class="ch ch-spark" role="img" aria-label={props.label}>
      {w > 0 && end && (
        <svg width={w} height={SPARK_H} viewBox={`0 0 ${w} ${SPARK_H}`} aria-hidden="true">
          <line class="ch-grid" x1={0} x2={w} y1={SPARK_H - 0.5} y2={SPARK_H - 0.5} />
          {area && <path class="ch-area ch-fade" d={area} />}
          {line && <path class="ch-line ch-draw" d={line} pathLength={1} />}
          <circle class="ch-dot ch-pop" cx={pts[pts.length - 1][0]} cy={pts[pts.length - 1][1]} r={4} />
          {pts.length > 1 && (
            <text class="ch-t ch-num" x={pts[0][0] - pad} y={pts[0][1] - 8} text-anchor="start">
              {Math.round(first[1])}
            </text>
          )}
          <text class="ch-t ch-num ch-strong" x={w} y={pts[pts.length - 1][1] - 9} text-anchor="end">
            {Math.round(end[1])}
            {props.unit ?? ''}
          </text>
        </svg>
      )}
    </div>
  )
}
