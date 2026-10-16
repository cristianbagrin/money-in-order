// Small, quiet SVG charts for Review. Thin marks, hairline grid, one axis, ink-colored text.
// Pointer over a chart (or tap-and-drag on touch, or arrow keys when focused) shows a readout.

import type { JSX } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks'
import { addDays, addMonths, dayOfMonth, monthName } from '../lib/dates'
import type { Burn, MonthPoint, WeekPoint } from '../lib/insights'
import { fmt } from '../lib/money'
import './charts.css'

// ---------------------------------------------------------------- shared

let seq = 0
function useUid(prefix: string): string {
  return useMemo(() => `${prefix}${++seq}`, [])
}

/** 1234500 (minor) -> "12k". Bare amounts for axis labels. */
function compact(minor: number): string {
  const v = Math.abs(minor) / 100
  const sign = minor < 0 ? '−' : ''
  const short = (x: number, unit: string) => sign + (x >= 100 || Number.isInteger(x) ? Math.round(x) : Math.round(x * 10) / 10) + unit
  if (v >= 1e6) return short(v / 1e6, 'M')
  if (v >= 1e3) return short(v / 1e3, 'k')
  return sign + Math.round(v)
}

/** A y-axis with 2–3 round gridlines above zero and a little headroom over `max`. */
function axis(max: number): { top: number; ticks: number[] } {
  if (!(max > 0)) return { top: 100, ticks: [] }
  const top = max * 1.12
  const raw = top / 3
  const mag = 10 ** Math.floor(Math.log10(raw))
  // three round gridlines when a round step allows it, otherwise the fewest (two)
  let three = 0
  let two = 0
  for (const k of [mag / 10, mag, mag * 10]) {
    for (const f of [1, 2, 2.5, 5]) {
      const s = Math.max(100, f * k)
      const count = Math.floor(top / s)
      if (count === 3 && s > three) three = s
      if (count >= 2 && s > two) two = s
    }
  }
  const step = three || two || Math.max(100, raw)
  const ticks: number[] = []
  for (let v = step; v <= top + 1e-9; v += step) ticks.push(v)
  return { top, ticks }
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
  key: 'line' | 'dash' | 'bar' | 'tick' | 'none'
  tone?: 'pen' | 'green' | 'red' | 'ink'
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

/** A bar with a 4px rounded top and a square foot on the baseline. */
function barPath(x: number, y: number, w: number, h: number): string {
  if (h <= 0 || w <= 0) return ''
  const r = Math.min(4, w / 2, h)
  return `M${x},${y + h}V${y + r}A${r},${r} 0 0 1 ${x + r},${y}H${x + w - r}A${r},${r} 0 0 1 ${x + w},${y + r}V${y + h}Z`
}

/** Right-hand y labels and hairline gridlines. */
function Grid(props: { ticks: number[]; y: (v: number) => number; x0: number; x1: number; base: number; avoid?: number | null }) {
  const avoid = props.avoid
  return (
    <g>
      {props.ticks.map((t) => {
        const yy = Math.round(props.y(t)) + 0.5
        // a reference line (plan, average) close by takes this gridline's place
        if (avoid != null && Math.abs(yy - avoid) < 14) return null
        return (
          <g key={t}>
            <line class="ch-grid" x1={props.x0} x2={props.x1} y1={yy} y2={yy} />
            <text class="ch-t ch-num" x={props.x1 + 8} y={yy} dy="0.35em">
              {compact(t)}
            </text>
          </g>
        )
      })}
      <line class="ch-base" x1={props.x0} x2={props.x1} y1={props.base + 0.5} y2={props.base + 0.5} />
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

// ---------------------------------------------------------------- burn: this month vs plan

const BURN_H = 170
const BURN_TOP = 18
const BURN_BOTTOM = 24

export function BurnChart(props: { burn: Burn; base: string }): JSX.Element {
  const b = props.burn
  const base = props.base
  const uid = useUid('burn')
  const days = Math.max(1, b.days)
  let last = -1
  b.actual.forEach((v, k) => v !== null && (last = k))
  const end = last >= 0 ? (b.actual[last] as number) : 0
  let max = Math.max(0, b.plan)
  for (const v of b.actual) if (v !== null && v > max) max = v
  for (const v of b.previous) if (v > max) max = v
  const ax = axis(max)
  const gutter = gutterFor(b.plan > 0 ? [...ax.ticks, b.plan] : ax.ticks)

  const x0 = 1
  // indexAt runs on pointer events, after the geometry below exists
  const scrub = useScrub(
    days,
    (px) => Math.round((px - x0) / (Math.max(1, plotW) / Math.max(1, days - 1))),
    () => (last >= 0 ? last : days - 1),
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const plotW = x1 - x0
  const step = days > 1 ? plotW / (days - 1) : 0
  const X = (k: number) => x0 + k * step
  const baseY = BURN_H - BURN_BOTTOM
  const Y = (v: number) => BURN_TOP + (1 - v / ax.top) * (baseY - BURN_TOP)

  const pts: [number, number][] = []
  for (let k = 0; k <= last; k++) pts.push([X(k), Y(b.actual[k] as number)])
  const prevPts: [number, number][] = b.previous.map((v, k) => [X(k), Y(v)])
  const planY = b.plan > 0 ? Math.round(Y(b.plan)) + 0.5 : null
  const over = planY !== null && max > b.plan && b.actual.some((v) => v !== null && v > b.plan)
  const endOver = b.plan > 0 && end > b.plan
  const line = linePath(pts)
  const area = pts.length > 1 ? `${line}L${pts[pts.length - 1][0].toFixed(1)},${baseY}L${x0},${baseY}Z` : ''

  const ticks = [1, 8, 15, 22, days].filter((d, k, a) => d <= days && a.indexOf(d) === k && (d === days || days - d >= 4))
  const thisName = b.month ? monthName(b.month) : 'This month'
  const prevName = b.month ? monthName(addMonths(b.month, -1)) : 'Last month'
  const shortMonth = b.month ? monthName(b.month, { short: true }) : ''

  const i = scrub.i
  let tip: JSX.Element | null = null
  if (i !== null && w > 0) {
    const a = b.actual[i]
    const rows: Row[] = []
    if (a !== null && a !== undefined) rows.push({ key: 'line', tone: endOver && a > b.plan ? 'red' : 'pen', value: fmt(a, base), label: 'spent' })
    if (b.previous.length) rows.push({ key: 'dash', value: fmt(b.previous[i], base), label: prevName })
    if (b.plan > 0 && a !== null && a !== undefined)
      rows.push(a <= b.plan ? { key: 'none', value: fmt(b.plan - a, base), label: 'left of plan' } : { key: 'none', value: fmt(a - b.plan, base), label: 'over plan' })
    else if (b.plan > 0) rows.push({ key: 'none', value: fmt(b.plan, base), label: 'plan' })
    const title = b.today !== null && b.today === i + 1 ? 'Today' : shortMonth ? `${shortMonth} ${i + 1}` : `Day ${i + 1}`
    tip = <Tip x={X(i)} w={w} title={title} rows={rows} />
  }

  // direct label for where the line ends
  let endLabel: JSX.Element | null = null
  if (last >= 0 && i === null && w > 0) {
    const [ex, ey] = pts[last]
    const leftSide = ex > 90
    const above = ey - 10 > BURN_TOP - 6
    endLabel = (
      <text
        class="ch-t ch-num ch-end ch-halo ch-late"
        x={leftSide ? ex - 8 : ex + 8}
        y={above ? ey - 9 : ey + 17}
        text-anchor={leftSide ? 'end' : 'start'}
      >
        {fmt(end, base)}
      </text>
    )
  }

  const summary =
    last >= 0
      ? `${thisName}: ${fmt(end, base)} spent${b.plan > 0 ? ` of a ${fmt(b.plan, base)} plan` : ''}${b.today ? ` by day ${b.today}` : ''}.`
      : `${thisName}: nothing spent yet.`

  return (
    <div class="ch">
      <div
        ref={scrub.ref}
        class="ch-plot"
        style={{ height: `${BURN_H}px` }}
        tabIndex={0}
        role="group"
        aria-label={summary}
        {...scrub.handlers}
      >
        {w > 0 && (
          <svg width={w} height={BURN_H} viewBox={`0 0 ${w} ${BURN_H}`} aria-hidden="true">
            <defs>
              <clipPath id={`${uid}-lo`}>
                <rect x="0" y={planY ?? 0} width={w} height={BURN_H} />
              </clipPath>
              <clipPath id={`${uid}-hi`}>
                <rect x="0" y="-10" width={w} height={(planY ?? 0) + 10} />
              </clipPath>
            </defs>
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} base={baseY} avoid={planY} />
            {ticks.map((d) => (
              <text
                key={d}
                class={`ch-t ch-num${b.today === d ? ' ch-strong' : ''}`}
                x={X(d - 1)}
                y={BURN_H - 6}
                text-anchor={d === 1 ? 'start' : d === days ? 'end' : 'middle'}
              >
                {d}
              </text>
            ))}
            {planY !== null && (
              <g>
                <line class="ch-plan" x1={x0} x2={x1} y1={planY} y2={planY} />
                <text class="ch-t ch-word ch-plan-label ch-halo" x={x0 + 2} y={planY - 5}>
                  plan
                </text>
                <text class="ch-t ch-num ch-strong" x={x1 + 8} y={planY} dy="0.35em">
                  {compact(b.plan)}
                </text>
              </g>
            )}
            <g key={`${b.month}|${days}`}>
              {prevPts.length > 1 && <path class="ch-prev ch-fade" d={linePath(prevPts)} />}
              {area && (
                <>
                  <path class="ch-area ch-fade" d={area} clip-path={over ? `url(#${uid}-lo)` : undefined} />
                  {over && <path class="ch-area over ch-fade" d={area} clip-path={`url(#${uid}-hi)`} />}
                </>
              )}
              {pts.length > 1 && (
                <>
                  <path class="ch-line ch-draw" d={line} pathLength={1} clip-path={over ? `url(#${uid}-lo)` : undefined} />
                  {over && <path class="ch-line over ch-draw" d={line} pathLength={1} clip-path={`url(#${uid}-hi)`} />}
                </>
              )}
              {last >= 0 && <circle class={`ch-dot ch-pop${endOver ? ' over' : ''}`} cx={pts[last][0]} cy={pts[last][1]} r={4} />}
            </g>
            {endLabel}
            {i !== null && (
              <g class="ch-hover">
                <line class="ch-guide" x1={Math.round(X(i)) + 0.5} x2={Math.round(X(i)) + 0.5} y1={BURN_TOP - 8} y2={baseY} />
                {b.previous.length > 0 && <circle class="ch-dot prev" cx={X(i)} cy={Y(b.previous[i])} r={3} />}
                {b.actual[i] !== null && b.actual[i] !== undefined && (
                  <circle class={`ch-dot${b.plan > 0 && (b.actual[i] as number) > b.plan ? ' over' : ''}`} cx={X(i)} cy={Y(b.actual[i] as number)} r={4} />
                )}
              </g>
            )}
          </svg>
        )}
        {tip}
      </div>
      {b.previous.length > 0 && (
        <div class="ch-legend" aria-hidden="true">
          <span>
            <i class={`ch-key line ${endOver ? 'red' : 'pen'}`} />
            {thisName}
          </span>
          <span>
            <i class="ch-key dash" />
            {prevName}
          </span>
        </div>
      )}
      <SrTable
        caption={summary}
        head={['Day', 'Spent', ...(b.previous.length ? [prevName] : [])]}
        rows={b.actual.map((v, k) => [String(k + 1), v === null ? '' : fmt(v, base), ...(b.previous.length ? [fmt(b.previous[k], base)] : [])])}
      />
    </div>
  )
}

// ---------------------------------------------------------------- months

const BARS_TOP = 16
const BARS_BOTTOM = 24

function monthLabel(month: string, current?: string) {
  const sameYear = !current || month.slice(0, 4) === current.slice(0, 4)
  return monthName(month, { year: !sameYear })
}

export function MonthBars(props: { points: MonthPoint[]; base: string; current?: string; onSelect?: (month: string) => void }): JSX.Element {
  const { points, base, current, onSelect } = props
  const H = 150
  const uid = useUid('mb')
  const n = Math.max(1, points.length)
  let max = 0
  for (const p of points) max = Math.max(max, p.spent, p.income)
  const ax = axis(max)
  const gutter = gutterFor(ax.ticks)
  const x0 = 0
  const scrub = useScrub(
    n,
    (px) => Math.floor((px - x0) / band),
    () => n - 1,
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const band = (x1 - x0) / n
  const bw = Math.min(24, Math.max(6, band * 0.42))
  const tw = Math.min(band * 0.8, bw + 14)
  const baseY = H - BARS_BOTTOM
  const Y = (v: number) => BARS_TOP + (1 - v / ax.top) * (baseY - BARS_TOP)
  const hasIncome = points.some((p) => p.income > 0)
  const i = scrub.i
  // when month names would touch, label every other month (always the latest)
  const every = band < 30 ? 2 : 1

  let tip: JSX.Element | null = null
  if (i !== null && points[i] && w > 0) {
    const p = points[i]
    const rows: Row[] = [{ key: 'bar', tone: 'pen', value: fmt(p.spent, base), label: p.month === current ? 'spent so far' : 'spent' }]
    if (p.income > 0) rows.push({ key: 'tick', tone: 'green', value: fmt(p.income, base), label: 'income' })
    if (p.savingsRate !== null) rows.push({ key: 'none', value: `${Math.round(p.savingsRate * 100)}%`, label: 'saved' })
    tip = <Tip x={x0 + band * (i + 0.5)} w={w} title={monthLabel(p.month, current)} rows={rows} />
  }

  const pick = (e: MouseEvent) => {
    if (!onSelect || !scrub.ref.current) return
    const r = scrub.ref.current.getBoundingClientRect()
    const k = clamp(Math.floor((e.clientX - r.left - x0) / band), 0, n - 1)
    if (points[k] && e.clientX - r.left <= x1) onSelect(points[k].month)
  }
  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.key === 'Enter' || e.key === ' ') && i !== null && onSelect && points[i]) {
      e.preventDefault()
      onSelect(points[i].month)
      return
    }
    scrub.handlers.onKeyDown(e)
  }

  const summary = points.length
    ? `Spending by month: ${points.map((p) => `${monthName(p.month, { short: true })} ${fmt(p.spent, base)}`).join(', ')}.`
    : 'No months yet.'

  return (
    <div class="ch">
      <div
        ref={scrub.ref}
        class={`ch-plot${onSelect ? ' ch-click' : ''}`}
        style={{ height: `${H}px` }}
        tabIndex={0}
        role="group"
        aria-label={summary}
        {...scrub.handlers}
        onKeyDown={onKeyDown}
        onClick={pick}
      >
        {w > 0 && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
            <defs>
              <pattern id={`${uid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="ch-hatch-bg" width="4" height="4" />
                <rect class="ch-hatch-line" width="1.6" height="4" />
              </pattern>
            </defs>
            <Grid ticks={ax.ticks} y={Y} x0={x0} x1={x1} base={baseY} />
            {points.map((p, k) => {
              const cx = x0 + band * (k + 0.5)
              const h = Math.max(0, baseY - Y(Math.max(0, p.spent)))
              const soFar = p.month === current
              const hot = i === k
              return (
                <g key={p.month} class="ch-slot" style={{ transform: `translateX(${cx.toFixed(1)}px)` }}>
                  {h > 0 && (
                    <path
                      class={`ch-bar ch-grow${hot ? ' hot' : ''}`}
                      style={{ animationDelay: `${k * 35}ms`, ...(soFar ? { fill: `url(#${uid}-hatch)` } : {}) }}
                      d={barPath(-bw / 2, baseY - h, bw, h)}
                    />
                  )}
                  {p.income > 0 && (
                    <line class="ch-income ch-fade" x1={-tw / 2} x2={tw / 2} y1={Y(p.income)} y2={Y(p.income)} />
                  )}
                  {(hot || (points.length - 1 - k) % every === 0) && (
                    <text class={`ch-t ch-word${hot || k === points.length - 1 ? ' ch-strong' : ''}`} x={0} y={H - 6} text-anchor="middle">
                      {monthName(p.month, { short: true })}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        )}
        {tip}
      </div>
      {hasIncome && (
        <div class="ch-legend" aria-hidden="true">
          <span>
            <i class="ch-key bar pen" />
            Spent
          </span>
          <span>
            <i class="ch-key tick green" />
            Income
          </span>
        </div>
      )}
      <SrTable
        caption="Spending and income by month"
        head={['Month', 'Spent', 'Income', 'Saved']}
        rows={points.map((p) => [
          monthLabel(p.month, current),
          fmt(p.spent, base),
          fmt(p.income, base),
          p.savingsRate === null ? '' : `${Math.round(p.savingsRate * 100)}%`,
        ])}
      />
    </div>
  )
}

// ---------------------------------------------------------------- weeks

function weekTitle(start: string, isLast: boolean): string {
  if (isLast) return 'This week'
  const end = addDays(start, 6)
  const m1 = monthName(start.slice(0, 7), { short: true })
  const m2 = monthName(end.slice(0, 7), { short: true })
  return m1 === m2 ? `${m1} ${dayOfMonth(start)}–${dayOfMonth(end)}` : `${m1} ${dayOfMonth(start)} – ${m2} ${dayOfMonth(end)}`
}

export function WeekBars(props: { weeks: WeekPoint[]; base: string }): JSX.Element {
  const { weeks, base } = props
  const H = 116
  const top = 16
  const bottom = 24
  const uid = useUid('wb')
  const n = Math.max(1, weeks.length)
  const done = weeks.slice(0, -1)
  const avg = done.length >= 2 ? Math.round(done.reduce((s, w) => s + w.spent, 0) / done.length) : 0
  let max = avg
  for (const w of weeks) max = Math.max(max, w.spent)
  const ax = { top: Math.max(1, max) * 1.08 }
  const gutter = avg > 0 ? gutterFor([avg]) : 0
  const x0 = 0
  const scrub = useScrub(
    n,
    (px) => Math.floor((px - x0) / band),
    () => n - 1,
  )
  const w = useWidth(scrub.ref)
  const x1 = Math.max(x0 + 10, w - gutter)
  const band = (x1 - x0) / n
  const bw = Math.min(20, Math.max(5, band * 0.46))
  const baseY = H - bottom
  const Y = (v: number) => top + (1 - v / ax.top) * (baseY - top)
  const i = scrub.i
  const avgY = avg > 0 ? Math.round(Y(avg)) + 0.5 : null

  let tip: JSX.Element | null = null
  if (i !== null && weeks[i] && w > 0) {
    const wk = weeks[i]
    const rows: Row[] = [{ key: 'bar', tone: 'pen', value: fmt(wk.spent, base), label: i === n - 1 ? 'so far' : 'spent' }]
    if (avg > 0) rows.push({ key: 'none', value: fmt(avg, base), label: 'average' })
    tip = <Tip x={x0 + band * (i + 0.5)} w={w} title={weekTitle(wk.start, i === n - 1)} rows={rows} />
  }

  const firstLabel = weeks.length > 1 ? `${monthName(weeks[0].start.slice(0, 7), { short: true })} ${dayOfMonth(weeks[0].start)}` : ''
  const summary = `Spending by week: ${weeks.map((wk, k) => `${weekTitle(wk.start, k === n - 1)} ${fmt(wk.spent, base)}`).join(', ')}.`

  return (
    <div class="ch">
      <div ref={scrub.ref} class="ch-plot" style={{ height: `${H}px` }} tabIndex={0} role="group" aria-label={summary} {...scrub.handlers}>
        {w > 0 && (
          <svg width={w} height={H} viewBox={`0 0 ${w} ${H}`} aria-hidden="true">
            <defs>
              <pattern id={`${uid}-hatch`} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect class="ch-hatch-bg" width="4" height="4" />
                <rect class="ch-hatch-line" width="1.6" height="4" />
              </pattern>
            </defs>
            <line class="ch-base" x1={x0} x2={x1} y1={baseY + 0.5} y2={baseY + 0.5} />
            {weeks.map((wk, k) => {
              const h = Math.max(0, baseY - Y(Math.max(0, wk.spent)))
              const cx = x0 + band * (k + 0.5)
              const isLast = k === n - 1
              return (
                <g key={wk.start} class="ch-slot" style={{ transform: `translateX(${cx.toFixed(1)}px)` }}>
                  {h > 0 && (
                    <path
                      class={`ch-bar ch-grow${i === k ? ' hot' : ''}`}
                      style={{ animationDelay: `${k * 30}ms`, ...(isLast ? { fill: `url(#${uid}-hatch)` } : {}) }}
                      d={barPath(-bw / 2, baseY - h, bw, h)}
                    />
                  )}
                </g>
              )
            })}
            {avgY !== null && (
              <g>
                <line class="ch-plan" x1={x0} x2={x1} y1={avgY} y2={avgY} />
                <text class="ch-t ch-word ch-plan-label ch-halo" x={x0 + 2} y={avgY - 5}>
                  average
                </text>
                <text class="ch-t ch-num ch-strong" x={x1 + 8} y={avgY} dy="0.35em">
                  {compact(avg)}
                </text>
              </g>
            )}
            {firstLabel && (
              <text class="ch-t ch-word" x={x0 + band * 0.5 - bw / 2} y={H - 6}>
                {firstLabel}
              </text>
            )}
            <text class="ch-t ch-word ch-strong" x={x0 + band * (n - 0.5) + bw / 2} y={H - 6} text-anchor="end">
              This week
            </text>
          </svg>
        )}
        {tip}
      </div>
      <SrTable caption="Spending by week" head={['Week', 'Spent']} rows={weeks.map((wk, k) => [weekTitle(wk.start, k === n - 1), fmt(wk.spent, base)])} />
    </div>
  )
}

// ---------------------------------------------------------------- sparkline

export function Sparkline(props: { values: number[]; highlightLast?: boolean; width?: number; height?: number }): JSX.Element {
  const W = props.width ?? 72
  const H = props.height ?? 22
  const vals = props.values.length ? props.values : [0]
  const pad = props.highlightLast ? 4 : 1.5
  let lo = 0
  let hi = 0
  for (const v of vals) {
    lo = Math.min(lo, v)
    hi = Math.max(hi, v)
  }
  const span = hi - lo || 1
  const X = (k: number) => (vals.length === 1 ? W - pad : pad + (k * (W - 2 * pad)) / (vals.length - 1))
  const Y = (v: number) => H - pad - ((v - lo) / span) * (H - 2 * pad)
  const pts: [number, number][] = vals.map((v, k) => [X(k), Y(v)])
  const [lx, ly] = pts[pts.length - 1]
  return (
    <svg class="ch-spark" width={W} height={H} viewBox={`0 0 ${W} ${H}`} aria-hidden="true">
      {pts.length > 1 && <path d={linePath(pts)} />}
      {props.highlightLast && <circle cx={lx} cy={ly} r={2.75} />}
    </svg>
  )
}
