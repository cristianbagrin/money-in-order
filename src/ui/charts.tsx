// Small, quiet SVG charts for Review. Thin marks, hairline grid, one axis, ink-colored text.
// Pointer over a chart (or tap-and-drag on touch, or arrow keys when focused) shows a readout.

import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import type { WealthPoint } from '../lib/accounts'
import { monthName } from '../lib/dates'
import { fmt } from '../lib/money'
import './charts.css'

// ---------------------------------------------------------------- shared

/** 1234500 (minor) -> "12k". Bare amounts for axis labels. */
function compact(minor: number): string {
  const v = Math.abs(minor) / 100
  const sign = minor < 0 ? '−' : ''
  const short = (x: number, unit: string) => sign + (x >= 100 || Number.isInteger(x) ? Math.round(x) : Math.round(x * 10) / 10) + unit
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
  key: 'line' | 'none'
  tone?: 'pen'
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

// ---------------------------------------------------------------- wealth over time

const WEALTH_H = 150
const WEALTH_TOP = 10
const WEALTH_BOTTOM = 24

/**
 * Net worth at each month end as one line, the month shown last and dotted. The axis hugs the data so a
 * month's change shows; the readout splits each month into cash and investments.
 */
export function WealthChart(props: { points: WealthPoint[]; base: string }): JSX.Element {
  const { points, base } = props
  const n = points.length
  const invested = points.some((p) => p.invest !== 0)
  const ax = span(Math.min(...points.map((p) => p.total)), Math.max(...points.map((p) => p.total)))
  const gutter = gutterFor(ax.ticks)
  const x0 = 1
  // indexAt runs on pointer events, after the geometry below exists
  const scrub = useScrub(
    n,
    (px) => Math.round((px - x0) / (Math.max(1, x1 - x0) / Math.max(1, n - 1))),
    () => n - 1,
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const X = (k: number) => (n > 1 ? x0 + (k * (x1 - x0)) / (n - 1) : x1)
  const baseY = WEALTH_H - WEALTH_BOTTOM
  const Y = (v: number) => WEALTH_TOP + (1 - (v - ax.lo) / (ax.hi - ax.lo)) * (baseY - WEALTH_TOP)
  const pts: [number, number][] = points.map((p, k) => [X(k), Y(p.total)])
  const line = linePath(pts)
  const area = n > 1 ? `${line}L${x1.toFixed(1)},${baseY}L${x0},${baseY}Z` : ''

  const last = points[n - 1].month
  const label = (m: string, short = true) => monthName(m, { short, year: m.slice(0, 4) !== last.slice(0, 4) || !short })
  // the ends, and the middle when there is room for it
  const marks = [0, ...(n >= 7 && w >= 300 ? [Math.round((n - 1) / 2)] : []), n - 1].filter((k, j, a) => a.indexOf(k) === j)

  const i = scrub.i
  let tip: JSX.Element | null = null
  if (i !== null && w > 0) {
    const p = points[i]
    const rows: Row[] = [{ key: 'line', tone: 'pen', value: fmt(p.total, base), label: 'net worth' }]
    if (invested) {
      rows.push({ key: 'none', value: fmt(p.cash, base), label: 'cash' })
      rows.push({ key: 'none', value: fmt(p.invest, base), label: 'investments' })
    }
    if (i > 0) rows.push({ key: 'none', value: fmt(p.total - points[i - 1].total, base, { sign: true }), label: 'that month' })
    tip = <Tip x={X(i)} w={w} title={monthName(p.month, { year: true })} rows={rows} />
  }

  const end = points[n - 1]
  const summary =
    n > 1
      ? `Net worth from ${label(points[0].month, false)} to ${label(last, false)}: ${fmt(points[0].total, base)} to ${fmt(end.total, base)}.`
      : `Net worth at the end of ${label(last, false)}: ${fmt(end.total, base)}.`

  return (
    <div class="ch">
      <div ref={scrub.ref} class="ch-plot" style={{ height: `${WEALTH_H}px` }} tabIndex={0} role="group" aria-label={summary} {...scrub.handlers}>
        {w > 0 && (
          <svg width={w} height={WEALTH_H} viewBox={`0 0 ${w} ${WEALTH_H}`} aria-hidden="true">
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} />
            {marks.map((k) => (
              <text
                key={k}
                class={`ch-t ch-word${k === n - 1 ? ' ch-strong' : ''}`}
                x={X(k)}
                y={WEALTH_H - 6}
                text-anchor={k === 0 && n > 1 ? 'start' : k === n - 1 ? 'end' : 'middle'}
              >
                {label(points[k].month)}
              </text>
            ))}
            {area && <path class="ch-area ch-fade" d={area} />}
            {n > 1 && <path class="ch-line ch-draw" d={line} pathLength={1} />}
            <circle class="ch-dot ch-pop" cx={pts[n - 1][0]} cy={pts[n - 1][1]} r={4} />
            {i !== null && (
              <g>
                <line class="ch-guide" x1={Math.round(X(i)) + 0.5} x2={Math.round(X(i)) + 0.5} y1={WEALTH_TOP - 6} y2={baseY} />
                <circle class="ch-dot" cx={pts[i][0]} cy={pts[i][1]} r={4} />
              </g>
            )}
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
